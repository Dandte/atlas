// ═══════════════════════════════════════
// ATLAS — Skill Forge (Phase 6)
// Creates dynamic tools from natural language
// Validates, persists, and registers skills
// ═══════════════════════════════════════

import { DynamicSkill, SkillSpec, SkillRuntimeContext, Tool, ToolDefinition, ToolResult } from '../types';
import { ModelRouter } from '../thalamus/model-router';
import { Sandbox } from './sandbox';
import { ToolRegistry } from '../motor/tool-registry';
import { ToolExecutor } from '../motor/executor';
import { MemoryManager } from '../hippocampus/memory-manager';
import { matchTemplate, getTemplateSummaries } from './skill-templates';
import { config } from '../config/config';
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';

export class SkillForge {
  private modelRouter: ModelRouter;
  private sandbox: Sandbox;
  private toolRegistry: ToolRegistry;
  private toolExecutor: ToolExecutor | null = null;
  private memory: MemoryManager;
  private skillsDir: string;
  private loadedSkills: Map<string, DynamicSkill> = new Map();
  private failureLog: Map<string, Array<{ input: any; error: string; at: number }>> = new Map();

  constructor(
    modelRouter: ModelRouter,
    sandbox: Sandbox,
    toolRegistry: ToolRegistry,
    memory: MemoryManager
  ) {
    this.modelRouter = modelRouter;
    this.sandbox = sandbox;
    this.toolRegistry = toolRegistry;
    this.memory = memory;
    this.skillsDir = config.dynamicSkillsDir;

    // Ensure skills directory exists
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }
  }

  /** Set the ToolExecutor for composable skill support (avoids circular dep) */
  setToolExecutor(executor: ToolExecutor): void {
    this.toolExecutor = executor;
  }

  // ── Create skill from description ──

  async createSkill(
    description: string,
    requestedBy: 'user' | 'atlas' | 'meta-learner' = 'user'
  ): Promise<{ success: boolean; skill?: DynamicSkill; error?: string }> {

    // Step 1: Generate specification
    const spec = await this.generateSpec(description);
    if (!spec) return { success: false, error: 'No pude generar la especificación del skill' };

    // Step 2: Check if similar tool already exists
    if (this.toolRegistry.has(spec.name)) {
      return {
        success: false,
        error: `Ya existe un tool con nombre "${spec.name}". ¿Querés que lo mejore en vez de crear uno nuevo?`,
      };
    }

    // Step 3: Generate code
    const code = await this.generateCode(spec);
    if (!code) return { success: false, error: 'No pude generar el código' };

    // Step 4: Validate in sandbox
    const validation = await this.sandbox.validate(code, spec);
    if (!validation.passed) {
      // Try auto-fix (max 2 attempts)
      const fixed = await this.autoFix(code, spec, validation.errors);
      if (!fixed) {
        return {
          success: false,
          error: `El código no pasó validación:\n${validation.errors.join('\n')}`,
        };
      }
      code.handlerCode = fixed.handlerCode;
    }

    // Step 5: Install dependencies if any
    if (spec.dependencies.length > 0) {
      try {
        await this.installDependencies(spec.dependencies);
      } catch (err: any) {
        return { success: false, error: `Error instalando dependencias: ${err.message}` };
      }
    }

    // Step 6: Create the skill object
    const skill: DynamicSkill = {
      id: uuid(),
      name: spec.name,
      displayName: spec.displayName,
      description: spec.description,
      version: 1,
      parameters: spec.parameters,
      code: code.handlerCode,
      dependencies: spec.dependencies,
      createdBy: requestedBy,
      createdAt: new Date(),
      updatedAt: new Date(),
      usageCount: 0,
      successRate: 100,
      averageExecutionMs: 0,
      tags: spec.tags,
      enabled: true,
      testCases: spec.testCases,
      composable: spec.composable || false,
      templateUsed: spec.templateUsed,
    };

    // Step 7: Save to disk and register
    this.saveSkill(skill);
    this.registerSkill(skill);

    // Step 8: Save in memory for reference
    this.memory.saveFact(
      `skill_created_${skill.name}`,
      `Skill "${skill.displayName}" creado: ${skill.description}`,
      'forge'
    );

    logger.info(`Forge: skill "${skill.name}" created (v${skill.version})`);
    return { success: true, skill };
  }

  // ── Generate specification via AI ──

  private async generateSpec(description: string): Promise<SkillSpec | null> {
    const existingTools = this.toolRegistry.getDefinitions()
      .map((t) => `- ${t.name}: ${t.description.substring(0, 80)}`)
      .join('\n');

    // Forge v2: template matching
    const templateMatch = matchTemplate(description);
    const templateHint = templateMatch
      ? `\nTEMPLATE SUGERIDO: "${templateMatch.id}" — ${templateMatch.description}. Si encaja, incluí "templateUsed": "${templateMatch.id}" y "composable": ${templateMatch.composable} en el JSON.`
      : '';

    const templateList = `\nTEMPLATES DISPONIBLES:\n${getTemplateSummaries()}\nSi el skill necesita usar otros tools de ATLAS (web_search, shell, file, etc.), marcalo como "composable": true.`;

    const response = await this.modelRouter.chat(
      `Eres el módulo Skill Forge de ATLAS. Generás especificaciones para nuevos tools.

REGLAS:
- name debe ser snake_case, descriptivo, máximo 30 caracteres
- description debe explicar claramente qué hace (el modelo IA la lee para decidir cuándo usar el tool)
- Parámetros deben ser los mínimos necesarios
- Incluir al menos 1 test case
- dependencies: solo packages npm conocidos y seguros. Preferir fetch nativo para HTTP.
- tags: palabras clave para encontrar el skill después
- NO incluir tools que ya existen (ver lista abajo)
- composable: true si el skill necesita usar otros tools de ATLAS via callTool()
- templateUsed: ID del template base si aplica (opcional)
${templateList}${templateHint}

Responde ÚNICAMENTE con JSON válido:
{
  "name": "check_dollar_price",
  "displayName": "Consultar precio del dólar",
  "description": "Consulta el precio actual del dólar (USD) en pesos colombianos (COP).",
  "parameters": [
    { "name": "source", "type": "string", "description": "Fuente de datos", "required": false, "default": "auto" }
  ],
  "dependencies": [],
  "tags": ["finanzas", "dólar"],
  "testCases": [
    { "description": "Debe retornar un precio", "input": {}, "expectedBehavior": "Retorna objeto con success: true", "timeout": 15000 }
  ],
  "composable": false,
  "templateUsed": null
}`,
      [
        {
          role: 'user',
          content: `TOOLS EXISTENTES (NO duplicar):\n${existingTools}\n\nDESCRIPCIÓN DEL NUEVO SKILL:\n${description}`,
        },
      ]
    );

    try {
      return JSON.parse(response.content.replace(/```json?|```/g, '').trim());
    } catch {
      logger.debug('Failed to parse skill spec JSON');
      return null;
    }
  }

  // ── Generate code via AI ──

  private async generateCode(spec: SkillSpec): Promise<{ handlerCode: string } | null> {
    // Forge v2: Template skeleton for better generation
    const template = spec.templateUsed ? matchTemplate(spec.description) || null : null;
    const skeletonHint = template
      ? `\nUSÁ ESTE SKELETON COMO BASE (adaptá los TODOs):\n\`\`\`\n${template.skeleton}\n\`\`\``
      : '';

    // Forge v2: Composable instructions
    const composableHint = spec.composable
      ? `\nESTE SKILL ES COMPOSABLE. Globals disponibles:
- callTool(name, params) → ejecuta otro tool de ATLAS (async)
- context.getFact(key) → lee un hecho de memoria (async, retorna string|null)
- context.searchFacts(query, limit) → busca hechos (async, retorna [{key,value}])
- context.saveFact(key, value) → guarda un hecho nuevo (async)
- context.userId, context.channel, context.isOwner
- context.datetime, context.availableTools
- Tools disponibles para callTool: ${this.toolRegistry.getNames().join(', ')}
- Declarar: \`declare function callTool(name: string, params: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }>;\`
- Declarar: \`declare const context: { userId: string; channel: string; isOwner: boolean; datetime: string; availableTools: string[]; getFact: (key: string) => Promise<string | null>; searchFacts: (query: string, limit?: number) => Promise<Array<{ key: string; value: string }>>; saveFact: (key: string, value: string) => Promise<void> };\``
      : '';

    // Forge v2+: Top successful skills as FULL code examples
    const topSkills = this.listSkills()
      .filter(s => s.successRate >= 80 && s.usageCount >= 3)
      .sort((a, b) => (b.successRate * b.usageCount) - (a.successRate * a.usageCount))
      .slice(0, 2);
    const examplesHint = topSkills.length > 0
      ? `\n\nEJEMPLOS DE SKILLS EXITOSOS EN PRODUCCIÓN (imitá este estilo):\n${topSkills.map(s => `--- ${s.name} (${s.successRate}% success, ${s.usageCount} usos) ---\n${s.code}`).join('\n\n')}`
      : '';

    const response = await this.modelRouter.chat(
      `Eres el módulo Skill Forge de ATLAS. Generás código TypeScript para tools.

El código debe seguir EXACTAMENTE esta estructura. Responde SOLO con el código, sin markdown:

// Skill: {name}
// {description}

import type { ToolResult } from "../types.js";

interface Params {
  // Parámetros tipados
}

export async function execute(params: Params): Promise<ToolResult> {
  try {
    // ... implementación ...

    return {
      success: true,
      output: "resultado como string legible"
    };
  } catch (err: any) {
    return {
      success: false,
      output: "",
      error: err.message
    };
  }
}

REGLAS DEL CÓDIGO:
- SIEMPRE retornar ToolResult con success, output, y error opcional
- output SIEMPRE es string (el modelo IA lo lee)
- Usar fetch nativo para HTTP (Node 22, no necesita import)
- Manejar TODOS los errores — nunca puede tirar exception no catcheada
- Timeout para operaciones de red: máximo 15 segundos
- No usar eval(), exec(), ni child_process
- No leer/escribir archivos fuera de ./data/ y ./skills/
- No acceder a variables de entorno directamente (recibirlas como params si es necesario)
- El código debe ser autocontenido (todo en un solo archivo)
- Máximo 200 líneas${skeletonHint}${composableHint}${examplesHint}`,
      [
        {
          role: 'user',
          content: `ESPECIFICACIÓN:\n${JSON.stringify(spec, null, 2)}`,
        },
      ]
    );

    const code = response.content.replace(/```typescript?|```/g, '').trim();

    if (!code.includes('export async function execute')) {
      return null;
    }

    return { handlerCode: code };
  }

  // ── Auto-fix code that failed validation ──

  private async autoFix(
    code: { handlerCode: string },
    spec: SkillSpec,
    errors: string[],
    attempt: number = 1
  ): Promise<{ handlerCode: string } | null> {
    if (attempt > 2) return null;

    const response = await this.modelRouter.chat(
      `El siguiente código de un tool falló validación. Corregilo.
Responde SOLO con el código corregido completo, sin explicaciones, sin markdown.`,
      [
        {
          role: 'user',
          content: `SPEC: ${JSON.stringify(spec, null, 2)}

CÓDIGO ORIGINAL:
${code.handlerCode}

ERRORES:
${errors.join('\n')}

Corregí el código para que pase la validación.`,
        },
      ]
    );

    const fixedCode = response.content.replace(/```typescript?|```/g, '').trim();

    // Re-validate
    const revalidation = await this.sandbox.validate(
      { handlerCode: fixedCode },
      spec
    );

    if (revalidation.passed) {
      return { handlerCode: fixedCode };
    }

    // Try once more
    return this.autoFix({ handlerCode: fixedCode }, spec, revalidation.errors, attempt + 1);
  }

  // ── Improve existing skill ──

  async improveSkill(
    skillName: string,
    feedback: string
  ): Promise<{ success: boolean; skill?: DynamicSkill; error?: string }> {
    const skill = this.getSkill(skillName);
    if (!skill) return { success: false, error: `Skill "${skillName}" no encontrado` };

    const response = await this.modelRouter.chat(
      `Mejorá este código de tool basándote en el feedback.
Responde SOLO con el código mejorado completo, sin explicaciones, sin markdown.`,
      [
        {
          role: 'user',
          content: `SKILL: ${skill.name} (v${skill.version})
DESCRIPCIÓN: ${skill.description}

CÓDIGO ACTUAL:
${skill.code}

FEEDBACK / MEJORA SOLICITADA:
${feedback}

STATS:
- Usos: ${skill.usageCount}
- Tasa de éxito: ${skill.successRate}%
- Tiempo promedio: ${skill.averageExecutionMs}ms`,
        },
      ]
    );

    const newCode = response.content.replace(/```typescript?|```/g, '').trim();

    // Validate in sandbox
    const validation = await this.sandbox.validate(
      { handlerCode: newCode },
      skill
    );

    if (!validation.passed) {
      return {
        success: false,
        error: `Código mejorado no pasó validación: ${validation.errors.join(', ')}`,
      };
    }

    // Save previous version
    this.memory.saveSkillVersion(skill.id, skill.version, skill.code, `Pre-upgrade to v${skill.version + 1}`);

    // Forge v2: Save rollback baseline before upgrading
    if (config.forgeAutoRollback) {
      skill.previousVersionCode = skill.code;
      skill.rollbackBaseline = {
        successRate: skill.successRate,
        version: skill.version,
        measuredAt: new Date().toISOString(),
        usageCountAtBaseline: skill.usageCount,
      };
    }

    // Update skill
    skill.code = newCode;
    skill.version++;
    skill.updatedAt = new Date();
    this.saveSkill(skill);
    this.registerSkill(skill);

    logger.info(`Forge: skill "${skill.name}" improved to v${skill.version}`);
    return { success: true, skill };
  }

  // ── Persistence ──

  private saveSkill(skill: DynamicSkill): void {
    const dir = path.join(this.skillsDir, skill.name);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Save manifest (without code — code goes in separate file)
    const manifest = { ...skill, code: undefined };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // Save code
    fs.writeFileSync(path.join(dir, 'handler.ts'), skill.code);

    // Save in SQLite for search
    this.memory.saveSkillMetadata(skill);

    this.loadedSkills.set(skill.name, skill);
  }

  // ── Load all skills on startup ──

  async loadSkills(): Promise<number> {
    let loaded = 0;

    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(this.skillsDir);
    } catch {
      return 0;
    }

    for (const dir of dirs) {
      try {
        const manifestPath = path.join(this.skillsDir, dir, 'manifest.json');
        const codePath = path.join(this.skillsDir, dir, 'handler.ts');

        if (!fs.existsSync(manifestPath) || !fs.existsSync(codePath)) continue;

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const code = fs.readFileSync(codePath, 'utf-8');

        const skill: DynamicSkill = { ...manifest, code };

        this.loadedSkills.set(skill.name, skill);

        if (skill.enabled) {
          this.registerSkill(skill);
          loaded++;
        }
      } catch (err) {
        logger.warn(`Forge: skill "${dir}" failed to load`, { error: err });
      }
    }

    if (loaded > 0) {
      logger.info(`Forge: ${loaded} dynamic skills loaded`);
    }

    return loaded;
  }

  // ── Register skill as active tool ──

  private registerSkill(skill: DynamicSkill): void {
    const sandbox = this.sandbox;
    const memory = this.memory;
    const toolExecutor = this.toolExecutor;
    const toolRegistry = this.toolRegistry;
    const saveSkill = this.saveSkill.bind(this);
    const checkAndRollback = this.checkAndRollback.bind(this);

    // Build input_schema from parameters
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const p of skill.parameters) {
      properties[p.name] = {
        type: p.type,
        description: p.description,
      };
      if (p.enum) {
        properties[p.name].enum = p.enum;
      }
      if (p.default !== undefined) {
        properties[p.name].default = p.default;
      }
      if (p.required) {
        required.push(p.name);
      }
    }

    const isComposable = skill.composable && config.forgeComposableEnabled && !!toolExecutor;
    const description = isComposable
      ? `[Dynamic/Composable] ${skill.description}`
      : `[Dynamic] ${skill.description}`;

    const wrappedTool: Tool = {
      definition: {
        name: skill.name,
        description,
        input_schema: {
          type: 'object',
          properties,
          required: required.length > 0 ? required : undefined,
        },
      },
      execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
        const startTime = Date.now();

        try {
          let result;

          if (isComposable) {
            // Forge v2: Composable execution with callTool bridge
            const runtimeContext: SkillRuntimeContext & { memoryManager: MemoryManager } = {
              userId: 'owner',
              channel: 'system',
              isOwner: true,
              locale: 'es-CO',
              timeOfDay: this.getTimeOfDay(),
              datetime: new Date().toISOString(),
              availableTools: toolRegistry.getNames(),
              memoryManager: memory,
            };

            const callToolFn = async (name: string, toolParams: Record<string, any>): Promise<ToolResult> => {
              // Prevent recursive calls to this same skill
              if (name === skill.name) {
                return { success: false, output: '', error: 'No se permite llamar al mismo skill recursivamente' };
              }
              return toolExecutor!.execute({ id: `composable-${Date.now()}`, name, input: toolParams });
            };

            result = await sandbox.executeComposable(
              skill.code, params as Record<string, any>, runtimeContext, callToolFn
            );
          } else {
            // Standard Worker Thread execution
            result = await sandbox.execute(skill.code, params as Record<string, any>);
          }

          const elapsed = Date.now() - startTime;

          // Update stats
          skill.usageCount++;
          skill.averageExecutionMs = Math.round(
            (skill.averageExecutionMs * (skill.usageCount - 1) + elapsed) / skill.usageCount
          );

          if (result.success) {
            skill.successRate = Math.round(
              (skill.successRate * (skill.usageCount - 1) + 100) / skill.usageCount
            );
          } else {
            skill.successRate = Math.round(
              (skill.successRate * (skill.usageCount - 1) + 0) / skill.usageCount
            );
          }

          // Log execution for analytics
          memory.logSkillExecution(
            skill.name,
            params as Record<string, any>,
            result.success,
            elapsed,
            result.error
          );

          // Forge v3: Auto-heal on failure
          if (!result.success && config.forgeAutoHeal) {
            this.trackFailure(skill.name, params, result.error || 'Unknown error');
          }

          // Save stats periodically
          if (skill.usageCount % 10 === 0) {
            saveSkill(skill);
          }

          // Forge v2: Check if we need to rollback after enough uses
          if (config.forgeAutoRollback && skill.rollbackBaseline) {
            checkAndRollback(skill.name);
          }

          return {
            success: result.success,
            output: typeof result.output === 'string' ? result.output : JSON.stringify(result.output),
            error: result.error,
          };
        } catch (err: any) {
          skill.usageCount++;
          skill.successRate = Math.round(
            (skill.successRate * (skill.usageCount - 1) + 0) / skill.usageCount
          );

          return {
            success: false,
            output: '',
            error: `Skill ${skill.name} falló: ${err.message}`,
          };
        }
      },
    };

    this.toolRegistry.register(wrappedTool);
  }

  // ── Forge v3: Self-Healing ──

  private trackFailure(skillName: string, input: any, error: string): void {
    if (!this.failureLog.has(skillName)) this.failureLog.set(skillName, []);
    const log = this.failureLog.get(skillName)!;

    // Keep last 20 failures
    log.push({ input, error, at: Date.now() });
    if (log.length > 20) log.shift();

    // Check: ≥N failures in last hour with ≥1 distinct error → auto-heal
    const minFailures = config.forgeAutoHealMinFailures;
    const recentErrors = log.filter(f => f.at > Date.now() - 3600_000);
    const distinctErrors = new Set(recentErrors.map(f => f.error)).size;

    if (recentErrors.length >= minFailures && distinctErrors >= 1) {
      this.autoHealSkill(skillName, recentErrors).catch(err =>
        logger.error(`Auto-heal failed for ${skillName}`, { error: err })
      );
      this.failureLog.delete(skillName); // Reset after heal attempt
    }
  }

  private async autoHealSkill(
    skillName: string,
    failures: Array<{ input: any; error: string }>
  ): Promise<void> {
    const errorSummary = failures
      .map(f => `Input: ${JSON.stringify(f.input).substring(0, 100)} → Error: ${f.error}`)
      .join('\n');

    logger.info(`SkillForge auto-healing "${skillName}" (${failures.length} recent failures)`);

    const feedback =
      `El skill está fallando en producción. Errores reales:\n${errorSummary}\n\n` +
      `Corregí el código para manejar estos casos.`;

    try {
      const result = await this.improveSkill(skillName, feedback);
      if (result.success) {
        logger.info(`SkillForge auto-healed "${skillName}" successfully`);
        this.memory.saveFact(
          `skill_autohealed_${skillName}`,
          `Auto-healed after ${failures.length} failures at ${new Date().toISOString()}`,
          'forge'
        );
      } else {
        logger.warn(`Auto-heal improvement failed for "${skillName}": ${result.error}`);
      }
    } catch (err) {
      logger.error(`Auto-heal improvement threw for "${skillName}"`, { error: err });
    }
  }

  // ── Forge v2: Auto-Rollback ──

  private checkAndRollback(skillName: string): void {
    const skill = this.loadedSkills.get(skillName);
    if (!skill || !skill.rollbackBaseline || !skill.previousVersionCode) return;

    const baseline = skill.rollbackBaseline;
    const usesSinceBaseline = skill.usageCount - baseline.usageCountAtBaseline;

    // Need enough uses to evaluate
    if (usesSinceBaseline < config.forgeRollbackMinUses) return;

    const threshold = config.forgeRollbackThreshold;
    const drop = baseline.successRate - skill.successRate;

    if (drop >= threshold) {
      logger.warn(
        `Forge ROLLBACK: "${skillName}" v${skill.version} → ` +
        `success dropped ${baseline.successRate}% → ${skill.successRate}% (threshold: ${threshold})`
      );

      // Restore previous code
      skill.code = skill.previousVersionCode;
      skill.version++;
      skill.updatedAt = new Date();
      skill.previousVersionCode = undefined;
      skill.rollbackBaseline = undefined;

      this.saveSkill(skill);
      this.registerSkill(skill);

      this.memory.saveFact(
        `forge_rollback_${skillName}`,
        `Skill "${skillName}" fue revertido automáticamente por caída de rendimiento (${baseline.successRate}% → ${skill.successRate}%)`,
        'forge'
      );
    }
  }

  private getTimeOfDay(): string {
    const hour = new Date().getHours();
    if (hour < 6) return 'madrugada';
    if (hour < 12) return 'mañana';
    if (hour < 18) return 'tarde';
    return 'noche';
  }

  // ── Install dependencies ──

  private async installDependencies(deps: string[]): Promise<void> {
    const ALLOWED_PACKAGES = new Set([
      'cheerio', 'xml2js', 'csv-parse', 'date-fns',
      'lodash', 'marked', 'turndown', 'qs', 'form-data',
      'jsdom', 'node-html-parser',
    ]);

    const BLOCKED_PACKAGES = new Set([
      'child_process', 'fs-extra', 'shelljs', 'execa',
      'node-pty', 'vm2',
    ]);

    for (const dep of deps) {
      const pkgName = dep.split('@')[0];

      if (BLOCKED_PACKAGES.has(pkgName)) {
        throw new Error(`Package "${pkgName}" está bloqueado por seguridad`);
      }

      if (!ALLOWED_PACKAGES.has(pkgName)) {
        throw new Error(`Package "${pkgName}" no está en la whitelist. Agregalo manualmente si es seguro.`);
      }
    }

    const { execSync } = require('child_process');
    execSync(`npm install ${deps.join(' ')} --save`, {
      cwd: config.rootDir,
      timeout: 60000,
    });
  }

  // ── Accessors ──

  getSkill(name: string): DynamicSkill | undefined {
    return this.loadedSkills.get(name);
  }

  listSkills(): DynamicSkill[] {
    return Array.from(this.loadedSkills.values());
  }

  removeSkill(name: string): boolean {
    const skill = this.loadedSkills.get(name);
    if (!skill) return false;

    skill.enabled = false;
    this.saveSkill(skill);
    this.toolRegistry.unregister(name);
    return true;
  }

  toggleSkill(name: string, enabled: boolean): boolean {
    const skill = this.loadedSkills.get(name);
    if (!skill) return false;

    skill.enabled = enabled;
    this.saveSkill(skill);

    if (enabled) {
      this.registerSkill(skill);
    } else {
      this.toolRegistry.unregister(name);
    }

    return true;
  }
}
