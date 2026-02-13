// ═══════════════════════════════════════
// ATLAS — Plugin Tool
// v0.9 Feature 5: Install/manage plugins
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../types';
import { PluginManager } from '../../forge/plugin-manager';

export class PluginTool implements Tool {
  private manager: PluginManager;

  definition = {
    name: 'plugin',
    description: 'Gestionar plugins de ATLAS: instalar, desinstalar, listar, activar/desactivar. Los plugins agregan herramientas nuevas.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['install', 'uninstall', 'list', 'enable', 'disable'],
          description: 'Accion',
        },
        path: { type: 'string', description: 'Ruta al archivo del plugin (para install)' },
        name: { type: 'string', description: 'Nombre del plugin (para uninstall/enable/disable)' },
      },
      required: ['action'],
    },
    dangerous: true,
  };

  constructor(manager: PluginManager) {
    this.manager = manager;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;

    try {
      switch (action) {
        case 'install': {
          const pluginPath = params.path as string;
          if (!pluginPath) return { success: false, output: '', error: 'Se requiere path' };
          const result = await this.manager.install('local', pluginPath);
          return { success: true, output: `Plugin "${result.name}" instalado con ${result.tools.length} herramientas: ${result.tools.join(', ')}` };
        }

        case 'uninstall': {
          const name = params.name as string;
          if (!name) return { success: false, output: '', error: 'Se requiere name' };
          const removed = await this.manager.uninstall(name);
          return { success: true, output: removed ? `Plugin "${name}" desinstalado.` : `Plugin "${name}" no encontrado.` };
        }

        case 'list': {
          const plugins = this.manager.listPlugins();
          if (plugins.length === 0) return { success: true, output: 'No hay plugins instalados.' };
          const lines = plugins.map(p =>
            `- ${p.name} v${p.version} (${p.enabled ? 'activo' : 'inactivo'}): ${p.toolsProvided.join(', ') || 'sin tools'}`
          );
          return { success: true, output: `Plugins (${plugins.length}):\n${lines.join('\n')}` };
        }

        case 'enable': {
          const name = params.name as string;
          if (!name) return { success: false, output: '', error: 'Se requiere name' };
          await this.manager.togglePlugin(name, true);
          return { success: true, output: `Plugin "${name}" activado.` };
        }

        case 'disable': {
          const name = params.name as string;
          if (!name) return { success: false, output: '', error: 'Se requiere name' };
          await this.manager.togglePlugin(name, false);
          return { success: true, output: `Plugin "${name}" desactivado.` };
        }

        default:
          return { success: false, output: '', error: `Accion desconocida: ${action}` };
      }
    } catch (err: any) {
      return { success: false, output: '', error: err.message };
    }
  }
}
