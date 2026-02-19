/**
 * AI Agent — Main entry point
 * 
 * A complete agent that:
 * - Accepts natural language instructions
 * - Uses tools (web search, file operations, code execution)
 * - Maintains conversation memory (short-term + long-term)
 * - Handles errors gracefully
 * 
 * Usage:
 *   npx tsx src/index.ts
 *   npx tsx src/index.ts "What files are in the current directory?"
 */

import 'dotenv/config';
import OpenAI from 'openai';
import * as readline from 'readline';
import { ShortTermMemory, LongTermMemory, SessionStore } from './memory.js';
import { getToolDefinitions, executeTool, type ToolContext } from './tools.js';
import type {
  ChatCompletionMessageParam,
  ChatCompletionAssistantMessageParam,
} from 'openai/resources/chat/completions';

// ─── Configuration ──────────────────────────────────────────────────────

const MODEL = process.env.MODEL ?? 'gpt-4o-mini';
const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS) || 15;
const WORKING_DIR = process.env.WORKING_DIR ?? './workspace';
const DATA_DIR = process.env.DATA_DIR ?? './data';

const SYSTEM_PROMPT = `You are a helpful AI assistant with access to tools.

You can:
- Search the web for current information
- Read and write files
- List directory contents
- Execute JavaScript code

Guidelines:
- Use tools when they would help answer the question
- Be concise but thorough
- If a tool fails, try an alternative approach
- Always explain what you're doing and why
- If you're unsure, say so

Current working directory: ${WORKING_DIR}`;

// ─── Agent ──────────────────────────────────────────────────────────────

class Agent {
  private client: OpenAI;
  private memory: ShortTermMemory;
  private longTermMemory: LongTermMemory;
  private sessionStore: SessionStore;
  private sessionId: string;
  private toolContext: ToolContext;

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    });

    this.memory = new ShortTermMemory(SYSTEM_PROMPT);
    this.longTermMemory = new LongTermMemory(`${DATA_DIR}/long-term.db`);
    this.sessionStore = new SessionStore(`${DATA_DIR}/sessions.db`);
    this.sessionId = `session_${Date.now()}`;
    
    this.toolContext = {
      workingDir: WORKING_DIR,
      env: process.env as Record<string, string | undefined>,
    };
  }

  /** Run the agent on a single user message */
  async run(userMessage: string): Promise<string> {
    // Add user message to memory
    this.memory.add({ role: 'user', content: userMessage });

    // Search long-term memory for relevant context
    const memories = this.longTermMemory.search(userMessage, 3);
    if (memories.length > 0) {
      const context = memories
        .map((m) => `- [${m.record.type}] ${m.record.content}`)
        .join('\n');
      this.memory.add({
        role: 'system',
        content: `Relevant information from memory:\n${context}`,
      });
    }

    // Agent loop
    let iterations = 0;
    while (iterations < MAX_ITERATIONS) {
      iterations++;

      try {
        const response = await this.client.chat.completions.create({
          model: MODEL,
          messages: this.memory.getMessages(),
          tools: getToolDefinitions(),
          tool_choice: 'auto',
          temperature: 0.1,
        });

        const message = response.choices[0].message;
        
        // Add assistant message to memory
        this.memory.add(message as ChatCompletionMessageParam);

        // If no tool calls, we have the final response
        if (!message.tool_calls?.length) {
          const content = message.content ?? '';
          
          // Save session
          this.sessionStore.save(this.sessionId, this.memory.getMessages());
          
          return content;
        }

        // Execute tool calls
        console.log(`\n  🔧 Executing ${message.tool_calls.length} tool(s)...`);
        
        for (const toolCall of message.tool_calls) {
          const args = this.safeParseJSON(toolCall.function.arguments);
          
          console.log(`  → ${toolCall.function.name}(${this.truncate(JSON.stringify(args), 100)})`);
          
          const result = await executeTool(toolCall.function.name, args, this.toolContext);

          this.memory.add({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }
      } catch (error) {
        if (this.isRetryableError(error)) {
          console.log(`  ⚠️  Retryable error, waiting 2s...`);
          await this.sleep(2000);
          continue;
        }
        
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error(`  ❌ Agent error: ${errorMsg}`);
        
        // Add error context so the LLM can adapt
        this.memory.add({
          role: 'system',
          content: `Error occurred: ${errorMsg}. Try a different approach.`,
        });
      }
    }

    return `I was unable to complete the task within ${MAX_ITERATIONS} iterations. Here's what I was working on:\n\n${this.memory.getSummary()}`;
  }

  /** Store a fact in long-term memory */
  remember(content: string, type: 'fact' | 'preference' | 'procedure' | 'note' = 'note'): string {
    return this.longTermMemory.store(content, type, this.sessionId, 0.7);
  }

  /** Search long-term memory */
  recall(query: string): string[] {
    return this.longTermMemory.search(query, 5).map((r) => r.record.content);
  }

  /** Cleanup */
  close(): void {
    this.longTermMemory.close();
    this.sessionStore.close();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private safeParseJSON(str: string): Record<string, unknown> {
    try {
      return JSON.parse(str);
    } catch {
      return { raw: str };
    }
  }

  private truncate(str: string, max: number): string {
    return str.length > max ? str.slice(0, max) + '...' : str;
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return msg.includes('rate limit') || msg.includes('429') || msg.includes('timeout');
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─── CLI Interface ──────────────────────────────────────────────────────

async function main() {
  console.log('🤖 AI Agent started');
  console.log(`   Model: ${MODEL}`);
  console.log(`   Working directory: ${WORKING_DIR}`);
  console.log('   Type "exit" to quit, "remember <text>" to store a memory\n');

  const agent = new Agent();

  // If a message was passed as CLI argument, run it and exit
  const cliMessage = process.argv.slice(2).join(' ');
  if (cliMessage) {
    console.log(`You: ${cliMessage}\n`);
    const response = await agent.run(cliMessage);
    console.log(`\nAgent: ${response}\n`);
    agent.close();
    return;
  }

  // Interactive mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim();
      
      if (!trimmed) {
        prompt();
        return;
      }
      
      if (trimmed === 'exit' || trimmed === 'quit') {
        console.log('\nGoodbye! 👋');
        agent.close();
        rl.close();
        return;
      }

      // Special command: remember
      if (trimmed.startsWith('remember ')) {
        const fact = trimmed.slice(9);
        agent.remember(fact, 'note');
        console.log(`\n  💾 Stored in memory: "${fact}"`);
        prompt();
        return;
      }

      // Special command: recall
      if (trimmed.startsWith('recall ')) {
        const query = trimmed.slice(7);
        const memories = agent.recall(query);
        if (memories.length === 0) {
          console.log('\n  🧠 No relevant memories found.');
        } else {
          console.log('\n  🧠 Memories:');
          memories.forEach((m, i) => console.log(`     ${i + 1}. ${m}`));
        }
        prompt();
        return;
      }

      try {
        const response = await agent.run(trimmed);
        console.log(`\nAgent: ${response}`);
      } catch (error) {
        console.error(`\n❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      prompt();
    });
  };

  prompt();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
