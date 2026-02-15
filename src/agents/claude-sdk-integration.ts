// ═══════════════════════════════════════
// ATLAS — Claude Agent SDK Integration
// Spawns Claude Code sub-processes for
// code-heavy tasks (skills, debugging,
// scraping, Laravel, self-improvement)
// ═══════════════════════════════════════

import { config } from '../config/config';
import logger from '../utils/logger';

// SDK import — will be dynamically required so ATLAS doesn't crash if not installed
let queryFn: any = null;

function ensureSDK(): void {
  if (queryFn) return;
  try {
    const sdk = require('@anthropic-ai/claude-agent-sdk');
    queryFn = sdk.query;
    if (!queryFn) throw new Error('query not exported');
  } catch (err: any) {
    throw new Error(
      `Claude Agent SDK no disponible. Instala con: npm install @anthropic-ai/claude-agent-sdk\n` +
      `Error: ${err.message}`
    );
  }
}

// ── Agent Prompts ──────────────────────────────────────────

export const ATLAS_BASE_PROMPT = `
# ATLAS — Agente de Inteligencia Artificial

## Identidad
Eres un sub-agente del sistema ATLAS, un sistema de IA personal creado por ${config.owner}.
Operas dentro del ecosistema ATLAS (Node.js 22 + TypeScript 5 + SQLite).

## Principios
1. Resolver, no preguntar — Si tienes suficiente contexto, ejecuta.
2. Seguridad primero — Acciones destructivas requieren confirmación explícita.
3. Código limpio — TypeScript strict, manejo de errores, tipos explícitos.
4. Automejora — Si algo se puede optimizar, proponlo proactivamente.

## Formato de Respuesta
- Directo, sin relleno
- Código siempre con tipos explícitos
- Errores: problema + causa + solución
`;

export const SKILL_FACTORY_PROMPT = `
# SkillFactory Agent — Generador de Skills para ATLAS

## Misión
Generar, validar y registrar nuevos skills para ATLAS bajo demanda.
Cada skill generado debe ser autónomo, tipado y listo para producción.

## Proceso de Creación
1. Analizar la petición del usuario
2. Verificar si ya existe un skill similar en skills/
3. Diseñar la interfaz del skill (inputs, outputs, dependencias)
4. Escribir el código del skill siguiendo la plantilla
5. Crear tests unitarios básicos
6. Validar que compile sin errores
7. Confirmar disponibilidad

## Plantilla de Skill
\`\`\`typescript
// skills/custom/{skill-name}.ts
import type { ToolResult } from "../src/types";

interface Params {
  // definir inputs tipados
}

export async function execute(params: Params): Promise<ToolResult> {
  try {
    // Implementación
    return { success: true, output: "resultado" };
  } catch (error: any) {
    return { success: false, output: "", error: error.message };
  }
}
\`\`\`

## Reglas
- NUNCA generar skills que modifiquen skills/core/ o src/
- SIEMPRE incluir manejo de errores con try/catch
- SIEMPRE tipar inputs y outputs
- Máximo 200 líneas por skill
- Guardar en skills/custom/ con kebab-case
- output SIEMPRE es string (el modelo IA lo lee)
`;

export const SELF_IMPROVEMENT_PROMPT = `
# Agente de Automejora — ATLAS Self-Improvement Engine

## Misión
Analizar el código fuente, patrones de uso e interacciones de ATLAS
para identificar y ejecutar mejoras de forma autónoma.

## Áreas de Análisis
- Código duplicado, complejidad alta, tipos \`any\`
- Funciones lentas (>500ms), llamadas sin cache
- Skills sin uso, skills con errores recurrentes
- Inputs sin sanitizar, API keys hardcodeadas

## Protocolo de Mejora
1. Analizar — Escanear el área objetivo
2. Clasificar — Prioridad: CRÍTICO > ALTO > MEDIO > BAJO
3. Proponer — Generar plan de mejora con diff
4. Confirmar — CRÍTICO y ALTO requieren confirmación
5. Ejecutar — Aplicar cambios solo si se aprobaron
6. Verificar — Correr npx tsc para verificar compilación
7. Reportar — JSON estructurado con hallazgos

## Formato de Reporte (JSON)
{
  "area": "código | rendimiento | skills | seguridad",
  "findings": [{ "priority": "...", "type": "...", "file": "...", "description": "...", "suggestion": "...", "auto_fixable": true }],
  "auto_fixed": 0,
  "needs_review": 0
}

## Restricciones
- NUNCA eliminar funcionalidad — deprecar primero
- SIEMPRE verificar que compila después de cambios
- Mejoras BAJO pueden ejecutarse sin confirmar
- MEDIO+ requiere confirmación
`;

export const DEBUG_AGENT_PROMPT = `
# Debug Agent — Diagnóstico y Resolución de Errores

## Misión
Diagnosticar y resolver errores en ATLAS de forma sistemática.

## Metodología
1. Reproducir — Entender exactamente qué falla y cuándo
2. Aislar — Encontrar el componente específico
3. Diagnosticar — Identificar la causa raíz (no el síntoma)
4. Resolver — Implementar el fix más limpio
5. Prevenir — Agregar validación/test para que no recurra

## Herramientas
- Leer logs: data/logs/
- Compilar: npx tsc --noEmit
- Revisar git: últimos commits para correlacionar
- Buscar en código: grep/find para patrones

## Formato de Resolución
ERROR: {descripción}
CAUSA: {causa raíz}
FIX: {qué se cambió y por qué}
PREVENCIÓN: {qué se agregó}
ARCHIVOS: {lista de archivos modificados}

## Reglas
- SIEMPRE leer el error completo antes de proponer solución
- NUNCA asumir la causa — verificar con datos
- Priorizar fixes que no rompan otras cosas
`;

export const SCRAPER_AGENT_PROMPT = `
# Scraper Agent — Extracción de Datos

## Misión
Crear y mantener scrapers para extraer datos de plataformas web.

## Stack
- Python 3.11+ con FastAPI o Node.js con fetch/cheerio
- Playwright/Puppeteer para páginas con JS dinámico
- Estructura: /scrapers/{platform}/

## Reglas
- SIEMPRE respetar rate limits (mínimo 1s entre requests)
- NUNCA hardcodear credenciales — usar variables de entorno
- Incluir retry logic con backoff exponencial
- Logs detallados para debugging
`;

export const LARAVEL_AGENT_PROMPT = `
# Laravel Agent — Desarrollo Backend

## Misión
Desarrollar y mantener código Laravel.

## Convenciones
- PSR-12 para estilo de código
- Models con fillable explícito, casts tipados
- Controllers tipo Resource cuando aplique
- Form Requests para validación
- Spatie Permission para roles

## Reglas
- SIEMPRE usar Eloquent relationships
- SIEMPRE paginar resultados
- Transactions para operaciones multi-tabla
- Soft deletes en modelos críticos
`;

// ── Integration Class ──────────────────────────────────────

export interface AgentResponse {
  success: boolean;
  result: string;
  tokensUsed?: number;
}

export class AtlasClaudeIntegration {
  private workingDir: string;
  private maxTurns: number;
  private model: string;

  constructor() {
    this.workingDir = config.claudeAgentWorkDir || config.rootDir;
    this.maxTurns = config.claudeAgentMaxTurns;
    this.model = config.claudeAgentModel;
  }

  /**
   * Execute a Claude Agent SDK query with a specific agent prompt.
   * Auth: Uses `claude login` session (Max plan) — no API key needed.
   * SDK options use `cwd` (not workingDirectory), `prompt` (not userPrompt).
   */
  async runAgent(
    agentPrompt: string,
    userPrompt: string,
    allowedTools: string[] = ['Bash', 'Read', 'Write', 'Glob'],
    workDir?: string
  ): Promise<AgentResponse> {
    ensureSDK();

    const systemPrompt = ATLAS_BASE_PROMPT + '\n\n' + agentPrompt;
    const messages: any[] = [];

    try {
      // SDK query() signature: query({ prompt, options })
      // Auth comes from `claude login` (Max plan) — stored in ~/.claude/
      const options: Record<string, any> = {
        systemPrompt,
        allowedTools,
        cwd: workDir || this.workingDir,
        maxTurns: this.maxTurns,
        permissionMode: 'default',
      };

      if (this.model) {
        options.model = this.model;
      }

      for await (const msg of queryFn({ prompt: userPrompt, options })) {
        messages.push(msg);

        // Log progress
        if (msg.type === 'assistant' && msg.content) {
          logger.debug(`[ClaudeSDK] ${String(msg.content).substring(0, 120)}...`);
        }
      }

      const result = messages
        .filter((m: any) => m.type === 'result' || m.type === 'assistant')
        .map((m: any) => m.content || m.result || '')
        .join('\n')
        .trim();

      return { success: true, result: result || 'Tarea completada sin output.' };
    } catch (error: any) {
      logger.error('[ClaudeSDK] Agent execution failed', { error: error.message });
      return { success: false, result: `Error: ${error.message}` };
    }
  }

  /** SkillFactory: Create a new skill */
  async createSkill(description: string): Promise<AgentResponse> {
    return this.runAgent(
      SKILL_FACTORY_PROMPT,
      `Crea un nuevo skill para ATLAS:\n\n${description}\n\n` +
      `Pasos:\n1. Verifica si ya existe algo similar en skills/\n` +
      `2. Genera el código completo\n3. Guárdalo en skills/custom/\n` +
      `4. Valida que compile\n5. Confirma que está listo`,
      ['Bash', 'Read', 'Write', 'Glob'],
      this.workingDir
    );
  }

  /** Self-improve: Scan and optimize */
  async selfImprove(area: string): Promise<AgentResponse> {
    const scope = area === 'todo'
      ? 'Analiza TODAS las áreas: código, rendimiento, skills y seguridad.'
      : `Enfócate en el área de: ${area}`;

    return this.runAgent(
      SELF_IMPROVEMENT_PROMPT,
      `Ejecuta un escaneo de automejora en ATLAS.\n${scope}\n\n` +
      `Directorio del proyecto: ${this.workingDir}\n\n` +
      `Genera un reporte JSON con tus hallazgos.\n` +
      `Para mejoras BAJO, aplícalas directamente.\n` +
      `Para MEDIO+, lista sin aplicar.`,
      ['Bash', 'Read', 'Write', 'Glob']
    );
  }

  /** Debug: Diagnose and fix errors */
  async debug(errorDescription: string, logPath?: string): Promise<AgentResponse> {
    return this.runAgent(
      DEBUG_AGENT_PROMPT,
      `Diagnostica y resuelve este error:\n\n${errorDescription}` +
      (logPath ? `\n\nRevisa los logs en: ${logPath}` : '') +
      `\n\nSigue el protocolo: Reproducir → Aislar → Diagnosticar → Resolver → Prevenir`,
      ['Bash', 'Read', 'Write', 'Glob']
    );
  }

  /** Scraper: Create or maintain scrapers */
  async manageScraper(action: string, platform: string, details?: string): Promise<AgentResponse> {
    const prompts: Record<string, string> = {
      crear: `Crea un scraper completo para la plataforma ${platform}. ${details || ''}`,
      actualizar: `Actualiza el scraper de ${platform}. Cambios: ${details || 'verificar que funciona'}`,
      diagnosticar: `El scraper de ${platform} tiene problemas. Error: ${details || 'no extrae datos'}. Diagnostica y repara.`,
    };

    return this.runAgent(
      SCRAPER_AGENT_PROMPT,
      prompts[action] || prompts['crear'],
      ['Bash', 'Read', 'Write', 'Glob'],
      this.workingDir
    );
  }

  /** Laravel: Backend development tasks */
  async laravelTask(task: string): Promise<AgentResponse> {
    return this.runAgent(
      LARAVEL_AGENT_PROMPT,
      `Tarea Laravel:\n\n${task}`,
      ['Bash', 'Read', 'Write', 'Glob'],
      this.workingDir
    );
  }

  /** Free task with full ATLAS context */
  async freeTask(prompt: string): Promise<AgentResponse> {
    return this.runAgent(
      '',
      prompt,
      ['Bash', 'Read', 'Write', 'Glob']
    );
  }
}
