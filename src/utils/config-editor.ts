// ═══════════════════════════════════════
// ATLAS — Configuration Editor
// Read/write .env with typed schema
// ═══════════════════════════════════════

import fs from 'fs';
import path from 'path';

const rootDir = path.resolve(__dirname, '..', '..');
const envPath = path.join(rootDir, '.env');

// ── Types ─────────────────────────────────────────────

export interface SettingDef {
  key: string;
  label: string;
  description: string;
  type: 'string' | 'boolean' | 'number' | 'password';
  category: string;
  group?: string;
  default: string;
}

export interface SettingValue {
  key: string;
  label: string;
  description: string;
  type: string;
  group: string;
  value: string;
  hasValue: boolean;
  default: string;
}

export interface SettingsCategory {
  id: string;
  label: string;
  settings: SettingValue[];
}

// ── Categories ────────────────────────────────────────

const CATEGORIES: { id: string; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Modelos AI' },
  { id: 'channels', label: 'Canales' },
  { id: 'security', label: 'Seguridad' },
  { id: 'intelligence', label: 'Inteligencia' },
  { id: 'sentinel', label: 'Sentinel' },
  { id: 'nexus', label: 'Nexus & Forge' },
  { id: 'production', label: 'Producción' },
  { id: 'integrations', label: 'Integraciones' },
];

// ── Schema ────────────────────────────────────────────

const SCHEMA: SettingDef[] = [
  // ══════════════ General ══════════════
  { key: 'ATLAS_NAME', label: 'Nombre del Sistema', description: 'Nombre que ATLAS usa al presentarse en conversaciones y notificaciones', type: 'string', category: 'general', default: 'ATLAS' },
  { key: 'ATLAS_OWNER', label: 'Propietario', description: 'Tu nombre. ATLAS personaliza respuestas e interacciones para el dueño', type: 'string', category: 'general', default: 'Jose' },
  { key: 'NODE_ENV', label: 'Entorno', description: 'development o production. Afecta logging, errores y optimizaciones', type: 'string', category: 'general', default: 'development' },
  { key: 'LOG_LEVEL', label: 'Nivel de Log', description: 'Detalle de logs: error (solo errores), warn, info (recomendado), debug (todo)', type: 'string', category: 'general', default: 'info' },

  // ══════════════ Modelos AI ══════════════
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key', description: 'Clave de API de Anthropic para usar Claude. Se obtiene en console.anthropic.com', type: 'password', category: 'models', group: 'Anthropic (Claude)', default: '' },
  { key: 'CLAUDE_MODEL', label: 'Modelo Claude', description: 'Modelo Claude a usar. Opciones: claude-haiku-4-5-20251001 (barato), claude-sonnet-4-5-20250929 (medio), claude-opus-4-6 (premium)', type: 'string', category: 'models', group: 'Anthropic (Claude)', default: 'claude-sonnet-4-20250514' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', description: 'Clave de OpenAI. Habilita GPT, Whisper (audio), DALL-E (imagenes), TTS (voz), Vision (OCR)', type: 'password', category: 'models', group: 'OpenAI', default: '' },
  { key: 'OPENAI_BASE_URL', label: 'OpenAI Base URL', description: 'URL base custom para API compatible con OpenAI. Vacio usa api.openai.com por defecto', type: 'string', category: 'models', group: 'OpenAI', default: '' },
  { key: 'OPENAI_MODEL', label: 'Modelo OpenAI', description: 'Modelo GPT a usar cuando se selecciona @gpt. Opciones: gpt-4o, gpt-4o-mini, gpt-4-turbo', type: 'string', category: 'models', group: 'OpenAI', default: 'gpt-4o' },
  { key: 'OLLAMA_BASE_URL', label: 'Ollama URL', description: 'URL del servidor Ollama para modelos locales. Default: http://localhost:11434', type: 'string', category: 'models', group: 'Ollama (Local)', default: 'http://localhost:11434' },
  { key: 'OLLAMA_MODEL', label: 'Modelo Ollama', description: 'Modelo local por defecto cuando se usa @ollama. Ej: llama3.2:3b, mistral, codellama', type: 'string', category: 'models', group: 'Ollama (Local)', default: 'llama3.1' },
  { key: 'OLLAMA_EMBEDDING_MODEL', label: 'Modelo Embeddings', description: 'Modelo Ollama para embeddings de busqueda semantica. Si vacio usa OLLAMA_MODEL', type: 'string', category: 'models', group: 'Ollama (Local)', default: '' },
  { key: 'LLAMACPP_BASE_URL', label: 'llama.cpp URL', description: 'URL del servidor llama-server. Default: http://localhost:8080. API compatible con OpenAI', type: 'string', category: 'models', group: 'llama.cpp (Local)', default: 'http://localhost:8080' },
  { key: 'LLAMACPP_MODEL', label: 'llama.cpp Modelo', description: 'Alias del modelo GGUF cargado en llama-server. Si vacio, el provider no se registra', type: 'string', category: 'models', group: 'llama.cpp (Local)', default: '' },
  // LM Studio
  { key: 'LMSTUDIO_ENABLED', label: 'LM Studio Habilitado', description: 'Activar LM Studio como proveedor local de modelos. Requiere LM Studio corriendo', type: 'boolean', category: 'models', group: 'LM Studio (Local)', default: 'false' },
  { key: 'LMSTUDIO_BASE_URL', label: 'LM Studio URL', description: 'URL del servidor LM Studio. Default: http://localhost:1234. API compatible con OpenAI', type: 'string', category: 'models', group: 'LM Studio (Local)', default: 'http://localhost:1234' },
  { key: 'LMSTUDIO_MODEL', label: 'LM Studio Modelo', description: 'Nombre del modelo cargado en LM Studio. Si vacio, usa el modelo activo del servidor', type: 'string', category: 'models', group: 'LM Studio (Local)', default: '' },
  // Gemini
  { key: 'GEMINI_API_KEY', label: 'Gemini API Key', description: 'API Key de Google AI Studio (aistudio.google.com). Soporta Gemini 2.0 Flash, Pro, etc', type: 'password', category: 'models', group: 'Gemini', default: '' },
  { key: 'GEMINI_MODEL', label: 'Modelo Gemini', description: 'Modelo a usar: gemini-2.0-flash, gemini-2.0-flash-lite, gemini-2.5-pro-exp-03-25', type: 'string', category: 'models', group: 'Gemini', default: 'gemini-2.0-flash' },
  // OpenRouter
  { key: 'OPENROUTER_API_KEY', label: 'OpenRouter API Key', description: 'API Key de OpenRouter (openrouter.ai). Acceso a 200+ modelos incluyendo Claude, GPT, Llama, Mistral', type: 'password', category: 'models', group: 'OpenRouter', default: '' },
  { key: 'OPENROUTER_MODEL', label: 'Modelo OpenRouter', description: 'Modelo a usar via OpenRouter. Ej: anthropic/claude-sonnet-4-20250514, google/gemini-2.0-flash-001, meta-llama/llama-3.1-70b-instruct', type: 'string', category: 'models', group: 'OpenRouter', default: 'anthropic/claude-sonnet-4-20250514' },
  { key: 'DEFAULT_MODEL', label: 'Modelo por Defecto', description: 'Proveedor de IA principal: claude, gemini, openrouter, openai, ollama, llamacpp. O nombre de modelo', type: 'string', category: 'models', group: 'General', default: 'claude' },

  // ══════════════ Canales ══════════════
  // CLI & Web
  { key: 'CLI_ENABLED', label: 'CLI Habilitado', description: 'Activar interfaz de terminal interactiva con readline y banner ASCII', type: 'boolean', category: 'channels', group: 'CLI & Web', default: 'true' },
  { key: 'WEB_ENABLED', label: 'Web Habilitado', description: 'Activar canal web con chat en el navegador via Socket.IO y REST API', type: 'boolean', category: 'channels', group: 'CLI & Web', default: 'false' },
  { key: 'WEB_PORT', label: 'Puerto Web', description: 'Puerto HTTP para el canal web. El chat estara disponible en http://localhost:PUERTO', type: 'number', category: 'channels', group: 'CLI & Web', default: '3000' },
  // Telegram
  { key: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', description: 'Token del bot de Telegram. Se obtiene hablando con @BotFather en Telegram', type: 'password', category: 'channels', group: 'Telegram', default: '' },
  { key: 'TELEGRAM_OWNER_CHAT_ID', label: 'Owner Chat ID', description: 'Tu chat ID en Telegram. Se obtiene hablando con @userinfobot. Identifica al dueño', type: 'string', category: 'channels', group: 'Telegram', default: '' },
  // WhatsApp (multi-instancia: gestionar instancias desde Dashboard > Channels)
  { key: 'WHATSAPP_ENABLED', label: 'WhatsApp Habilitado', description: 'Activar sistema WhatsApp multi-instancia. Las instancias se gestionan desde Dashboard > Channels', type: 'boolean', category: 'channels', group: 'WhatsApp', default: 'false' },
  { key: 'WHATSAPP_OWNER_NUMBER', label: 'Numero del Dueño', description: 'Tu numero de WhatsApp con codigo de pais (ej: 573006653119). Identifica al dueño en sesiones', type: 'string', category: 'channels', group: 'WhatsApp', default: '' },
  { key: 'WHATSAPP_ALLOWED_NUMBERS', label: 'Numeros Permitidos (default)', description: 'Default para nuevas instancias. Los numeros por instancia se configuran desde Dashboard > Channels', type: 'string', category: 'channels', group: 'WhatsApp', default: '' },
  // Discord
  { key: 'DISCORD_ENABLED', label: 'Discord Habilitado', description: 'Activar canal Discord. Requiere bot token y al menos un guild permitido', type: 'boolean', category: 'channels', group: 'Discord', default: 'false' },
  { key: 'DISCORD_BOT_TOKEN', label: 'Bot Token', description: 'Token del bot de Discord. Se obtiene en discord.com/developers/applications', type: 'password', category: 'channels', group: 'Discord', default: '' },
  { key: 'DISCORD_ALLOWED_GUILDS', label: 'Guilds Permitidos', description: 'IDs de servidores Discord donde el bot puede responder, separados por coma', type: 'string', category: 'channels', group: 'Discord', default: '' },
  { key: 'DISCORD_OWNER_ID', label: 'Owner User ID', description: 'Tu User ID de Discord. Click derecho en tu perfil > Copiar ID (Developer Mode)', type: 'string', category: 'channels', group: 'Discord', default: '' },
  // Slack
  { key: 'SLACK_ENABLED', label: 'Slack Habilitado', description: 'Activar canal Slack en Socket Mode. Requiere bot token + app token', type: 'boolean', category: 'channels', group: 'Slack', default: 'false' },
  { key: 'SLACK_BOT_TOKEN', label: 'Bot Token', description: 'Token xoxb- del bot de Slack. Se obtiene en api.slack.com/apps > OAuth', type: 'password', category: 'channels', group: 'Slack', default: '' },
  { key: 'SLACK_APP_TOKEN', label: 'App Token', description: 'Token xapp- para Socket Mode. Se genera en api.slack.com/apps > Basic Info > App-Level Tokens', type: 'password', category: 'channels', group: 'Slack', default: '' },
  { key: 'SLACK_SIGNING_SECRET', label: 'Signing Secret', description: 'Secret para verificar requests de Slack. Se encuentra en Basic Information', type: 'password', category: 'channels', group: 'Slack', default: '' },
  { key: 'SLACK_ALLOWED_CHANNELS', label: 'Canales Permitidos', description: 'IDs de canales Slack donde el bot responde, separados por coma. Vacio = todos', type: 'string', category: 'channels', group: 'Slack', default: '' },
  { key: 'SLACK_OWNER_ID', label: 'Owner User ID', description: 'Tu Slack User ID. Click en tu perfil > ... > Copy member ID', type: 'string', category: 'channels', group: 'Slack', default: '' },
  // DM Pairing
  { key: 'DM_PAIRING_ENABLED', label: 'DM Pairing', description: 'Usuarios desconocidos necesitan un codigo de verificacion para hablar con ATLAS', type: 'boolean', category: 'security', group: 'DM Pairing', default: 'false' },
  { key: 'DM_PAIRING_TTL_MINUTES', label: 'TTL del Codigo (min)', description: 'Minutos que un codigo de pairing permanece valido antes de expirar', type: 'number', category: 'security', group: 'DM Pairing', default: '60' },
  { key: 'DM_PAIRING_MAX_PENDING', label: 'Max Solicitudes Pendientes', description: 'Maximo de solicitudes de pairing pendientes simultaneamente', type: 'number', category: 'security', group: 'DM Pairing', default: '3' },
  // Sesiones
  { key: 'SESSION_TIMEOUT_HOURS', label: 'Timeout de Sesion', description: 'Horas de inactividad antes de cerrar la sesion. El dueño tiene 4h, otros usuarios 1h', type: 'number', category: 'channels', group: 'Sesiones', default: '4' },
  // WhatsApp Monitor
  { key: 'WHATSAPP_MONITOR_ENABLED', label: 'Monitor (default)', description: 'Default para nuevas instancias. El monitor por instancia se configura desde Dashboard > Channels', type: 'boolean', category: 'channels', group: 'WhatsApp Monitor', default: 'true' },
  { key: 'WHATSAPP_DOWNLOAD_MEDIA', label: 'Descargar Media', description: 'Descargar automaticamente archivos multimedia recibidos en WhatsApp', type: 'boolean', category: 'channels', group: 'WhatsApp Monitor', default: 'true' },
  { key: 'WHATSAPP_DOWNLOAD_IMAGES', label: 'Descargar Imagenes', description: 'Guardar fotos recibidas en la carpeta de media de WhatsApp', type: 'boolean', category: 'channels', group: 'WhatsApp Monitor', default: 'true' },
  { key: 'WHATSAPP_DOWNLOAD_DOCUMENTS', label: 'Descargar Documentos', description: 'Guardar PDFs, Word, Excel y otros documentos recibidos', type: 'boolean', category: 'channels', group: 'WhatsApp Monitor', default: 'true' },
  { key: 'WHATSAPP_DOWNLOAD_AUDIO', label: 'Descargar Audio', description: 'Guardar notas de voz y archivos de audio recibidos', type: 'boolean', category: 'channels', group: 'WhatsApp Monitor', default: 'true' },
  { key: 'WHATSAPP_DOWNLOAD_VIDEO', label: 'Descargar Video', description: 'Guardar videos recibidos (puede usar mucho espacio en disco)', type: 'boolean', category: 'channels', group: 'WhatsApp Monitor', default: 'false' },
  { key: 'WHATSAPP_MEDIA_DIR', label: 'Directorio de Media', description: 'Carpeta donde se guardan los archivos descargados. Vacio = data/whatsapp/media/', type: 'string', category: 'channels', group: 'WhatsApp Monitor', default: '' },
  { key: 'WHATSAPP_IGNORED_CHATS', label: 'Chats Ignorados', description: 'IDs de chats/grupos a ignorar en el monitor, separados por coma', type: 'string', category: 'channels', group: 'WhatsApp Monitor', default: '' },
  { key: 'WHATSAPP_IN_BRIEFING', label: 'Incluir en Briefing', description: 'Incluir resumen de mensajes WhatsApp en el briefing matutino automatico', type: 'boolean', category: 'channels', group: 'WhatsApp Monitor', default: 'true' },
  { key: 'WHATSAPP_IN_DAILY_SUMMARY', label: 'Incluir en Resumen Diario', description: 'Incluir estadisticas de WhatsApp en el resumen diario nocturno', type: 'boolean', category: 'channels', group: 'WhatsApp Monitor', default: 'true' },

  // ══════════════ Seguridad ══════════════
  { key: 'REQUIRE_APPROVAL_FOR_SHELL', label: 'Aprobar Comandos Shell', description: 'Pedir confirmacion antes de ejecutar comandos de terminal. Recomendado: activado', type: 'boolean', category: 'security', default: 'true' },
  { key: 'MAX_SHELL_TIMEOUT', label: 'Shell Timeout (ms)', description: 'Tiempo maximo en milisegundos que un comando shell puede ejecutarse. Default: 30000 (30s)', type: 'number', category: 'security', default: '30000' },
  { key: 'BLOCKED_SHELL_COMMANDS', label: 'Comandos Bloqueados', description: 'Lista de comandos peligrosos que ATLAS nunca ejecutara, separados por coma', type: 'string', category: 'security', default: 'rm -rf /,mkfs,dd if=/dev/zero' },

  // ══════════════ Inteligencia ══════════════
  // Busqueda Web
  { key: 'SEARCH_ENGINE', label: 'Motor de Busqueda', description: 'Motor para busquedas web: duckduckgo (gratis), brave (necesita API key), searxng (self-hosted)', type: 'string', category: 'intelligence', group: 'Busqueda Web', default: 'duckduckgo' },
  { key: 'BRAVE_SEARCH_API_KEY', label: 'Brave Search API Key', description: 'API key de Brave Search. Se obtiene en brave.com/search/api. Gratis hasta 2000 queries/mes', type: 'password', category: 'intelligence', group: 'Busqueda Web', default: '' },
  { key: 'SEARXNG_URL', label: 'SearXNG URL', description: 'URL de tu instancia SearXNG self-hosted. Ej: http://localhost:8888', type: 'string', category: 'intelligence', group: 'Busqueda Web', default: '' },
  // Memoria
  { key: 'CHROMA_URL', label: 'ChromaDB URL', description: 'URL del servidor ChromaDB para almacenamiento vectorial. Opcional', type: 'string', category: 'intelligence', group: 'Memoria', default: 'http://localhost:8000' },
  { key: 'MAX_CONTEXT_MESSAGES', label: 'Max Mensajes en Contexto', description: 'Cantidad maxima de mensajes del historial que se envian al modelo en cada interaccion', type: 'number', category: 'intelligence', group: 'Memoria', default: '40' },
  { key: 'EMOTIONAL_ENGINE_ENABLED', label: 'Motor Emocional', description: 'ATLAS ajusta su tono y personalidad segun el contexto emocional de la conversacion', type: 'boolean', category: 'intelligence', group: 'Memoria', default: 'true' },
  // Reflexion
  { key: 'REFLECTION_ENABLED', label: 'Reflexion Automatica', description: 'Despues de cada interaccion, ATLAS analiza la conversacion y extrae datos utiles', type: 'boolean', category: 'intelligence', group: 'Reflexion', default: 'true' },
  { key: 'DEEP_REFLECTION_EVERY', label: 'Reflexion Profunda cada N', description: 'Cada N interacciones se hace un analisis profundo de patrones y habilidades', type: 'number', category: 'intelligence', group: 'Reflexion', default: '50' },
  // RAG
  { key: 'RAG_ENABLED', label: 'RAG Habilitado', description: 'Busqueda semantica en documentos indexados (PDF, DOCX, TXT). Requiere embeddings', type: 'boolean', category: 'intelligence', group: 'RAG (Documentos)', default: 'false' },
  { key: 'DOCUMENTS_DIR', label: 'Directorio de Documentos', description: 'Carpeta raiz para documentos RAG. Subcarpetas: inbox/ (auto-ingesta), processed/', type: 'string', category: 'intelligence', group: 'RAG (Documentos)', default: '' },
  { key: 'RAG_CHUNK_SIZE', label: 'Tamano de Chunk', description: 'Caracteres por fragmento al indexar documentos. Mayor = mas contexto, menor = mas precision', type: 'number', category: 'intelligence', group: 'RAG (Documentos)', default: '1000' },
  { key: 'RAG_CHUNK_OVERLAP', label: 'Solapamiento de Chunks', description: 'Caracteres de solapamiento entre fragmentos consecutivos para mantener coherencia', type: 'number', category: 'intelligence', group: 'RAG (Documentos)', default: '200' },

  // ══════════════ Sentinel ══════════════
  // Infraestructura
  { key: 'REDIS_URL', label: 'Redis URL', description: 'Conexion a Redis para el scheduler BullMQ. Si no hay Redis, usa node-cron como fallback', type: 'string', category: 'sentinel', group: 'Infraestructura', default: 'redis://localhost:6379' },
  // Proactividad
  { key: 'MORNING_BRIEFING_HOUR', label: 'Hora del Briefing', description: 'Hora (0-23) para enviar el briefing matutino con resumen de novedades', type: 'number', category: 'sentinel', group: 'Proactividad', default: '7' },
  { key: 'MORNING_BRIEFING_CHANNEL', label: 'Canal del Briefing', description: 'Canal donde enviar el briefing: telegram, whatsapp, web, all', type: 'string', category: 'sentinel', group: 'Proactividad', default: 'telegram' },
  { key: 'DAILY_SUMMARY_HOUR', label: 'Hora del Resumen Diario', description: 'Hora (0-23) para enviar el resumen del dia con estadisticas y actividad', type: 'number', category: 'sentinel', group: 'Proactividad', default: '20' },
  { key: 'HEALTH_CHECK_INTERVAL', label: 'Intervalo Health Check', description: 'Minutos entre cada verificacion de salud de servidores y URLs monitoreados', type: 'number', category: 'sentinel', group: 'Proactividad', default: '5' },
  // Health Check
  { key: 'HEALTH_CHECK_ENABLED', label: 'Health Check Habilitado', description: 'Monitoreo automatico de servidores y URLs. Notifica si algo se cae', type: 'boolean', category: 'sentinel', group: 'Health Check', default: 'false' },
  { key: 'HEALTH_CHECK_SERVERS', label: 'Servidores a Monitorear', description: 'Lista de servidores IP:puerto a verificar con ping, separados por coma', type: 'string', category: 'sentinel', group: 'Health Check', default: '' },
  { key: 'HEALTH_CHECK_URLS', label: 'URLs a Monitorear', description: 'Lista de URLs HTTP a verificar (status 200), separadas por coma', type: 'string', category: 'sentinel', group: 'Health Check', default: '' },
  // Anomalias
  { key: 'ANOMALY_CHECK_INTERVAL', label: 'Intervalo de Anomalias', description: 'Segundos entre cada analisis de metricas del sistema (CPU, RAM, disco)', type: 'number', category: 'sentinel', group: 'Deteccion de Anomalias', default: '60' },
  { key: 'ANOMALY_THRESHOLD', label: 'Umbral de Anomalia', description: 'Desviaciones estandar para considerar una metrica anomala. Menor = mas sensible (1.0-5.0)', type: 'number', category: 'sentinel', group: 'Deteccion de Anomalias', default: '2.0' },

  // ══════════════ Nexus & Forge ══════════════
  // Nexus
  { key: 'NEXUS_ENABLED', label: 'Nexus Habilitado', description: 'Sistema multi-agente: enruta mensajes a agentes especializados (negocio, dev, sysadmin...)', type: 'boolean', category: 'nexus', group: 'Nexus (Multi-Agente)', default: 'true' },
  { key: 'NEXUS_AGENTS', label: 'Agentes Activos', description: 'Agentes disponibles separados por coma: business, sysadmin, developer, researcher, creative, general', type: 'string', category: 'nexus', group: 'Nexus (Multi-Agente)', default: 'business,sysadmin,developer,researcher,creative,general' },
  { key: 'NEXUS_AI_ROUTING', label: 'Enrutamiento con IA', description: 'Usar IA para decidir que agente maneja cada mensaje. Si no, usa keywords y patrones', type: 'boolean', category: 'nexus', group: 'Nexus (Multi-Agente)', default: 'true' },
  // Forge
  { key: 'SANDBOX_TIMEOUT', label: 'Sandbox Timeout (ms)', description: 'Tiempo maximo de ejecucion para skills creadas dinamicamente por el Forge', type: 'number', category: 'nexus', group: 'Forge (Auto-Evolucion)', default: '30000' },
  { key: 'SANDBOX_MAX_MEMORY', label: 'Sandbox Memoria Max (MB)', description: 'Memoria maxima permitida para skills dinamicas en sandbox aislado', type: 'number', category: 'nexus', group: 'Forge (Auto-Evolucion)', default: '256' },
  { key: 'META_LEARNER_ENABLED', label: 'Meta-Learner', description: 'ATLAS aprende automaticamente a crear nuevas skills basandose en patrones de uso', type: 'boolean', category: 'nexus', group: 'Forge (Auto-Evolucion)', default: 'true' },
  { key: 'META_LEARNER_SCHEDULE', label: 'Schedule Meta-Learner', description: 'Expresion cron para el ciclo de meta-aprendizaje. Default: 3am diario (0 3 * * *)', type: 'string', category: 'nexus', group: 'Forge (Auto-Evolucion)', default: '0 3 * * *' },
  { key: 'META_LEARNER_AUTO_CREATE', label: 'Auto-Crear Skills', description: 'MetaLearner crea skills automaticamente cuando detecta patrones repetitivos', type: 'boolean', category: 'nexus', group: 'Forge (Auto-Evolucion)', default: 'false' },
  { key: 'META_LEARNER_MAX_AUTO_CREATIONS', label: 'Max Auto-Creaciones', description: 'Maximo de skills que MetaLearner puede crear automaticamente por ciclo', type: 'number', category: 'nexus', group: 'Forge (Auto-Evolucion)', default: '3' },
  { key: 'FORGE_COMPOSABLE_ENABLED', label: 'Skills Composables', description: 'Habilitar skills que pueden llamar a otras herramientas de ATLAS via callTool()', type: 'boolean', category: 'nexus', group: 'Forge (Composable)', default: 'true' },
  { key: 'FORGE_MAX_CALLTOOL', label: 'Max callTool por Skill', description: 'Maximo de llamadas a callTool() permitidas por ejecucion de skill composable', type: 'number', category: 'nexus', group: 'Forge (Composable)', default: '10' },
  { key: 'FORGE_COMPOSABLE_TIMEOUT', label: 'Timeout Composable (ms)', description: 'Tiempo maximo de ejecucion para skills composables. Default: 30s', type: 'number', category: 'nexus', group: 'Forge (Composable)', default: '30000' },
  { key: 'FORGE_AUTO_HEAL', label: 'Auto-Heal de Skills', description: 'Reparar automaticamente skills que fallan en produccion usando IA', type: 'boolean', category: 'nexus', group: 'Forge (Auto-Heal)', default: 'true' },
  { key: 'FORGE_AUTO_HEAL_MIN_FAILURES', label: 'Min Fallos para Auto-Heal', description: 'Cantidad minima de fallos recientes antes de disparar auto-reparacion', type: 'number', category: 'nexus', group: 'Forge (Auto-Heal)', default: '3' },
  { key: 'FORGE_AUTO_ROLLBACK', label: 'Auto-Rollback de Skills', description: 'Revertir automaticamente a version anterior si una skill empeora despues de mejora', type: 'boolean', category: 'nexus', group: 'Forge (Auto-Heal)', default: 'true' },
  { key: 'FORGE_ROLLBACK_THRESHOLD', label: 'Umbral de Rollback (%)', description: 'Si successRate cae por debajo de este % despues de un improve, se revierte', type: 'number', category: 'nexus', group: 'Forge (Auto-Heal)', default: '20' },
  { key: 'FORGE_ROLLBACK_MIN_USES', label: 'Min Usos para Rollback', description: 'Cantidad minima de ejecuciones antes de evaluar si hacer rollback', type: 'number', category: 'nexus', group: 'Forge (Auto-Heal)', default: '5' },

  // ══════════════ Produccion ══════════════
  // Dashboard
  { key: 'DASHBOARD_ENABLED', label: 'Dashboard Habilitado', description: 'Panel de control web con metricas, memoria, agentes, logs y configuracion', type: 'boolean', category: 'production', group: 'Dashboard', default: 'false' },
  { key: 'DASHBOARD_PORT', label: 'Puerto del Dashboard', description: 'Puerto HTTP donde se sirve el dashboard. Acceder en http://localhost:PUERTO', type: 'number', category: 'production', group: 'Dashboard', default: '4000' },
  { key: 'DASHBOARD_AUTH', label: 'Autenticacion Dashboard', description: 'Proteger el dashboard con login JWT. Requiere configurar contraseña', type: 'boolean', category: 'production', group: 'Dashboard', default: 'false' },
  { key: 'DASHBOARD_PASSWORD', label: 'Contraseña Dashboard', description: 'Password para acceder al dashboard. Se hashea con bcrypt al iniciar', type: 'password', category: 'production', group: 'Dashboard', default: '' },
  // Health Server
  { key: 'HEALTH_SERVER_ENABLED', label: 'Health Server', description: 'Servidor HTTP de health probes para Docker/K8s (/health, /ready, /live)', type: 'boolean', category: 'production', group: 'Health Server', default: 'false' },
  { key: 'HEALTH_SERVER_PORT', label: 'Puerto Health Server', description: 'Puerto del servidor de probes. Default: 9090', type: 'number', category: 'production', group: 'Health Server', default: '9090' },
  // Backup
  { key: 'BACKUP_ENABLED', label: 'Backup Automatico', description: 'Crear backups periodicos de la base de datos SQLite (VACUUM INTO)', type: 'boolean', category: 'production', group: 'Backup', default: 'false' },
  { key: 'BACKUP_DIR', label: 'Directorio de Backups', description: 'Carpeta donde se guardan los backups. Vacio = carpeta backups/ en raiz', type: 'string', category: 'production', group: 'Backup', default: '' },
  { key: 'BACKUP_RETAIN_DAYS', label: 'Dias de Retencion', description: 'Backups mas antiguos que estos dias se eliminan automaticamente', type: 'number', category: 'production', group: 'Backup', default: '14' },
  { key: 'BACKUP_SCHEDULE', label: 'Schedule de Backup', description: 'Expresion cron para backups automaticos. Default: 2am diario (0 2 * * *)', type: 'string', category: 'production', group: 'Backup', default: '0 2 * * *' },
  { key: 'BACKUP_COMPRESS', label: 'Comprimir Backups', description: 'Comprimir backups en formato tar.gz para ahorrar espacio en disco', type: 'boolean', category: 'production', group: 'Backup', default: 'true' },

  // ══════════════ Integraciones ══════════════
  // Email (SMTP)
  { key: 'SMTP_HOST', label: 'Servidor SMTP', description: 'Host del servidor de correo. Ej: smtp.gmail.com, smtp.office365.com', type: 'string', category: 'integrations', group: 'Email (SMTP)', default: '' },
  { key: 'SMTP_PORT', label: 'Puerto SMTP', description: 'Puerto del servidor: 587 (TLS/STARTTLS), 465 (SSL), 25 (sin encriptar)', type: 'number', category: 'integrations', group: 'Email (SMTP)', default: '587' },
  { key: 'SMTP_USER', label: 'Usuario SMTP', description: 'Email o usuario para autenticacion SMTP. Ej: atlas@tudominio.com', type: 'string', category: 'integrations', group: 'Email (SMTP)', default: '' },
  { key: 'SMTP_PASS', label: 'Password SMTP', description: 'Contraseña o app password del correo. Para Gmail usar app password de 16 caracteres', type: 'password', category: 'integrations', group: 'Email (SMTP)', default: '' },
  { key: 'SMTP_FROM', label: 'Direccion de Envio', description: 'Direccion que aparece como remitente. Ej: ATLAS <atlas@tudominio.com>', type: 'string', category: 'integrations', group: 'Email (SMTP)', default: '' },
  { key: 'SMTP_SECURE', label: 'Conexion SSL/TLS', description: 'Usar conexion SSL directa (puerto 465). Desactivar para STARTTLS (puerto 587)', type: 'boolean', category: 'integrations', group: 'Email (SMTP)', default: 'false' },
  // Webhooks
  { key: 'WEBHOOK_ENABLED', label: 'Webhooks Habilitados', description: 'Servidor HTTP que recibe eventos externos (GitHub, Stripe, etc) y los procesa', type: 'boolean', category: 'integrations', group: 'Webhooks', default: 'false' },
  { key: 'WEBHOOK_PORT', label: 'Puerto Webhooks', description: 'Puerto HTTP donde escuchan los webhooks. Diferente al dashboard y web channel', type: 'number', category: 'integrations', group: 'Webhooks', default: '5000' },
  // n8n
  { key: 'N8N_ENABLED', label: 'n8n Habilitado', description: 'Integracion bidireccional con servidor n8n remoto para automatizacion de workflows', type: 'boolean', category: 'integrations', group: 'n8n', default: 'false' },
  { key: 'N8N_URL', label: 'n8n URL', description: 'URL del servidor n8n. Ej: https://n8n.tudominio.com o http://ip:5678', type: 'string', category: 'integrations', group: 'n8n', default: 'http://localhost:5678' },
  { key: 'N8N_API_KEY', label: 'n8n API Key', description: 'API Key de n8n. Se genera en n8n > Settings > API > Create API Key', type: 'password', category: 'integrations', group: 'n8n', default: '' },
  { key: 'N8N_WEBHOOK_BASE_URL', label: 'n8n Webhook URL', description: 'URL base para webhooks de n8n si es diferente a la URL principal (ej: con reverse proxy)', type: 'string', category: 'integrations', group: 'n8n', default: '' },
  // Google Calendar
  { key: 'GOOGLE_CLIENT_ID', label: 'Google Client ID', description: 'OAuth2 Client ID de Google Cloud Console para acceso a Calendar API', type: 'password', category: 'integrations', group: 'Google Calendar', default: '' },
  { key: 'GOOGLE_CLIENT_SECRET', label: 'Google Client Secret', description: 'OAuth2 Client Secret. Se obtiene en console.cloud.google.com > Credentials', type: 'password', category: 'integrations', group: 'Google Calendar', default: '' },
  { key: 'GOOGLE_REFRESH_TOKEN', label: 'Google Refresh Token', description: 'Token de refresco OAuth2. Se obtiene con el flujo de autorizacion de Google', type: 'password', category: 'integrations', group: 'Google Calendar', default: '' },
  // Spotify
  { key: 'SPOTIFY_CLIENT_ID', label: 'Spotify Client ID', description: 'App Client ID de Spotify Developer Dashboard (developer.spotify.com)', type: 'password', category: 'integrations', group: 'Spotify', default: '' },
  { key: 'SPOTIFY_CLIENT_SECRET', label: 'Spotify Client Secret', description: 'App Secret de Spotify. Se obtiene en developer.spotify.com/dashboard', type: 'password', category: 'integrations', group: 'Spotify', default: '' },
  { key: 'SPOTIFY_REFRESH_TOKEN', label: 'Spotify Refresh Token', description: 'Token de refresco para control de reproduccion. Requiere scope user-modify-playback-state', type: 'password', category: 'integrations', group: 'Spotify', default: '' },
  // Laravel & Database
  { key: 'LARAVEL_API_URL', label: 'Laravel API URL', description: 'URL base del backend Laravel para consultas de negocio. Ej: https://api.tuapp.com', type: 'string', category: 'integrations', group: 'Laravel & Database', default: '' },
  { key: 'LARAVEL_API_TOKEN', label: 'Laravel API Token', description: 'Bearer token para autenticacion con la API de Laravel', type: 'password', category: 'integrations', group: 'Laravel & Database', default: '' },
  { key: 'DATABASE_URL', label: 'MySQL Database URL', description: 'Conexion MySQL para consultas directas. Formato: mysql://user:pass@host:3306/dbname', type: 'password', category: 'integrations', group: 'Laravel & Database', default: '' },

  // ══════════════ v0.9 Features ══════════════
  { key: 'ROUTING_FEEDBACK_ENABLED', label: 'Feedback de Routing', description: 'Rastrear y mejorar las decisiones de routing con feedback automatico', type: 'boolean', category: 'nexus', group: 'v0.9 Features', default: 'true' },
  { key: 'PIPELINES_ENABLED', label: 'Pipelines', description: 'Cadenas de procesamiento automatizadas con multiples pasos secuenciales', type: 'boolean', category: 'nexus', group: 'v0.9 Features', default: 'true' },
  { key: 'PIPELINE_MAX_STEPS', label: 'Max Pasos Pipeline', description: 'Maximo de pasos permitidos por pipeline para evitar loops infinitos', type: 'number', category: 'nexus', group: 'v0.9 Features', default: '20' },
  { key: 'GOALS_ENABLED', label: 'Motor de Objetivos', description: 'Sistema de metas a largo plazo con seguimiento automatico y pasos programados', type: 'boolean', category: 'nexus', group: 'v0.9 Features', default: 'true' },
  { key: 'GOALS_MAX_ACTIVE', label: 'Max Objetivos Activos', description: 'Cantidad maxima de objetivos que pueden estar activos simultaneamente', type: 'number', category: 'nexus', group: 'v0.9 Features', default: '10' },
  { key: 'KNOWLEDGE_GRAPH_ENABLED', label: 'Grafo de Conocimiento', description: 'Extraccion y almacenamiento de entidades y relaciones del conocimiento', type: 'boolean', category: 'intelligence', group: 'Knowledge Graph', default: 'true' },
  { key: 'BEHAVIOR_ENGINE_ENABLED', label: 'Motor de Comportamiento', description: 'Analiza patrones de uso y sugiere automatizaciones proactivamente', type: 'boolean', category: 'intelligence', group: 'Behavior Engine', default: 'true' },
  { key: 'BEHAVIOR_ANALYSIS_SCHEDULE', label: 'Schedule de Analisis', description: 'Cron para el ciclo de analisis de comportamiento. Default: cada 6h', type: 'string', category: 'intelligence', group: 'Behavior Engine', default: '0 */6 * * *' },
  { key: 'BEHAVIOR_MIN_CONFIDENCE', label: 'Confianza Minima', description: 'Umbral de confianza (0.0-1.0) para sugerir automatizaciones al usuario', type: 'string', category: 'intelligence', group: 'Behavior Engine', default: '0.6' },
  { key: 'BEHAVIOR_SUGGESTION_TTL_HOURS', label: 'TTL de Sugerencias (h)', description: 'Horas que una sugerencia permanece activa antes de expirar', type: 'number', category: 'intelligence', group: 'Behavior Engine', default: '24' },
  { key: 'PLUGINS_ENABLED', label: 'Sistema de Plugins', description: 'Instalar y gestionar plugins que extienden las capacidades de ATLAS', type: 'boolean', category: 'nexus', group: 'v0.9 Features', default: 'true' },
  { key: 'MULTI_USER_ENABLED', label: 'Multi-Usuario', description: 'Soporte para multiples usuarios con roles y permisos diferenciados', type: 'boolean', category: 'security', group: 'Multi-Usuario', default: 'false' },
  { key: 'CONTEXT_CARRYOVER_MESSAGES', label: 'Mensajes de Carryover', description: 'Mensajes del contexto anterior que se mantienen al cambiar de agente', type: 'number', category: 'intelligence', group: 'Memoria', default: '5' },
  { key: 'VOICE_AUTO_TRANSCRIBE', label: 'Transcripcion de Voz', description: 'Transcribir automaticamente notas de voz recibidas usando Whisper', type: 'boolean', category: 'channels', group: 'Voz', default: 'true' },
  { key: 'VOICE_AUTO_RESPOND_AUDIO', label: 'Responder con Audio', description: 'Generar respuesta de voz automatica ademas del texto al recibir notas de voz', type: 'boolean', category: 'channels', group: 'Voz', default: 'false' },
  { key: 'VOICE_TTS_LANGUAGE', label: 'Idioma TTS', description: 'Idioma para sintesis de voz: es (espanol), en (ingles), etc.', type: 'string', category: 'channels', group: 'Voz', default: 'es' },
  { key: 'STT_PROVIDER', label: 'Proveedor STT', description: 'Proveedor para transcripcion de voz: openai (Whisper, de pago) o groq (Whisper gratis)', type: 'string', category: 'channels', group: 'Voz', default: 'openai' },
  { key: 'GROQ_API_KEY', label: 'Groq API Key', description: 'API key de Groq (gratis). Se obtiene en console.groq.com > API Keys. Permite STT sin costo', type: 'password', category: 'channels', group: 'Voz', default: '' },
  { key: 'TTS_PROVIDER', label: 'Proveedor TTS', description: 'Proveedor para sintesis de voz: openai (6 voces) o elevenlabs (voces premium)', type: 'string', category: 'channels', group: 'Voz', default: 'openai' },
  { key: 'TTS_DEFAULT_VOICE', label: 'Voz por Defecto', description: 'OpenAI: alloy/echo/fable/onyx/nova/shimmer. ElevenLabs: voice ID. Vacio usa default del provider', type: 'string', category: 'channels', group: 'Voz', default: '' },
  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API Key', description: 'API key de ElevenLabs. Se obtiene en elevenlabs.io > Profile > API Keys', type: 'password', category: 'channels', group: 'Voz', default: '' },
  { key: 'ELEVENLABS_VOICE_ID', label: 'ElevenLabs Voice ID', description: 'ID de la voz de ElevenLabs. Se obtiene en elevenlabs.io > Voices > Voice ID', type: 'string', category: 'channels', group: 'Voz', default: '' },
  { key: 'ELEVENLABS_MODEL_ID', label: 'ElevenLabs Modelo', description: 'Modelo ElevenLabs: eleven_multilingual_v2 (default, soporta espanol), eleven_turbo_v2 (rapido)', type: 'string', category: 'channels', group: 'Voz', default: 'eleven_multilingual_v2' },
  { key: 'DEFAULT_PERSONALITY_PROFILE', label: 'Perfil de Personalidad', description: 'Perfil activo: casual (relajado), formal (profesional), technical (tecnico)', type: 'string', category: 'intelligence', group: 'Personalidad', default: 'casual' },
  { key: 'BROWSER_AGENT_MAX_STEPS', label: 'Max Pasos Browser Agent', description: 'Pasos maximos que el agente de navegador puede ejecutar en una tarea autonoma', type: 'number', category: 'nexus', group: 'v0.9 Features', default: '10' },
  { key: 'AB_TESTING_ENABLED', label: 'A/B Testing', description: 'Comparar variantes de prompts y configuraciones con metricas automaticas', type: 'boolean', category: 'nexus', group: 'v0.9 Features', default: 'false' },
  { key: 'MOBILE_API_ENABLED', label: 'API Movil', description: 'Endpoint REST optimizado para app movil con autenticacion JWT', type: 'boolean', category: 'production', group: 'API Movil', default: 'false' },
  { key: 'ERP_ENABLED', label: 'ERP Integrado', description: 'Herramienta de gestion empresarial integrada con la API Laravel', type: 'boolean', category: 'integrations', group: 'ERP', default: 'false' },
  { key: 'ERP_COMPANY', label: 'Empresa ERP', description: 'Nombre de la empresa para el modulo ERP. Default: default', type: 'string', category: 'integrations', group: 'ERP', default: 'default' },

  // ══════════════ Domótica ══════════════
  { key: 'DOMOTICA_ENABLED', label: 'Domotica Habilitada', description: 'Control de dispositivos inteligentes via Tuya/Smart Life', type: 'boolean', category: 'integrations', group: 'Domotica (Tuya)', default: 'false' },
  { key: 'TUYA_ACCESS_KEY', label: 'Tuya Access Key', description: 'Access ID de la plataforma Tuya IoT (iot.tuya.com > Cloud > Development)', type: 'password', category: 'integrations', group: 'Domotica (Tuya)', default: '' },
  { key: 'TUYA_SECRET_KEY', label: 'Tuya Secret Key', description: 'Access Secret de Tuya IoT. Se obtiene junto al Access ID en el proyecto cloud', type: 'password', category: 'integrations', group: 'Domotica (Tuya)', default: '' },
  { key: 'TUYA_API_URL', label: 'Tuya API URL', description: 'URL base de la API Tuya. Americas: openapi.tuyaus.com, Europa: openapi.tuyaeu.com', type: 'string', category: 'integrations', group: 'Domotica (Tuya)', default: 'https://openapi.tuyaus.com' },
  { key: 'TUYA_DEVICE_ID', label: 'Tuya Device ID', description: 'ID del dispositivo Tuya principal (hub o dispositivo directo). Opcional si usas discovery', type: 'string', category: 'integrations', group: 'Domotica (Tuya)', default: '' },
  { key: 'DOMOTICA_POLL_INTERVAL', label: 'Intervalo de Poll (s)', description: 'Segundos entre cada consulta de estado de dispositivos. Default: 60', type: 'number', category: 'integrations', group: 'Domotica (Tuya)', default: '60' },

  // ══════════════ v1.1 — New Integrations ══════════════
  // IMAP
  { key: 'IMAP_HOST', label: 'Servidor IMAP', description: 'Host del servidor IMAP para leer emails. Ej: imap.gmail.com, outlook.office365.com', type: 'string', category: 'integrations', group: 'Email (IMAP)', default: '' },
  { key: 'IMAP_PORT', label: 'Puerto IMAP', description: 'Puerto del servidor: 993 (SSL, recomendado), 143 (sin encriptar)', type: 'number', category: 'integrations', group: 'Email (IMAP)', default: '993' },
  { key: 'IMAP_SECURE', label: 'IMAP SSL/TLS', description: 'Usar conexion SSL para IMAP. Recomendado: activado (puerto 993)', type: 'boolean', category: 'integrations', group: 'Email (IMAP)', default: 'true' },
  { key: 'IMAP_USER', label: 'Usuario IMAP', description: 'Email o usuario para autenticacion IMAP. Si vacio, usa SMTP_USER', type: 'string', category: 'integrations', group: 'Email (IMAP)', default: '' },
  { key: 'IMAP_PASS', label: 'Password IMAP', description: 'Contraseña IMAP. Si vacio, usa SMTP_PASS. Para Gmail: app password de 16 caracteres', type: 'password', category: 'integrations', group: 'Email (IMAP)', default: '' },
  // Home Assistant
  { key: 'HOME_ASSISTANT_URL', label: 'Home Assistant URL', description: 'URL del servidor Home Assistant. Ej: http://192.168.1.100:8123 o https://ha.tudominio.com', type: 'string', category: 'integrations', group: 'Home Assistant', default: '' },
  { key: 'HOME_ASSISTANT_TOKEN', label: 'Home Assistant Token', description: 'Long-lived access token. Se obtiene en HA > Perfil > Security > Long-Lived Access Tokens', type: 'password', category: 'integrations', group: 'Home Assistant', default: '' },
  // Financial Tracker
  { key: 'FINANCIAL_ENABLED', label: 'Tracker Financiero', description: 'Herramienta para registrar ingresos y gastos personales y de negocios', type: 'boolean', category: 'integrations', group: 'Financial Tracker', default: 'true' },
  // Copilot Mode
  { key: 'COPILOT_ENABLED', label: 'Modo Copilot', description: 'Vigilancia de directorios con deteccion de cambios en archivos y sugerencias proactivas', type: 'boolean', category: 'integrations', group: 'Copilot Mode', default: 'true' },

  // ══════════════ v1.2 — New Integrations ══════════════
  // Voice TTS
  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API Key', description: 'API key de ElevenLabs para sintesis de voz premium. Alternativa a OpenAI TTS', type: 'password', category: 'integrations', group: 'Voice TTS', default: '' },
  // Notion
  { key: 'NOTION_API_KEY', label: 'Notion API Key', description: 'Token de integracion de Notion. Crear en notion.so/my-integrations', type: 'password', category: 'integrations', group: 'Notion', default: '' },
  // Twilio
  { key: 'TWILIO_ACCOUNT_SID', label: 'Twilio Account SID', description: 'Account SID de Twilio. Se encuentra en el dashboard de Twilio', type: 'string', category: 'integrations', group: 'Twilio', default: '' },
  { key: 'TWILIO_AUTH_TOKEN', label: 'Twilio Auth Token', description: 'Auth Token de Twilio. Se encuentra junto al Account SID', type: 'password', category: 'integrations', group: 'Twilio', default: '' },
  { key: 'TWILIO_PHONE_NUMBER', label: 'Twilio Phone Number', description: 'Numero telefonico de Twilio en formato E.164 (ej: +1234567890)', type: 'string', category: 'integrations', group: 'Twilio', default: '' },
  // MQTT
  { key: 'MQTT_BROKER_URL', label: 'MQTT Broker URL', description: 'URL del broker MQTT. Ej: mqtt://192.168.1.100:1883 o mqtts://broker.hivemq.com', type: 'string', category: 'integrations', group: 'MQTT / IoT', default: '' },
  { key: 'MQTT_USERNAME', label: 'MQTT Username', description: 'Usuario para autenticacion MQTT (opcional)', type: 'string', category: 'integrations', group: 'MQTT / IoT', default: '' },
  { key: 'MQTT_PASSWORD', label: 'MQTT Password', description: 'Contraseña para autenticacion MQTT (opcional)', type: 'password', category: 'integrations', group: 'MQTT / IoT', default: '' },
  // CRM
  { key: 'CRM_ENABLED', label: 'CRM Habilitado', description: 'Sistema CRM integrado para gestion de contactos y negocios', type: 'boolean', category: 'integrations', group: 'CRM', default: 'true' },
  // Cloud Backup
  { key: 'S3_BACKUP_BUCKET', label: 'S3 Bucket', description: 'Nombre del bucket S3 para backups cloud. Compatible con AWS, DigitalOcean Spaces, MinIO', type: 'string', category: 'integrations', group: 'Cloud Backup', default: '' },
  { key: 'S3_BACKUP_REGION', label: 'S3 Region', description: 'Region AWS del bucket S3. Default: us-east-1', type: 'string', category: 'integrations', group: 'Cloud Backup', default: 'us-east-1' },
  { key: 'S3_BACKUP_ENDPOINT', label: 'S3 Endpoint', description: 'URL endpoint personalizado para S3-compatible (DigitalOcean, MinIO). Dejar vacio para AWS', type: 'string', category: 'integrations', group: 'Cloud Backup', default: '' },
  { key: 'GDRIVE_BACKUP_FOLDER', label: 'Google Drive Folder', description: 'Nombre de la carpeta en Google Drive para backups. Requiere rclone configurado', type: 'string', category: 'integrations', group: 'Cloud Backup', default: 'ATLAS-Backups' },

  // ══════════════ MCP (Model Context Protocol) ══════════════
  { key: 'MCP_SERVER_ENABLED', label: 'MCP Server', description: 'Exponer herramientas de ATLAS como servidor MCP para que otros clientes las consuman', type: 'boolean', category: 'integrations', group: 'MCP', default: 'false' },
  { key: 'MCP_SERVER_PORT', label: 'Puerto MCP Server', description: 'Puerto donde escucha el servidor MCP (SSE transport)', type: 'number', category: 'integrations', group: 'MCP', default: '5050' },
  { key: 'MCP_SERVERS', label: 'Servidores MCP Externos', description: 'JSON array de servidores MCP a conectar. Formato: [{"name":"x","url":"http://..."}]', type: 'string', category: 'integrations', group: 'MCP', default: '' },
];

// ── .env I/O ──────────────────────────────────────────

function readEnvFile(): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf-8');
  const result: Record<string, string> = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    let value = trimmed.substring(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function writeEnvValue(key: string, value: string): void {
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, `${key}=${value}\n`, 'utf-8');
    return;
  }

  const content = fs.readFileSync(envPath, 'utf-8');
  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#') || !trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const lineKey = trimmed.substring(0, eqIdx).trim();
    if (lineKey === key) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }

  if (!found) {
    lines.push(`${key}=${value}`);
  }

  fs.writeFileSync(envPath, lines.join(lineEnding), 'utf-8');
}

// ── Masking ───────────────────────────────────────────

function maskValue(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '\u2022'.repeat(8);
  return value.substring(0, 4) + '\u2022'.repeat(4) + value.substring(value.length - 4);
}

// ── Public API ────────────────────────────────────────

export function getAllSettings(): SettingsCategory[] {
  const env = readEnvFile();

  return CATEGORIES.map(cat => ({
    id: cat.id,
    label: cat.label,
    settings: SCHEMA
      .filter(s => s.category === cat.id)
      .map(s => {
        const rawValue = env[s.key] !== undefined ? env[s.key] : s.default;
        return {
          key: s.key,
          label: s.label,
          description: s.description,
          type: s.type,
          group: s.group || '',
          value: s.type === 'password' ? maskValue(rawValue) : rawValue,
          hasValue: rawValue !== '',
          default: s.default,
        };
      }),
  }));
}

export function updateSetting(key: string, value: string): { success: boolean; error?: string } {
  const setting = SCHEMA.find(s => s.key === key);
  if (!setting) {
    return { success: false, error: `Setting "${key}" not in schema.` };
  }

  writeEnvValue(key, value);
  return { success: true };
}
