/**
 * Tool system for the AI agent.
 * 
 * Each tool has:
 * - A name and description (sent to the LLM)
 * - A JSON Schema for parameters (for function calling)
 * - An execute function (the actual implementation)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

// ─── Types ───────────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ToolContext {
  workingDir: string;
  env: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

// ─── Tool Registry ───────────────────────────────────────────────────────

const tools: Map<string, ToolDefinition> = new Map();

function registerTool(tool: ToolDefinition): void {
  tools.set(tool.name, tool);
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name);
}

export function getToolDefinitions(): ChatCompletionTool[] {
  return Array.from(tools.values()).map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = tools.get(name);
  if (!tool) {
    return { success: false, error: `Unknown tool: ${name}` };
  }

  const startTime = Date.now();
  try {
    const result = await Promise.race([
      tool.execute(args, ctx),
      new Promise<ToolResult>((_, reject) =>
        setTimeout(() => reject(new Error('Tool timed out after 30s')), 30_000)
      ),
    ]);
    
    const duration = Date.now() - startTime;
    console.log(`  ⚡ ${name} completed in ${duration}ms (${result.success ? '✓' : '✗'})`);
    
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.log(`  ⚡ ${name} failed in ${duration}ms: ${message}`);
    return { success: false, error: message };
  }
}

// ─── Tool 1: Web Search ─────────────────────────────────────────────────

registerTool({
  name: 'web_search',
  description:
    'Search the web for current information. Returns titles, URLs, and snippets. Use this when you need up-to-date information.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      maxResults: {
        type: 'number',
        description: 'Number of results to return (1-5, default 3)',
      },
    },
    required: ['query'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const query = String(args.query ?? '').trim();
    if (!query) return { success: false, error: 'Empty query' };

    const maxResults = Math.min(Math.max(Number(args.maxResults) || 3, 1), 5);
    const apiKey = ctx.env.BRAVE_API_KEY;

    if (!apiKey) {
      return {
        success: false,
        error: 'BRAVE_API_KEY not configured. Set it in .env to enable web search.',
      };
    }

    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(maxResults));

    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal: ctx.abortSignal,
    });

    if (!response.ok) {
      return { success: false, error: `Search API returned ${response.status}` };
    }

    const data = (await response.json()) as {
      web?: { results?: Array<{ title: string; url: string; description: string }> };
    };

    const results = (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    }));

    return { success: true, data: { query, results } };
  },
});

// ─── Tool 2: Read File ──────────────────────────────────────────────────

registerTool({
  name: 'read_file',
  description:
    'Read the contents of a file. Returns the file content as text. Use this to examine files.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the working directory',
      },
      maxLines: {
        type: 'number',
        description: 'Maximum lines to read (default: all)',
      },
    },
    required: ['path'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const filePath = String(args.path ?? '');
    if (!filePath) return { success: false, error: 'No path provided' };

    // Security: resolve and check path is within working directory
    const resolved = path.resolve(ctx.workingDir, filePath);
    if (!resolved.startsWith(path.resolve(ctx.workingDir))) {
      return { success: false, error: 'Access denied: path outside working directory' };
    }

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) return { success: false, error: 'Not a file' };
      if (stat.size > 5 * 1024 * 1024) {
        return { success: false, error: 'File exceeds 5MB limit' };
      }

      let content = await fs.readFile(resolved, 'utf-8');
      
      const maxLines = Number(args.maxLines) || 0;
      if (maxLines > 0) {
        const lines = content.split('\n');
        content = lines.slice(0, maxLines).join('\n');
        if (lines.length > maxLines) {
          content += `\n... (${lines.length - maxLines} more lines)`;
        }
      }

      return {
        success: true,
        data: { path: filePath, content, size: stat.size },
      };
    } catch (error: unknown) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` };
      if (e.code === 'EACCES') return { success: false, error: `Permission denied: ${filePath}` };
      return { success: false, error: `Read failed: ${e.message}` };
    }
  },
});

// ─── Tool 3: Write File ─────────────────────────────────────────────────

registerTool({
  name: 'write_file',
  description:
    'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does. Automatically creates parent directories.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the working directory',
      },
      content: {
        type: 'string',
        description: 'Content to write to the file',
      },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const filePath = String(args.path ?? '');
    const content = String(args.content ?? '');
    if (!filePath) return { success: false, error: 'No path provided' };

    const resolved = path.resolve(ctx.workingDir, filePath);
    if (!resolved.startsWith(path.resolve(ctx.workingDir))) {
      return { success: false, error: 'Access denied: path outside working directory' };
    }

    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, 'utf-8');
      return {
        success: true,
        data: { path: filePath, bytesWritten: Buffer.byteLength(content) },
      };
    } catch (error: unknown) {
      return { success: false, error: `Write failed: ${(error as Error).message}` };
    }
  },
});

// ─── Tool 4: List Directory ─────────────────────────────────────────────

registerTool({
  name: 'list_directory',
  description:
    'List the contents of a directory. Returns file names, types, and sizes.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path relative to the working directory (default: ".")',
      },
    },
    required: [],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const dirPath = String(args.path ?? '.');
    const resolved = path.resolve(ctx.workingDir, dirPath);

    if (!resolved.startsWith(path.resolve(ctx.workingDir))) {
      return { success: false, error: 'Access denied: path outside working directory' };
    }

    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const items = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(resolved, entry.name);
          let size: number | undefined;
          if (entry.isFile()) {
            try {
              const stat = await fs.stat(fullPath);
              size = stat.size;
            } catch { /* ignore */ }
          }
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
            size,
          };
        }),
      );

      return { success: true, data: { path: dirPath, entries: items } };
    } catch (error: unknown) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return { success: false, error: `Directory not found: ${dirPath}` };
      return { success: false, error: `List failed: ${e.message}` };
    }
  },
});

// ─── Tool 5: Execute JavaScript ─────────────────────────────────────────

registerTool({
  name: 'execute_js',
  description:
    'Execute JavaScript code and return the result. The code runs in the current Node.js process. Use console.log() for output. The last expression is returned as the result.',
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'JavaScript code to execute',
      },
    },
    required: ['code'],
  },
  async execute(args, _ctx): Promise<ToolResult> {
    const code = String(args.code ?? '');
    if (!code) return { success: false, error: 'No code provided' };

    // Capture console.log output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...logArgs: unknown[]) => {
      logs.push(logArgs.map(String).join(' '));
    };

    try {
      // Wrap in an async IIFE so await works
      const wrappedCode = `(async () => { ${code} })()`;
      const result = await eval(wrappedCode);
      
      return {
        success: true,
        data: {
          result: result !== undefined ? String(result) : undefined,
          output: logs.join('\n') || undefined,
        },
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: `Execution error: ${(error as Error).message}`,
        data: { output: logs.join('\n') || undefined },
      };
    } finally {
      console.log = originalLog;
    }
  },
});
