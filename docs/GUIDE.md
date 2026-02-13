# ATLAS — System Documentation

Complete technical reference for ATLAS v1.2. Covers architecture, tools, skills, plugins, agents, pipelines, memory, channels, and configuration.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Cognitive Loop](#cognitive-loop)
3. [Creating Tools](#creating-tools)
4. [Skill Forge (Dynamic Tool Creation)](#skill-forge)
5. [Plugins](#plugins)
6. [Agents (Nexus)](#agents-nexus)
7. [Sub-Agents](#sub-agents)
8. [Pipelines](#pipelines)
9. [Scheduler & Proactive Tasks](#scheduler--proactive-tasks)
10. [Memory System](#memory-system)
11. [Channels](#channels)
12. [Model Providers (Thalamus)](#model-providers-thalamus)
13. [Security & Approval](#security--approval)
14. [Webhooks](#webhooks)
15. [MCP (Model Context Protocol)](#mcp-model-context-protocol)
16. [Home Automation (Domotica)](#home-automation)
17. [RAG (Document Intelligence)](#rag-document-intelligence)
18. [Dashboard](#dashboard)
19. [Configuration Reference](#configuration-reference)

---

## Architecture Overview

ATLAS follows a neuroscience-inspired modular architecture:

```
CHANNELS (CLI, Telegram, WhatsApp, Web, Discord, Slack, Dashboard)
    │
    ▼
NEXUS — Coordinator (3-level routing, 4 execution modes, 6+ agents)
    │
    ▼
CORTEX — Cognitive Loop (Perceive → Contextualize → Act → Learn → Reflect)
    │
    ├── HIPPOCAMPUS (Episodic, Semantic, Vector, Knowledge Graph)
    ├── MOTOR (ToolRegistry, ToolExecutor, 50+ tools)
    └── THALAMUS (ModelRouter: Claude, GPT, Ollama, Gemini, LMStudio, OpenRouter)
    │
    ▼
SENTINEL — Background Engine (Scheduler, Proactive, Anomaly, Pipelines, Webhooks)
```

### Key Design Decisions

- **CommonJS module system** — Required for better-sqlite3 + chalk v4 compatibility.
- **Anthropic internal format** — All messages use Anthropic's `ContentBlock` format internally. OpenAI/Ollama providers convert both directions.
- **MessageProcessor interface** — Abstracts `CognitiveLoop` and `Coordinator` interchangeably. When `NEXUS_ENABLED=false`, messages go directly to `CognitiveLoop`.
- **Conditional registration** — Channels, tools, and integrations only load when their configuration is present.

---

## Cognitive Loop

The `CognitiveLoop` (`src/cortex/cognitive-loop.ts`) is the brain of ATLAS. It processes every user message through a 5-phase cycle:

### Phase 1: PERCEIVE
Parse the incoming message, detect intent, identify attachments (images, documents, audio).

### Phase 2: CONTEXTUALIZE
Build a rich context using `WorkingMemory`:
- **Temporal context** — Time of day, day of week, weekend detection
- **User profile** — Facts about the user from semantic memory
- **Relevant facts** — Semantic search via VectorStore
- **Similar episodes** — Past conversations with relevance scoring
- **Document chunks** — RAG results if relevant documents exist
- **Knowledge graph** — Related entities and relationships

### Phase 3: ACT
Send the message + context + tools to the AI model. If the model returns tool calls, execute them and iterate (up to 30 iterations). Tools are executed via the `ToolExecutor` which handles:
- Dangerous tool detection → Approval system
- Smart retry on transient failures
- Execution logging for analytics

### Phase 4: LEARN
Store the interaction in episodic memory. Update session metadata.

### Phase 5: REFLECT
The `Reflector` runs async (non-blocking) after each response:
- Extract facts with confidence scores
- Score response quality
- Detect patterns
- Identify skill gaps
- Every N interactions: deep reflection (comprehensive analysis)

### Options Override

```typescript
interface CognitiveLoopOptions {
  systemPrompt?: string;     // Override system prompt
  toolDefs?: ToolDefinition[];  // Override available tools
  providerName?: string;     // Force specific model
  temperature?: number;
  maxTokens?: number;
  skipMemory?: boolean;      // Don't store in episodic memory
  skipReflection?: boolean;  // Skip post-response reflection
}
```

---

## Creating Tools

Tools are ATLAS's way of interacting with the world. Every tool implements the `Tool` interface.

### Tool Interface

```typescript
interface Tool {
  definition: ToolDefinition;
  execute(params: Record<string, unknown>): Promise<ToolResult>;
}

interface ToolDefinition {
  name: string;              // snake_case, unique
  description: string;       // AI reads this to decide when to use the tool
  input_schema: Record<string, unknown>;  // JSON Schema
  dangerous?: boolean;       // Requires user approval
}

interface ToolResult {
  success: boolean;
  output: string;           // AI reads this — always a human-readable string
  error?: string;
}
```

### Creating a New Tool

Create a file in `src/motor/tools/`:

```typescript
// src/motor/tools/my-tool.ts

import { Tool, ToolResult } from '../../types';

export class MyTool implements Tool {
  definition = {
    name: 'my_tool',
    description: 'Does something useful. The AI reads this description to decide when to call this tool.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to look up',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return',
          default: 10,
        },
      },
      required: ['query'],
    },
    dangerous: false,  // Set to true if it modifies external state
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const query = params.query as string;
    const limit = (params.limit as number) || 10;

    try {
      // Your implementation here
      const results = await doSomething(query, limit);

      return {
        success: true,
        output: `Found ${results.length} results:\n${results.join('\n')}`,
      };
    } catch (err: any) {
      return {
        success: false,
        output: '',
        error: err.message,
      };
    }
  }
}
```

### Registering the Tool

In `src/index.ts` (or your bootstrap file), register it with the `ToolRegistry`:

```typescript
import { MyTool } from './motor/tools/my-tool';

// In your initialization code:
toolRegistry.register(new MyTool());
```

### Conditional Registration

Many tools only register when their dependencies are configured:

```typescript
if (config.laravelApiUrl) {
  toolRegistry.register(new LaravelApiTool());
}
```

### Dangerous Tools

Tools marked `dangerous: true` require user approval before execution. The approval system routes through whatever channel the user is on (CLI buttons, Telegram inline keyboard, Discord buttons, etc.).

```typescript
definition = {
  name: 'shell',
  description: 'Execute a shell command',
  input_schema: { /* ... */ },
  dangerous: true,  // Will ask for approval
};
```

### ToolExecutor & Smart Retry

The `ToolExecutor` wraps all tool calls with:
- Approval checks for dangerous tools
- Audit logging (tool name, params, result, risk level)
- Dashboard event emission
- Fallback map: if a tool fails, try an alternative

---

## Skill Forge

The Skill Forge (`src/forge/skill-forge.ts`) lets ATLAS create new tools dynamically from natural language descriptions.

### How It Works

1. **User describes** what they need: "I need a tool that checks the dollar price in Colombia"
2. **AI generates specification** — name, parameters, description, test cases
3. **AI generates TypeScript code** — following the `execute()` pattern
4. **Sandbox validates** — static analysis, compile check, test execution
5. **Auto-fix** — If validation fails, AI tries to fix the code (2 attempts)
6. **Dependencies installed** — Only whitelisted npm packages
7. **Registered & persisted** — Saved to `skills/{name}/` and registered in ToolRegistry

### Using via Chat

```
User: "Crea un skill que consulte el precio del dólar en Colombia"
ATLAS: [Uses forge_skill tool with action: create]
```

The `forge_skill` tool supports these actions:
- `create` — Create a new skill from description
- `improve` — Improve an existing skill with feedback
- `list` — List all dynamic skills
- `info` — Get details about a specific skill
- `remove` — Disable a skill
- `enable` / `disable` — Toggle a skill on/off
- `stats` — Get usage statistics

### Skill Templates

The Forge uses 9 predefined templates to guide code generation. When a description matches template keywords, the skeleton is provided to the AI for better code quality.

| Template | Type | Description |
|----------|------|-------------|
| `api_fetcher` | Standard | Fetch data from HTTP APIs with retry |
| `web_scraper` | Standard | Extract data from web pages using cheerio |
| `data_transformer` | Standard | Transform, convert, or format data |
| `scheduled_checker` | Standard | Check conditions and generate alerts |
| `file_processor` | Standard | Read, parse, or generate files |
| `multi_step` | Composable | Orchestrate multiple ATLAS tools |
| `database_query` | Composable | Query databases via the database tool |
| `notification_alert` | Composable | Send alerts via ATLAS notifications |
| `memory_driven` | Composable | Read/write ATLAS memory system |

### Composable Skills

Composable skills can call other ATLAS tools via a `callTool()` bridge:

```typescript
// Available in composable skills:
declare function callTool(
  name: string,
  params: Record<string, any>
): Promise<{ success: boolean; output: string; error?: string }>;

// Also available:
declare const context: {
  userId: string;
  channel: string;
  isOwner: boolean;
  datetime: string;
  availableTools: string[];
  getFact: (key: string) => Promise<string | null>;
  searchFacts: (query: string, limit?: number) => Promise<Array<{ key: string; value: string }>>;
  saveFact: (key: string, value: string) => Promise<void>;
};
```

**Limits:**
- Max 10 `callTool()` calls per execution (`FORGE_MAX_CALLTOOL`)
- 5-second timeout per `callTool()` call
- 30-second total timeout (`FORGE_COMPOSABLE_TIMEOUT`)
- Cannot call itself recursively

### Sandbox Security

Two execution modes:
- **Standard skills** — Worker Thread with `resourceLimits` (memory cap)
- **Composable skills** — `vm.createContext()` with limited globals (no `require`, no `process`, no `fs`)

**Static analysis blocks:**
- `process.exit()`, `eval()`, `new Function()`
- `child_process`, `cluster` imports
- `process.env` access
- Explicit infinite loops

**Allowed dependencies whitelist:**
cheerio, xml2js, csv-parse, date-fns, lodash, marked, turndown, qs, form-data, jsdom, node-html-parser

### Auto-Heal

When `FORGE_AUTO_HEAL=true`:
- Tracks failures per skill (last 20)
- After N failures in 1 hour (default: 3) → auto-improves the skill
- Uses real error messages as context for the AI fix
- Saves fact: `skill_autohealed_{name}`

### Auto-Rollback

When `FORGE_AUTO_ROLLBACK=true`:
- Before each `improveSkill()`, saves current code + success rate as baseline
- After N uses (default: 5) of the new version, compares success rates
- If success rate drops by more than threshold (default: 20%) → reverts to previous code
- Saves fact: `forge_rollback_{name}`

### Meta-Learner

The Meta-Learner (`src/forge/meta-learner.ts`) runs on a schedule (default: daily at 3 AM):

1. **Analyzes** recent episodes, skill stats, failures, reflections
2. **Identifies** repetitive tasks, dead skills, improvement opportunities
3. **Proposes** new skills to create
4. **Auto-improves** skills with <50% success rate
5. **Disables** dead skills (0 usage)
6. **Auto-creates** skills from strong patterns (if `META_LEARNER_AUTO_CREATE=true`, max 3/week)

### Skill File Structure

```
skills/
└── check_dollar/
    ├── manifest.json    # Metadata (without code)
    └── handler.ts       # TypeScript source code
```

---

## Plugins

The Plugin system (`src/forge/plugin-manager.ts`) allows loading external tool bundles.

### Plugin Interface

A plugin is a CommonJS module that exports:

```typescript
// plugins/my-plugin.ts

import { Tool, ToolResult } from '../src/types';

export const name = 'my-plugin';
export const version = '1.0.0';
export const description = 'Does cool things';
export const author = 'Jose';

export const tools: Tool[] = [
  {
    definition: {
      name: 'cool_tool',
      description: 'Does something cool',
      input_schema: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Input data' },
        },
        required: ['input'],
      },
    },
    execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
      return {
        success: true,
        output: `Processed: ${params.input}`,
      };
    },
  },
];

// Optional lifecycle hooks
export async function init(config: Record<string, any>): Promise<void> {
  // Called when plugin is loaded
}

export async function destroy(): Promise<void> {
  // Called when plugin is unloaded
}
```

### Plugin Lifecycle

1. **Install** — `pluginManager.install('local', 'my-plugin.ts')`
   - Loads the module via `require()`
   - Validates exports (name, version, tools array)
   - Registers all tools in ToolRegistry
   - Calls `init()` if defined
   - Saves metadata to SQLite

2. **Load on startup** — All enabled plugins auto-load from database

3. **Toggle** — `pluginManager.togglePlugin('my-plugin', false)`
   - Unregisters tools from ToolRegistry
   - Calls `destroy()` if defined

4. **Uninstall** — `pluginManager.uninstall('my-plugin')`
   - Calls `destroy()`, unregisters tools, removes from database

### Plugin Directory

Place plugin files in the `plugins/` directory (configurable via `PLUGINS_DIR`). The PluginManager can:
- `listAvailable()` — Scan directory for uninstalled plugins (reads metadata via regex without executing)
- `listPlugins()` — List all installed plugins with status
- `getLoadedCount()` — Number of currently active plugins

### Managing via Chat

Use the built-in `plugin` tool:
```
User: "Lista los plugins disponibles"
User: "Instala el plugin weather-advanced"
User: "Desactiva el plugin my-plugin"
```

---

## Agents (Nexus)

The Nexus system (`src/nexus/`) orchestrates multiple specialized AI agents.

### Agent Definition

```typescript
interface AgentDefinition {
  id: string;                    // Unique identifier (e.g., 'business')
  name: string;                  // Same as id
  displayName: string;           // Human-readable (e.g., 'Business Analyst')
  description: string;           // What this agent specializes in
  systemPrompt: string;          // Custom system prompt for this agent
  preferredModel: string;        // Model prefix (e.g., 'claude', 'gpt')
  preferredTools: string[];      // Tools this agent prefers
  triggerKeywords: string[];     // Keywords for Level 1 routing
  triggerPatterns: RegExp[];     // Regex patterns for Level 2 routing
  capabilities: string[];        // Capability tags
  temperature: number;           // 0.0-1.0
  maxTokens: number;
  enabled: boolean;
}
```

### Built-in Agents

| Agent | Keywords | Specialty |
|-------|----------|-----------|
| **business** | ventas, inventario, stock, precio... | Sales analysis, inventory, financial metrics |
| **sysadmin** | servidor, deploy, nginx, docker... | Server management, deployment, monitoring |
| **developer** | código, bug, function, API, git... | Code, Laravel, PHP, TypeScript, git |
| **researcher** | investigar, comparar, buscar... | Web research, market analysis, comparisons |
| **creative** | escribir, copy, post, nombre... | Copywriting, social media, naming |
| **general** | *(fallback)* | Everything else |

### 3-Level Routing

The Coordinator (`src/nexus/coordinator.ts`) routes messages through 3 levels:

**Level 1: Keyword Matching** (<1ms)
- Scan message for each agent's `triggerKeywords`
- +1 per keyword found, +2 for keyword at start of message
- If clear winner (score > 1.5x second place) → route

**Level 2: Pattern Matching** (<1ms)
- Test message against each agent's `triggerPatterns` (regex)
- +3 per pattern match
- Combined with Level 1 scores

**Level 3: AI Routing** (100-500ms)
- Only if `NEXUS_AI_ROUTING=true` and no keyword/pattern match
- Sends message + agent descriptions to model
- Model returns JSON routing decision

### Execution Modes

| Mode | Description |
|------|-------------|
| **single** | One agent handles the entire message. Uses CognitiveLoop with full memory/reflection. |
| **parallel** | Multiple agents process simultaneously. Results synthesized by AI. |
| **sequential** | Agents process one after another, each building on previous results. |
| **consensus** | Multiple agents answer independently, then AI synthesizes a consensus. |

### @Prefix Routing

Users can force routing to a specific agent:

```
@dev review this code
@biz what were yesterday's sales?
@sys check server status
@research compare React vs Vue
@write write a social media post
```

Aliases: `dev`→developer, `biz`→business, `sys`→sysadmin, `research`→researcher, `write`→creative

### Creating Custom Agents

Custom agents persist in SQLite + disk (`agents/custom/*.json`). Create via the `agent_manager` tool:

```
User: "Crea un agente especializado en marketing digital"
```

Or programmatically:

```typescript
const definition: AgentDefinition = {
  id: 'marketing',
  name: 'marketing',
  displayName: 'Marketing Specialist',
  description: 'Expert in digital marketing strategies',
  systemPrompt: 'You are a marketing expert...',
  preferredModel: 'claude',
  preferredTools: ['web_search', 'web_fetch'],
  triggerKeywords: ['marketing', 'SEO', 'ads', 'campaign'],
  triggerPatterns: [/campaign|marketing|seo/i],
  capabilities: ['marketing_strategy', 'seo_analysis'],
  temperature: 0.5,
  maxTokens: 4096,
  enabled: true,
};

coordinator.registerAgent(definition);
```

### Routing Feedback

When `ROUTING_FEEDBACK_ENABLED=true`, ATLAS learns from routing corrections:
- If the user says "that should have gone to the developer agent", the system records this
- Future routing considers past corrections

---

## Sub-Agents

Sub-agents (`src/nexus/sub-agent.ts`) are isolated CognitiveLoop instances that run tasks in the background.

### Usage via Chat

```
User: "Necesito que investigues en paralelo: mercado de EVs en Colombia y regulaciones de criptomonedas"
ATLAS: [Uses spawn_agent tool twice, then collects results]
```

The `spawn_agent` tool supports:
- `spawn` — Start a sub-agent with a task description
- `status` — Check progress
- `collect` — Get the result
- `abort` — Cancel a running sub-agent
- `list` — List active and recent sub-agents

### How It Works

1. A new `CognitiveLoop` is created with shared memory but isolated conversation
2. The sub-agent processes its task independently
3. Results are persisted in SQLite (`sub_agents` table)
4. The parent can collect results when ready

---

## Pipelines

Pipelines (`src/sentinel/pipeline-engine.ts`) are event-driven automation workflows.

### Pipeline Definition

```typescript
interface PipelineDefinition {
  id: string;
  name: string;
  description: string;
  triggerEvent: string;          // Event that starts the pipeline
  triggerFilter?: Record<string, any>;  // Optional filter on event data
  steps: PipelineStep[];
  enabled: boolean;
}
```

### Step Types

| Step Type | Description | Params |
|-----------|-------------|--------|
| `call_tool` | Execute any registered ATLAS tool | `{ tool: string, input: {} }` |
| `send_message` | Send a message to a channel | `{ channel: string, chatId: string, message: string }` |
| `save_fact` | Save a fact to semantic memory | `{ key: string, value: string, category?: string }` |
| `route_to_agent` | Delegate to a specific agent | `{ agent: string, message: string }` |
| `wait` | Pause execution (max 30s) | `{ ms: number }` |
| `condition` | Check a condition, optionally abort | `{ field: string, operator: string, value: any, failAction?: 'abort' }` |
| `call_n8n` | Trigger an n8n workflow | `{ workflow_id?: string, webhook_path?: string, payload: {} }` |

### Trigger Events

Pipelines listen for these events:

| Event | Source | Data |
|-------|--------|------|
| `tool_executed` | CognitiveLoop | `{ toolName, params, success, durationMs }` |
| `agent_routed` | Coordinator | `{ agent, mode, confidence }` |
| `channel_connected` | Channel | `{ channel, status }` |
| `channel_disconnected` | Channel | `{ channel, status }` |
| `schedule_triggered` | Scheduler | `{ taskId, result }` |
| `device_state_changed` | DomoticaMonitor | `{ deviceId, changes }` |
| `webhook_received` | WebhookServer | `{ source, payload }` |

### Template Variables

Steps can reference context using `{{path}}` syntax:
- `{{trigger.field}}` — Data from the trigger event
- `{{results.0.output}}` — Output from step 0

### Creating a Pipeline

```json
{
  "name": "lights-off-at-night",
  "description": "Turn off all lights at 11 PM",
  "triggerEvent": "schedule_triggered",
  "triggerFilter": { "taskId": "night_routine" },
  "steps": [
    {
      "type": "call_tool",
      "params": {
        "tool": "domotica",
        "input": { "action": "off", "device_name": "Sala" }
      }
    },
    {
      "type": "send_message",
      "params": {
        "channel": "telegram",
        "chatId": "{{trigger.chatId}}",
        "message": "Luces apagadas. Buenas noches."
      }
    }
  ]
}
```

### Pipeline Execution

- Steps execute sequentially within a pipeline
- If a step fails, the pipeline stops (no partial rollback)
- Maximum steps per pipeline: `PIPELINE_MAX_STEPS` (default: 20)
- Execution history stored in `pipeline_executions` table

---

## Scheduler & Proactive Tasks

The Scheduler (`src/sentinel/scheduler.ts`) manages recurring tasks.

### Backend

- **Primary**: BullMQ (Redis) — persistent, survives restarts
- **Fallback**: node-cron — in-memory, if Redis unavailable

### System Tasks

| Task | Default Schedule | Description |
|------|-----------------|-------------|
| `morning_briefing` | `0 7 * * *` | Morning report with weather, events, stats, WA messages |
| `daily_summary` | `0 20 * * *` | End-of-day summary with interactions, facts learned |
| `health_check` | `*/5 * * * *` | Check local system + remote servers + URLs |
| `deep_reflection` | `0 3 * * *` | Deep analysis of recent interactions |
| `memory_cleanup` | `0 4 * * *` | Summarize old episodes, clean stale data |
| `auto_cleanup` | `0 5 * * 0` | Delete old episodes/metrics, VACUUM |
| `meta_learner` | `0 3 * * *` | Analyze patterns, propose skills |

### Creating Custom Tasks

Via the `schedule_task` tool:

```
User: "Recuérdame revisar las ventas todos los lunes a las 9 AM"
ATLAS: [Creates a scheduled task with cron: 0 9 * * 1]
```

Natural language → cron conversion supports patterns like:
- "every 5 minutes" → `*/5 * * * *`
- "every day at 3 PM" → `0 15 * * *`
- "every Monday at 9 AM" → `0 9 * * 1`
- "every hour" → `0 * * * *`

### Handler Registration

```typescript
scheduler.registerHandler('my_handler', {
  execute: async (params) => {
    // Your logic here
    return 'Task completed successfully';  // or null for silent success
  },
});
```

### Proactive Engine

The `ProactiveEngine` (`src/sentinel/proactive-engine.ts`) provides built-in handlers:

- **morningBriefing** — Collects data points (time, weather, unread WA, overnight events), then uses AI to generate a personalized briefing
- **dailySummary** — Summarizes today's episodes, facts learned, tools used, WA stats
- **healthCheck** — Pings local system (CPU, RAM, disk), remote servers, URLs, API endpoints, database
- **deepReflection** — Delegates to the Reflector module
- **memoryCleanup** — Summarizes episodes older than 30 days, deletes old data
- **autoCleanup** — Deletes episodes >30d, metrics >60d, VACUUMs if DB >100MB

---

## Memory System

The Hippocampus (`src/hippocampus/`) provides 5 memory layers.

### Episodic Memory

Full conversation history stored in SQLite.

```typescript
interface Episode {
  id: string;
  sessionId: string;
  channel: string;
  role: string;         // 'user' | 'assistant'
  content: string;
  toolsUsed: string | null;
  model: string | null;
  tokensUsed: number | null;
  timestamp: string;
}
```

### Semantic Memory (Facts)

Learned facts with confidence scores.

```typescript
interface Fact {
  id: string;
  key: string;           // Unique identifier (e.g., 'user_preference_language')
  value: string;
  category: string;      // 'preference', 'personal', 'technical', etc.
  source: string;        // 'reflection', 'user', 'forge', etc.
  confidence: number;    // 0.0 - 1.0
  timesReferenced: number;
  createdAt: string;
  updatedAt: string;
}
```

Facts are saved by:
- **Reflector** — Extracts facts from conversations (confidence-weighted)
- **User** — Direct via `memory_save` tool
- **Forge** — Records skill creation/healing events
- **Pipelines** — Via `save_fact` step

### Vector Store

SQLite-backed vector store for semantic search.

- **Embeddings**: Generated via Ollama or OpenAI
- **Storage**: Float64Array BLOBs in SQLite
- **Search**: In-memory cosine similarity
- **Factory**: `createVectorStore()` auto-detects available embedding source

### Knowledge Graph

Entity-relationship graph for structured knowledge.

```typescript
interface KGEntity {
  id: string;
  name: string;
  type: string;           // 'person', 'company', 'concept', etc.
  properties: Record<string, any>;
}

interface KGRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;           // 'works_at', 'knows', 'related_to', etc.
  bidirectional: boolean;
}
```

### Working Memory

`WorkingMemory` (`src/hippocampus/working.ts`) builds rich context for each message:

```typescript
interface WorkingMemoryContext {
  temporal: {
    datetime: string;
    dayOfWeek: string;
    timeOfDay: 'madrugada' | 'mañana' | 'tarde' | 'noche';
    isWeekend: boolean;
  };
  relevantFacts: Array<{ key: string; value: string }>;
  similarEpisodes: Array<{ summary: string; date: string; relevanceScore: number }>;
  userProfile: string;
  recentMessages: number;
  activeGoals: string[];
  graphContext?: Array<{ entity: string; type: string; relationships: string[] }>;
  documentChunks?: Array<{ content: string; source: string; score: number }>;
}
```

### Memory Manager API

Key methods on `MemoryManager` (`src/hippocampus/memory-manager.ts`):

| Method | Description |
|--------|-------------|
| `saveFact(key, value, confidence)` | Save/update a fact |
| `getFact(key)` | Get a specific fact |
| `searchFacts(query, limit)` | Search facts by text |
| `deleteFact(id)` | Delete a fact |
| `getAllFacts()` | Get all facts |
| `getFactCount()` | Count facts |
| `getRecentEpisodes(limit)` | Get recent episodes |
| `getTodayEpisodes()` | Get today's episodes |
| `getEpisodeCount()` | Count episodes |
| `saveReflection(sessionId, insight, type)` | Save a reflection |
| `getRecentReflections(limit)` | Get recent reflections |
| `saveMetric(name, value)` | Store a metric data point |
| `getMetricStats(name, hours)` | Get metric statistics |
| `getDBSize()` | Get database size in bytes |
| `vacuum()` | Optimize database |

---

## Channels

Channels are ATLAS's communication interfaces. All channels implement the `Channel` interface.

### Channel Interface

```typescript
interface Channel {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(chatId: string, message: OutgoingMessage): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  isRunning(): boolean;
}
```

### Message Types

```typescript
interface IncomingMessage {
  id: string;
  channel: string;       // 'cli', 'telegram', 'whatsapp', 'web', 'discord', 'slack'
  chatId: string;
  userId: string;
  userName?: string;
  text: string;
  attachments?: Attachment[];
  replyToMessageId?: string;
  timestamp: Date;
}

interface OutgoingMessage {
  text: string;
  parseMode?: 'markdown' | 'html' | 'plain';
  attachments?: OutgoingAttachment[];
  replyToMessageId?: string;
}
```

### Supported Channels

| Channel | Library | Features |
|---------|---------|----------|
| **CLI** | readline | ASCII banner, /commands, color output, approval prompt |
| **Telegram** | grammY | Text, photos, voice, documents, commands, inline keyboards |
| **WhatsApp** | Baileys v7 | QR auth, images, message monitoring, contact tracking |
| **Web** | Express + Socket.IO | Neural canvas interface, real-time, PWA, voice |
| **Discord** | discord.js v14 | Messages, images, commands, approval buttons, guild filtering |
| **Slack** | @slack/bolt v4 | Socket Mode, threads, slash commands, blocks, reactions |

### ChannelManager

The `ChannelManager` (`src/channels/channel-manager.ts`) orchestrates all non-CLI channels:
- Routes incoming messages to the `MessageProcessor` (CognitiveLoop or Coordinator)
- Per-chat queues prevent interleaved responses
- Message formatting per channel (HTML for Telegram, mrkdwn for Slack, markdown for Discord)
- Message splitting by channel limits (4096 Telegram, 3000 Slack, 1900 Discord)
- Cross-channel sending via `sendToChannel(channelName, message, chatId)`

### Adding a New Channel

1. Create `src/channels/my-channel.ts` implementing `Channel`
2. Register in bootstrap: `channelManager.registerChannel(new MyChannel())`
3. Add parse mode and split limit in ChannelManager if needed

### Session Manager

The `SessionManager` (`src/cortex/session-manager.ts`) handles unified sessions:
- **Owner (Jose)**: Single session across ALL channels, 4-hour timeout
- **Other users**: Separate sessions per channel+userId, 1-hour timeout
- Owner detection: CLI/Web = always owner, Telegram by `TELEGRAM_OWNER_CHAT_ID`, WhatsApp by `WHATSAPP_OWNER_NUMBER`, Discord by `DISCORD_OWNER_ID`, Slack by `SLACK_OWNER_ID`
- Persists to SQLite, restores owner session on restart

---

## Model Providers (Thalamus)

The Thalamus (`src/thalamus/`) manages AI model providers through the `ModelRouter`.

### Supported Providers

| Provider | Prefix | Features |
|----------|--------|----------|
| **Claude** | `@claude` | Native function calling, streaming |
| **GPT** | `@gpt` | Anthropic↔OpenAI format conversion |
| **Ollama** | `@ollama` | Local models, retry without tools |
| **Gemini** | `@gemini` | Google Generative AI |
| **LM Studio** | `@lmstudio` | Local models via OpenAI-compatible API |
| **OpenRouter** | `@openrouter` | 200+ models via single API |
| **llama.cpp** | `@llamacpp` | Direct llama.cpp server |

### @Prefix Model Switching

Users can switch models mid-conversation:
```
@gpt Explain quantum computing
@ollama Summarize this article
@claude Write me a haiku
```

### ModelRouter Features

- **Circuit breaker**: After 5 failures → 30-second cooldown
- **Exponential backoff**: 3 retry attempts with increasing delays
- **Fallback chain**: If primary model fails, try next available
- **Sticky override**: `@model` stays active until changed or session ends

### ModelProvider Interface

```typescript
interface ModelProvider {
  name: string;
  chat(
    systemPrompt: string,
    messages: Message[],
    tools?: ToolDefinition[],
    chatOptions?: ChatOptions
  ): Promise<ModelResponse>;
  chatStream?(
    systemPrompt: string,
    messages: Message[],
    tools?: ToolDefinition[],
    chatOptions?: ChatOptions,
    onEvent?: StreamCallback
  ): Promise<ModelResponse>;
}
```

---

## Security & Approval

### Approval System

Tools marked `dangerous: true` require explicit user approval:

1. Tool is called → `ApprovalSystem` checks if dangerous
2. If dangerous → sends approval request to user's channel
3. User approves/denies via channel-specific UI:
   - **CLI**: y/n prompt
   - **Telegram**: Inline keyboard buttons
   - **Discord**: ActionRow buttons
   - **Slack**: Block buttons
   - **Web**: Overlay modal
4. Decision logged in audit trail

### DM Pairing

When `DM_PAIRING_ENABLED=true`, unknown senders must provide a pairing code:
- Owner generates 8-character code via `/pairing` command
- Unknown user sends the code to ATLAS
- After verification, the sender is permanently allowed
- Code alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no ambiguous chars)

### Audit Log

Every tool execution is logged with:
- Tool name, parameters, result
- Success/failure status
- Model used
- Risk level (low/medium/high)
- Agent ID, session ID, channel
- Timestamp

### Shell Safety

```env
REQUIRE_APPROVAL_FOR_SHELL=true
MAX_SHELL_TIMEOUT=30000
BLOCKED_SHELL_COMMANDS=rm -rf /,mkfs,dd if=/dev/zero
```

---

## Webhooks

The Webhook Server (`src/sentinel/webhook-server.ts`) accepts incoming HTTP events.

### Configuration

```env
WEBHOOK_ENABLED=true
WEBHOOK_PORT=5000
```

### Endpoints

```
POST /webhook/:source    — Receive a webhook from any source
GET  /webhook/health     — Health check
```

### Action Types

When a webhook is received, it can:
1. **`notify`** — Send a notification to the owner
2. **`pipeline`** — Trigger a specific pipeline
3. **`tool`** — Execute a tool
4. **`log`** — Log to audit trail

### Example: GitHub Webhook

```
POST /webhook/github
Body: { "action": "opened", "pull_request": { ... } }
→ Triggers pipelines with triggerEvent: "webhook_received"
→ Filter: { "source": "github" }
```

---

## MCP (Model Context Protocol)

ATLAS supports MCP as both a **server** (expose tools to external AI) and a **client** (import tools from external MCP servers).

### MCP Server

When `MCP_SERVER_ENABLED=true`, ATLAS exposes its tools via MCP on port 5050:
- External AI systems can discover and call ATLAS tools
- Authentication via API key

### MCP Client

Configure external MCP servers to import their tools:

```env
MCP_SERVERS=[{"name":"filesystem","url":"http://localhost:3000/mcp"}]
```

Imported tools appear in ToolRegistry alongside native tools.

---

## Home Automation

### Tuya/Smart Life Integration

```env
DOMOTICA_ENABLED=true
TUYA_ACCESS_KEY=...
TUYA_SECRET_KEY=...
TUYA_API_URL=https://openapi.tuyaus.com
TUYA_DEVICE_ID=...     # Any device ID for API auth
```

### DomoticaTool Actions

| Action | Description |
|--------|-------------|
| `on` | Turn device on |
| `off` | Turn device off |
| `toggle` | Toggle device state |
| `status` | Get device status |
| `list` | List all devices |
| `set_value` | Set a specific property value |
| `scenes` | List available scenes |
| `trigger_scene` | Execute a scene |
| `groups` | List device groups |
| `room_control` | Control all devices in a room |

### Multi-Gang Support

Multi-gang switches have multiple switch codes (e.g., `switch_1`, `switch_2`). The tool auto-detects switch codes per device with a priority list. Users can specify via `switch_code` parameter.

### DomoticaMonitor

Polls Tuya API for state changes (interval: `DOMOTICA_POLL_INTERVAL`). Changes emit `device_state_changed` events that can trigger pipelines.

### Dashboard Control

The Dashboard includes a Domotica page with:
- Device list with real-time state
- Per-switch toggle buttons for multi-gang
- Manual refresh button
- Scene triggers

---

## RAG (Document Intelligence)

### Setup

```env
RAG_ENABLED=true
DOCUMENTS_DIR=./data/documents
RAG_CHUNK_SIZE=1000
RAG_CHUNK_OVERLAP=200
```

### Supported Formats

- PDF (via pdf-parse)
- DOCX (via mammoth)
- TXT, MD, CSV, HTML (native)

### How It Works

1. **Ingest**: Place documents in `data/documents/inbox/`
2. **Auto-watch**: `DocumentWatcher` detects new files via chokidar
3. **Parse**: Extract text based on file type
4. **Chunk**: Split by paragraphs with configurable overlap
5. **Embed**: Generate embeddings via Ollama/OpenAI
6. **Store**: Save chunks + embeddings in VectorStore

### Tools

- `doc_search` — Semantic search across indexed documents
- `doc_manage` — Index, list, remove, reindex, stats

### Context Injection

When RAG is enabled, `WorkingMemory.buildContext()` automatically includes relevant document chunks in the system prompt.

---

## Dashboard

### Setup

```env
DASHBOARD_ENABLED=true
DASHBOARD_PORT=4000
DASHBOARD_AUTH=true
DASHBOARD_PASSWORD=your-password
```

### Pages

| Page | Features |
|------|----------|
| **Overview** | System stats, uptime, channels, memory counts |
| **Memory** | Browse/search/edit/delete facts, episodes, reflections |
| **Agents** | List agents, enable/disable, routing stats |
| **Skills** | Forge skills, enable/disable, usage stats |
| **Tasks** | Scheduled tasks, enable/disable, run now |
| **Logs** | Real-time log viewer with level filtering |
| **Config** | Edit .env from browser |
| **Domotica** | Smart home control |
| **Analytics** | Tool usage charts, daily activity |
| **Costs** | AI model usage costs per provider/day/agent |
| **Pipelines** | Visual builder and execution history |
| **Channels** | Health status, message counts, reconnect |

### Authentication

When `DASHBOARD_AUTH=true`:
- JWT-based authentication
- bcrypt password hashing
- httpOnly cookies
- Login rate limiting
- WebSocket JWT verification

### REST API

Full CRUD API at `http://localhost:4000/api/`. See [README](../README.md#api-endpoints) for complete endpoint list.

### Real-time Updates

Dashboard uses Socket.IO for real-time updates:
- System stats every 10 seconds
- Tool execution events
- Agent routing events
- Log entries
- Channel status changes

---

## Configuration Reference

All configuration is via `.env` file. See `.env.example` for the complete list of 130+ variables.

### Core Sections

| Section | Key Variables |
|---------|--------------|
| **Identity** | `ATLAS_NAME`, `ATLAS_OWNER` |
| **AI Models** | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_BASE_URL`, `GEMINI_API_KEY`, `DEFAULT_MODEL` |
| **Channels** | `TELEGRAM_BOT_TOKEN`, `WHATSAPP_ENABLED`, `WEB_ENABLED`, `DISCORD_ENABLED`, `SLACK_ENABLED` |
| **Memory** | `MAX_CONTEXT_MESSAGES`, `REFLECTION_ENABLED`, `KNOWLEDGE_GRAPH_ENABLED` |
| **Nexus** | `NEXUS_ENABLED`, `NEXUS_AGENTS`, `NEXUS_AI_ROUTING` |
| **Sentinel** | `REDIS_URL`, `MORNING_BRIEFING_HOUR`, `HEALTH_CHECK_ENABLED` |
| **Forge** | `FORGE_AUTO_HEAL`, `FORGE_AUTO_ROLLBACK`, `META_LEARNER_ENABLED` |
| **Security** | `REQUIRE_APPROVAL_FOR_SHELL`, `DM_PAIRING_ENABLED` |
| **Production** | `DASHBOARD_ENABLED`, `HEALTH_SERVER_ENABLED`, `RAG_ENABLED`, `BACKUP_ENABLED` |
| **Voice** | `VOICE_AUTO_TRANSCRIBE`, `TTS_PROVIDER`, `STT_PROVIDER` |
| **Domotica** | `DOMOTICA_ENABLED`, `TUYA_ACCESS_KEY`, `TUYA_SECRET_KEY` |
| **Integrations** | `NOTION_API_KEY`, `TWILIO_ACCOUNT_SID`, `SMTP_HOST`, `MQTT_BROKER_URL` |

### Environment-Specific

ATLAS supports environment-specific config files:
- `.env` — Base configuration
- `.env.development` — Development overrides
- `.env.production` — Production overrides

Loaded based on `NODE_ENV` value.

---

<p align="center">
  <sub>ATLAS v1.2 — Built by <strong>Jose</strong>, powered by Claude.</sub>
</p>
