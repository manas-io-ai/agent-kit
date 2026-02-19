# MCP Server Starter

A Model Context Protocol (MCP) server template with 3 working tools. Ready to use with Claude Desktop, Cursor, and any MCP-compatible client.

## What's Included

| Tool | Description |
|------|-------------|
| `word_count` | Analyze text — word count, character count, sentences, paragraphs, reading time, average word length |
| `json_transform` | Transform JSON data — pick fields, filter arrays, sort, flatten nested objects, group by field |
| `hash_text` | Generate hashes — supports md5, sha1, sha256, sha512 |

## Quick Start

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run tests
npm test
```

## Setup with Claude Desktop

Add this to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "starter": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-starter/dist/index.js"]
    }
  }
}
```

Or for development:

```json
{
  "mcpServers": {
    "starter": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-server-starter/src/index.ts"]
    }
  }
}
```

## Setup with Cursor

Add to your `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "starter": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-starter/dist/index.js"]
    }
  }
}
```

## Adding Your Own Tools

1. Add the tool implementation to `src/tools.ts`:

```typescript
export function myNewTool(input: string): { result: string } {
  // Your implementation
  return { result: `processed: ${input}` };
}
```

2. Add the tool definition to `src/index.ts`:

```typescript
const TOOLS: Tool[] = [
  // ... existing tools ...
  {
    name: 'my_new_tool',
    description: 'What this tool does',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Input to process',
        },
      },
      required: ['input'],
    },
  },
];
```

3. Add the handler in the `CallToolRequestSchema` handler:

```typescript
case 'my_new_tool': {
  const input = String(args?.input ?? '');
  const result = myNewTool(input);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}
```

4. Add tests in `tests/tools.test.ts`.

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Type check
npm run typecheck
```

## Project Structure

```
mcp-server-starter/
├── src/
│   ├── index.ts    ← Server setup + tool routing
│   └── tools.ts    ← Tool implementations (pure functions)
├── tests/
│   └── tools.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

## How MCP Works

MCP (Model Context Protocol) is a standard for connecting AI models to tools and data sources. The protocol:

1. **Client** (Claude, Cursor, etc.) connects to your server via stdio
2. Client calls `tools/list` to discover available tools
3. When the AI wants to use a tool, the client calls `tools/call` with the tool name and arguments
4. Your server executes the tool and returns the result
5. The client passes the result back to the AI

The key insight: your tools are **pure functions** that take input and return output. The MCP SDK handles all the protocol plumbing.

## License

MIT — use this template for anything you want.
