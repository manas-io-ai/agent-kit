# Chapter 4: Deploying AI Agents

> Building an agent is the fun part. Keeping it alive, observable, and not bankrupting you — that's where engineering happens.

This chapter covers how to deploy agents to production: Docker containers, serverless functions, long-running processes, and the operational concerns that keep them running reliably.

---

## Table of Contents

1. [Deployment Models](#deployment-models)
2. [Docker Deployment](#docker-deployment)
3. [Serverless Deployment](#serverless-deployment)
4. [Long-Running Processes](#long-running-processes)
5. [Monitoring & Observability](#monitoring--observability)
6. [Error Recovery](#error-recovery)
7. [Cost Management](#cost-management)
8. [Security Checklist](#security-checklist)

---

## Deployment Models

| Model | Best For | Latency | Cost Model | Complexity |
|-------|----------|---------|------------|------------|
| **Docker** | Persistent agents, complex state | Low | Fixed (server) | Medium |
| **Serverless** | Event-driven, stateless tasks | Cold start | Per-invocation | Low |
| **Long-running** | Always-on agents, real-time | Lowest | Fixed (server) | High |

### Decision Tree

```
Does the agent need to be always-on?
  → Yes: Long-running process or Docker
  → No: Is it triggered by events (webhooks, schedules)?
    → Yes: Serverless
    → No: Docker (most flexible)

Does the agent maintain state between requests?
  → Yes: Docker or Long-running (with external state store)
  → No: Serverless works great
```

---

## Docker Deployment

Docker is the most common deployment target. It works everywhere, is easy to reproduce, and handles dependencies cleanly.

### Dockerfile

```dockerfile
# Multi-stage build for smaller image
FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json package-lock.json ./
RUN npm ci --production=false

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production stage
FROM node:20-slim AS production

# Install SQLite native deps (for better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only production dependencies
COPY package.json package-lock.json ./
RUN npm ci --production=true

# Copy built code
COPY --from=builder /app/dist ./dist

# Create data directory for memory/state
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data

# Run as non-root
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1))"

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
```

### Docker Compose

```yaml
version: '3.8'

services:
  agent:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - LOG_LEVEL=info
    volumes:
      - agent-data:/app/data
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '1.0'
        reservations:
          memory: 256M
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  # Optional: Redis for cross-instance state
  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes

volumes:
  agent-data:
  redis-data:
```

### Deployment Script

```bash
#!/bin/bash
set -euo pipefail

# deploy.sh — Build and deploy the agent
REGISTRY="${REGISTRY:-ghcr.io/your-org}"
IMAGE_NAME="${IMAGE_NAME:-ai-agent}"
TAG="${TAG:-$(git rev-parse --short HEAD)}"

echo "Building ${IMAGE_NAME}:${TAG}..."
docker build -t "${REGISTRY}/${IMAGE_NAME}:${TAG}" .
docker tag "${REGISTRY}/${IMAGE_NAME}:${TAG}" "${REGISTRY}/${IMAGE_NAME}:latest"

echo "Pushing to registry..."
docker push "${REGISTRY}/${IMAGE_NAME}:${TAG}"
docker push "${REGISTRY}/${IMAGE_NAME}:latest"

echo "Deploying..."
# For docker compose on a VPS:
ssh deploy@your-server "cd /opt/agent && docker compose pull && docker compose up -d"

# Or for Kubernetes:
# kubectl set image deployment/agent agent=${REGISTRY}/${IMAGE_NAME}:${TAG}

echo "Deployed ${IMAGE_NAME}:${TAG} ✓"
```

---

## Serverless Deployment

For agents that are triggered by events (webhooks, API calls, cron jobs), serverless is cost-effective and simple.

### AWS Lambda / Vercel Function

```typescript
// api/agent.ts — Vercel Edge Function
import { NextRequest, NextResponse } from 'next/server';

export const config = {
  runtime: 'nodejs', // Use Node.js runtime for better-sqlite3 support
  maxDuration: 60,   // 60 second timeout
};

export default async function handler(req: NextRequest) {
  if (req.method !== 'POST') {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const { message, sessionId } = await req.json();

  if (!message || typeof message !== 'string') {
    return NextResponse.json({ error: 'Missing message' }, { status: 400 });
  }

  try {
    // Stateless — load context from external store
    const context = await loadSessionFromRedis(sessionId);
    
    const agent = createAgent({
      systemPrompt: 'You are a helpful AI assistant.',
      tools: getTools(),
      memory: context?.messages ?? [],
    });

    const response = await agent.run(message);

    // Save updated context
    await saveSessionToRedis(sessionId, agent.getState());

    return NextResponse.json({
      response: response.content,
      sessionId: sessionId ?? response.sessionId,
      toolsUsed: response.toolsUsed,
    });
  } catch (error) {
    console.error('Agent error:', error);
    return NextResponse.json(
      { error: 'Agent execution failed' },
      { status: 500 },
    );
  }
}
```

### Serverless Considerations

**Cold starts:** First invocation is slow (~1-3s). Mitigate with:
- Provisioned concurrency (AWS Lambda)
- Keep-alive pings (costs a bit more)
- Lightweight initialization

**State:** Serverless is stateless by design. Store state externally:
- Redis/Valkey for session state
- S3/R2 for file artifacts
- PostgreSQL/Turso for persistent memory

**Timeouts:** Most serverless platforms cap at 60-300 seconds. For long agent tasks:
- Break into smaller steps
- Use background jobs (SQS, Inngest, Trigger.dev)
- Return early with a job ID, let client poll

```typescript
// For long-running tasks, use a queue
import { Inngest } from 'inngest';

const inngest = new Inngest({ id: 'ai-agent' });

// Define the agent task as a multi-step function
export const agentTask = inngest.createFunction(
  { id: 'agent-task', retries: 3 },
  { event: 'agent/task.requested' },
  async ({ event, step }) => {
    // Step 1: Plan
    const plan = await step.run('create-plan', async () => {
      return createPlan(event.data.message);
    });

    // Step 2: Execute each step (each is independently retryable)
    const results = [];
    for (const [i, planStep] of plan.steps.entries()) {
      const result = await step.run(`execute-step-${i}`, async () => {
        return executeStep(planStep);
      });
      results.push(result);
    }

    // Step 3: Summarize
    return step.run('summarize', async () => {
      return summarize(results);
    });
  },
);
```

---

## Long-Running Processes

For agents that need to be always-on (listening to messages, monitoring events, running on a schedule):

### Process Manager (systemd)

```ini
# /etc/systemd/system/ai-agent.service
[Unit]
Description=AI Agent Service
After=network.target

[Service]
Type=simple
User=agent
WorkingDirectory=/opt/agent
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/agent/data

# Resource limits
MemoryMax=512M
CPUQuota=100%

# Environment
EnvironmentFile=/opt/agent/.env

[Install]
WantedBy=multi-user.target
```

### Graceful Shutdown

```typescript
class AgentProcess {
  private running = false;
  private activeOperations = 0;
  
  async start(): Promise<void> {
    this.running = true;
    
    // Handle shutdown signals
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('uncaughtException', (err) => {
      console.error('Uncaught exception:', err);
      this.shutdown('uncaughtException');
    });
    process.on('unhandledRejection', (err) => {
      console.error('Unhandled rejection:', err);
      // Don't shutdown for unhandled rejections, but log them
    });
    
    console.log('Agent started');
    
    // Main loop
    while (this.running) {
      try {
        await this.processNextTask();
      } catch (error) {
        console.error('Error in main loop:', error);
        await this.sleep(5000); // Back off on errors
      }
    }
  }
  
  private async shutdown(signal: string): Promise<void> {
    console.log(`Shutting down (${signal})...`);
    this.running = false;
    
    // Wait for active operations to complete (max 30s)
    const deadline = Date.now() + 30_000;
    while (this.activeOperations > 0 && Date.now() < deadline) {
      console.log(`Waiting for ${this.activeOperations} active operations...`);
      await this.sleep(1000);
    }
    
    if (this.activeOperations > 0) {
      console.warn(`Force shutdown with ${this.activeOperations} active operations`);
    }
    
    // Cleanup
    await this.cleanup();
    process.exit(0);
  }
  
  private async processNextTask(): Promise<void> {
    this.activeOperations++;
    try {
      // Your agent logic here
    } finally {
      this.activeOperations--;
    }
  }
  
  private async cleanup(): Promise<void> {
    // Close database connections, flush logs, etc.
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

---

## Monitoring & Observability

You can't fix what you can't see. Every production agent needs:

### Structured Logging

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  serializers: {
    error: pino.stdSerializers.err,
  },
});

// Create child loggers for context
function createAgentLogger(sessionId: string) {
  return logger.child({ sessionId, component: 'agent' });
}

// Usage in agent
const log = createAgentLogger('session-123');
log.info({ tool: 'web_search', query: 'test' }, 'Executing tool');
log.error({ error, toolName: 'api_call' }, 'Tool execution failed');
log.info({ 
  tokensUsed: 1500, 
  duration: 2300, 
  toolCalls: 3 
}, 'Agent turn completed');
```

### Metrics

```typescript
interface AgentMetrics {
  // Counters
  totalRequests: number;
  totalToolCalls: number;
  totalErrors: number;
  totalTokensUsed: number;
  
  // Gauges
  activeSessions: number;
  memoryUsageMb: number;
  
  // Histograms
  responseTimes: number[];      // ms per request
  toolCallDurations: number[];  // ms per tool call
  tokensPerRequest: number[];
  iterationsPerRequest: number[];
}

class MetricsCollector {
  private metrics: AgentMetrics = {
    totalRequests: 0,
    totalToolCalls: 0,
    totalErrors: 0,
    totalTokensUsed: 0,
    activeSessions: 0,
    memoryUsageMb: 0,
    responseTimes: [],
    toolCallDurations: [],
    tokensPerRequest: [],
    iterationsPerRequest: [],
  };
  
  recordRequest(duration: number, tokens: number, iterations: number): void {
    this.metrics.totalRequests++;
    this.metrics.totalTokensUsed += tokens;
    this.metrics.responseTimes.push(duration);
    this.metrics.tokensPerRequest.push(tokens);
    this.metrics.iterationsPerRequest.push(iterations);
    
    // Keep only last 1000 measurements
    if (this.metrics.responseTimes.length > 1000) {
      this.metrics.responseTimes = this.metrics.responseTimes.slice(-1000);
      this.metrics.tokensPerRequest = this.metrics.tokensPerRequest.slice(-1000);
      this.metrics.iterationsPerRequest = this.metrics.iterationsPerRequest.slice(-1000);
    }
  }
  
  recordToolCall(toolName: string, duration: number, success: boolean): void {
    this.metrics.totalToolCalls++;
    this.metrics.toolCallDurations.push(duration);
    if (!success) this.metrics.totalErrors++;
  }
  
  getSnapshot(): Record<string, number> {
    const mem = process.memoryUsage();
    return {
      totalRequests: this.metrics.totalRequests,
      totalToolCalls: this.metrics.totalToolCalls,
      totalErrors: this.metrics.totalErrors,
      totalTokensUsed: this.metrics.totalTokensUsed,
      errorRate: this.metrics.totalErrors / Math.max(this.metrics.totalToolCalls, 1),
      avgResponseTimeMs: average(this.metrics.responseTimes),
      p95ResponseTimeMs: percentile(this.metrics.responseTimes, 95),
      avgTokensPerRequest: average(this.metrics.tokensPerRequest),
      avgIterationsPerRequest: average(this.metrics.iterationsPerRequest),
      memoryUsageMb: Math.round(mem.heapUsed / 1024 / 1024),
    };
  }
}

function average(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[index];
}
```

### Health Check Endpoint

```typescript
import express from 'express';

function createHealthEndpoint(agent: AgentProcess, metrics: MetricsCollector) {
  const app = express();
  
  // Basic health check
  app.get('/health', (req, res) => {
    const healthy = agent.isRunning() && agent.getActiveOperations() < 100;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'healthy' : 'degraded',
      uptime: process.uptime(),
      activeOperations: agent.getActiveOperations(),
    });
  });
  
  // Detailed metrics
  app.get('/metrics', (req, res) => {
    res.json(metrics.getSnapshot());
  });
  
  // Readiness (for Kubernetes)
  app.get('/ready', (req, res) => {
    const ready = agent.isReady();
    res.status(ready ? 200 : 503).json({ ready });
  });
  
  return app;
}
```

---

## Error Recovery

Agents fail in interesting ways. Here's how to handle them:

### Circuit Breaker

When an external service is down, stop hitting it:

```typescript
class CircuitBreaker {
  private failures: number = 0;
  private lastFailure: number = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  
  constructor(
    private maxFailures: number = 5,
    private resetTimeMs: number = 60_000,
  ) {}
  
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.resetTimeMs) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }
  
  private onFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.maxFailures) {
      this.state = 'open';
    }
  }
}

// Usage
const openaiCircuit = new CircuitBreaker(3, 30_000);

async function callLLM(messages: Message[]) {
  return openaiCircuit.call(() => openai.chat.completions.create({
    model: 'gpt-4o',
    messages,
  }));
}
```

### Checkpointing

For long-running agent tasks, save progress so you can resume:

```typescript
interface Checkpoint {
  taskId: string;
  step: number;
  state: Record<string, unknown>;
  messages: Message[];
  timestamp: number;
}

class CheckpointManager {
  constructor(private store: Database.Database) {
    store.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        task_id TEXT PRIMARY KEY,
        step INTEGER NOT NULL,
        state TEXT NOT NULL,
        messages TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
  }
  
  save(checkpoint: Checkpoint): void {
    this.store.prepare(`
      INSERT OR REPLACE INTO checkpoints (task_id, step, state, messages, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      checkpoint.taskId,
      checkpoint.step,
      JSON.stringify(checkpoint.state),
      JSON.stringify(checkpoint.messages),
      checkpoint.timestamp,
    );
  }
  
  load(taskId: string): Checkpoint | null {
    const row = this.store.prepare(
      'SELECT * FROM checkpoints WHERE task_id = ?'
    ).get(taskId) as any;
    
    if (!row) return null;
    
    return {
      taskId: row.task_id,
      step: row.step,
      state: JSON.parse(row.state),
      messages: JSON.parse(row.messages),
      timestamp: row.timestamp,
    };
  }
  
  delete(taskId: string): void {
    this.store.prepare('DELETE FROM checkpoints WHERE task_id = ?').run(taskId);
  }
}

// Usage in agent
async function resumableAgent(taskId: string, goal: string) {
  const checkpoint = checkpointManager.load(taskId);
  let state = checkpoint?.state ?? { plan: null, results: [] };
  let startStep = checkpoint?.step ?? 0;
  
  const plan = state.plan ?? await createPlan(goal);
  state.plan = plan;
  
  for (let i = startStep; i < plan.steps.length; i++) {
    // Save checkpoint before each step
    checkpointManager.save({
      taskId,
      step: i,
      state,
      messages: memory.getMessages(),
      timestamp: Date.now(),
    });
    
    const result = await executeStep(plan.steps[i]);
    (state.results as unknown[]).push(result);
  }
  
  // Clean up checkpoint on completion
  checkpointManager.delete(taskId);
  return state;
}
```

---

## Cost Management

AI agent costs can spiral. Track and limit them:

```typescript
interface CostTracker {
  /** Track a single LLM call */
  trackLLMCall(model: string, inputTokens: number, outputTokens: number): void;
  
  /** Track a tool call */
  trackToolCall(toolName: string, costCents: number): void;
  
  /** Get total cost for a session */
  getSessionCost(sessionId: string): number;
  
  /** Check if budget is exceeded */
  isOverBudget(sessionId: string, budgetCents: number): boolean;
}

// Pricing per 1M tokens (as of early 2025)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o':           { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':      { input: 0.15,  output: 0.60  },
  'claude-3-5-sonnet': { input: 3.00, output: 15.00 },
  'claude-3-5-haiku':  { input: 0.80,  output: 4.00  },
};

function calculateLLMCost(
  model: string, 
  inputTokens: number, 
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  
  return Math.round((inputCost + outputCost) * 100); // cents
}
```

### Cost Alerts

```typescript
class CostAlertManager {
  private alerts: Array<{ threshold: number; action: (cost: number) => void }> = [];
  
  addAlert(thresholdCents: number, action: (cost: number) => void): void {
    this.alerts.push({ threshold: thresholdCents, action });
  }
  
  check(currentCostCents: number): void {
    for (const alert of this.alerts) {
      if (currentCostCents >= alert.threshold) {
        alert.action(currentCostCents);
      }
    }
  }
}

// Usage
const costAlerts = new CostAlertManager();

// Warn at $1
costAlerts.addAlert(100, (cost) => {
  logger.warn({ cost }, 'Session cost exceeded $1');
});

// Hard stop at $5
costAlerts.addAlert(500, (cost) => {
  logger.error({ cost }, 'Session cost exceeded $5 — terminating');
  throw new Error('Budget exceeded');
});
```

---

## Security Checklist

Before deploying any agent to production:

### ✅ Secrets Management

```bash
# Never hardcode secrets. Use environment variables or a secrets manager.
# Bad:
OPENAI_API_KEY="sk-abc123..." # in code

# Good:
# .env file (not committed to git)
OPENAI_API_KEY=sk-abc123...

# Better:
# AWS Secrets Manager / Hashicorp Vault / 1Password CLI
OPENAI_API_KEY=$(op read "op://Prod/OpenAI/API Key")
```

### ✅ Input Sanitization

```typescript
// Validate all user input before passing to tools
function sanitizeInput(input: string): string {
  return input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // Control characters
    .trim()
    .slice(0, 10_000); // Length limit
}
```

### ✅ Network Security

```typescript
// Block tools from accessing internal network
const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '169.254.169.254', '10.', '172.16.', '192.168.'];

function isInternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return BLOCKED_HOSTS.some(h => parsed.hostname.startsWith(h));
  } catch {
    return true; // Block invalid URLs
  }
}
```

### ✅ File System Security

```typescript
// Jail file operations to a specific directory
function securePath(basePath: string, requestedPath: string): string {
  const resolved = path.resolve(basePath, requestedPath);
  if (!resolved.startsWith(path.resolve(basePath))) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}
```

### ✅ Rate Limiting

```typescript
// Limit requests per user/session
const rateLimiter = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userId: string, maxPerMinute: number): boolean {
  const now = Date.now();
  const entry = rateLimiter.get(userId);
  
  if (!entry || now > entry.resetAt) {
    rateLimiter.set(userId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  
  if (entry.count >= maxPerMinute) return false;
  entry.count++;
  return true;
}
```

### Full Checklist

- [ ] All secrets in environment variables (not in code)
- [ ] HTTPS everywhere (API endpoints, webhooks)
- [ ] Rate limiting on all endpoints
- [ ] Input validation on all tool inputs
- [ ] File system jailing for file tools
- [ ] Network access restrictions (no internal network)
- [ ] SQL injection prevention (parameterized queries)
- [ ] Code execution sandboxing (if applicable)
- [ ] Resource limits (CPU, memory, disk)
- [ ] Logging (no secrets in logs)
- [ ] Monitoring and alerting
- [ ] Cost limits per session/user
- [ ] Graceful shutdown handling
- [ ] Backup strategy for persistent data

---

**Next:** [Chapter 5 — Monetization →](./05-monetization.md)
