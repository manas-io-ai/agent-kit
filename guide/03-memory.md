# Chapter 3: Memory Systems for AI Agents

> An agent without memory is a goldfish. It can do things, but it can't learn, recall, or build context over time.

Memory is what separates a stateless API wrapper from a real agent. This chapter covers three types of memory, with working implementations you can drop into your projects.

---

## Table of Contents

1. [Why Memory Matters](#why-memory-matters)
2. [The Three Types of Memory](#the-three-types-of-memory)
3. [Short-Term Memory (Conversation)](#short-term-memory-conversation)
4. [Long-Term Memory (Vector DB)](#long-term-memory-vector-db)
5. [Episodic Memory (Session Logs)](#episodic-memory-session-logs)
6. [Putting It All Together](#putting-it-all-together)
7. [Memory Management Strategies](#memory-management-strategies)

---

## Why Memory Matters

Without memory:
- Agent repeats the same mistakes
- User has to re-explain preferences every session
- Agent can't reference earlier conversation context
- Multi-step tasks fail because the agent forgets its own plan

With memory:
- Agent learns user preferences over time
- Past solutions inform future decisions
- Long conversations stay coherent
- Agent builds genuine expertise on your codebase/data

## The Three Types of Memory

| Type | Duration | Analogy | Use Case |
|------|----------|---------|----------|
| **Short-term** | Current session | Working memory | Active conversation, current task context |
| **Long-term** | Persistent | Semantic memory | Facts, preferences, learned information |
| **Episodic** | Persistent | Autobiographical memory | Past sessions, what happened and when |

```
┌─────────────────────────────────────────────┐
│                Agent Brain                    │
│                                               │
│  ┌──────────────┐  ┌────────────────────┐   │
│  │  Short-term   │  │    Long-term        │   │
│  │  (messages)   │  │    (vector DB)      │   │
│  │               │  │                     │   │
│  │  Recent msgs  │  │  Facts & knowledge  │   │
│  │  Tool results │  │  User preferences   │   │
│  │  Current plan │  │  Learned patterns   │   │
│  └──────────────┘  └────────────────────┘   │
│                                               │
│  ┌──────────────────────────────────────┐   │
│  │         Episodic                       │   │
│  │         (session logs)                 │   │
│  │                                        │   │
│  │  "Last Tuesday, user asked me to..."  │   │
│  │  "When I tried X, it failed because." │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

---

## Short-Term Memory (Conversation)

Short-term memory is the message history of the current conversation. Every agent has this by default — it's the `messages` array you send to the LLM.

The challenge: **context windows are finite.** A conversation with many tool calls can easily exceed the window. You need strategies to manage this.

### Implementation

```typescript
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  timestamp: number;
  metadata?: {
    tokenEstimate: number;
    importance: 'low' | 'medium' | 'high';
  };
}

class ShortTermMemory {
  private messages: Message[] = [];
  private maxTokens: number;
  private systemPrompt: string;
  
  constructor(systemPrompt: string, maxTokens: number = 100_000) {
    this.systemPrompt = systemPrompt;
    this.maxTokens = maxTokens;
    this.messages = [{
      role: 'system',
      content: systemPrompt,
      timestamp: Date.now(),
      metadata: {
        tokenEstimate: this.estimateTokens(systemPrompt),
        importance: 'high',
      },
    }];
  }
  
  add(message: Omit<Message, 'timestamp' | 'metadata'>): void {
    const full: Message = {
      ...message,
      timestamp: Date.now(),
      metadata: {
        tokenEstimate: this.estimateTokens(message.content),
        importance: this.classifyImportance(message),
      },
    };
    this.messages.push(full);
    this.compact();
  }
  
  getMessages(): Message[] {
    return [...this.messages];
  }
  
  /** Get messages formatted for the LLM API */
  getForAPI(): Array<{ role: string; content: string; tool_call_id?: string }> {
    return this.messages.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
    }));
  }
  
  /** Compact the history when it gets too long */
  private compact(): void {
    const totalTokens = this.messages.reduce(
      (sum, m) => sum + (m.metadata?.tokenEstimate ?? 0),
      0
    );
    
    if (totalTokens <= this.maxTokens) return;
    
    // Strategy 1: Summarize old tool results (they're usually the biggest)
    for (let i = 1; i < this.messages.length - 10; i++) {
      const msg = this.messages[i];
      if (msg.role === 'tool' && msg.metadata!.tokenEstimate > 500) {
        // Replace verbose tool output with a summary
        const summary = this.summarizeToolResult(msg.content);
        msg.content = summary;
        msg.metadata!.tokenEstimate = this.estimateTokens(summary);
      }
    }
    
    // Strategy 2: Drop low-importance old messages (keep first 3 and last 10)
    if (this.getTotalTokens() > this.maxTokens) {
      const keep = [
        ...this.messages.slice(0, 3), // System prompt + first user message + first response
        ...this.messages.slice(-10),   // Recent context
      ];
      
      // Summarize the dropped middle
      const dropped = this.messages.slice(3, -10);
      if (dropped.length > 0) {
        const summaryMsg: Message = {
          role: 'system',
          content: `[Earlier in this conversation: ${this.summarizeDropped(dropped)}]`,
          timestamp: Date.now(),
          metadata: { tokenEstimate: 200, importance: 'medium' },
        };
        this.messages = [keep[0], keep[1], keep[2], summaryMsg, ...keep.slice(3)];
      }
    }
  }
  
  private getTotalTokens(): number {
    return this.messages.reduce((sum, m) => sum + (m.metadata?.tokenEstimate ?? 0), 0);
  }
  
  private estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters for English
    return Math.ceil(text.length / 4);
  }
  
  private classifyImportance(message: Omit<Message, 'timestamp' | 'metadata'>): 'low' | 'medium' | 'high' {
    if (message.role === 'system') return 'high';
    if (message.role === 'user') return 'high';
    if (message.role === 'tool') return 'low';
    return 'medium';
  }
  
  private summarizeToolResult(content: string): string {
    // Truncate long tool outputs
    if (content.length > 2000) {
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          return JSON.stringify({
            _summary: `Array with ${parsed.length} items`,
            firstItem: parsed[0],
            lastItem: parsed[parsed.length - 1],
          });
        }
        // Keep keys but truncate deep values
        const summarized: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(parsed)) {
          const str = JSON.stringify(value);
          summarized[key] = str.length > 200
            ? `[${typeof value}: ${str.length} chars]`
            : value;
        }
        return JSON.stringify(summarized);
      } catch {
        return content.slice(0, 500) + '\n...[truncated]';
      }
    }
    return content;
  }
  
  private summarizeDropped(messages: Message[]): string {
    const userMsgs = messages.filter(m => m.role === 'user');
    const toolCalls = messages.filter(m => m.role === 'tool');
    return `${userMsgs.length} user messages, ${toolCalls.length} tool calls. Topics: ${
      userMsgs.map(m => m.content.slice(0, 50)).join('; ')
    }`;
  }
}
```

---

## Long-Term Memory (Vector DB)

Long-term memory lets your agent store and retrieve information across sessions. The key technology here is **vector embeddings** — converting text into numerical vectors and finding similar items via cosine similarity.

We'll use SQLite as the storage backend (zero infrastructure) and a simple embedding approach.

### Implementation

```typescript
import Database from 'better-sqlite3';
import { createHash } from 'crypto';

interface MemoryEntry {
  id: string;
  content: string;
  embedding: number[];
  metadata: {
    type: 'fact' | 'preference' | 'procedure' | 'entity';
    source: string;
    createdAt: number;
    accessCount: number;
    lastAccessed: number;
    importance: number; // 0-1
  };
}

interface SearchResult {
  entry: MemoryEntry;
  similarity: number;
}

class LongTermMemory {
  private db: Database.Database;
  private embeddingDimension: number;
  
  constructor(dbPath: string, embeddingDimension: number = 384) {
    this.db = new Database(dbPath);
    this.embeddingDimension = embeddingDimension;
    this.initialize();
  }
  
  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        access_count INTEGER DEFAULT 0,
        last_accessed INTEGER NOT NULL,
        importance REAL DEFAULT 0.5
      );
      
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed DESC);
    `);
  }
  
  /** Store a new memory */
  async store(
    content: string,
    type: MemoryEntry['metadata']['type'],
    source: string,
    importance: number = 0.5,
  ): Promise<string> {
    const id = createHash('sha256')
      .update(content)
      .digest('hex')
      .slice(0, 16);
    
    const embedding = await this.getEmbedding(content);
    
    this.db.prepare(`
      INSERT OR REPLACE INTO memories (id, content, embedding, type, source, created_at, last_accessed, importance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      content,
      Buffer.from(new Float32Array(embedding).buffer),
      type,
      source,
      Date.now(),
      Date.now(),
      importance,
    );
    
    return id;
  }
  
  /** Search memories by semantic similarity */
  async search(
    query: string,
    options: {
      limit?: number;
      type?: MemoryEntry['metadata']['type'];
      minSimilarity?: number;
    } = {},
  ): Promise<SearchResult[]> {
    const { limit = 10, type, minSimilarity = 0.3 } = options;
    
    const queryEmbedding = await this.getEmbedding(query);
    
    // Fetch candidates
    let sql = 'SELECT * FROM memories';
    const params: unknown[] = [];
    
    if (type) {
      sql += ' WHERE type = ?';
      params.push(type);
    }
    
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      content: string;
      embedding: Buffer;
      type: string;
      source: string;
      created_at: number;
      access_count: number;
      last_accessed: number;
      importance: number;
    }>;
    
    // Calculate cosine similarity for each
    const results: SearchResult[] = rows
      .map(row => {
        const storedEmbedding = Array.from(new Float32Array(row.embedding.buffer));
        const similarity = cosineSimilarity(queryEmbedding, storedEmbedding);
        
        // Boost by importance and recency
        const recencyBoost = Math.max(0, 1 - (Date.now() - row.last_accessed) / (30 * 24 * 60 * 60 * 1000)); // Decay over 30 days
        const boostedSimilarity = similarity * 0.7 + row.importance * 0.2 + recencyBoost * 0.1;
        
        return {
          entry: {
            id: row.id,
            content: row.content,
            embedding: storedEmbedding,
            metadata: {
              type: row.type as MemoryEntry['metadata']['type'],
              source: row.source,
              createdAt: row.created_at,
              accessCount: row.access_count,
              lastAccessed: row.last_accessed,
              importance: row.importance,
            },
          },
          similarity: boostedSimilarity,
        };
      })
      .filter(r => r.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
    
    // Update access counts
    const updateStmt = this.db.prepare(
      'UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?'
    );
    
    for (const result of results) {
      updateStmt.run(Date.now(), result.entry.id);
    }
    
    return results;
  }
  
  /** Delete a specific memory */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return result.changes > 0;
  }
  
  /** Get all memories of a certain type */
  getByType(type: MemoryEntry['metadata']['type']): MemoryEntry[] {
    const rows = this.db.prepare('SELECT * FROM memories WHERE type = ? ORDER BY importance DESC')
      .all(type) as any[];
    
    return rows.map(row => ({
      id: row.id,
      content: row.content,
      embedding: Array.from(new Float32Array(row.embedding.buffer)),
      metadata: {
        type: row.type,
        source: row.source,
        createdAt: row.created_at,
        accessCount: row.access_count,
        lastAccessed: row.last_accessed,
        importance: row.importance,
      },
    }));
  }
  
  /** Decay old, rarely accessed memories */
  decay(maxAge: number = 90 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    const result = this.db.prepare(
      'DELETE FROM memories WHERE last_accessed < ? AND importance < 0.8 AND access_count < 3'
    ).run(cutoff);
    return result.changes;
  }
  
  /** Get embedding using OpenAI API or local model */
  private async getEmbedding(text: string): Promise<number[]> {
    // Option 1: OpenAI embeddings (best quality)
    if (process.env.OPENAI_API_KEY) {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: text,
          dimensions: this.embeddingDimension,
        }),
      });
      
      const data = await response.json();
      return data.data[0].embedding;
    }
    
    // Option 2: Simple local embedding (no API needed)
    // Uses a hash-based approach — less accurate but zero cost
    return this.localEmbedding(text);
  }
  
  /** 
   * A simple local embedding function.
   * Not as good as proper embeddings, but works offline with zero cost.
   * Uses character n-gram hashing projected to a fixed dimension.
   */
  private localEmbedding(text: string): number[] {
    const normalized = text.toLowerCase().trim();
    const embedding = new Float32Array(this.embeddingDimension);
    
    // Character trigram hashing
    for (let i = 0; i < normalized.length - 2; i++) {
      const trigram = normalized.slice(i, i + 3);
      const hash = this.simpleHash(trigram);
      const index = Math.abs(hash) % this.embeddingDimension;
      embedding[index] += hash > 0 ? 1 : -1;
    }
    
    // Word-level features
    const words = normalized.split(/\s+/);
    for (const word of words) {
      const hash = this.simpleHash(word);
      const index = Math.abs(hash) % this.embeddingDimension;
      embedding[index] += (hash > 0 ? 1 : -1) * 2; // Words weighted more
    }
    
    // Normalize to unit vector
    const magnitude = Math.sqrt(
      embedding.reduce((sum, val) => sum + val * val, 0)
    );
    
    if (magnitude > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= magnitude;
      }
    }
    
    return Array.from(embedding);
  }
  
  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash;
  }
  
  close(): void {
    this.db.close();
  }
}

/** Cosine similarity between two vectors */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('Vector length mismatch');
  
  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }
  
  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);
  
  if (magnitudeA === 0 || magnitudeB === 0) return 0;
  
  return dotProduct / (magnitudeA * magnitudeB);
}
```

### Usage Example

```typescript
const memory = new LongTermMemory('./agent-memory.db');

// Store some memories
await memory.store(
  'User prefers TypeScript over Python',
  'preference',
  'conversation-2024-01-15',
  0.9,
);

await memory.store(
  'The project uses PostgreSQL on port 5432 with database name "myapp"',
  'fact',
  'conversation-2024-01-15',
  0.8,
);

await memory.store(
  'To deploy, run: docker compose up -d && ./scripts/migrate.sh',
  'procedure',
  'conversation-2024-01-16',
  0.7,
);

// Search
const results = await memory.search('How do I deploy?');
// Returns the deployment procedure with high similarity

const prefs = await memory.search('What language does the user like?', { type: 'preference' });
// Returns the TypeScript preference
```

---

## Episodic Memory (Session Logs)

Episodic memory records **what happened** — full session transcripts with summaries. This lets the agent reference past interactions: "Last time we worked on this, you said..."

### Implementation

```typescript
import Database from 'better-sqlite3';

interface Episode {
  id: string;
  sessionId: string;
  summary: string;
  messages: Message[];
  startedAt: number;
  endedAt: number;
  metadata: {
    userGoal?: string;
    outcome: 'success' | 'partial' | 'failed' | 'abandoned';
    toolsUsed: string[];
    topicsDiscussed: string[];
    lessonsLearned?: string[];
  };
}

class EpisodicMemory {
  private db: Database.Database;
  
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initialize();
  }
  
  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        messages TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        user_goal TEXT,
        outcome TEXT NOT NULL,
        tools_used TEXT NOT NULL,
        topics TEXT NOT NULL,
        lessons TEXT
      );
      
      CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);
      CREATE INDEX IF NOT EXISTS idx_episodes_time ON episodes(started_at DESC);
    `);
  }
  
  /** Save a completed session as an episode */
  async saveEpisode(
    sessionId: string,
    messages: Message[],
    llm: LLMClient,
  ): Promise<string> {
    // Use LLM to generate episode summary
    const summaryResponse = await llm.complete({
      messages: [
        {
          role: 'system',
          content: `Summarize this conversation session. Return JSON:
{
  "summary": "2-3 sentence summary of what happened",
  "userGoal": "what the user was trying to accomplish",
  "outcome": "success|partial|failed|abandoned",
  "toolsUsed": ["tool1", "tool2"],
  "topicsDiscussed": ["topic1", "topic2"],
  "lessonsLearned": ["lesson1"]
}`,
        },
        {
          role: 'user',
          content: JSON.stringify(messages.map(m => ({
            role: m.role,
            content: m.content.slice(0, 500),
          }))),
        },
      ],
      responseFormat: { type: 'json_object' },
    });
    
    const meta = JSON.parse(summaryResponse);
    const id = `ep_${sessionId}_${Date.now()}`;
    
    this.db.prepare(`
      INSERT INTO episodes (id, session_id, summary, messages, started_at, ended_at, user_goal, outcome, tools_used, topics, lessons)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sessionId,
      meta.summary,
      JSON.stringify(messages),
      messages[0]?.timestamp ?? Date.now(),
      messages[messages.length - 1]?.timestamp ?? Date.now(),
      meta.userGoal ?? null,
      meta.outcome,
      JSON.stringify(meta.toolsUsed ?? []),
      JSON.stringify(meta.topicsDiscussed ?? []),
      JSON.stringify(meta.lessonsLearned ?? []),
    );
    
    return id;
  }
  
  /** Get recent episodes */
  getRecent(limit: number = 10): Episode[] {
    const rows = this.db.prepare(
      'SELECT * FROM episodes ORDER BY started_at DESC LIMIT ?'
    ).all(limit) as any[];
    
    return rows.map(this.rowToEpisode);
  }
  
  /** Search episodes by topic or content */
  searchEpisodes(query: string, limit: number = 5): Episode[] {
    // SQLite FTS would be better, but this works for moderate data
    const rows = this.db.prepare(`
      SELECT * FROM episodes 
      WHERE summary LIKE ? OR topics LIKE ? OR user_goal LIKE ?
      ORDER BY started_at DESC 
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit) as any[];
    
    return rows.map(this.rowToEpisode);
  }
  
  /** Get episodes where a specific tool was used */
  getByTool(toolName: string): Episode[] {
    const rows = this.db.prepare(
      "SELECT * FROM episodes WHERE tools_used LIKE ? ORDER BY started_at DESC"
    ).all(`%${toolName}%`) as any[];
    
    return rows.map(this.rowToEpisode);
  }
  
  /** Get all lessons learned */
  getLessons(): string[] {
    const rows = this.db.prepare(
      "SELECT lessons FROM episodes WHERE lessons IS NOT NULL AND lessons != '[]'"
    ).all() as Array<{ lessons: string }>;
    
    const allLessons: string[] = [];
    for (const row of rows) {
      const lessons = JSON.parse(row.lessons);
      allLessons.push(...lessons);
    }
    return [...new Set(allLessons)]; // Deduplicate
  }
  
  private rowToEpisode(row: any): Episode {
    return {
      id: row.id,
      sessionId: row.session_id,
      summary: row.summary,
      messages: JSON.parse(row.messages),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      metadata: {
        userGoal: row.user_goal,
        outcome: row.outcome,
        toolsUsed: JSON.parse(row.tools_used),
        topicsDiscussed: JSON.parse(row.topics),
        lessonsLearned: row.lessons ? JSON.parse(row.lessons) : undefined,
      },
    };
  }
  
  close(): void {
    this.db.close();
  }
}
```

---

## Putting It All Together

Here's how all three memory types work together in an agent:

```typescript
class AgentMemory {
  shortTerm: ShortTermMemory;
  longTerm: LongTermMemory;
  episodic: EpisodicMemory;
  
  constructor(
    systemPrompt: string,
    dataDir: string,
  ) {
    this.shortTerm = new ShortTermMemory(systemPrompt);
    this.longTerm = new LongTermMemory(`${dataDir}/long-term.db`);
    this.episodic = new EpisodicMemory(`${dataDir}/episodes.db`);
  }
  
  /** Build the full context for the LLM */
  async buildContext(userMessage: string): Promise<Message[]> {
    // 1. Search long-term memory for relevant facts
    const relevantMemories = await this.longTerm.search(userMessage, { limit: 5 });
    
    // 2. Search episodic memory for relevant past sessions
    const relevantEpisodes = this.episodic.searchEpisodes(userMessage, 3);
    
    // 3. Build a context injection
    let contextInjection = '';
    
    if (relevantMemories.length > 0) {
      contextInjection += '\n\n## Relevant Information from Memory\n';
      for (const mem of relevantMemories) {
        contextInjection += `- [${mem.entry.metadata.type}] ${mem.entry.content}\n`;
      }
    }
    
    if (relevantEpisodes.length > 0) {
      contextInjection += '\n\n## Relevant Past Sessions\n';
      for (const ep of relevantEpisodes) {
        const date = new Date(ep.startedAt).toLocaleDateString();
        contextInjection += `- [${date}] ${ep.summary} (outcome: ${ep.metadata.outcome})\n`;
      }
    }
    
    // Get all accumulated lessons
    const lessons = this.episodic.getLessons();
    if (lessons.length > 0) {
      contextInjection += '\n\n## Lessons Learned\n';
      for (const lesson of lessons.slice(-10)) { // Last 10 lessons
        contextInjection += `- ${lesson}\n`;
      }
    }
    
    // 4. Inject context into the system prompt
    if (contextInjection) {
      // Add as a system message right after the original system prompt
      const messages = this.shortTerm.getForAPI();
      messages.splice(1, 0, {
        role: 'system',
        content: `Context from your memory:${contextInjection}`,
      });
      return messages as Message[];
    }
    
    return this.shortTerm.getMessages();
  }
  
  /** After the agent responds, extract and store new information */
  async processResponse(
    userMessage: string,
    assistantMessage: string,
    llm: LLMClient,
  ): Promise<void> {
    // Use LLM to extract facts worth remembering
    const extractResponse = await llm.complete({
      messages: [
        {
          role: 'system',
          content: `Analyze this conversation exchange. Extract any facts, preferences, or 
procedures worth remembering for future sessions.

Return JSON:
{
  "memories": [
    { "content": "the fact/preference/procedure", "type": "fact|preference|procedure", "importance": 0.0-1.0 }
  ]
}

Return empty memories array if nothing is worth storing.
Be selective — only store genuinely useful information.`,
        },
        {
          role: 'user',
          content: `User said: ${userMessage}\n\nAssistant responded: ${assistantMessage.slice(0, 2000)}`,
        },
      ],
      responseFormat: { type: 'json_object' },
    });
    
    const extracted = JSON.parse(extractResponse);
    
    for (const mem of extracted.memories ?? []) {
      await this.longTerm.store(
        mem.content,
        mem.type,
        `conversation-${new Date().toISOString().split('T')[0]}`,
        mem.importance,
      );
    }
  }
  
  /** Save the current session as an episode (call when session ends) */
  async endSession(sessionId: string, llm: LLMClient): Promise<void> {
    const messages = this.shortTerm.getMessages();
    if (messages.length > 2) { // More than just system + one user message
      await this.episodic.saveEpisode(sessionId, messages, llm);
    }
  }
  
  /** Periodic maintenance */
  async maintenance(): Promise<{ decayed: number }> {
    const decayed = this.longTerm.decay();
    return { decayed };
  }
  
  close(): void {
    this.longTerm.close();
    this.episodic.close();
  }
}
```

### Using It in Your Agent

```typescript
async function main() {
  const memory = new AgentMemory(
    'You are a helpful AI assistant with memory of past interactions.',
    './data',
  );
  
  const sessionId = `session_${Date.now()}`;
  
  // Agent loop
  while (true) {
    const userInput = await getUserInput();
    if (userInput === 'exit') break;
    
    // Add to short-term memory
    memory.shortTerm.add({ role: 'user', content: userInput });
    
    // Build context with all memory types
    const context = await memory.buildContext(userInput);
    
    // Get LLM response
    const response = await llm.complete({ messages: context });
    
    // Add response to short-term memory
    memory.shortTerm.add({ role: 'assistant', content: response });
    
    // Extract and store long-term memories (async, don't block)
    memory.processResponse(userInput, response, llm).catch(console.error);
    
    console.log(response);
  }
  
  // Save session as episode
  await memory.endSession(sessionId, llm);
  memory.close();
}
```

---

## Memory Management Strategies

### 1. Importance Scoring

Not all information is worth remembering. Score importance based on:

```typescript
function scoreImportance(content: string, context: string): number {
  let score = 0.5; // Base score
  
  // Explicit preferences are high importance
  if (/prefer|always|never|like|hate|want/i.test(content)) score += 0.2;
  
  // Procedures and how-tos are valuable
  if (/step|process|how to|guide|command/i.test(content)) score += 0.15;
  
  // Names, credentials, config are important
  if (/password|key|secret|name|email|url|port/i.test(content)) score += 0.2;
  
  // Corrections are very important (learning from mistakes)
  if (/actually|correction|wrong|mistake|instead/i.test(content)) score += 0.25;
  
  return Math.min(score, 1.0);
}
```

### 2. Forgetting Curve

Memories that aren't accessed should decay over time:

```typescript
function shouldForget(memory: MemoryEntry): boolean {
  const daysSinceAccess = (Date.now() - memory.metadata.lastAccessed) / (24 * 60 * 60 * 1000);
  const accessFrequency = memory.metadata.accessCount / daysSinceAccess;
  
  // High importance memories decay slower
  const decayRate = 1 - memory.metadata.importance;
  const retention = Math.exp(-decayRate * daysSinceAccess / 30);
  
  // Frequently accessed memories are retained
  const accessBoost = Math.min(accessFrequency * 0.1, 0.5);
  
  return (retention + accessBoost) < 0.2;
}
```

### 3. Deduplication

Prevent storing the same fact multiple times:

```typescript
async function storeIfNew(
  memory: LongTermMemory,
  content: string,
  type: MemoryEntry['metadata']['type'],
  source: string,
): Promise<boolean> {
  // Check for duplicates
  const existing = await memory.search(content, { limit: 1, minSimilarity: 0.85 });
  
  if (existing.length > 0) {
    // Update the existing memory instead
    // (boost its importance and reset access time)
    return false;
  }
  
  await memory.store(content, type, source);
  return true;
}
```

---

## Key Takeaways

1. **Short-term memory** is your conversation buffer — manage its size or you'll blow context windows
2. **Long-term memory** (vector search) lets agents learn across sessions — even a simple implementation adds massive value
3. **Episodic memory** gives agents autobiographical context — "we tried this before and it failed"
4. **The local embedding fallback** means you can have working memory with zero API costs
5. **Forgetting is a feature** — decay old, unimportant memories to keep the system fast and relevant
6. **Extract memories asynchronously** — don't block the conversation to store knowledge

---

**Next:** [Chapter 4 — Deployment →](./04-deployment.md)
