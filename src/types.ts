// ═══════════════════════════════════════
// ATLAS — Core Type Definitions
// ═══════════════════════════════════════

/** Message in a conversation */
export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/** Content block within a message (Anthropic format) */
export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  // Image support (Anthropic native format)
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

/** Tool definition for model consumption */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  dangerous?: boolean;
}

/** Result of a tool execution */
export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

/** A tool that ATLAS can use */
export interface Tool {
  definition: ToolDefinition;
  execute(params: Record<string, unknown>): Promise<ToolResult>;
}

/** A tool call from the model */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Response from a model provider */
export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  rawContent: ContentBlock[];
  model: string;
  tokensUsed: { input: number; output: number };
  stopReason: string;
}

/** Options for model chat calls (temperature, maxTokens) */
export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

/** Streaming event emitted during chatStream() */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string }
  | { type: 'tool_input_delta'; toolCallId: string; partialJson: string }
  | { type: 'content_complete'; response: ModelResponse }
  | { type: 'error'; error: string };

/** Callback for receiving stream events */
export type StreamCallback = (event: StreamEvent) => void;

/** Interface for model providers */
export interface ModelProvider {
  name: string;
  chat(
    systemPrompt: string,
    messages: Message[],
    tools?: ToolDefinition[],
    chatOptions?: ChatOptions
  ): Promise<ModelResponse>;
  /** Optional streaming support */
  chatStream?(
    systemPrompt: string,
    messages: Message[],
    tools?: ToolDefinition[],
    chatOptions?: ChatOptions,
    onEvent?: StreamCallback
  ): Promise<ModelResponse>;
}

/** Incoming message from any channel */
export interface IncomingMessage {
  id: string;
  channel: string;
  chatId: string;
  userId: string;
  userName?: string;
  text: string;
  attachments?: Attachment[];
  replyToMessageId?: string;
  timestamp: Date;
}

/** File/media attachment */
export interface Attachment {
  type: 'image' | 'audio' | 'video' | 'document' | 'voice';
  url?: string;
  buffer?: Buffer;
  mimeType: string;
  fileName?: string;
  fileSize?: number;
  path?: string;
}

/** Outgoing message to a channel */
export interface OutgoingMessage {
  text: string;
  parseMode?: 'markdown' | 'html' | 'plain';
  attachments?: OutgoingAttachment[];
  replyToMessageId?: string;
}

/** Outgoing file attachment */
export interface OutgoingAttachment {
  type: 'image' | 'document' | 'audio';
  buffer?: Buffer;
  path?: string;
  fileName?: string;
}

/** Channel interface for communication */
export interface Channel {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(chatId: string, message: OutgoingMessage): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  isRunning(): boolean;
}

/** Result of processing a message through the cognitive loop */
export interface ProcessResult {
  response: string;
  model: string;
  tokensUsed: { input: number; output: number };
  toolsUsed: string[];
  processingTime: number;
  sessionId: string;
}

/** A stored fact in semantic memory */
export interface Fact {
  id: string;
  key: string;
  value: string;
  category: string;
  source: string;
  confidence: number;
  timesReferenced: number;
  createdAt: string;
  updatedAt: string;
}

/** A stored episode in episodic memory */
export interface Episode {
  id: string;
  sessionId: string;
  channel: string;
  role: string;
  content: string;
  toolsUsed: string | null;
  model: string | null;
  tokensUsed: number | null;
  timestamp: string;
}

/** Approval handler for dangerous operations */
export type ApprovalHandler = (action: {
  tool: string;
  params: Record<string, unknown>;
  description: string;
}) => Promise<boolean>;

/** Audit log entry */
export interface AuditEntry {
  id: string;
  action: string;
  tool: string;
  params: string;
  result: string;
  success: boolean;
  model: string;
  timestamp: string;
}

// ── Phase 4: Intelligence Types ──

/** Working memory context for system prompt injection */
export interface WorkingMemoryContext {
  temporal: {
    datetime: string;
    dayOfWeek: string;
    timeOfDay: 'madrugada' | 'mañana' | 'tarde' | 'noche';
    isWeekend: boolean;
  };
  relevantFacts: Array<{ key: string; value: string }>;
  similarEpisodes: Array<{
    summary: string;
    date: string;
    relevanceScore: number;
  }>;
  userProfile: string;
  recentMessages: number;
  activeGoals: string[];
}

/** Result from the Reflector module */
export interface ReflectionResult {
  facts: Array<{ key: string; value: string; confidence: number }>;
  qualityScore: number;
  qualityNotes: string;
  patternsDetected: string[];
  skillGaps: string[];
  improvements: string[];
}

/** A stored reflection */
export interface Reflection {
  id: string;
  sessionId: string;
  insight: string;
  type: string;
  createdAt: string;
}

// ── Phase 5: Sentinel Types ──

/** A scheduled task managed by the Scheduler */
export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  schedule: string;
  handler: string;
  params?: Record<string, any>;
  channel?: string;
  chatId?: string;
  enabled: boolean;
  createdBy: 'system' | 'user' | 'atlas';
  lastRun?: string;
  lastResult?: string;
  runCount: number;
}

/** Handler that executes scheduled task logic */
export interface TaskHandler {
  execute(params: Record<string, any>): Promise<string | null>;
}

/** Stats from historical metric comparison */
export interface MetricStats {
  avg: number;
  stddev: number;
  samples: number;
}

/** Anomaly analysis report */
export interface AnomalyReport {
  anomalies: string[];
  analysis: string;
  timestamp: Date;
}

/** Auto-fix definition for the Watchdog */
export interface AutoFix {
  condition: string;
  action: string;
  command?: string;
  requiresApproval: boolean;
}

// ── Phase 6: Forge / Auto-Evolution Types ──

/** A dynamically created skill/tool */
export interface DynamicSkill {
  id: string;
  name: string;
  displayName: string;
  description: string;
  version: number;
  parameters: ToolParameter[];
  code: string;
  dependencies: string[];
  createdBy: 'user' | 'atlas' | 'meta-learner';
  createdAt: Date;
  updatedAt: Date;
  usageCount: number;
  successRate: number;
  averageExecutionMs: number;
  tags: string[];
  enabled: boolean;
  testCases: TestCase[];
  // Forge v2
  composable?: boolean;
  templateUsed?: string;
  previousVersionCode?: string;
  rollbackBaseline?: {
    successRate: number;
    version: number;
    measuredAt: string;
    usageCountAtBaseline: number;
  };
}

/** Test case for validating a dynamic skill */
export interface TestCase {
  description: string;
  input: Record<string, any>;
  expectedBehavior: string;
  timeout: number;
}

/** Parameter definition for a dynamic skill */
export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
  default?: any;
  enum?: string[];
}

/** Spec generated by AI for a new skill */
export interface SkillSpec {
  name: string;
  displayName: string;
  description: string;
  parameters: ToolParameter[];
  dependencies: string[];
  tags: string[];
  testCases: TestCase[];
  composable?: boolean;
  templateUsed?: string;
}

/** Runtime context injected into skill execution */
export interface SkillRuntimeContext {
  userId: string;
  channel: string;
  isOwner: boolean;
  locale: string;
  timeOfDay: string;
  datetime: string;
  availableTools: string[];
}

/** Skill template archetype */
export interface SkillTemplate {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  skeleton: string;
  defaultDependencies: string[];
  composable: boolean;
}

/** Result of sandbox code execution */
export interface SandboxResult {
  success: boolean;
  output: any;
  error?: string;
  executionMs: number;
  memoryUsedMB: number;
}

/** Result of sandbox code validation */
export interface ValidationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

/** Report from the Meta-Learner analysis */
export interface MetaLearningReport {
  repetitiveTasks: Array<{ pattern: string; frequency: string; suggestion: string; details: string }>;
  skillImprovements: Array<{ skillName: string; issue: string; suggestedFix: string }>;
  usagePatterns: Array<{ pattern: string; suggestion: string }>;
  proposedSkills: Array<{ name: string; description: string; reason: string }>;
  deadSkills: string[];
  systemImprovements: string[];
}

// ── Behavior Engine Types ──

export interface BehaviorEvent {
  eventType: string;
  eventKey: string;
  channel: string;
  dayOfWeek: number;
  hour: number;
  sessionId: string;
  metadata?: Record<string, any>;
}

export interface BehaviorPattern {
  id: number;
  patternType: string;
  description: string;
  patternKey: string;
  confidence: number;
  occurrences: number;
  lastSeen: string;
  active: boolean;
}

export interface ProactiveSuggestion {
  id: number;
  type: string;
  content: string;
  priority: number;
  status: string;
}

export interface BehaviorAnalysisResult {
  patternsFound: number;
  patternsUpdated: number;
  suggestions: ProactiveSuggestion[];
  anomalies: string[];
}

// ── Phase 7: Nexus / Multi-Agent Types ──

/** Definition of a specialized agent */
export interface AgentDefinition {
  id: string;
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  preferredModel: string;
  preferredTools: string[];
  triggerKeywords: string[];
  triggerPatterns: RegExp[];
  capabilities: string[];
  temperature: number;
  maxTokens: number;
  enabled: boolean;
}

/** Result from a single agent execution */
export interface AgentResult {
  agentId: string;
  agentName: string;
  response: string;
  toolsUsed: string[];
  confidence: number;
  executionMs: number;
  metadata?: Record<string, any>;
}

/** Routing decision from the Coordinator */
export interface RoutingDecision {
  primaryAgent: string;
  secondaryAgents: string[];
  confidence: number;
  reasoning: string;
  mode: 'single' | 'parallel' | 'sequential' | 'consensus';
}

/** Options to override CognitiveLoop defaults */
export interface CognitiveLoopOptions {
  systemPrompt?: string;
  toolDefs?: ToolDefinition[];
  providerName?: string;
  temperature?: number;
  maxTokens?: number;
  skipMemory?: boolean;
  skipReflection?: boolean;
}

// ── Phase 9: v0.9 Features ──

/** Pipeline step definition */
export interface PipelineStep {
  type: 'call_tool' | 'send_message' | 'save_fact' | 'route_to_agent' | 'wait' | 'condition' | 'call_n8n';
  params: Record<string, any>;
  description?: string;
}

/** Pipeline definition stored in DB */
export interface PipelineDefinition {
  id: string;
  name: string;
  description: string;
  triggerEvent: string;
  triggerFilter?: Record<string, any>;
  steps: PipelineStep[];
  enabled: boolean;
  runCount: number;
  lastRun?: string;
  lastResult?: string;
  createdBy: string;
}

/** Knowledge graph entity */
export interface KGEntity {
  id: string;
  name: string;
  type: string;
  properties: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

/** Knowledge graph relationship */
export interface KGRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  properties: Record<string, any>;
  bidirectional: boolean;
  createdAt: string;
}

/** Goal definition */
export interface GoalDefinition {
  id: string;
  name: string;
  description: string;
  strategy: string;
  schedule: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
  progress: number;
  stepsCompleted: string[];
  nextStep: string;
  context: Record<string, any>;
  channel?: string;
  createdAt: string;
  completedAt?: string;
}

/** A/B test variant */
export interface ABVariant {
  id: string;
  name: string;
  content: string;
  weight: number;
}

/** A/B test definition */
export interface ABTestDefinition {
  id: string;
  name: string;
  description: string;
  sectionId: string;
  variants: ABVariant[];
  status: 'draft' | 'running' | 'completed';
  winnerVariant?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

/** Personality profile */
export interface PersonalityProfile {
  id: string;
  name: string;
  displayName: string;
  temperature: number;
  toneInstructions: string;
  emojiLevel: 'none' | 'minimal' | 'moderate' | 'heavy';
  formality: 'formal' | 'casual' | 'technical' | 'creative';
  active: boolean;
  autoSwitchRules?: Record<string, any>;
}

/** Plugin info */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  source: 'local' | 'npm';
  toolsProvided: string[];
  enabled: boolean;
  installedAt: string;
}

/** User role for multi-user */
export type UserRole = 'owner' | 'admin' | 'user' | 'guest';

/** User definition */
export interface UserDefinition {
  id: string;
  identifier: string;
  displayName: string;
  role: UserRole;
  channels: string[];
  createdAt: string;
  lastSeen: string;
}

/** Extended working memory context with graph */
export interface ExtendedWorkingMemoryContext extends WorkingMemoryContext {
  graphContext?: Array<{ entity: string; type: string; relationships: string[] }>;
  documentChunks?: Array<{ content: string; source: string; score: number }>;
}

/** Interface for anything that can process messages (CognitiveLoop or Coordinator) */
export interface MessageProcessor {
  process(
    userMessage: string,
    sessionId: string,
    channel: string,
    attachments?: Attachment[],
    options?: CognitiveLoopOptions
  ): Promise<ProcessResult>;
  onToolUse?: (toolName: string, params: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, success: boolean) => void;
  /** Optional streaming callback — set by channels that support streaming */
  onStreamDelta?: StreamCallback;
}
