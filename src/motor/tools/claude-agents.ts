// ═══════════════════════════════════════
// ATLAS — Claude Agent SDK Tools
// Registers SDK-powered agents as ATLAS tools
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../types';
import { AtlasClaudeIntegration, AgentResponse } from '../../agents/claude-sdk-integration';
import logger from '../../utils/logger';

/** Convert AgentResponse → ToolResult */
function toToolResult(res: AgentResponse): ToolResult {
  return {
    success: res.success,
    output: res.result,
    error: res.success ? undefined : res.result,
  };
}

// ── 1. Skill Factory ──

export class ClaudeSkillFactoryTool implements Tool {
  private sdk: AtlasClaudeIntegration;

  definition = {
    name: 'claude_skill_factory',
    description: 'Genera nuevos skills usando Claude Code como sub-agente. Escribe archivos, valida compilación, y registra el skill. Usar cuando forge_skill no es suficiente para tareas complejas de código.',
    input_schema: {
      type: 'object' as const,
      properties: {
        description: {
          type: 'string',
          description: 'Descripción detallada del skill a crear',
        },
      },
      required: ['description'],
    },
    dangerous: false,
  };

  constructor(sdk: AtlasClaudeIntegration) {
    this.sdk = sdk;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const description = params.description as string;
    if (!description) {
      return { success: false, output: '', error: 'Se requiere "description"' };
    }
    logger.info(`[ClaudeSDK] Skill Factory: ${description.substring(0, 80)}...`);
    const res = await this.sdk.createSkill(description);
    return toToolResult(res);
  }
}

// ── 2. Self-Improvement ──

export class ClaudeSelfImproveTool implements Tool {
  private sdk: AtlasClaudeIntegration;

  definition = {
    name: 'claude_self_improve',
    description: 'Analiza y optimiza el código de ATLAS: busca duplicados, performance issues, seguridad, y skills problemáticos. Genera reporte y aplica fixes de baja prioridad automáticamente.',
    input_schema: {
      type: 'object' as const,
      properties: {
        area: {
          type: 'string',
          description: 'Área a analizar',
          enum: ['código', 'rendimiento', 'skills', 'seguridad', 'todo'],
          default: 'todo',
        },
      },
    },
    dangerous: true, // Can modify files
  };

  constructor(sdk: AtlasClaudeIntegration) {
    this.sdk = sdk;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const area = (params.area as string) || 'todo';
    logger.info(`[ClaudeSDK] Self-improve scan: ${area}`);
    const res = await this.sdk.selfImprove(area);
    return toToolResult(res);
  }
}

// ── 3. Debug Agent ──

export class ClaudeDebugTool implements Tool {
  private sdk: AtlasClaudeIntegration;

  definition = {
    name: 'claude_debug',
    description: 'Diagnostica y resuelve errores del sistema ATLAS o de proyectos conectados. Lee logs, analiza stack traces, identifica causa raíz, aplica fix, y previene recurrencia.',
    input_schema: {
      type: 'object' as const,
      properties: {
        error: {
          type: 'string',
          description: 'Descripción del error o stack trace',
        },
        log_path: {
          type: 'string',
          description: 'Ruta a logs relevantes (opcional)',
        },
      },
      required: ['error'],
    },
    dangerous: true, // Can modify files to fix bugs
  };

  constructor(sdk: AtlasClaudeIntegration) {
    this.sdk = sdk;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const error = params.error as string;
    const logPath = params.log_path as string | undefined;
    if (!error) {
      return { success: false, output: '', error: 'Se requiere "error"' };
    }
    logger.info(`[ClaudeSDK] Debug: ${error.substring(0, 80)}...`);
    const res = await this.sdk.debug(error, logPath);
    return toToolResult(res);
  }
}

// ── 4. Scraper Manager ──

export class ClaudeScraperTool implements Tool {
  private sdk: AtlasClaudeIntegration;

  definition = {
    name: 'claude_scraper',
    description: 'Crea, actualiza o diagnostica scrapers de datos para plataformas web. Genera código Python/Node completo con retry logic y Dockerfile.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          description: 'Acción a realizar',
          enum: ['crear', 'actualizar', 'diagnosticar'],
        },
        platform: {
          type: 'string',
          description: 'Nombre de la plataforma (ej: "addi", "krediya")',
        },
        details: {
          type: 'string',
          description: 'Detalles adicionales de la tarea',
        },
      },
      required: ['action', 'platform'],
    },
    dangerous: true,
  };

  constructor(sdk: AtlasClaudeIntegration) {
    this.sdk = sdk;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;
    const platform = params.platform as string;
    const details = params.details as string | undefined;
    if (!action || !platform) {
      return { success: false, output: '', error: 'Se requiere "action" y "platform"' };
    }
    logger.info(`[ClaudeSDK] Scraper: ${action} ${platform}`);
    const res = await this.sdk.manageScraper(action, platform, details);
    return toToolResult(res);
  }
}

// ── 5. Laravel Dev ──

export class ClaudeLaravelTool implements Tool {
  private sdk: AtlasClaudeIntegration;

  definition = {
    name: 'claude_laravel',
    description: 'Desarrollo backend Laravel: crea migrations, models, controllers, services, jobs. Sigue convenciones PSR-12 y patrones Repository/Service.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task: {
          type: 'string',
          description: 'Descripción de la tarea Laravel a realizar',
        },
      },
      required: ['task'],
    },
    dangerous: true,
  };

  constructor(sdk: AtlasClaudeIntegration) {
    this.sdk = sdk;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const task = params.task as string;
    if (!task) {
      return { success: false, output: '', error: 'Se requiere "task"' };
    }
    logger.info(`[ClaudeSDK] Laravel: ${task.substring(0, 80)}...`);
    const res = await this.sdk.laravelTask(task);
    return toToolResult(res);
  }
}

// ── 6. Claude Code (Free Agent) ──

export class ClaudeCodeTool implements Tool {
  private sdk: AtlasClaudeIntegration;

  definition = {
    name: 'claude_code',
    description: 'Agente de código libre con capacidades completas de Claude Code. Para tareas complejas de programación que requieren leer/escribir múltiples archivos, ejecutar comandos, y razonar sobre código.',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: {
          type: 'string',
          description: 'Instrucción detallada de lo que debe hacer el agente',
        },
      },
      required: ['prompt'],
    },
    dangerous: true,
  };

  constructor(sdk: AtlasClaudeIntegration) {
    this.sdk = sdk;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const prompt = params.prompt as string;
    if (!prompt) {
      return { success: false, output: '', error: 'Se requiere "prompt"' };
    }
    logger.info(`[ClaudeSDK] FreeTask: ${prompt.substring(0, 80)}...`);
    const res = await this.sdk.freeTask(prompt);
    return toToolResult(res);
  }
}

// ── Registration Helper ──

/** Register all Claude Agent SDK tools into ATLAS ToolRegistry */
export function registerClaudeAgentTools(registry: { register(tool: Tool): void }): void {
  const sdk = new AtlasClaudeIntegration();

  registry.register(new ClaudeSkillFactoryTool(sdk));
  registry.register(new ClaudeSelfImproveTool(sdk));
  registry.register(new ClaudeDebugTool(sdk));
  registry.register(new ClaudeScraperTool(sdk));
  registry.register(new ClaudeLaravelTool(sdk));
  registry.register(new ClaudeCodeTool(sdk));

  logger.info('Claude Agent SDK: 6 tools registered');
}
