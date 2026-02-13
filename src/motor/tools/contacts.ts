// ═══════════════════════════════════════
// ATLAS — Contacts Tool
// Manage contact aliases for WhatsApp
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { MemoryManager } from '../../hippocampus/memory-manager';
import logger from '../../utils/logger';

export class ContactsTool implements Tool {
  definition: ToolDefinition = {
    name: 'contacts',
    description:
      'Gestionar directorio de contactos para envío de mensajes por WhatsApp. ' +
      'Guardar aliases como "mi esposa = 573001234567" o "gerente Suba = 573009876543". ' +
      'Listar, buscar o eliminar contactos guardados.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'list', 'remove', 'search'],
          description: 'Acción a realizar',
        },
        alias: {
          type: 'string',
          description: 'Nombre o alias del contacto (ej: "gerente Suba", "mi esposa")',
        },
        phone: {
          type: 'string',
          description: 'Número con código de país (ej: "573001234567")',
        },
      },
      required: ['action'],
    },
  };

  private memory: MemoryManager;

  constructor(memory: MemoryManager) {
    this.memory = memory;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action);

    try {
      switch (action) {
        case 'save': {
          const alias = String(params.alias || '');
          let phone = String(params.phone || '');
          if (!alias || !phone) {
            return { success: false, output: '', error: 'Se requiere alias y phone para guardar' };
          }

          // Normalize phone: Colombian 10-digit → add 57
          phone = phone.replace(/[\s\-\(\)\+]/g, '');
          if (/^\d{10}$/.test(phone) && phone.startsWith('3')) {
            phone = '57' + phone;
          }
          if (phone.startsWith('0')) {
            phone = '57' + phone.substring(1);
          }

          const key = `contacto_${alias.toLowerCase()}`;
          this.memory.saveFact(key, phone, 'contacts', 1.0);
          logger.info(`Contact saved: ${alias} → ${phone}`);
          return {
            success: true,
            output: `📇 Contacto guardado: "${alias}" → ${phone}`,
          };
        }

        case 'list': {
          const facts = this.memory.searchFacts('contacto_', 100);
          if (facts.length === 0) {
            return { success: true, output: 'No hay contactos guardados.' };
          }
          const lines = facts.map(f => {
            const alias = f.key.replace('contacto_', '');
            return `• ${alias}: ${f.value}`;
          });
          return {
            success: true,
            output: `📇 Contactos (${facts.length}):\n${lines.join('\n')}`,
          };
        }

        case 'remove': {
          const alias = String(params.alias || '');
          if (!alias) {
            return { success: false, output: '', error: 'Se requiere alias para eliminar' };
          }
          const key = `contacto_${alias.toLowerCase()}`;
          const fact = this.memory.getFact(key);
          if (fact) {
            this.memory.deleteFact(fact.id);
            logger.info(`Contact removed: ${alias}`);
            return { success: true, output: `Contacto "${alias}" eliminado.` };
          }
          return { success: false, output: '', error: `No se encontró contacto: "${alias}"` };
        }

        case 'search': {
          const query = String(params.alias || '');
          if (!query) {
            return { success: false, output: '', error: 'Se requiere alias para buscar' };
          }
          const results = this.memory.searchFacts(`contacto_${query}`, 10);
          if (results.length === 0) {
            return { success: true, output: `No se encontraron contactos con "${query}".` };
          }
          const lines = results.map(f => {
            const alias = f.key.replace('contacto_', '');
            return `• ${alias}: ${f.value}`;
          });
          return {
            success: true,
            output: `Resultados (${results.length}):\n${lines.join('\n')}`,
          };
        }

        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      return { success: false, output: '', error: err.message };
    }
  }
}
