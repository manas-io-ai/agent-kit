# Chapter 2: Building a Tool System

> Tools are the hands of an AI agent. Without them, it can only talk. With them, it can *do*.

A tool system is the infrastructure that lets an LLM call functions in your codebase. This chapter shows you how to build one that's robust, extensible, and production-ready.

---

## Table of Contents

1. [Tool System Architecture](#tool-system-architecture)
2. [Core Interfaces](#core-interfaces)
3. [The Tool Registry](#the-tool-registry)
4. [Input Validation](#input-validation)
5. [Error Handling](#error-handling)
6. [5 Working Tool Implementations](#5-working-tool-implementations)
7. [Timeout & Resource Limits](#timeout--resource-limits)
8. [Testing Tools](#testing-tools)

---

## Tool System Architecture

```
LLM Response (tool_call)
        │
        ▼
┌──────────────┐
│  Tool Router  │ ← Looks up tool by name
└──────┬───────┘
       ▼
┌──────────────┐
│  Validator    │ ← Validates input against schema
└──────┬───────┘
       ▼
┌──────────────┐
│  Rate Limiter │ ← Prevents abuse
└──────┬───────┘
       ▼
┌──────────────┐
│  Executor     │ ← Runs the tool with timeout
└──────┬───────┘
       ▼
┌──────────────┐
│  Formatter    │ ← Formats result for LLM
└──────────────┘
```

## Core Interfaces

```typescript
import { z, ZodSchema } from 'zod';

// The core tool interface
interface Tool<TInput = unknown, TOutput = unknown> {
  /** Unique tool name (used in function calling) */
  name: string;
  
  /** Human-readable description (sent to the LLM) */
  description: string;
  
  /** Zod schema for input validation */
  inputSchema: ZodSchema<TInput>;
  
  /** JSON Schema version (auto-generated from Zod for the LLM API) */
  parametersJsonSchema: Record<string, unknown>;
  
  /** The actual implementation */
  execute: (input: TInput, context: ToolContext) => Promise<ToolResult<TOutput>>;
  
  /** Optional: estimated cost per invocation */
  estimatedCostCents?: number;
  
  /** Optional: rate limit (calls per minute) */
  rateLimit?: number;
  
  /** Optional: timeout in milliseconds */
  timeoutMs?: number;
  
  /** Optional: requires confirmation from user before executing */
  requiresConfirmation?: boolean;
}

interface ToolContext {
  /** Unique ID for this agent session */
  sessionId: string;
  
  /** Working directory for file operations */
  workingDirectory: string;
  
  /** Abort signal for cancellation */
  abortSignal: AbortSignal;
  
  /** Logger instance */
  logger: Logger;
  
  /** Environment variables available to tools */
  env: Record<string, string>;
}

interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  
  /** Metadata the LLM doesn't see but we log */
  metadata?: {
    durationMs: number;
    tokensUsed?: number;
    cached?: boolean;
  };
}

// Helper to create tools with full type safety
function defineTool<TInput, TOutput>(config: Tool<TInput, TOutput>): Tool<TInput, TOutput> {
  return config;
}
```

## The Tool Registry

```typescript
import { zodToJsonSchema } from 'zod-to-json-schema';

class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private callCounts: Map<string, { count: number; windowStart: number }> = new Map();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    
    // Auto-generate JSON Schema from Zod schema if not provided
    if (!tool.parametersJsonSchema) {
      tool.parametersJsonSchema = zodToJsonSchema(tool.inputSchema);
    }
    
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Get all tool definitions formatted for the LLM API */
  getDefinitions(): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }> {
    return Array.from(this.tools.values()).map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parametersJsonSchema,
      },
    }));
  }

  /** Execute a tool with full validation, rate limiting, and error handling */
  async execute(
    name: string,
    rawInput: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: `Unknown tool: ${name}` };
    }

    // Rate limiting
    if (tool.rateLimit) {
      if (!this.checkRateLimit(name, tool.rateLimit)) {
        return { success: false, error: `Rate limit exceeded for ${name}` };
      }
    }

    // Input validation
    const parseResult = tool.inputSchema.safeParse(rawInput);
    if (!parseResult.success) {
      const errors = parseResult.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid input: ${errors}` };
    }

    // Execution with timeout
    const timeoutMs = tool.timeoutMs ?? 30_000;
    const startTime = Date.now();

    try {
      const result = await Promise.race([
        tool.execute(parseResult.data, context),
        new Promise<ToolResult>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool "${name}" timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);

      // Attach duration metadata
      result.metadata = {
        ...result.metadata,
        durationMs: Date.now() - startTime,
      };

      context.logger.info(`Tool ${name} completed`, {
        success: result.success,
        durationMs: result.metadata.durationMs,
      });

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      context.logger.error(`Tool ${name} failed`, { error, durationMs });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown execution error',
        metadata: { durationMs },
      };
    }
  }

  private checkRateLimit(toolName: string, maxPerMinute: number): boolean {
    const now = Date.now();
    const entry = this.callCounts.get(toolName);

    if (!entry || now - entry.windowStart > 60_000) {
      this.callCounts.set(toolName, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= maxPerMinute) {
      return false;
    }

    entry.count++;
    return true;
  }
}
```

## Input Validation

Always validate tool inputs. LLMs can hallucinate parameter values, pass wrong types, or inject unexpected data.

```typescript
import { z } from 'zod';

// Example: A file read tool with strict path validation
const fileReadSchema = z.object({
  path: z.string()
    .min(1, 'Path cannot be empty')
    .refine(
      (p) => !p.includes('..'),
      'Path traversal not allowed'
    )
    .refine(
      (p) => p.startsWith('/workspace/') || !p.startsWith('/'),
      'Absolute paths must be within /workspace/'
    ),
  encoding: z.enum(['utf-8', 'base64']).default('utf-8'),
  maxBytes: z.number().int().positive().max(10_000_000).default(1_000_000),
});

// Example: A web search tool with query sanitization
const webSearchSchema = z.object({
  query: z.string()
    .min(1, 'Query cannot be empty')
    .max(500, 'Query too long')
    .transform(q => q.trim()),
  maxResults: z.number().int().min(1).max(10).default(5),
  freshness: z.enum(['day', 'week', 'month', 'any']).default('any'),
});

// Example: A database query tool with SQL injection prevention
const databaseQuerySchema = z.object({
  query: z.string()
    .min(1)
    .refine(
      (q) => {
        const lower = q.toLowerCase().trim();
        // Only allow SELECT statements
        return lower.startsWith('select');
      },
      'Only SELECT queries are allowed'
    )
    .refine(
      (q) => {
        const lower = q.toLowerCase();
        // Block dangerous operations
        const blocked = ['drop', 'delete', 'update', 'insert', 'alter', 'exec', 'execute'];
        return !blocked.some(word => lower.includes(word));
      },
      'Query contains blocked operations'
    ),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).default([]),
  database: z.string().default('default'),
});
```

## Error Handling

Tools fail. Networks go down, APIs rate-limit, files don't exist. Your tool system must handle this gracefully.

```typescript
// Custom error types for tools
class ToolError extends Error {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly retryable: boolean = false,
    public readonly userMessage?: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

class ToolTimeoutError extends ToolError {
  constructor(toolName: string, timeoutMs: number) {
    super(
      `Tool "${toolName}" timed out after ${timeoutMs}ms`,
      toolName,
      true, // timeouts are retryable
      `The operation timed out. Try again or simplify the request.`,
    );
  }
}

class ToolRateLimitError extends ToolError {
  constructor(toolName: string, public readonly retryAfterMs: number) {
    super(
      `Rate limit exceeded for "${toolName}"`,
      toolName,
      true,
      `Rate limit hit. Please wait a moment.`,
    );
  }
}

// Retry wrapper with exponential backoff
async function executeWithRetry(
  tool: Tool,
  input: unknown,
  context: ToolContext,
  maxRetries: number = 3,
): Promise<ToolResult> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await tool.execute(input, context);
      
      if (result.success || !isRetryable(result.error)) {
        return result;
      }
      
      lastError = new Error(result.error);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (error instanceof ToolError && !error.retryable) {
        return { success: false, error: error.userMessage ?? error.message };
      }
    }

    // Exponential backoff: 1s, 2s, 4s
    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 1000;
      context.logger.warn(`Retrying ${tool.name} in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return {
    success: false,
    error: `Failed after ${maxRetries + 1} attempts: ${lastError?.message}`,
  };
}

function isRetryable(error?: string): boolean {
  if (!error) return false;
  const retryablePatterns = [
    'timeout', 'rate limit', 'ECONNRESET', 'ENOTFOUND',
    '429', '503', '502', 'network',
  ];
  const lower = error.toLowerCase();
  return retryablePatterns.some(p => lower.includes(p));
}
```

---

## 5 Working Tool Implementations

### Tool 1: `web_search`

```typescript
import { z } from 'zod';

const webSearchTool = defineTool({
  name: 'web_search',
  description: 'Search the web for current information. Returns titles, URLs, and snippets.',
  
  inputSchema: z.object({
    query: z.string().min(1).max(500).describe('Search query'),
    maxResults: z.number().int().min(1).max(10).default(5)
      .describe('Number of results to return'),
  }),
  
  parametersJsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'number', description: 'Number of results (1-10)' },
    },
    required: ['query'],
  },
  
  rateLimit: 30, // 30 calls per minute
  timeoutMs: 10_000,
  
  async execute(input, context) {
    const { query, maxResults } = input;
    
    // Using Brave Search API (free tier: 2000 queries/month)
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(maxResults));
    
    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': context.env.BRAVE_API_KEY ?? '',
      },
      signal: context.abortSignal,
    });
    
    if (!response.ok) {
      if (response.status === 429) {
        return { success: false, error: 'Rate limit exceeded. Try again later.' };
      }
      return { success: false, error: `Search API returned ${response.status}` };
    }
    
    const data = await response.json();
    
    const results = (data.web?.results ?? []).map((r: any) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    }));
    
    return {
      success: true,
      data: {
        query,
        results,
        totalEstimated: data.web?.totalEstimatedMatches ?? 0,
      },
    };
  },
});
```

### Tool 2: `file_read`

```typescript
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

const fileReadTool = defineTool({
  name: 'file_read',
  description: 'Read the contents of a file. Supports text files. Returns the file content as a string.',
  
  inputSchema: z.object({
    path: z.string().min(1).describe('Path to the file (relative to working directory)'),
    encoding: z.enum(['utf-8', 'base64']).default('utf-8').describe('File encoding'),
    maxLines: z.number().int().positive().max(10000).optional()
      .describe('Maximum number of lines to read'),
    offset: z.number().int().min(0).default(0)
      .describe('Line number to start reading from (0-indexed)'),
  }),
  
  parametersJsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      encoding: { type: 'string', enum: ['utf-8', 'base64'], description: 'Encoding' },
      maxLines: { type: 'number', description: 'Max lines to read' },
      offset: { type: 'number', description: 'Starting line number' },
    },
    required: ['path'],
  },
  
  timeoutMs: 5_000,
  
  async execute(input, context) {
    // Resolve path relative to working directory
    const resolvedPath = path.resolve(context.workingDirectory, input.path);
    
    // Security: ensure the path is within the working directory
    if (!resolvedPath.startsWith(context.workingDirectory)) {
      return { success: false, error: 'Access denied: path is outside working directory' };
    }
    
    try {
      const stat = await fs.stat(resolvedPath);
      
      if (!stat.isFile()) {
        return { success: false, error: 'Path is not a file' };
      }
      
      // Limit file size to 10MB
      if (stat.size > 10 * 1024 * 1024) {
        return { success: false, error: 'File exceeds 10MB size limit' };
      }
      
      let content = await fs.readFile(resolvedPath, input.encoding === 'base64' ? 'base64' : 'utf-8');
      
      // Apply line filtering
      if (input.maxLines || input.offset > 0) {
        const lines = (content as string).split('\n');
        const sliced = lines.slice(input.offset, input.maxLines ? input.offset + input.maxLines : undefined);
        content = sliced.join('\n');
      }
      
      return {
        success: true,
        data: {
          path: input.path,
          content,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        },
      };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return { success: false, error: `File not found: ${input.path}` };
      }
      if (error.code === 'EACCES') {
        return { success: false, error: `Permission denied: ${input.path}` };
      }
      return { success: false, error: `Failed to read file: ${error.message}` };
    }
  },
});
```

### Tool 3: `code_execute`

```typescript
import { z } from 'zod';
import { spawn } from 'child_process';

const codeExecuteTool = defineTool({
  name: 'code_execute',
  description: 'Execute JavaScript/TypeScript code in a sandboxed Node.js environment. Returns stdout, stderr, and exit code.',
  
  inputSchema: z.object({
    code: z.string().min(1).max(50_000).describe('JavaScript or TypeScript code to execute'),
    language: z.enum(['javascript', 'typescript']).default('javascript')
      .describe('Programming language'),
    timeoutSeconds: z.number().min(1).max(30).default(10)
      .describe('Execution timeout in seconds'),
  }),
  
  parametersJsonSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Code to execute' },
      language: { type: 'string', enum: ['javascript', 'typescript'] },
      timeoutSeconds: { type: 'number', description: 'Timeout in seconds (max 30)' },
    },
    required: ['code'],
  },
  
  requiresConfirmation: true, // Always confirm before running code
  timeoutMs: 35_000,
  
  async execute(input, context) {
    const { code, language, timeoutSeconds } = input;
    
    return new Promise((resolve) => {
      const runtime = language === 'typescript' ? 'npx' : 'node';
      const args = language === 'typescript'
        ? ['tsx', '--eval', code]
        : ['--eval', code];
      
      const proc = spawn(runtime, args, {
        cwd: context.workingDirectory,
        timeout: timeoutSeconds * 1000,
        env: {
          ...process.env,
          NODE_ENV: 'sandbox',
          // Remove sensitive env vars
          OPENAI_API_KEY: '',
          DATABASE_URL: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > 100_000) {
          proc.kill();
          stdout = stdout.slice(0, 100_000) + '\n...[truncated]';
        }
      });
      
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
        if (stderr.length > 50_000) {
          stderr = stderr.slice(0, 50_000) + '\n...[truncated]';
        }
      });
      
      proc.on('close', (exitCode) => {
        resolve({
          success: exitCode === 0,
          data: {
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: exitCode ?? -1,
          },
          error: exitCode !== 0 ? `Process exited with code ${exitCode}` : undefined,
        });
      });
      
      proc.on('error', (error) => {
        resolve({
          success: false,
          error: `Failed to spawn process: ${error.message}`,
        });
      });
    });
  },
});
```

### Tool 4: `api_call`

```typescript
import { z } from 'zod';

const apiCallTool = defineTool({
  name: 'api_call',
  description: 'Make an HTTP API call. Supports GET, POST, PUT, PATCH, DELETE. Returns status code, headers, and body.',
  
  inputSchema: z.object({
    url: z.string().url().describe('Full URL to call'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET')
      .describe('HTTP method'),
    headers: z.record(z.string()).optional()
      .describe('Request headers as key-value pairs'),
    body: z.union([z.string(), z.record(z.unknown())]).optional()
      .describe('Request body (string or JSON object)'),
    timeoutSeconds: z.number().min(1).max(30).default(10)
      .describe('Request timeout in seconds'),
  }),
  
  parametersJsonSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to call' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      headers: { type: 'object', description: 'Request headers' },
      body: { description: 'Request body' },
      timeoutSeconds: { type: 'number', description: 'Timeout in seconds' },
    },
    required: ['url'],
  },
  
  rateLimit: 60,
  timeoutMs: 35_000,
  
  async execute(input, context) {
    const { url, method, headers, body, timeoutSeconds } = input;
    
    // Security: block internal network requests
    const parsedUrl = new URL(url);
    const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254'];
    if (blockedHosts.includes(parsedUrl.hostname) || parsedUrl.hostname.startsWith('10.') || parsedUrl.hostname.startsWith('192.168.')) {
      return { success: false, error: 'Access to internal network addresses is blocked' };
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    
    try {
      const requestBody = body
        ? typeof body === 'string'
          ? body
          : JSON.stringify(body)
        : undefined;
      
      const defaultHeaders: Record<string, string> = {};
      if (requestBody && typeof body === 'object') {
        defaultHeaders['Content-Type'] = 'application/json';
      }
      
      const response = await fetch(url, {
        method,
        headers: { ...defaultHeaders, ...headers },
        body: requestBody,
        signal: controller.signal,
      });
      
      // Read response (limit to 1MB)
      const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10);
      if (contentLength > 1_000_000) {
        return {
          success: true,
          data: {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers),
            body: '[Response too large - exceeded 1MB limit]',
            truncated: true,
          },
        };
      }
      
      const contentType = response.headers.get('content-type') ?? '';
      let responseBody: unknown;
      
      if (contentType.includes('application/json')) {
        responseBody = await response.json();
      } else {
        const text = await response.text();
        responseBody = text.length > 100_000
          ? text.slice(0, 100_000) + '\n...[truncated]'
          : text;
      }
      
      return {
        success: response.ok,
        data: {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers),
          body: responseBody,
        },
        error: response.ok ? undefined : `HTTP ${response.status}: ${response.statusText}`,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return { success: false, error: `Request timed out after ${timeoutSeconds}s` };
      }
      return { success: false, error: `Request failed: ${error.message}` };
    } finally {
      clearTimeout(timeout);
    }
  },
});
```

### Tool 5: `database_query`

```typescript
import { z } from 'zod';
import Database from 'better-sqlite3';

// Connection pool for SQLite databases
const dbConnections: Map<string, Database.Database> = new Map();

function getConnection(dbPath: string): Database.Database {
  let db = dbConnections.get(dbPath);
  if (!db) {
    db = new Database(dbPath, { readonly: true }); // Read-only for safety
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    dbConnections.set(dbPath, db);
  }
  return db;
}

const databaseQueryTool = defineTool({
  name: 'database_query',
  description: 'Execute a read-only SQL query against a SQLite database. Only SELECT statements are allowed.',
  
  inputSchema: z.object({
    query: z.string()
      .min(1)
      .max(5000)
      .refine(q => q.trim().toLowerCase().startsWith('select'), 'Only SELECT queries are allowed')
      .describe('SQL SELECT query'),
    params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).default([])
      .describe('Query parameters (for prepared statements)'),
    database: z.string().default('default.db')
      .describe('Database file name'),
    limit: z.number().int().min(1).max(1000).default(100)
      .describe('Maximum number of rows to return'),
  }),
  
  parametersJsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'SQL SELECT query' },
      params: { type: 'array', items: {}, description: 'Query parameters' },
      database: { type: 'string', description: 'Database file name' },
      limit: { type: 'number', description: 'Max rows (default 100)' },
    },
    required: ['query'],
  },
  
  timeoutMs: 10_000,
  
  async execute(input, context) {
    const { query, params, database, limit } = input;
    
    const dbPath = path.resolve(context.workingDirectory, 'data', database);
    
    // Security: ensure database is within working directory
    if (!dbPath.startsWith(path.resolve(context.workingDirectory))) {
      return { success: false, error: 'Database path outside working directory' };
    }
    
    try {
      const db = getConnection(dbPath);
      
      // Add LIMIT if not already present
      let limitedQuery = query;
      if (!query.toLowerCase().includes('limit')) {
        limitedQuery = `${query} LIMIT ${limit}`;
      }
      
      const stmt = db.prepare(limitedQuery);
      const rows = stmt.all(...params);
      
      // Get column names
      const columns = rows.length > 0 ? Object.keys(rows[0] as object) : [];
      
      return {
        success: true,
        data: {
          columns,
          rows,
          rowCount: rows.length,
          query: limitedQuery,
        },
      };
    } catch (error: any) {
      if (error.message.includes('no such table')) {
        // Helpful: list available tables
        try {
          const db = getConnection(dbPath);
          const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all() as Array<{ name: string }>;
          
          return {
            success: false,
            error: `Table not found. Available tables: ${tables.map(t => t.name).join(', ')}`,
          };
        } catch {
          return { success: false, error: error.message };
        }
      }
      
      return { success: false, error: `Query failed: ${error.message}` };
    }
  },
});
```

---

## Timeout & Resource Limits

Every tool needs bounds. An unbounded tool is a liability.

```typescript
interface ResourceLimits {
  /** Max execution time per tool call */
  timeoutMs: number;
  
  /** Max output size in bytes */
  maxOutputBytes: number;
  
  /** Max concurrent tool executions */
  maxConcurrent: number;
  
  /** Max total tool calls per session */
  maxCallsPerSession: number;
  
  /** Max total cost per session (cents) */
  maxCostPerSession: number;
}

const DEFAULT_LIMITS: ResourceLimits = {
  timeoutMs: 30_000,
  maxOutputBytes: 1_000_000,
  maxConcurrent: 5,
  maxCallsPerSession: 100,
  maxCostPerSession: 500, // $5
};

class BoundedToolExecutor {
  private activeCalls: number = 0;
  private totalCalls: number = 0;
  private totalCostCents: number = 0;
  
  constructor(
    private registry: ToolRegistry,
    private limits: ResourceLimits = DEFAULT_LIMITS,
  ) {}
  
  async execute(
    name: string,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    // Check session limits
    if (this.totalCalls >= this.limits.maxCallsPerSession) {
      return { success: false, error: 'Session tool call limit reached' };
    }
    
    // Check concurrency
    if (this.activeCalls >= this.limits.maxConcurrent) {
      return { success: false, error: 'Too many concurrent tool calls' };
    }
    
    // Check cost
    const tool = this.registry.get(name);
    if (tool?.estimatedCostCents) {
      if (this.totalCostCents + tool.estimatedCostCents > this.limits.maxCostPerSession) {
        return { success: false, error: 'Session cost limit reached' };
      }
    }
    
    this.activeCalls++;
    this.totalCalls++;
    
    try {
      const result = await this.registry.execute(name, input, context);
      
      // Track cost
      if (tool?.estimatedCostCents) {
        this.totalCostCents += tool.estimatedCostCents;
      }
      
      // Truncate oversized output
      const serialized = JSON.stringify(result.data);
      if (serialized.length > this.limits.maxOutputBytes) {
        result.data = {
          truncated: true,
          preview: serialized.slice(0, 10_000),
          originalSize: serialized.length,
        };
      }
      
      return result;
    } finally {
      this.activeCalls--;
    }
  }
}
```

## Testing Tools

Every tool should have tests. Here's a pattern:

```typescript
import { describe, test, expect, beforeEach } from 'vitest';

function createTestContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    sessionId: 'test-session',
    workingDirectory: '/tmp/test-workspace',
    abortSignal: new AbortController().signal,
    logger: console as any,
    env: {},
    ...overrides,
  };
}

describe('web_search tool', () => {
  test('validates empty query', async () => {
    const result = await registry.execute('web_search', { query: '' }, createTestContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input');
  });
  
  test('respects max results limit', async () => {
    const result = await registry.execute(
      'web_search',
      { query: 'test', maxResults: 20 },
      createTestContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input');
  });
  
  test('returns structured results', async () => {
    const result = await registry.execute(
      'web_search',
      { query: 'TypeScript tutorial' },
      createTestContext({ env: { BRAVE_API_KEY: 'test-key' } }),
    );
    
    if (result.success) {
      expect(result.data).toHaveProperty('results');
      expect(result.data).toHaveProperty('query', 'TypeScript tutorial');
    }
  });
});

describe('file_read tool', () => {
  beforeEach(async () => {
    // Create test files
    await fs.mkdir('/tmp/test-workspace', { recursive: true });
    await fs.writeFile('/tmp/test-workspace/test.txt', 'hello world');
  });
  
  test('reads files within workspace', async () => {
    const result = await registry.execute(
      'file_read',
      { path: 'test.txt' },
      createTestContext({ workingDirectory: '/tmp/test-workspace' }),
    );
    expect(result.success).toBe(true);
    expect(result.data.content).toBe('hello world');
  });
  
  test('blocks path traversal', async () => {
    const result = await registry.execute(
      'file_read',
      { path: '../../../etc/passwd' },
      createTestContext({ workingDirectory: '/tmp/test-workspace' }),
    );
    expect(result.success).toBe(false);
  });
});
```

---

## Key Takeaways

1. **Always validate inputs** — LLMs produce creative garbage sometimes
2. **Always set timeouts** — a hung tool blocks the whole agent
3. **Rate limit external calls** — protect yourself and your API providers
4. **Return structured errors** — the LLM needs to understand what went wrong to retry
5. **Log everything** — you'll need it for debugging
6. **Security by default** — block path traversal, internal networks, destructive operations

---

**Next:** [Chapter 3 — Memory Systems →](./03-memory.md)
