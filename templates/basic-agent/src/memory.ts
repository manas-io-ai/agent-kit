/**
 * Memory system for the AI agent.
 * 
 * Provides:
 * - Short-term memory (conversation history with compaction)
 * - Long-term memory (SQLite-backed with simple vector search)
 * - Session persistence (save/load conversations)
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import type {
  ChatCompletionMessageParam,
  ChatCompletionAssistantMessageParam,
  ChatCompletionToolMessageParam,
} from 'openai/resources/chat/completions';

// ─── Short-Term Memory ──────────────────────────────────────────────────

interface TrackedMessage {
  message: ChatCompletionMessageParam;
  timestamp: number;
  tokenEstimate: number;
}

export class ShortTermMemory {
  private messages: TrackedMessage[] = [];
  private maxTokens: number;

  constructor(
    private systemPrompt: string,
    maxTokens: number = 80_000,
  ) {
    this.maxTokens = maxTokens;
    this.messages.push({
      message: { role: 'system', content: systemPrompt },
      timestamp: Date.now(),
      tokenEstimate: this.estimateTokens(systemPrompt),
    });
  }

  /** Add a message to the conversation */
  add(message: ChatCompletionMessageParam): void {
    const content = this.extractContent(message);
    this.messages.push({
      message,
      timestamp: Date.now(),
      tokenEstimate: this.estimateTokens(content),
    });
    this.compactIfNeeded();
  }

  /** Get all messages formatted for the OpenAI API */
  getMessages(): ChatCompletionMessageParam[] {
    return this.messages.map((m) => m.message);
  }

  /** Get conversation history as a plain text summary */
  getSummary(): string {
    return this.messages
      .filter((m) => m.message.role !== 'system')
      .map((m) => `[${m.message.role}] ${this.extractContent(m.message).slice(0, 200)}`)
      .join('\n');
  }

  /** Current estimated token count */
  getTokenCount(): number {
    return this.messages.reduce((sum, m) => sum + m.tokenEstimate, 0);
  }

  /** Number of messages */
  get length(): number {
    return this.messages.length;
  }

  private compactIfNeeded(): void {
    if (this.getTokenCount() <= this.maxTokens) return;

    // Strategy: Summarize old tool results (they're the biggest)
    for (let i = 1; i < this.messages.length - 6; i++) {
      const tracked = this.messages[i];
      if (tracked.message.role === 'tool' && tracked.tokenEstimate > 300) {
        const content = this.extractContent(tracked.message);
        const truncated = content.slice(0, 500) + '\n...[truncated for brevity]';
        (tracked.message as ChatCompletionToolMessageParam).content = truncated;
        tracked.tokenEstimate = this.estimateTokens(truncated);
      }
    }

    // If still over budget, drop old middle messages
    if (this.getTokenCount() > this.maxTokens) {
      const keep = 3; // Keep system + first exchange
      const keepEnd = 8; // Keep last 8 messages
      
      if (this.messages.length > keep + keepEnd) {
        const head = this.messages.slice(0, keep);
        const tail = this.messages.slice(-keepEnd);
        const dropped = this.messages.length - keep - keepEnd;
        
        const marker: TrackedMessage = {
          message: {
            role: 'system',
            content: `[${dropped} earlier messages omitted for context length]`,
          },
          timestamp: Date.now(),
          tokenEstimate: 20,
        };
        
        this.messages = [...head, marker, ...tail];
      }
    }
  }

  private extractContent(message: ChatCompletionMessageParam): string {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => ('text' in part ? part.text : '[non-text]'))
        .join(' ');
    }
    // For assistant messages with tool_calls
    const assistantMsg = message as ChatCompletionAssistantMessageParam;
    if (assistantMsg.tool_calls) {
      return assistantMsg.tool_calls
        .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
        .join('; ');
    }
    return '';
  }

  private estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token for English
    return Math.ceil(text.length / 4);
  }
}

// ─── Long-Term Memory ───────────────────────────────────────────────────

interface MemoryRecord {
  id: string;
  content: string;
  type: 'fact' | 'preference' | 'procedure' | 'note';
  source: string;
  importance: number;
  createdAt: number;
  accessCount: number;
}

interface SearchResult {
  record: MemoryRecord;
  similarity: number;
}

export class LongTermMemory {
  private db: Database.Database;
  private dimension: number;

  constructor(dbPath: string, dimension: number = 256) {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.dimension = dimension;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL,
        type TEXT NOT NULL DEFAULT 'note',
        source TEXT NOT NULL DEFAULT '',
        importance REAL NOT NULL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed INTEGER NOT NULL
      );
      
      CREATE INDEX IF NOT EXISTS idx_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_importance ON memories(importance DESC);
    `);
  }

  /** Store a memory */
  store(
    content: string,
    type: MemoryRecord['type'] = 'note',
    source: string = '',
    importance: number = 0.5,
  ): string {
    const id = createHash('sha256').update(content).digest('hex').slice(0, 12);
    const embedding = this.embed(content);
    const now = Date.now();

    this.db
      .prepare(
        `INSERT OR REPLACE INTO memories 
         (id, content, embedding, type, source, importance, created_at, access_count, last_accessed) 
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(id, content, Buffer.from(new Float32Array(embedding).buffer), type, source, importance, now, now);

    return id;
  }

  /** Search memories by similarity to a query */
  search(query: string, limit: number = 5, minSimilarity: number = 0.1): SearchResult[] {
    const queryEmbedding = this.embed(query);

    const rows = this.db.prepare('SELECT * FROM memories').all() as Array<{
      id: string;
      content: string;
      embedding: Buffer;
      type: string;
      source: string;
      importance: number;
      created_at: number;
      access_count: number;
      last_accessed: number;
    }>;

    const results: SearchResult[] = rows
      .map((row) => {
        const stored = Array.from(
          new Float32Array(row.embedding.buffer, row.embedding.byteOffset, this.dimension),
        );
        const sim = cosineSimilarity(queryEmbedding, stored);
        // Boost by importance
        const boosted = sim * 0.8 + row.importance * 0.2;

        return {
          record: {
            id: row.id,
            content: row.content,
            type: row.type as MemoryRecord['type'],
            source: row.source,
            importance: row.importance,
            createdAt: row.created_at,
            accessCount: row.access_count,
          },
          similarity: boosted,
        };
      })
      .filter((r) => r.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    // Update access counts
    const update = this.db.prepare(
      'UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?',
    );
    for (const r of results) {
      update.run(Date.now(), r.record.id);
    }

    return results;
  }

  /** Get all memories */
  getAll(): MemoryRecord[] {
    const rows = this.db
      .prepare('SELECT id, content, type, source, importance, created_at, access_count FROM memories ORDER BY importance DESC')
      .all() as Array<{
      id: string;
      content: string;
      type: string;
      source: string;
      importance: number;
      created_at: number;
      access_count: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      type: r.type as MemoryRecord['type'],
      source: r.source,
      importance: r.importance,
      createdAt: r.created_at,
      accessCount: r.access_count,
    }));
  }

  /** Delete a memory by ID */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  }

  /** Delete old, low-importance, rarely accessed memories */
  decay(maxAgeDays: number = 90): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    return this.db
      .prepare(
        'DELETE FROM memories WHERE last_accessed < ? AND importance < 0.7 AND access_count < 3',
      )
      .run(cutoff).changes;
  }

  /** Simple local embedding using character n-gram hashing */
  private embed(text: string): number[] {
    const normalized = text.toLowerCase().trim();
    const vec = new Float32Array(this.dimension);

    // Character trigrams
    for (let i = 0; i < normalized.length - 2; i++) {
      const trigram = normalized.slice(i, i + 3);
      const h = hash(trigram);
      vec[Math.abs(h) % this.dimension] += h > 0 ? 1 : -1;
    }

    // Word-level features (weighted higher)
    for (const word of normalized.split(/\s+/)) {
      if (word.length < 2) continue;
      const h = hash(word);
      vec[Math.abs(h) % this.dimension] += (h > 0 ? 1 : -1) * 2;
    }

    // L2 normalize
    let mag = 0;
    for (let i = 0; i < vec.length; i++) mag += vec[i] * vec[i];
    mag = Math.sqrt(mag);
    if (mag > 0) for (let i = 0; i < vec.length; i++) vec[i] /= mag;

    return Array.from(vec);
  }

  close(): void {
    this.db.close();
  }
}

// ─── Session Persistence ────────────────────────────────────────────────

export class SessionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        messages TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        summary TEXT
      );
    `);
  }

  save(sessionId: string, messages: ChatCompletionMessageParam[], summary?: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions (id, messages, created_at, updated_at, summary)
         VALUES (?, ?, COALESCE((SELECT created_at FROM sessions WHERE id = ?), ?), ?, ?)`,
      )
      .run(sessionId, JSON.stringify(messages), sessionId, now, now, summary ?? null);
  }

  load(sessionId: string): ChatCompletionMessageParam[] | null {
    const row = this.db
      .prepare('SELECT messages FROM sessions WHERE id = ?')
      .get(sessionId) as { messages: string } | undefined;

    return row ? JSON.parse(row.messages) : null;
  }

  list(): Array<{ id: string; summary: string | null; updatedAt: number }> {
    return this.db
      .prepare('SELECT id, summary, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 20')
      .all() as Array<{ id: string; summary: string | null; updated_at: number }>;
  }

  close(): void {
    this.db.close();
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  return magA && magB ? dot / (magA * magB) : 0;
}
