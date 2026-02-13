// ═══════════════════════════════════════
// ATLAS — Document Management Tool (RAG)
// Index, list, remove, reindex documents
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { DocumentManager } from '../../rag/document-manager';

export class DocManageTool implements Tool {
  definition: ToolDefinition = {
    name: 'doc_manage',
    description:
      'Gestionar documentos indexados: indexar nuevos archivos, listar documentos, eliminar, reindexar, ver estadísticas.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['index', 'list', 'remove', 'reindex', 'stats'],
          description: 'Acción a realizar',
        },
        file_path: {
          type: 'string',
          description: 'Ruta del archivo a indexar (para action=index)',
        },
        document_id: {
          type: 'string',
          description: 'ID del documento (para action=remove/reindex)',
        },
      },
      required: ['action'],
    },
  };

  private docManager: DocumentManager;

  constructor(docManager: DocumentManager) {
    this.docManager = docManager;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action);

    try {
      switch (action) {
        case 'index': {
          const filePath = String(params.file_path || '');
          if (!filePath) {
            return { success: false, output: '', error: 'Se requiere file_path para indexar' };
          }
          const doc = await this.docManager.ingest(filePath);
          return {
            success: true,
            output: `Documento indexado: ${doc.filename}\n- ID: ${doc.id}\n- Chunks: ${doc.chunkCount}\n- Tamaño: ${(doc.fileSize / 1024).toFixed(1)} KB`,
          };
        }

        case 'list': {
          const docs = this.docManager.listDocuments();
          if (docs.length === 0) {
            return { success: true, output: 'No hay documentos indexados.' };
          }
          const list = docs.map(d =>
            `- ${d.filename} (${d.chunkCount} chunks, ${(d.fileSize / 1024).toFixed(1)} KB) [${d.id}]`
          ).join('\n');
          return { success: true, output: `${docs.length} documento(s):\n${list}` };
        }

        case 'remove': {
          const docId = String(params.document_id || '');
          if (!docId) {
            return { success: false, output: '', error: 'Se requiere document_id para eliminar' };
          }
          const removed = await this.docManager.removeDocument(docId);
          return {
            success: true,
            output: removed ? 'Documento eliminado.' : 'Documento no encontrado.',
          };
        }

        case 'reindex': {
          const docId = String(params.document_id || '');
          if (!docId) {
            return { success: false, output: '', error: 'Se requiere document_id para reindexar' };
          }
          const reindexed = await this.docManager.reindex(docId);
          return {
            success: true,
            output: reindexed
              ? `Documento reindexado: ${reindexed.filename} (${reindexed.chunkCount} chunks)`
              : 'Documento no encontrado o archivo original no existe.',
          };
        }

        case 'stats': {
          const count = await this.docManager.getDocumentCount();
          const docs = this.docManager.listDocuments();
          const totalChunks = docs.reduce((sum, d) => sum + d.chunkCount, 0);
          const totalSize = docs.reduce((sum, d) => sum + d.fileSize, 0);
          return {
            success: true,
            output: `RAG Stats:\n- Documentos: ${count}\n- Chunks totales: ${totalChunks}\n- Tamaño total: ${(totalSize / 1024 / 1024).toFixed(2)} MB`,
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
