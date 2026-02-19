# Chapter 1: AI Agent Architecture Patterns

> An AI agent is a system that uses an LLM to decide what actions to take, executes those actions, observes the results, and repeats until a goal is achieved.

The difference between a chatbot and an agent is **autonomy**. A chatbot responds. An agent *acts*.

This chapter covers the four foundational architecture patterns. Every production agent you'll encounter is some combination of these.

---

## Table of Contents

1. [The Core Loop](#the-core-loop)
2. [Pattern 1: ReAct (Reason + Act)](#pattern-1-react-reason--act)
3. [Pattern 2: Plan-Execute](#pattern-2-plan-execute)
4. [Pattern 3: Tool-Use (Function Calling)](#pattern-3-tool-use-function-calling)
5. [Pattern 4: Multi-Agent](#pattern-4-multi-agent)
6. [Choosing the Right Pattern](#choosing-the-right-pattern)
7. [Combining Patterns](#combining-patterns)

---

## The Core Loop

Every agent, regardless of pattern, follows this loop:

```
┌─────────────┐
│   Observe   │ ← Gather context (user input, tool results, memory)
└──────┬──────┘
       ▼
┌─────────────┐
│    Think     │ ← LLM decides what to do next
└──────┬──────┘
       ▼
┌─────────────┐
│     Act      │ ← Execute a tool, respond, or terminate
└──────┬──────┘
       ▼
┌─────────────┐
│   Update     │ ← Store results, update memory
└──────┬──────┘
       │
       └──────→ Loop back to Observe (or exit)
```

In TypeScript, the skeleton looks like this:

```typescript
interface AgentState {
  messages: Message[];
  memory: Record<string, unknown>;
  iteration: number;
  maxIterations: number;
}

async function agentLoop(state: AgentState): Promise<string> {
  while (state.iteration < state.maxIterations) {
    // 1. Think — ask the LLM what to do
    const response = await llm.chat(state.messages);
    
    // 2. Check if we're done
    if (response.finishReason === 'stop' && !response.toolCalls?.length) {
      return response.content; // Final answer
    }
    
    // 3. Act — execute tool calls
    for (const toolCall of response.toolCalls ?? []) {
      const result = await executeTool(toolCall.name, toolCall.arguments);
      state.messages.push({
        role: 'tool',
        toolCallId: toolCall.id,
        content: JSON.stringify(result),
      });
    }
    
    // 4. Update
    state.iteration++;
  }
  
  throw new Error('Agent exceeded maximum iterations');
}
```

This is the foundation. Every pattern below is a variation on how the **Think** step works.

---

## Pattern 1: ReAct (Reason + Act)

**Paper:** [Yao et al., 2022](https://arxiv.org/abs/2210.03629)

ReAct interleaves reasoning traces with actions. The LLM explicitly "thinks out loud" before each action, making its decision process transparent and debuggable.

### How It Works

```
Thought: I need to find the current weather in Tokyo.
Action: web_search("Tokyo weather today")
Observation: Tokyo is currently 15°C with clear skies...
Thought: Now I have the weather. The user asked for it in Fahrenheit.
Action: calculate("15 * 9/5 + 32")
Observation: 59
Thought: I have the answer. 59°F with clear skies.
Answer: The current weather in Tokyo is 59°F (15°C) with clear skies.
```

### Implementation

```typescript
const REACT_SYSTEM_PROMPT = `You are an AI agent that solves problems step by step.

For each step, you MUST use this exact format:

Thought: <your reasoning about what to do next>
Action: <tool_name>(<parameters as JSON>)

When you have the final answer:
Thought: <your reasoning>
Answer: <final response to the user>

Available tools:
{{tools}}

Rules:
- Always think before acting
- One action per step
- Never make up tool results — wait for the Observation`;

interface ReActStep {
  thought: string;
  action?: { tool: string; params: Record<string, unknown> };
  answer?: string;
}

function parseReActResponse(text: string): ReActStep {
  const thoughtMatch = text.match(/Thought:\s*(.+?)(?=\n(?:Action|Answer))/s);
  const actionMatch = text.match(/Action:\s*(\w+)\((.+)\)/s);
  const answerMatch = text.match(/Answer:\s*(.+)/s);

  const step: ReActStep = {
    thought: thoughtMatch?.[1]?.trim() ?? '',
  };

  if (answerMatch) {
    step.answer = answerMatch[1].trim();
  } else if (actionMatch) {
    step.action = {
      tool: actionMatch[1],
      params: JSON.parse(actionMatch[2]),
    };
  }

  return step;
}

async function reactAgent(
  userMessage: string,
  tools: Tool[],
  maxSteps: number = 10
): Promise<string> {
  const toolDescriptions = tools
    .map(t => `- ${t.name}(${JSON.stringify(t.parameters)}): ${t.description}`)
    .join('\n');

  const messages: Message[] = [
    {
      role: 'system',
      content: REACT_SYSTEM_PROMPT.replace('{{tools}}', toolDescriptions),
    },
    { role: 'user', content: userMessage },
  ];

  for (let step = 0; step < maxSteps; step++) {
    const response = await llm.complete({ messages, temperature: 0 });
    const parsed = parseReActResponse(response);

    // Log the reasoning trace
    console.log(`[Step ${step + 1}] Thought: ${parsed.thought}`);

    if (parsed.answer) {
      return parsed.answer;
    }

    if (parsed.action) {
      console.log(`[Step ${step + 1}] Action: ${parsed.action.tool}`);
      const result = await executeTool(parsed.action.tool, parsed.action.params);
      
      // Append the action and observation to the conversation
      messages.push({ role: 'assistant', content: response });
      messages.push({
        role: 'user',
        content: `Observation: ${JSON.stringify(result)}`,
      });
    }
  }

  throw new Error('ReAct agent exceeded maximum steps');
}
```

### When to Use ReAct

✅ **Good for:**
- Tasks that require multi-step reasoning
- Debugging — the thought trace is incredibly useful
- When you need the LLM to explain its approach
- Research tasks, data analysis, complex Q&A

❌ **Not ideal for:**
- Simple single-tool calls (overkill)
- Latency-sensitive applications (each thought adds a round-trip)
- Tasks where the plan is obvious upfront

---

## Pattern 2: Plan-Execute

The LLM first creates a complete plan, then executes each step. This separates high-level reasoning from low-level execution.

### How It Works

```
User: "Set up a new TypeScript project with Express and deploy it to Vercel"

Plan:
1. Create project directory and initialize npm
2. Install dependencies (typescript, express, @types/express)
3. Create tsconfig.json with proper settings
4. Write a basic Express server in src/index.ts
5. Create vercel.json configuration
6. Deploy using Vercel CLI

Executing step 1...
Executing step 2...
...
```

### Implementation

```typescript
interface Plan {
  goal: string;
  steps: PlanStep[];
}

interface PlanStep {
  id: number;
  description: string;
  tool: string;
  params: Record<string, unknown>;
  dependencies: number[]; // IDs of steps that must complete first
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: unknown;
}

const PLANNER_PROMPT = `You are a planning agent. Given a goal, create a detailed plan.

Return a JSON plan with this structure:
{
  "goal": "the user's goal",
  "steps": [
    {
      "id": 1,
      "description": "what this step does",
      "tool": "tool_name",
      "params": { ... },
      "dependencies": []
    }
  ]
}

Available tools:
{{tools}}

Rules:
- Break complex tasks into small, concrete steps
- Each step should use exactly one tool
- Specify dependencies (steps that must complete first)
- Be specific in descriptions — no vague steps`;

async function planExecuteAgent(
  userMessage: string,
  tools: Tool[],
): Promise<string> {
  // Phase 1: Plan
  const plan = await createPlan(userMessage, tools);
  console.log(`Plan created with ${plan.steps.length} steps`);

  // Phase 2: Execute
  const results: Map<number, unknown> = new Map();

  for (const step of topologicalSort(plan.steps)) {
    // Check dependencies
    const depsReady = step.dependencies.every(
      depId => results.has(depId)
    );
    if (!depsReady) {
      throw new Error(`Dependencies not met for step ${step.id}`);
    }

    console.log(`Executing step ${step.id}: ${step.description}`);
    step.status = 'running';

    try {
      // Inject dependency results into params
      const resolvedParams = resolveDependencies(step.params, results);
      const result = await executeTool(step.tool, resolvedParams);
      
      step.status = 'completed';
      step.result = result;
      results.set(step.id, result);
    } catch (error) {
      step.status = 'failed';
      
      // Re-plan from this point
      console.log(`Step ${step.id} failed, re-planning...`);
      const revisedPlan = await replan(plan, step, error);
      plan.steps = revisedPlan.steps;
    }
  }

  // Phase 3: Summarize
  return await summarizeResults(plan, results);
}

async function createPlan(goal: string, tools: Tool[]): Promise<Plan> {
  const toolDescriptions = tools
    .map(t => `- ${t.name}: ${t.description}`)
    .join('\n');

  const response = await llm.complete({
    messages: [
      {
        role: 'system',
        content: PLANNER_PROMPT.replace('{{tools}}', toolDescriptions),
      },
      { role: 'user', content: goal },
    ],
    responseFormat: { type: 'json_object' },
  });

  return JSON.parse(response) as Plan;
}

async function replan(
  originalPlan: Plan,
  failedStep: PlanStep,
  error: unknown,
): Promise<Plan> {
  const response = await llm.complete({
    messages: [
      {
        role: 'system',
        content: `A plan step failed. Revise the remaining steps.
          
Original plan: ${JSON.stringify(originalPlan)}
Failed step: ${JSON.stringify(failedStep)}
Error: ${String(error)}

Return a revised plan JSON with updated remaining steps.`,
      },
    ],
    responseFormat: { type: 'json_object' },
  });

  return JSON.parse(response) as Plan;
}

function topologicalSort(steps: PlanStep[]): PlanStep[] {
  const sorted: PlanStep[] = [];
  const visited = new Set<number>();

  function visit(step: PlanStep) {
    if (visited.has(step.id)) return;
    visited.add(step.id);
    for (const depId of step.dependencies) {
      const dep = steps.find(s => s.id === depId);
      if (dep) visit(dep);
    }
    sorted.push(step);
  }

  steps.forEach(visit);
  return sorted;
}

function resolveDependencies(
  params: Record<string, unknown>,
  results: Map<number, unknown>,
): Record<string, unknown> {
  const resolved = { ...params };
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === 'string' && value.startsWith('$step_')) {
      const stepId = parseInt(value.replace('$step_', ''), 10);
      resolved[key] = results.get(stepId);
    }
  }
  return resolved;
}
```

### When to Use Plan-Execute

✅ **Good for:**
- Complex, multi-step tasks with clear sequential flow
- Tasks where you want user approval of the plan before execution
- Parallel execution (independent steps can run concurrently)
- When re-planning on failure is important

❌ **Not ideal for:**
- Exploratory tasks where the next step depends on discovery
- Simple tasks (planning overhead isn't worth it)
- Highly dynamic environments where plans go stale fast

---

## Pattern 3: Tool-Use (Function Calling)

This is the most common pattern in production. Instead of parsing text, you use the LLM's native function-calling capability. The model outputs structured tool calls directly.

### How It Works

Most LLM APIs (OpenAI, Anthropic, etc.) support a `tools` parameter. The model can decide to call one or more tools, and the API returns structured JSON — no parsing needed.

### Implementation

```typescript
import OpenAI from 'openai';

interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
    }>;
    required: string[];
  };
}

// Define tools in OpenAI function-calling format
const toolDefinitions: ToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Search the web for current information',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results (1-10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_file',
    description: 'Read contents of a file',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to read',
        },
      },
      required: ['path'],
    },
  },
];

async function toolUseAgent(
  userMessage: string,
  tools: Map<string, ToolFunction>,
  maxRounds: number = 15,
): Promise<string> {
  const client = new OpenAI();
  
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are a helpful AI agent. Use the available tools to accomplish tasks.
Be thorough — verify your work. If a tool fails, try an alternative approach.`,
    },
    { role: 'user', content: userMessage },
  ];

  for (let round = 0; round < maxRounds; round++) {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages,
      tools: toolDefinitions.map(t => ({
        type: 'function' as const,
        function: t,
      })),
      tool_choice: 'auto',
    });

    const message = response.choices[0].message;
    messages.push(message);

    // If no tool calls, we're done
    if (!message.tool_calls?.length) {
      return message.content ?? '';
    }

    // Execute all tool calls (can be parallel)
    const toolResults = await Promise.all(
      message.tool_calls.map(async (toolCall) => {
        const fn = tools.get(toolCall.function.name);
        if (!fn) {
          return {
            tool_call_id: toolCall.id,
            role: 'tool' as const,
            content: JSON.stringify({ error: `Unknown tool: ${toolCall.function.name}` }),
          };
        }

        try {
          const args = JSON.parse(toolCall.function.arguments);
          const result = await fn(args);
          return {
            tool_call_id: toolCall.id,
            role: 'tool' as const,
            content: JSON.stringify(result),
          };
        } catch (error) {
          return {
            tool_call_id: toolCall.id,
            role: 'tool' as const,
            content: JSON.stringify({
              error: error instanceof Error ? error.message : 'Tool execution failed',
            }),
          };
        }
      })
    );

    messages.push(...toolResults);
  }

  throw new Error('Agent exceeded maximum rounds');
}
```

### When to Use Tool-Use

✅ **Good for:**
- Most production agents (this is the default choice)
- When you need structured, reliable tool calls
- Parallel tool execution
- When the LLM API supports native function calling

❌ **Not ideal for:**
- Models that don't support function calling (use ReAct instead)
- When you need visible reasoning traces (add chain-of-thought to system prompt)

---

## Pattern 4: Multi-Agent

Multiple specialized agents collaborate to solve a problem. Each agent has its own role, tools, and system prompt.

### How It Works

```
┌──────────────┐
│  Orchestrator │ ← Routes tasks to specialists
└──────┬───────┘
       │
  ┌────┼────┐
  ▼    ▼    ▼
┌───┐┌───┐┌───┐
│ R ││ C ││ W │  ← Researcher, Coder, Writer
└───┘└───┘└───┘
```

### Implementation

```typescript
interface Agent {
  name: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  model: string;
}

interface OrchestratorDecision {
  agent: string;
  task: string;
  context?: string;
}

const agents: Agent[] = [
  {
    name: 'researcher',
    systemPrompt: `You are a research specialist. Your job is to find accurate, 
up-to-date information using web search. Always cite sources. Be thorough.`,
    tools: [/* web_search, fetch_page */],
    model: 'gpt-4o',
  },
  {
    name: 'coder',
    systemPrompt: `You are a coding specialist. Write clean, tested, production-ready code.
Always include error handling. Explain your approach briefly.`,
    tools: [/* read_file, write_file, execute_code */],
    model: 'gpt-4o',
  },
  {
    name: 'writer',
    systemPrompt: `You are a writing specialist. Create clear, engaging content.
Adapt tone to the audience. Be concise but thorough.`,
    tools: [/* read_file, write_file */],
    model: 'gpt-4o',
  },
];

const ORCHESTRATOR_PROMPT = `You are an orchestrator managing a team of AI agents.

Available agents:
{{agents}}

Given a user request, decide which agent(s) should handle it and what task to give them.
If a task requires multiple agents, specify the order.

Return JSON:
{
  "delegations": [
    { "agent": "agent_name", "task": "specific task description", "context": "relevant info" }
  ]
}`;

async function multiAgentOrchestrator(
  userMessage: string,
): Promise<string> {
  // Step 1: Orchestrator decides who does what
  const agentDescriptions = agents
    .map(a => `- ${a.name}: ${a.systemPrompt.slice(0, 100)}...`)
    .join('\n');

  const planResponse = await llm.complete({
    messages: [
      {
        role: 'system',
        content: ORCHESTRATOR_PROMPT.replace('{{agents}}', agentDescriptions),
      },
      { role: 'user', content: userMessage },
    ],
    responseFormat: { type: 'json_object' },
  });

  const plan = JSON.parse(planResponse) as {
    delegations: OrchestratorDecision[];
  };

  // Step 2: Execute delegations in order
  const results: Map<string, string> = new Map();

  for (const delegation of plan.delegations) {
    const agent = agents.find(a => a.name === delegation.agent);
    if (!agent) continue;

    console.log(`[Orchestrator] Delegating to ${agent.name}: ${delegation.task}`);

    // Build context from previous results
    let context = delegation.context ?? '';
    if (results.size > 0) {
      context += '\n\nPrevious results:\n';
      for (const [name, result] of results) {
        context += `\n[${name}]: ${result}\n`;
      }
    }

    const result = await runAgent(agent, delegation.task, context);
    results.set(agent.name, result);
  }

  // Step 3: Synthesize final response
  const synthesis = await llm.complete({
    messages: [
      {
        role: 'system',
        content: 'Synthesize the following agent results into a coherent response for the user.',
      },
      {
        role: 'user',
        content: `Original request: ${userMessage}\n\nAgent results:\n${
          Array.from(results.entries())
            .map(([name, result]) => `[${name}]: ${result}`)
            .join('\n\n')
        }`,
      },
    ],
  });

  return synthesis;
}

async function runAgent(
  agent: Agent,
  task: string,
  context: string,
): Promise<string> {
  // Each agent runs its own tool-use loop
  return toolUseAgent(
    `${task}\n\nContext: ${context}`,
    agentTools.get(agent.name)!,
  );
}
```

### Patterns Within Multi-Agent

**Hierarchical:** One orchestrator delegates to specialists (shown above).

**Peer-to-peer:** Agents communicate directly with each other:

```typescript
interface AgentMessage {
  from: string;
  to: string;
  content: string;
  timestamp: number;
}

class AgentNetwork {
  private mailboxes: Map<string, AgentMessage[]> = new Map();
  
  send(msg: AgentMessage): void {
    const inbox = this.mailboxes.get(msg.to) ?? [];
    inbox.push(msg);
    this.mailboxes.set(msg.to, inbox);
  }
  
  receive(agentName: string): AgentMessage[] {
    const msgs = this.mailboxes.get(agentName) ?? [];
    this.mailboxes.set(agentName, []);
    return msgs;
  }
}
```

**Debate:** Two agents argue opposing positions, a judge picks the best answer:

```typescript
async function debatePattern(question: string): Promise<string> {
  const proArgument = await runAgent(proAgent, `Argue FOR: ${question}`, '');
  const conArgument = await runAgent(conAgent, `Argue AGAINST: ${question}`, '');
  
  const judgment = await llm.complete({
    messages: [
      {
        role: 'system',
        content: 'You are a judge. Evaluate both arguments and provide the most accurate answer.',
      },
      {
        role: 'user',
        content: `Question: ${question}\n\nFOR: ${proArgument}\n\nAGAINST: ${conArgument}`,
      },
    ],
  });
  
  return judgment;
}
```

### When to Use Multi-Agent

✅ **Good for:**
- Complex tasks requiring diverse expertise
- When you want to parallelize work
- Code review, debate, adversarial testing
- Large autonomous workflows

❌ **Not ideal for:**
- Simple tasks (massive overhead)
- Latency-sensitive applications
- When token cost is a concern (multiplies API calls)

---

## Choosing the Right Pattern

| Factor | ReAct | Plan-Execute | Tool-Use | Multi-Agent |
|--------|-------|--------------|----------|-------------|
| **Complexity** | Medium | High | Low-Medium | High |
| **Latency** | High | Medium | Low | Very High |
| **Debuggability** | Excellent | Good | Good | Hard |
| **Token cost** | High | Medium | Low | Very High |
| **Reliability** | Good | Good | Best | Variable |
| **Best for** | Research | Workflows | Most tasks | Complex projects |

**Decision tree:**

```
Is this a simple tool-calling task?
  → Yes: Use Tool-Use (Pattern 3)
  → No: Does the task have a clear sequential plan?
    → Yes: Use Plan-Execute (Pattern 2)
    → No: Does the task need exploration/reasoning?
      → Yes: Use ReAct (Pattern 1)
      → No: Does it require diverse expertise?
        → Yes: Use Multi-Agent (Pattern 4)
        → No: Start with Tool-Use and add complexity as needed
```

---

## Combining Patterns

Production agents rarely use one pattern in isolation. Here's a common combination:

```typescript
// Multi-Agent + Tool-Use + Plan-Execute
async function productionAgent(userMessage: string): Promise<string> {
  // 1. Plan (high-level)
  const plan = await createPlan(userMessage, availableAgents);
  
  // 2. For each plan step, delegate to a specialist agent
  for (const step of plan.steps) {
    // 3. Each specialist uses Tool-Use pattern internally
    const agent = selectAgent(step);
    const result = await toolUseAgent(step.task, agent.tools);
    
    // 4. If the step is complex, the agent might use ReAct internally
    // (This happens naturally if you add chain-of-thought to the system prompt)
  }
  
  return synthesize(plan);
}
```

The key insight: **start simple, add complexity only when needed.** Most agents in production use Pattern 3 (Tool-Use) with good prompts and reliable tools. Don't over-engineer.

---

**Next:** [Chapter 2 — Building a Tool System →](./02-tool-system.md)
