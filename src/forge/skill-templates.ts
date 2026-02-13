// ═══════════════════════════════════════
// ATLAS — Skill Templates (Forge v2)
// Predefined archetypes for skill generation
// ═══════════════════════════════════════

import { SkillTemplate } from '../types';

export const SKILL_TEMPLATES: SkillTemplate[] = [
  // ── 1. API Fetcher ──
  {
    id: 'api_fetcher',
    name: 'API Fetcher',
    description: 'Fetch data from an HTTP API with retry, auth headers, and response parsing',
    keywords: ['api', 'fetch', 'endpoint', 'rest', 'request', 'http', 'get', 'post', 'consultar', 'precio', 'cotización'],
    composable: false,
    defaultDependencies: [],
    skeleton: `// Skill: {name}
// {description}

import type { ToolResult } from "../types.js";

interface Params {
  // TODO: Define parameters
  query?: string;
}

async function fetchWithRetry(url: string, options: RequestInit = {}, retries = 2): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok && i < retries) continue;
      return res;
    } catch (err) {
      if (i === retries) throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

export async function execute(params: Params): Promise<ToolResult> {
  try {
    // TODO: Build URL and headers
    const url = 'https://api.example.com/data';
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    const res = await fetchWithRetry(url, { headers });
    const data = await res.json();

    // TODO: Parse and format response
    return {
      success: true,
      output: JSON.stringify(data, null, 2)
    };
  } catch (err: any) {
    return {
      success: false,
      output: "",
      error: err.message
    };
  }
}`,
  },

  // ── 2. Web Scraper ──
  {
    id: 'web_scraper',
    name: 'Web Scraper',
    description: 'Extract structured data from web pages using cheerio selectors',
    keywords: ['scrape', 'extract', 'crawl', 'page', 'html', 'web', 'parse', 'tabla', 'página'],
    composable: false,
    defaultDependencies: ['cheerio'],
    skeleton: `// Skill: {name}
// {description}

import type { ToolResult } from "../types.js";
import * as cheerio from "cheerio";

interface Params {
  url?: string;
  selector?: string;
}

export async function execute(params: Params): Promise<ToolResult> {
  try {
    const url = params.url || 'https://example.com';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ATLAS-Bot/1.0' }
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { success: false, output: "", error: \`HTTP \${res.status}: \${res.statusText}\` };
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // TODO: Extract data using selectors
    const selector = params.selector || 'h1';
    const results: string[] = [];
    $(selector).each((_, el) => {
      results.push($(el).text().trim());
    });

    return {
      success: true,
      output: results.length > 0
        ? results.join('\\n')
        : 'No se encontraron resultados con el selector dado.'
    };
  } catch (err: any) {
    return {
      success: false,
      output: "",
      error: err.message
    };
  }
}`,
  },

  // ── 3. Data Transformer ──
  {
    id: 'data_transformer',
    name: 'Data Transformer',
    description: 'Transform, convert, calculate, or format data with input validation',
    keywords: ['convert', 'transform', 'format', 'parse', 'calc', 'calculate', 'convertir', 'calcular', 'generar'],
    composable: false,
    defaultDependencies: [],
    skeleton: `// Skill: {name}
// {description}

import type { ToolResult } from "../types.js";

interface Params {
  input: string;
  format?: string;
}

export async function execute(params: Params): Promise<ToolResult> {
  try {
    if (!params.input) {
      return { success: false, output: "", error: "Se requiere el parámetro 'input'" };
    }

    // TODO: Implement transformation logic
    const input = params.input;
    let result: string;

    // Example: transform data
    result = input.toUpperCase(); // Replace with actual transformation

    return {
      success: true,
      output: result
    };
  } catch (err: any) {
    return {
      success: false,
      output: "",
      error: err.message
    };
  }
}`,
  },

  // ── 4. Scheduled Checker ──
  {
    id: 'scheduled_checker',
    name: 'Scheduled Checker',
    description: 'Check a condition, compare against threshold, and generate alerts',
    keywords: ['check', 'monitor', 'alert', 'watch', 'verify', 'monitorear', 'verificar', 'alerta', 'threshold'],
    composable: false,
    defaultDependencies: [],
    skeleton: `// Skill: {name}
// {description}

import type { ToolResult } from "../types.js";

interface Params {
  target?: string;
  threshold?: number;
}

interface CheckResult {
  status: 'ok' | 'warning' | 'critical';
  value: number | string;
  message: string;
}

async function performCheck(target: string, threshold: number): Promise<CheckResult> {
  // TODO: Implement the actual check
  // Example: fetch a URL and check response time, check a value, etc.

  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(target, { signal: controller.signal });
    clearTimeout(timeout);
    const elapsed = Date.now() - start;

    if (!res.ok) {
      return { status: 'critical', value: res.status, message: \`HTTP \${res.status}\` };
    }

    if (elapsed > threshold) {
      return { status: 'warning', value: elapsed, message: \`Respuesta lenta: \${elapsed}ms (threshold: \${threshold}ms)\` };
    }

    return { status: 'ok', value: elapsed, message: \`OK (\${elapsed}ms)\` };
  } catch (err: any) {
    clearTimeout(timeout);
    return { status: 'critical', value: 0, message: err.message };
  }
}

export async function execute(params: Params): Promise<ToolResult> {
  try {
    const target = params.target || 'https://example.com';
    const threshold = params.threshold || 5000;

    const result = await performCheck(target, threshold);

    const emoji = result.status === 'ok' ? '[OK]' : result.status === 'warning' ? '[WARN]' : '[CRIT]';

    return {
      success: true,
      output: \`\${emoji} \${result.message} (valor: \${result.value})\`
    };
  } catch (err: any) {
    return {
      success: false,
      output: "",
      error: err.message
    };
  }
}`,
  },

  // ── 5. Multi-Step (Composable) ──
  {
    id: 'multi_step',
    name: 'Multi-Step Workflow',
    description: 'Orchestrate multiple ATLAS tools in sequence using callTool bridge',
    keywords: ['workflow', 'pipeline', 'chain', 'sequence', 'multi', 'orquestar', 'automatizar', 'combinar'],
    composable: true,
    defaultDependencies: [],
    skeleton: `// Skill: {name}
// {description}
// COMPOSABLE: Este skill puede usar callTool() para invocar otros tools de ATLAS

import type { ToolResult } from "../types.js";

interface Params {
  // TODO: Define parameters
  input?: string;
}

// callTool está disponible como función global inyectada por el sandbox
// Firma: async callTool(toolName: string, params: Record<string, any>): Promise<ToolResult>
declare function callTool(name: string, params: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }>;

// context está disponible como variable global con info de la sesión
declare const context: { userId: string; channel: string; isOwner: boolean; datetime: string; availableTools: string[] };

export async function execute(params: Params): Promise<ToolResult> {
  try {
    // Step 1: Use another ATLAS tool
    // const searchResult = await callTool('web_search', { query: params.input });
    // if (!searchResult.success) throw new Error(searchResult.error || 'Search failed');

    // Step 2: Process the result
    // const processed = searchResult.output;

    // Step 3: Save or act on the result
    // await callTool('memory_save', { key: 'result', value: processed });

    return {
      success: true,
      output: "Workflow completado exitosamente"
    };
  } catch (err: any) {
    return {
      success: false,
      output: "",
      error: err.message
    };
  }
}`,
  },
  // ── 6. Database Query (Composable) ──
  {
    id: 'database_query',
    name: 'Database Query',
    description: 'Execute a database query via the database tool and format results',
    keywords: ['database', 'sql', 'query', 'tabla', 'registro', 'consulta', 'mysql', 'sqlite', 'db', 'select'],
    composable: true,
    defaultDependencies: [],
    skeleton: `// Skill: {name}
// {description}
// COMPOSABLE: Uses callTool('database', ...) to query the database

import type { ToolResult } from "../types.js";

interface Params {
  query?: string;
  table?: string;
}

declare function callTool(name: string, params: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }>;
declare const context: {
  userId: string; channel: string; isOwner: boolean; datetime: string; availableTools: string[];
  getFact: (key: string) => Promise<string | null>;
  searchFacts: (query: string, limit?: number) => Promise<Array<{ key: string; value: string }>>;
  saveFact: (key: string, value: string) => Promise<void>;
};

export async function execute(params: Params): Promise<ToolResult> {
  try {
    if (!params.query && !params.table) {
      return { success: false, output: "", error: "Se requiere 'query' SQL o 'table' para consultar" };
    }

    const sql = params.query || \`SELECT * FROM \${params.table} LIMIT 20\`;

    const result = await callTool('database', { query: sql });
    if (!result.success) {
      return { success: false, output: "", error: result.error || "Query failed" };
    }

    // Format output
    return {
      success: true,
      output: result.output
    };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
}`,
  },

  // ── 7. File Processor ──
  {
    id: 'file_processor',
    name: 'File Processor',
    description: 'Read, parse, transform, or generate files (CSV, JSON, TXT) from data/ directory',
    keywords: ['file', 'archivo', 'csv', 'json', 'parse', 'leer', 'procesar', 'export', 'generar', 'txt'],
    composable: false,
    defaultDependencies: [],
    skeleton: `// Skill: {name}
// {description}

import type { ToolResult } from "../types.js";

interface Params {
  file?: string;
  action?: 'read' | 'parse' | 'generate';
  data?: string;
  format?: string;
}

export async function execute(params: Params): Promise<ToolResult> {
  try {
    const action = params.action || 'read';
    const filePath = params.file || '';

    // Security: only allow data/ directory
    if (filePath && !filePath.startsWith('data/') && !filePath.startsWith('./data/')) {
      return { success: false, output: "", error: "Solo se permiten archivos en data/" };
    }

    // TODO: Implement file processing logic based on action
    // 'read' — read and return contents
    // 'parse' — parse CSV/JSON and return structured data
    // 'generate' — create a file from data

    return {
      success: true,
      output: "File processed successfully"
    };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
}`,
  },

  // ── 8. Notification Alert (Composable) ──
  {
    id: 'notification_alert',
    name: 'Notification Alert',
    description: 'Check a condition and send notification via ATLAS notification system',
    keywords: ['notify', 'notificar', 'alert', 'alerta', 'avisar', 'send', 'enviar', 'recordar', 'reminder'],
    composable: true,
    defaultDependencies: [],
    skeleton: `// Skill: {name}
// {description}
// COMPOSABLE: Uses callTool('notifications', ...) to send alerts

import type { ToolResult } from "../types.js";

interface Params {
  message: string;
  channel?: string;
  condition?: string;
}

declare function callTool(name: string, params: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }>;
declare const context: {
  userId: string; channel: string; isOwner: boolean; datetime: string; availableTools: string[];
  getFact: (key: string) => Promise<string | null>;
  searchFacts: (query: string, limit?: number) => Promise<Array<{ key: string; value: string }>>;
  saveFact: (key: string, value: string) => Promise<void>;
};

export async function execute(params: Params): Promise<ToolResult> {
  try {
    if (!params.message) {
      return { success: false, output: "", error: "Se requiere 'message'" };
    }

    const targetChannel = params.channel || 'telegram';

    // TODO: Check condition before sending (if condition param provided)

    const result = await callTool('notifications', {
      channel: targetChannel,
      message: params.message,
    });

    if (!result.success) {
      return { success: false, output: "", error: result.error || "Notification failed" };
    }

    return {
      success: true,
      output: \`Notificación enviada por \${targetChannel}: "\${params.message.substring(0, 100)}"\`
    };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
}`,
  },

  // ── 9. Memory-Driven (Composable) ──
  {
    id: 'memory_driven',
    name: 'Memory-Driven',
    description: 'Read, search, and save facts from ATLAS memory system for context-aware operations',
    keywords: ['memory', 'remember', 'recordar', 'historial', 'perfil', 'preferencia', 'contexto', 'fact', 'memoria'],
    composable: true,
    defaultDependencies: [],
    skeleton: `// Skill: {name}
// {description}
// COMPOSABLE: Uses context.searchFacts(), context.getFact(), context.saveFact()

import type { ToolResult } from "../types.js";

interface Params {
  action?: 'search' | 'get' | 'save' | 'summarize';
  query?: string;
  key?: string;
  value?: string;
}

declare function callTool(name: string, params: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }>;
declare const context: {
  userId: string; channel: string; isOwner: boolean; datetime: string; availableTools: string[];
  getFact: (key: string) => Promise<string | null>;
  searchFacts: (query: string, limit?: number) => Promise<Array<{ key: string; value: string }>>;
  saveFact: (key: string, value: string) => Promise<void>;
};

export async function execute(params: Params): Promise<ToolResult> {
  try {
    const action = params.action || 'search';

    if (action === 'get' && params.key) {
      const value = await context.getFact(params.key);
      return { success: true, output: value || \`No se encontró el fact "\${params.key}"\` };
    }

    if (action === 'save' && params.key && params.value) {
      await context.saveFact(params.key, params.value);
      return { success: true, output: \`Guardado: \${params.key} = \${params.value}\` };
    }

    if (action === 'search' && params.query) {
      const facts = await context.searchFacts(params.query, 10);
      if (facts.length === 0) {
        return { success: true, output: "No se encontraron facts relevantes." };
      }
      const output = facts.map(f => \`- \${f.key}: \${f.value}\`).join('\\n');
      return { success: true, output: \`Facts encontrados:\\n\${output}\` };
    }

    return { success: false, output: "", error: "Se requiere action + parámetros (search+query, get+key, save+key+value)" };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
}`,
  },
];

/**
 * Match a skill description to the best template by keyword overlap.
 * Returns the template with the highest keyword match score, or null if no match.
 */
export function matchTemplate(description: string): SkillTemplate | null {
  const descLower = description.toLowerCase();
  let bestMatch: SkillTemplate | null = null;
  let bestScore = 0;

  for (const template of SKILL_TEMPLATES) {
    let score = 0;
    for (const kw of template.keywords) {
      if (descLower.includes(kw.toLowerCase())) {
        score++;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = template;
    }
  }

  // Require at least 1 keyword match
  return bestScore >= 1 ? bestMatch : null;
}

/**
 * Get a template by ID.
 */
export function getTemplate(id: string): SkillTemplate | undefined {
  return SKILL_TEMPLATES.find(t => t.id === id);
}

/**
 * Get all template summaries for AI prompt injection.
 */
export function getTemplateSummaries(): string {
  return SKILL_TEMPLATES.map(t =>
    `- ${t.id}: ${t.description} (keywords: ${t.keywords.slice(0, 5).join(', ')}${t.composable ? ' | COMPOSABLE' : ''})`
  ).join('\n');
}
