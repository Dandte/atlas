// ═══════════════════════════════════════
// ATLAS — Forge Skill Tool (Phase 6)
// Create, list, improve, manage dynamic skills
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { SkillForge } from '../../forge/skill-forge';
import { MemoryManager } from '../../hippocampus/memory-manager';
import logger from '../../utils/logger';

export class ForgeSkillTool implements Tool {
  private skillForge: SkillForge;
  private memory: MemoryManager;

  definition: ToolDefinition = {
    name: 'forge_skill',
    description: `Crear, listar, mejorar, o gestionar skills dinámicos de ATLAS. ATLAS puede crear nuevas herramientas a partir de una descripción. Usar cuando el usuario pide crear un tool, listar skills, mejorar uno existente, o cuando ATLAS mismo detecta que necesita una herramienta que no tiene.`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'improve', 'remove', 'enable', 'disable', 'info'],
          description:
            'Acción: create (crear nuevo), list (ver todos), improve (mejorar existente), remove/enable/disable (gestionar), info (ver detalle)',
        },
        description: {
          type: 'string',
          description:
            'Para create: qué debe hacer el skill. Para improve: qué cambio aplicar.',
        },
        skill_name: {
          type: 'string',
          description:
            'Nombre del skill (para improve/remove/enable/disable/info)',
        },
      },
      required: ['action'],
    },
  };

  constructor(skillForge: SkillForge, memory: MemoryManager) {
    this.skillForge = skillForge;
    this.memory = memory;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;

    try {
      switch (action) {
        case 'create':
          return await this.createSkill(params);
        case 'list':
          return this.listSkills();
        case 'improve':
          return await this.improveSkill(params);
        case 'remove':
          return this.removeSkill(params);
        case 'enable':
          return this.toggleSkill(params, true);
        case 'disable':
          return this.toggleSkill(params, false);
        case 'info':
          return this.skillInfo(params);
        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      return { success: false, output: '', error: err.message };
    }
  }

  private async createSkill(params: Record<string, unknown>): Promise<ToolResult> {
    const description = params.description as string;
    if (!description) {
      return { success: false, output: '', error: 'Se requiere "description" para crear un skill.' };
    }

    const result = await this.skillForge.createSkill(description, 'user');
    if (result.success && result.skill) {
      const lines = [
        `Skill "${result.skill.name}" creado (v${result.skill.version})`,
        `Nombre: ${result.skill.displayName}`,
        `Descripción: ${result.skill.description}`,
        `Tags: ${result.skill.tags.join(', ')}`,
      ];
      if (result.skill.composable) lines.push(`Tipo: Composable (puede usar otros tools via callTool)`);
      if (result.skill.templateUsed) lines.push(`Template base: ${result.skill.templateUsed}`);
      lines.push(`Ya está activo y disponible para usar.`);

      return { success: true, output: lines.join('\n') };
    }
    return { success: false, output: '', error: result.error || 'Error desconocido creando skill' };
  }

  private listSkills(): ToolResult {
    const skills = this.skillForge.listSkills();

    if (skills.length === 0) {
      return { success: true, output: 'No hay skills dinámicos creados.' };
    }

    const lines = skills.map((s) => {
      const status = s.enabled ? 'ON' : 'OFF';
      const type = s.composable ? ' [Composable]' : '';
      const template = s.templateUsed ? ` (template: ${s.templateUsed})` : '';
      return (
        `[${status}] ${s.name} v${s.version}${type}${template} | ${s.description}\n` +
        `  ${s.usageCount} usos | ${s.successRate}% éxito | ${s.averageExecutionMs}ms promedio | Por: ${s.createdBy}`
      );
    });

    return {
      success: true,
      output: `Skills dinámicos (${skills.length}):\n\n${lines.join('\n\n')}`,
    };
  }

  private async improveSkill(params: Record<string, unknown>): Promise<ToolResult> {
    const skillName = params.skill_name as string;
    const feedback = params.description as string;

    if (!skillName || !feedback) {
      return {
        success: false,
        output: '',
        error: 'Se requiere "skill_name" y "description" (feedback de mejora).',
      };
    }

    const result = await this.skillForge.improveSkill(skillName, feedback);
    if (result.success && result.skill) {
      return {
        success: true,
        output: `Skill "${result.skill.name}" mejorado a v${result.skill.version}.`,
      };
    }
    return { success: false, output: '', error: result.error || 'Error mejorando skill' };
  }

  private removeSkill(params: Record<string, unknown>): ToolResult {
    const skillName = params.skill_name as string;
    if (!skillName) {
      return { success: false, output: '', error: 'Se requiere "skill_name".' };
    }

    const removed = this.skillForge.removeSkill(skillName);
    if (removed) {
      return { success: true, output: `Skill "${skillName}" deshabilitado y removido.` };
    }
    return { success: false, output: '', error: `Skill "${skillName}" no encontrado.` };
  }

  private toggleSkill(params: Record<string, unknown>, enabled: boolean): ToolResult {
    const skillName = params.skill_name as string;
    if (!skillName) {
      return { success: false, output: '', error: 'Se requiere "skill_name".' };
    }

    const toggled = this.skillForge.toggleSkill(skillName, enabled);
    if (toggled) {
      return {
        success: true,
        output: `Skill "${skillName}" ${enabled ? 'habilitado' : 'deshabilitado'}.`,
      };
    }
    return { success: false, output: '', error: `Skill "${skillName}" no encontrado.` };
  }

  private skillInfo(params: Record<string, unknown>): ToolResult {
    const skillName = params.skill_name as string;
    if (!skillName) {
      return { success: false, output: '', error: 'Se requiere "skill_name".' };
    }

    const skill = this.skillForge.getSkill(skillName);
    if (!skill) {
      return { success: false, output: '', error: `Skill "${skillName}" no encontrado.` };
    }

    // Get version history
    const versions = this.memory.getSkillVersions(skill.id);

    const info = [
      `Skill: ${skill.name} (v${skill.version})`,
      `Nombre: ${skill.displayName}`,
      `Descripción: ${skill.description}`,
      `Estado: ${skill.enabled ? 'Habilitado' : 'Deshabilitado'}`,
      `Composable: ${skill.composable ? 'Sí (puede usar callTool)' : 'No'}`,
      `Template: ${skill.templateUsed || 'ninguno'}`,
      `Creado por: ${skill.createdBy}`,
      `Creado: ${skill.createdAt}`,
      `Actualizado: ${skill.updatedAt}`,
      ``,
      `Stats:`,
      `  Usos: ${skill.usageCount}`,
      `  Tasa de éxito: ${skill.successRate}%`,
      `  Tiempo promedio: ${skill.averageExecutionMs}ms`,
    ];

    if (skill.rollbackBaseline) {
      info.push(`  Rollback baseline: ${skill.rollbackBaseline.successRate}% (v${skill.rollbackBaseline.version})`);
    }

    info.push(
      ``,
      `Tags: ${skill.tags.join(', ')}`,
      `Dependencias: ${skill.dependencies.length > 0 ? skill.dependencies.join(', ') : 'ninguna'}`,
      ``,
      `Tests (${skill.testCases.length}):`,
      ...skill.testCases.map((t) => `  - ${t.description}`),
      ``,
      `Versiones (${versions.length + 1}):`,
      `  v${skill.version} (actual)`,
      ...versions.map((v) => `  v${v.version} — ${v.createdAt}${v.changelog ? ` (${v.changelog})` : ''}`),
      ``,
      `Código (${skill.code.split('\n').length} líneas):`,
      skill.code.substring(0, 500) + (skill.code.length > 500 ? '\n...(truncado)' : ''),
    );

    return { success: true, output: info.join('\n') };
  }
}
