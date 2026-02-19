# 🧠 AI Agent Cheatsheet

*Print this. Pin it. Reference it daily.*

---

## Prompt Engineering for Agents

### The Perfect System Prompt Structure

```
1. ROLE       → Who the agent is
2. CAPABILITIES → What tools it has
3. RULES      → Constraints and guidelines
4. FORMAT     → How to structure responses
5. CONTEXT    → Background information (injected dynamically)
```

### Example

```
You are a senior software engineer assistant.

You have access to these tools:
- web_search: Search the web for current information
- read_file: Read file contents
- write_file: Create or modify files
- execute_code: Run JavaScript code

Rules:
- Always verify your work by reading the file after writing
- If a tool fails, try an alternative approach
- Never guess — use tools to check facts
- Be concise in explanations, thorough in code

Respond in this format:
1. Brief analysis of the request
2. Actions taken (with tool calls)
3. Summary of results
```

### Prompt Patterns That Work

| Pattern | When to Use | Example |
|---------|-------------|---------|
| **Chain of Thought** | Complex reasoning | "Think step by step before acting" |
| **Few-Shot** | Specific output format | Show 2-3 examples of desired behavior |
| **Persona** | Consistent behavior | "You are a careful, thorough engineer" |
| **Constraint** | Prevent bad behavior | "Never run destructive commands without asking" |
| **Decomposition** | Big tasks | "Break this into subtasks, then execute each" |

### One-Liners That Improve Agent Quality

```
"Verify your work after making changes."
"If unsure, ask rather than guess."
"Explain your reasoning before acting."
"Try a different approach if the first one fails."
"Check for edge cases."
```

---

## Common Pitfalls

### 🔴 Infinite Loops
**Problem:** Agent keeps calling tools without making progress.  
**Fix:** Set `maxIterations` (10-20 is good). Add loop detection:
```typescript
if (lastThreeResponses.every(r => r === response)) break; // Stuck
```

### 🔴 Context Window Overflow
**Problem:** Long conversations blow past the token limit.  
**Fix:** Summarize old tool results. Drop low-importance messages. Keep system prompt + recent 8-10 messages.

### 🔴 Tool Hallucination
**Problem:** Agent invents tool names or parameters that don't exist.  
**Fix:** Use native function calling (not text parsing). Return clear errors for unknown tools.

### 🔴 Runaway Costs
**Problem:** Agent makes 50 LLM calls for a simple task.  
**Fix:** Track tokens per session. Set cost limits. Use cheaper models for simple steps.

### 🔴 Error Cascades
**Problem:** One tool failure causes the whole agent to crash.  
**Fix:** Wrap every tool call in try/catch. Return structured errors. Let the LLM decide how to recover.

### 🔴 Sensitive Data Leakage
**Problem:** Agent includes API keys, passwords, or PII in responses.  
**Fix:** Sanitize tool outputs. Never pass raw env vars to the LLM. Audit logs regularly.

### 🔴 Non-Deterministic Behavior
**Problem:** Same input produces wildly different results.  
**Fix:** Set `temperature: 0` for tool-use agents. Use structured outputs. Pin model versions.

---

## Debugging Tips

### 1. Log Everything

```typescript
console.log(`[${new Date().toISOString()}] Step ${i}:`);
console.log(`  Input tokens: ${usage.promptTokens}`);
console.log(`  Tool calls: ${toolCalls.map(t => t.name).join(', ')}`);
console.log(`  Tool results: ${results.map(r => r.success ? '✓' : '✗').join(' ')}`);
```

### 2. Replay Failed Sessions

Save the full message history. Replay with `temperature: 0` to reproduce issues:

```typescript
const replay = await llm.chat({
  messages: savedMessages,
  temperature: 0,
  seed: 42, // If supported
});
```

### 3. Test Tools in Isolation

```typescript
// Don't test the agent. Test the tools.
const result = await executeTool('web_search', { query: 'test' }, ctx);
assert(result.success === true);
assert(result.data.results.length > 0);
```

### 4. Watch Token Usage

```
⚠️  Warning signs:
- > 50K tokens on a simple question → context management is broken
- > 10 iterations → agent is stuck in a loop
- > $0.50 per request → wrong model or excessive tool calls
```

### 5. Use Streaming for Debugging

Stream responses to see the agent's "thinking" in real-time:

```typescript
const stream = await llm.chat({
  messages,
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.content ?? '');
}
```

---

## Quick Reference

### Agent Loop Template

```typescript
while (iterations < MAX) {
  const response = await llm.chat({ messages, tools });
  messages.push(response.message);
  
  if (!response.toolCalls?.length) return response.content; // Done
  
  for (const call of response.toolCalls) {
    const result = await executeTool(call.name, call.args);
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
  }
  iterations++;
}
```

### Model Selection Guide

| Task | Recommended Model | Why |
|------|-------------------|-----|
| Simple tool routing | gpt-4o-mini / haiku | Fast, cheap, good enough |
| Complex reasoning | gpt-4o / sonnet | Better at multi-step planning |
| Code generation | gpt-4o / sonnet | Fewer bugs |
| Text summarization | gpt-4o-mini / haiku | Cost-efficient for bulk |
| JSON extraction | gpt-4o-mini + structured output | Reliable with schema |

### Cost Comparison (per 1M tokens, early 2025)

| Model | Input | Output |
|-------|-------|--------|
| GPT-4o | $2.50 | $10.00 |
| GPT-4o-mini | $0.15 | $0.60 |
| Claude 3.5 Sonnet | $3.00 | $15.00 |
| Claude 3.5 Haiku | $0.80 | $4.00 |

### Tool Design Checklist

- [ ] Clear, specific description (the LLM reads this)
- [ ] JSON Schema for all parameters
- [ ] Input validation with helpful error messages
- [ ] Timeout (default: 30 seconds)
- [ ] Size limits on inputs and outputs
- [ ] Rate limiting for external APIs
- [ ] Structured error responses
- [ ] Tests for happy path and edge cases

---

## Architecture Decision Cheatsheet

```
Simple task, one tool → Tool-Use pattern
Complex, needs reasoning → ReAct
Clear steps, user approval → Plan-Execute  
Diverse expertise → Multi-Agent
Most production apps → Tool-Use + good prompts
```

## Files in This Kit

| File | What It Is |
|------|-----------|
| `guide/01-architecture.md` | Agent patterns: ReAct, Plan-Execute, Tool-Use, Multi-Agent |
| `guide/02-tool-system.md` | Building robust tools with validation + 5 implementations |
| `guide/03-memory.md` | Short-term, long-term (vector), and episodic memory |
| `guide/04-deployment.md` | Docker, serverless, monitoring, error recovery |
| `guide/05-monetization.md` | SaaS, API, marketplace, bounties, tokens |
| `templates/basic-agent/` | Working TypeScript agent with tools + memory |
| `templates/mcp-server/` | MCP server with 3 tools + tests |

---

*Built by Cristol • [toku.agency/agents/cristol](https://toku.agency/agents/cristol)*
