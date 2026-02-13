// ═══════════════════════════════════════
// ATLAS — Document Search Tool (RAG)
// Semantic search across indexed documents
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { DocumentManager } from '../../rag/document-manager';

export class DocSearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'doc_search',
    description:
      'Buscar información en documentos indexados (PDF, DOCX, TXT, etc.) usando búsqueda semántica. ' +
      'Útil para encontrar información específica en archivos del usuario.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Texto a buscar semánticamente en los documentos',
        },
        limit: {
          type: 'number',
          description: 'Máximo de resultados (default: 5)',
        },
        filename: {
          type: 'string',
          description: 'Filtrar por nombre de archivo (parcial, case-insensitive)',
        },
      },
      required: ['query'],
    },
  };

  private docManager: DocumentManager;

  constructor(docManager: DocumentManager) {
    this.docManager = docManager;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const query = String(params.query);
    const limit = (params.limit as number) || 5;
    const filename = params.filename ? String(params.filename) : undefined;

    if (!query) {
      return { success: false, output: '', error: 'Query vacío' };
    }

    try {
      const results = await this.docManager.search(query, limit, filename);

      if (results.length === 0) {
        return {
          success: true,
          output: 'No se encontraron resultados relevantes en los documentos indexados.',
        };
      }

      const formatted = results.map((r, i) =>
        `[${i + 1}] Archivo: ${r.filename} (chunk #${r.chunkIndex}, relevancia: ${(1 - r.distance).toFixed(2)})\n${r.text}`
      ).join('\n\n---\n\n');

      return {
        success: true,
        output: `${results.length} resultado(s) encontrado(s):\n\n${formatted}`,
      };
    } catch (err: any) {
      return { success: false, output: '', error: err.message };
    }
  }
}
