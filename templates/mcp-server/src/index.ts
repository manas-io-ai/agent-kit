#!/usr/bin/env node

/**
 * MCP Server Starter
 * 
 * A Model Context Protocol server with 3 working tools:
 * 1. word_count — Count words, characters, sentences in text
 * 2. json_transform — Transform JSON data (pick fields, filter, sort)
 * 3. hash_text — Generate hashes of text (md5, sha1, sha256)
 * 
 * This server communicates over stdio, following the MCP specification.
 * It works with Claude Desktop, Cursor, and any MCP-compatible client.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { wordCount, jsonTransform, hashText } from './tools.js';

// ─── Tool Definitions ───────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'word_count',
    description:
      'Analyze text and return word count, character count, sentence count, paragraph count, and estimated reading time.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'The text to analyze',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'json_transform',
    description:
      'Transform JSON data. Supports picking specific fields, filtering arrays by condition, and sorting arrays by a field.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        data: {
          description: 'The JSON data to transform (object or array)',
        },
        operation: {
          type: 'string',
          enum: ['pick', 'filter', 'sort', 'flatten', 'group_by'],
          description: 'The transformation operation to perform',
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'For pick: fields to keep. For sort: [field, direction].',
        },
        condition: {
          type: 'object',
          description: 'For filter: { field, operator, value } where operator is eq/neq/gt/lt/gte/lte/contains',
          properties: {
            field: { type: 'string' },
            operator: { type: 'string', enum: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains'] },
            value: {},
          },
        },
      },
      required: ['data', 'operation'],
    },
  },
  {
    name: 'hash_text',
    description:
      'Generate a hash of the given text. Supports md5, sha1, sha256, and sha512 algorithms.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'The text to hash',
        },
        algorithm: {
          type: 'string',
          enum: ['md5', 'sha1', 'sha256', 'sha512'],
          description: 'Hash algorithm to use (default: sha256)',
        },
      },
      required: ['text'],
    },
  },
];

// ─── Server Setup ───────────────────────────────────────────────────────

const server = new Server(
  {
    name: 'mcp-server-starter',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'word_count': {
        const text = String(args?.text ?? '');
        if (!text) {
          return errorResult('Missing required parameter: text');
        }
        const result = wordCount(text);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'json_transform': {
        const data = args?.data;
        const operation = String(args?.operation ?? '');
        if (data === undefined || !operation) {
          return errorResult('Missing required parameters: data, operation');
        }
        const result = jsonTransform(
          data as Record<string, unknown> | unknown[],
          operation as 'pick' | 'filter' | 'sort' | 'flatten' | 'group_by',
          (args?.fields as string[]) ?? [],
          args?.condition as { field: string; operator: string; value: unknown } | undefined,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'hash_text': {
        const text = String(args?.text ?? '');
        if (!text) {
          return errorResult('Missing required parameter: text');
        }
        const algorithm = (args?.algorithm as string) ?? 'sha256';
        const result = hashText(text, algorithm);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResult(`Tool execution failed: ${message}`);
  }
});

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// ─── Start Server ───────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Server started on stdio');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

export { TOOLS };
