// ═══════════════════════════════════════
// ATLAS — Configuration Manager
// ═══════════════════════════════════════

import dotenv from 'dotenv';
import path from 'path';

const rootDir = path.resolve(__dirname, '..', '..');
const nodeEnv = process.env.NODE_ENV || 'development';

// Load .env.{NODE_ENV} first, then .env as fallback
dotenv.config({ path: path.join(rootDir, `.env.${nodeEnv}`) });
dotenv.config({ path: path.join(rootDir, '.env') });

function env(key: string, fallback: string = ''): string {
  return process.env[key] ?? fallback;
}

function envBool(key: string, fallback: boolean = false): boolean {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val.toLowerCase() === 'true' || val === '1';
}

function envInt(key: string, fallback: number = 0): number {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

export const config = {
  // Environment
  nodeEnv,
  isProd: nodeEnv === 'production',

  // Identity
  name: env('ATLAS_NAME', 'ATLAS'),
  owner: env('ATLAS_OWNER', 'Jose'),

  // Models
  anthropicApiKey: env('ANTHROPIC_API_KEY'),
  claudeModel: env('CLAUDE_MODEL', 'claude-sonnet-4-20250514'),
  openaiApiKey: env('OPENAI_API_KEY'),
  openaiBaseUrl: env('OPENAI_BASE_URL'),
  openaiModel: env('OPENAI_MODEL', 'gpt-4o'),
  ollamaBaseUrl: env('OLLAMA_BASE_URL', 'http://localhost:11434'),
  ollamaModel: env('OLLAMA_MODEL', 'llama3.1'),
  llamacppBaseUrl: env('LLAMACPP_BASE_URL', 'http://localhost:8080'),
  llamacppModel: env('LLAMACPP_MODEL', ''),
  lmstudioBaseUrl: env('LMSTUDIO_BASE_URL', 'http://localhost:1234'),
  lmstudioModel: env('LMSTUDIO_MODEL', ''),
  lmstudioEnabled: envBool('LMSTUDIO_ENABLED', false),
  openrouterApiKey: env('OPENROUTER_API_KEY'),
  openrouterModel: env('OPENROUTER_MODEL', 'anthropic/claude-sonnet-4-20250514'),
  geminiApiKey: env('GEMINI_API_KEY'),
  geminiModel: env('GEMINI_MODEL', 'gemini-2.0-flash'),
  defaultModel: env('DEFAULT_MODEL', 'claude'),

  // Channels
  telegramBotToken: env('TELEGRAM_BOT_TOKEN'),
  whatsappEnabled: envBool('WHATSAPP_ENABLED'),
  webPort: envInt('WEB_PORT', 3000),
  webEnabled: envBool('WEB_ENABLED'),
  cliEnabled: envBool('CLI_ENABLED', true),

  // External APIs
  laravelApiUrl: env('LARAVEL_API_URL'),
  laravelApiToken: env('LARAVEL_API_TOKEN'),
  databaseUrl: env('DATABASE_URL'),

  // Proactivity
  morningBriefingHour: envInt('MORNING_BRIEFING_HOUR', 7),
  morningBriefingChannel: env('MORNING_BRIEFING_CHANNEL', 'telegram'),
  healthCheckInterval: envInt('HEALTH_CHECK_INTERVAL', 5),
  dailySummaryHour: envInt('DAILY_SUMMARY_HOUR', 20),

  // Security
  requireApprovalForShell: envBool('REQUIRE_APPROVAL_FOR_SHELL', true),
  maxShellTimeout: envInt('MAX_SHELL_TIMEOUT', 30000),
  blockedShellCommands: env('BLOCKED_SHELL_COMMANDS', 'rm -rf /,mkfs,dd if=/dev/zero')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // Session Management (Unified Sessions)
  telegramOwnerChatId: env('TELEGRAM_OWNER_CHAT_ID'),
  whatsappOwnerNumber: env('WHATSAPP_OWNER_NUMBER'),
  sessionTimeoutHours: envInt('SESSION_TIMEOUT_HOURS', 4),

  // WhatsApp
  whatsappAllowedNumbers: env('WHATSAPP_ALLOWED_NUMBERS')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // WhatsApp Monitor
  whatsappMonitorEnabled: envBool('WHATSAPP_MONITOR_ENABLED', true),
  whatsappDownloadMedia: envBool('WHATSAPP_DOWNLOAD_MEDIA', true),
  whatsappDownloadImages: envBool('WHATSAPP_DOWNLOAD_IMAGES', true),
  whatsappDownloadDocuments: envBool('WHATSAPP_DOWNLOAD_DOCUMENTS', true),
  whatsappDownloadAudio: envBool('WHATSAPP_DOWNLOAD_AUDIO', true),
  whatsappDownloadVideo: envBool('WHATSAPP_DOWNLOAD_VIDEO', false),
  whatsappMediaDir: env('WHATSAPP_MEDIA_DIR', path.join(rootDir, 'data', 'whatsapp', 'media')),
  whatsappIgnoredChats: env('WHATSAPP_IGNORED_CHATS')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  whatsappInBriefing: envBool('WHATSAPP_IN_BRIEFING', true),
  whatsappInDailySummary: envBool('WHATSAPP_IN_DAILY_SUMMARY', true),

  // Search
  searchEngine: env('SEARCH_ENGINE', 'duckduckgo'),
  braveSearchApiKey: env('BRAVE_SEARCH_API_KEY'),
  searxngUrl: env('SEARXNG_URL'),

  // Memory
  chromaUrl: env('CHROMA_URL', 'http://localhost:8000'),
  maxContextMessages: envInt('MAX_CONTEXT_MESSAGES', 40),

  // Soul / Personality
  emotionalEngineEnabled: envBool('EMOTIONAL_ENGINE_ENABLED', true),

  // Reflection (Phase 4)
  reflectionEnabled: envBool('REFLECTION_ENABLED', true),
  deepReflectionEvery: envInt('DEEP_REFLECTION_EVERY', 50),

  // Embeddings (Phase 4)
  ollamaEmbeddingModel: env('OLLAMA_EMBEDDING_MODEL'),

  // Sentinel (Phase 5)
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
  healthCheckEnabled: envBool('HEALTH_CHECK_ENABLED'),
  healthCheckServers: env('HEALTH_CHECK_SERVERS'),
  healthCheckUrls: env('HEALTH_CHECK_URLS'),
  anomalyCheckInterval: envInt('ANOMALY_CHECK_INTERVAL', 60),
  anomalyThreshold: parseFloat(env('ANOMALY_THRESHOLD', '2.0')),

  // Forge / Auto-Evolution (Phase 6)
  sandboxTimeout: envInt('SANDBOX_TIMEOUT', 30000),
  sandboxMaxMemory: envInt('SANDBOX_MAX_MEMORY', 256),
  metaLearnerEnabled: envBool('META_LEARNER_ENABLED', true),
  metaLearnerSchedule: env('META_LEARNER_SCHEDULE', '0 3 * * *'),

  // Forge v2 — Composable Skills
  forgeComposableEnabled: envBool('FORGE_COMPOSABLE_ENABLED', true),
  forgeMaxCallTool: envInt('FORGE_MAX_CALLTOOL', 10),
  forgeComposableTimeout: envInt('FORGE_COMPOSABLE_TIMEOUT', 30000),

  // Forge v2 — Auto-Heal
  forgeAutoHeal: envBool('FORGE_AUTO_HEAL', true),
  forgeAutoHealMinFailures: envInt('FORGE_AUTO_HEAL_MIN_FAILURES', 3),

  // Forge v2 — Auto-Rollback
  forgeAutoRollback: envBool('FORGE_AUTO_ROLLBACK', true),
  forgeRollbackThreshold: envInt('FORGE_ROLLBACK_THRESHOLD', 20),
  forgeRollbackMinUses: envInt('FORGE_ROLLBACK_MIN_USES', 5),

  // Forge v2 — Meta-Learner Auto-Create
  metaLearnerAutoCreate: envBool('META_LEARNER_AUTO_CREATE', false),
  metaLearnerMaxAutoCreations: envInt('META_LEARNER_MAX_AUTO_CREATIONS', 3),

  // Behavior Engine — Proactive Intelligence
  behaviorEngineEnabled: envBool('BEHAVIOR_ENGINE_ENABLED', true),
  behaviorAnalysisSchedule: env('BEHAVIOR_ANALYSIS_SCHEDULE', '0 */6 * * *'),
  behaviorMinConfidence: parseFloat(env('BEHAVIOR_MIN_CONFIDENCE', '0.6')),
  behaviorSuggestionTtlHours: envInt('BEHAVIOR_SUGGESTION_TTL_HOURS', 24),

  // Nexus / Multi-Agent (Phase 7)
  nexusEnabled: envBool('NEXUS_ENABLED', true),
  nexusAgents: env('NEXUS_AGENTS', 'business,sysadmin,developer,researcher,creative,general')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  nexusAiRouting: envBool('NEXUS_AI_ROUTING', true),

  // Health Server (Production)
  healthServerEnabled: envBool('HEALTH_SERVER_ENABLED'),
  healthServerPort: envInt('HEALTH_SERVER_PORT', 9090),

  // Dashboard (Production)
  dashboardEnabled: envBool('DASHBOARD_ENABLED'),
  dashboardPort: envInt('DASHBOARD_PORT', 4000),
  dashboardAuth: envBool('DASHBOARD_AUTH'),
  dashboardPassword: env('DASHBOARD_PASSWORD'),

  // RAG — Document Intelligence
  ragEnabled: envBool('RAG_ENABLED'),
  documentsDir: env('DOCUMENTS_DIR', path.join(rootDir, 'data', 'documents')),
  ragChunkSize: envInt('RAG_CHUNK_SIZE', 1000),
  ragChunkOverlap: envInt('RAG_CHUNK_OVERLAP', 200),

  // Backup
  backupEnabled: envBool('BACKUP_ENABLED'),
  backupDir: env('BACKUP_DIR', path.join(rootDir, 'backups')),
  backupRetainDays: envInt('BACKUP_RETAIN_DAYS', 14),
  backupSchedule: env('BACKUP_SCHEDULE', '0 2 * * *'),
  backupCompress: envBool('BACKUP_COMPRESS', true),

  // SMTP / Email
  smtpHost: env('SMTP_HOST'),
  smtpPort: envInt('SMTP_PORT', 587),
  smtpUser: env('SMTP_USER'),
  smtpPass: env('SMTP_PASS'),
  smtpFrom: env('SMTP_FROM'),
  smtpSecure: envBool('SMTP_SECURE', false),

  // IMAP (Email reading)
  imapHost: env('IMAP_HOST'),
  imapPort: envInt('IMAP_PORT', 993),
  imapSecure: envBool('IMAP_SECURE', true),
  imapUser: env('IMAP_USER'),
  imapPass: env('IMAP_PASS'),

  // Home Assistant
  homeAssistantUrl: env('HOME_ASSISTANT_URL'),
  homeAssistantToken: env('HOME_ASSISTANT_TOKEN'),

  // v1.1 — Feature Flags
  financialEnabled: envBool('FINANCIAL_ENABLED', true),
  copilotEnabled: envBool('COPILOT_ENABLED', true),

  // v1.2 — New Integrations
  notionApiKey: env('NOTION_API_KEY'),
  twilioAccountSid: env('TWILIO_ACCOUNT_SID'),
  twilioAuthToken: env('TWILIO_AUTH_TOKEN'),
  twilioPhoneNumber: env('TWILIO_PHONE_NUMBER'),
  mqttBrokerUrl: env('MQTT_BROKER_URL'),
  mqttUsername: env('MQTT_USERNAME'),
  mqttPassword: env('MQTT_PASSWORD'),
  elevenLabsApiKey: env('ELEVENLABS_API_KEY'),
  crmEnabled: envBool('CRM_ENABLED', true),
  s3BackupBucket: env('S3_BACKUP_BUCKET'),
  s3BackupRegion: env('S3_BACKUP_REGION', 'us-east-1'),
  s3BackupEndpoint: env('S3_BACKUP_ENDPOINT'),
  gdriveBackupFolder: env('GDRIVE_BACKUP_FOLDER', 'ATLAS-Backups'),

  // Webhooks
  webhookEnabled: envBool('WEBHOOK_ENABLED'),
  webhookPort: envInt('WEBHOOK_PORT', 5000),

  // n8n Integration
  n8nEnabled: envBool('N8N_ENABLED', false),
  n8nUrl: env('N8N_URL', 'http://localhost:5678'),
  n8nApiKey: env('N8N_API_KEY'),
  n8nWebhookBaseUrl: env('N8N_WEBHOOK_BASE_URL'),

  // Google Calendar
  googleClientId: env('GOOGLE_CLIENT_ID'),
  googleClientSecret: env('GOOGLE_CLIENT_SECRET'),
  googleRefreshToken: env('GOOGLE_REFRESH_TOKEN'),

  // Spotify
  spotifyClientId: env('SPOTIFY_CLIENT_ID'),
  spotifyClientSecret: env('SPOTIFY_CLIENT_SECRET'),
  spotifyRefreshToken: env('SPOTIFY_REFRESH_TOKEN'),

  // v0.9 — Smart Routing Feedback
  routingFeedbackEnabled: envBool('ROUTING_FEEDBACK_ENABLED', true),

  // v0.9 — Pipelines
  pipelinesEnabled: envBool('PIPELINES_ENABLED', true),
  pipelineMaxSteps: envInt('PIPELINE_MAX_STEPS', 20),

  // v0.9 — Context Carryover
  contextCarryoverMessages: envInt('CONTEXT_CARRYOVER_MESSAGES', 5),

  // v0.9 — Plugins
  pluginsEnabled: envBool('PLUGINS_ENABLED', true),
  pluginsDir: path.join(rootDir, 'plugins'),

  // v0.9 — Voice Mode
  voiceAutoTranscribe: envBool('VOICE_AUTO_TRANSCRIBE', true),
  voiceAutoRespondAudio: envBool('VOICE_AUTO_RESPOND_AUDIO', false),
  voiceTtsLanguage: env('VOICE_TTS_LANGUAGE', 'es'),

  // STT Provider
  sttProvider: env('STT_PROVIDER', 'openai') as 'openai' | 'groq',
  groqApiKey: env('GROQ_API_KEY', ''),

  // TTS Provider
  ttsProvider: env('TTS_PROVIDER', 'openai') as 'openai' | 'elevenlabs',
  ttsDefaultVoice: env('TTS_DEFAULT_VOICE', ''),

  // ElevenLabs
  elevenlabsApiKey: env('ELEVENLABS_API_KEY', ''),
  elevenlabsVoiceId: env('ELEVENLABS_VOICE_ID', ''),
  elevenlabsModelId: env('ELEVENLABS_MODEL_ID', 'eleven_multilingual_v2'),

  // v0.9 — Goals
  goalsEnabled: envBool('GOALS_ENABLED', true),
  goalsMaxActive: envInt('GOALS_MAX_ACTIVE', 10),

  // v0.9 — Knowledge Graph
  knowledgeGraphEnabled: envBool('KNOWLEDGE_GRAPH_ENABLED', true),

  // v0.9 — Multi-user
  multiUserEnabled: envBool('MULTI_USER_ENABLED', false),

  // v0.9 — Browser Agent
  browserAgentMaxSteps: envInt('BROWSER_AGENT_MAX_STEPS', 10),

  // v0.9 — Personality Profiles
  defaultPersonalityProfile: env('DEFAULT_PERSONALITY_PROFILE', 'casual'),

  // v0.9 — ERP Integration
  erpEnabled: envBool('ERP_ENABLED', false),
  erpCompany: env('ERP_COMPANY', 'default'),

  // v0.9 — Mobile API
  mobileApiEnabled: envBool('MOBILE_API_ENABLED', false),

  // Domótica — Tuya/Smart Life
  domoticaEnabled: envBool('DOMOTICA_ENABLED', false),
  tuyaAccessKey: env('TUYA_ACCESS_KEY'),
  tuyaSecretKey: env('TUYA_SECRET_KEY'),
  tuyaApiUrl: env('TUYA_API_URL', 'https://openapi.tuyaus.com'),
  tuyaDeviceId: env('TUYA_DEVICE_ID'),
  domoticaPollInterval: envInt('DOMOTICA_POLL_INTERVAL', 60),

  // v1.0 — Discord
  discordEnabled: envBool('DISCORD_ENABLED', false),
  discordBotToken: env('DISCORD_BOT_TOKEN'),
  discordAllowedGuilds: env('DISCORD_ALLOWED_GUILDS')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  discordOwnerId: env('DISCORD_OWNER_ID'),

  // v1.0 — Slack
  slackEnabled: envBool('SLACK_ENABLED', false),
  slackBotToken: env('SLACK_BOT_TOKEN'),
  slackAppToken: env('SLACK_APP_TOKEN'),
  slackSigningSecret: env('SLACK_SIGNING_SECRET'),
  slackAllowedChannels: env('SLACK_ALLOWED_CHANNELS')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  slackOwnerId: env('SLACK_OWNER_ID'),

  // v1.0 — DM Pairing
  dmPairingEnabled: envBool('DM_PAIRING_ENABLED', false),
  dmPairingTtlMinutes: envInt('DM_PAIRING_TTL_MINUTES', 60),
  dmPairingMaxPending: envInt('DM_PAIRING_MAX_PENDING', 3),

  // v0.9 — A/B Testing
  abTestingEnabled: envBool('AB_TESTING_ENABLED', false),

  // MCP (Model Context Protocol)
  mcpServerEnabled: envBool('MCP_SERVER_ENABLED', false),
  mcpServerPort: envInt('MCP_SERVER_PORT', 5050),
  mcpServers: env('MCP_SERVERS'), // JSON array of {name, url, apiKey?}

  // Claude Agent SDK
  claudeAgentEnabled: envBool('CLAUDE_AGENT_SDK_ENABLED', false),
  claudeAgentWorkDir: env('CLAUDE_AGENT_WORK_DIR'),
  claudeAgentModel: env('CLAUDE_AGENT_MODEL', 'claude-sonnet-4-5-20250929'),
  claudeAgentMaxTurns: envInt('CLAUDE_AGENT_MAX_TURNS', 25),

  // Paths
  rootDir,
  dataDir: path.join(rootDir, 'data'),
  dbPath: path.join(rootDir, 'data', 'atlas.sqlite'),
  skillsDir: path.join(rootDir, 'skills'),
  dynamicSkillsDir: path.join(rootDir, 'skills', 'dynamic'),
  logsDir: path.join(rootDir, 'data', 'logs'),
} as const;

export type AtlasConfig = typeof config;

/** Validate required config at startup — throws on critical issues */
export function validateConfig(): string[] {
  const warnings: string[] = [];

  if (!config.anthropicApiKey && !config.openaiApiKey) {
    throw new Error('Se requiere al menos ANTHROPIC_API_KEY o OPENAI_API_KEY en .env');
  }

  if (config.dashboardEnabled && config.dashboardAuth && !config.dashboardPassword) {
    warnings.push('DASHBOARD_AUTH habilitado pero DASHBOARD_PASSWORD vacío');
  }

  if (config.ragEnabled && !config.ollamaBaseUrl && !config.openaiApiKey) {
    warnings.push('RAG habilitado pero sin embedding source (Ollama/OpenAI)');
  }

  return warnings;
}
