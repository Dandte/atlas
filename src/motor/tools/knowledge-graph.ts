// ═══════════════════════════════════════
// ATLAS — Knowledge Graph Tool
// v0.9 Feature 8: Entity-Relationship queries
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../types';
import { KnowledgeGraph } from '../../hippocampus/knowledge-graph';

export class KnowledgeGraphTool implements Tool {
  private kg: KnowledgeGraph;

  definition = {
    name: 'knowledge_graph',
    description: 'Grafo de conocimiento: agregar entidades (personas, empresas, productos, etc) y relaciones entre ellas. Consultar relaciones, buscar caminos. Usar para mapear relaciones del mundo de Jose.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['add_entity', 'add_relationship', 'get_relationships', 'find_path', 'search', 'delete_entity', 'delete_relationship', 'stats', 'graph'],
          description: 'Accion a ejecutar',
        },
        name: { type: 'string', description: 'Nombre de la entidad' },
        entity_type: {
          type: 'string',
          enum: ['person', 'company', 'product', 'location', 'concept', 'project', 'other'],
          description: 'Tipo de entidad',
        },
        properties: { type: 'object', description: 'Propiedades adicionales (JSON)' },
        source: { type: 'string', description: 'Entidad origen (para relaciones)' },
        target: { type: 'string', description: 'Entidad destino (para relaciones)' },
        relationship_type: { type: 'string', description: 'Tipo de relacion: works_at, owns, competes_with, related_to, uses, part_of, manages, etc' },
        bidirectional: { type: 'boolean', description: 'Si la relacion es bidireccional' },
        query: { type: 'string', description: 'Busqueda de entidades' },
        from: { type: 'string', description: 'Entidad inicio (para find_path)' },
        to: { type: 'string', description: 'Entidad destino (para find_path)' },
        id: { type: 'string', description: 'ID de relacion (para delete_relationship)' },
        filter_type: { type: 'string', description: 'Filtrar por tipo de entidad (para graph)' },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  constructor(kg: KnowledgeGraph) {
    this.kg = kg;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;

    try {
      switch (action) {
        case 'add_entity': {
          const name = params.name as string;
          const type = params.entity_type as string;
          if (!name || !type) return { success: false, output: '', error: 'Se requiere name y entity_type' };
          const id = this.kg.addEntity(name, type, (params.properties as Record<string, any>) || {});
          return { success: true, output: `Entidad creada: "${name}" (${type}) [${id}]` };
        }

        case 'add_relationship': {
          const source = params.source as string;
          const target = params.target as string;
          const relType = params.relationship_type as string;
          if (!source || !target || !relType) return { success: false, output: '', error: 'Se requiere source, target y relationship_type' };
          const id = this.kg.addRelationship(
            source, target, relType,
            (params.properties as Record<string, any>) || {},
            params.bidirectional as boolean || false
          );
          return { success: true, output: `Relacion creada: "${source}" -[${relType}]-> "${target}" [${id}]` };
        }

        case 'get_relationships': {
          const name = params.name as string;
          if (!name) return { success: false, output: '', error: 'Se requiere name' };
          const rels = this.kg.getRelationships(name);
          if (rels.length === 0) return { success: true, output: `No se encontraron relaciones para "${name}"` };
          const lines = rels.map(r =>
            `${r.source.name} (${r.source.type}) -[${r.relationship.type}]-> ${r.target.name} (${r.target.type})`
          );
          return { success: true, output: `Relaciones de "${name}":\n${lines.join('\n')}` };
        }

        case 'find_path': {
          const from = params.from as string;
          const to = params.to as string;
          if (!from || !to) return { success: false, output: '', error: 'Se requiere from y to' };
          const path = this.kg.findPath(from, to);
          if (path.length === 0) return { success: true, output: `No se encontro camino de "${from}" a "${to}"` };
          const pathStr = path.map(e => `${e.name} (${e.type})`).join(' → ');
          return { success: true, output: `Camino: ${pathStr}` };
        }

        case 'search': {
          const query = params.query as string || params.name as string;
          if (!query) return { success: false, output: '', error: 'Se requiere query' };
          const results = this.kg.findRelatedEntities(query, 10);
          if (results.length === 0) return { success: true, output: `No se encontraron entidades para "${query}"` };
          const lines = results.map(r =>
            `- ${r.entity.name} (${r.entity.type})${r.relationships.length > 0 ? ': ' + r.relationships.join(', ') : ''}`
          );
          return { success: true, output: `Resultados para "${query}":\n${lines.join('\n')}` };
        }

        case 'delete_entity': {
          const name = params.name as string;
          if (!name) return { success: false, output: '', error: 'Se requiere name' };
          const deleted = this.kg.deleteEntity(name);
          return { success: true, output: deleted ? `Entidad "${name}" eliminada` : `Entidad "${name}" no encontrada` };
        }

        case 'delete_relationship': {
          const id = params.id as string;
          if (!id) return { success: false, output: '', error: 'Se requiere id' };
          const deleted = this.kg.deleteRelationship(id);
          return { success: true, output: deleted ? `Relacion ${id} eliminada` : `Relacion ${id} no encontrada` };
        }

        case 'stats': {
          const stats = this.kg.getStats();
          let output = `Knowledge Graph:\n`;
          output += `- Entidades: ${stats.entityCount}\n`;
          output += `- Relaciones: ${stats.relationshipCount}\n`;
          if (stats.entityTypes.length > 0) {
            output += `- Tipos: ${stats.entityTypes.map(t => `${t.type} (${t.count})`).join(', ')}`;
          }
          return { success: true, output };
        }

        case 'graph': {
          const filterType = params.filter_type as string | undefined;
          const graph = this.kg.getGraph(filterType);
          let output = `Grafo${filterType ? ` (filtro: ${filterType})` : ''}:\n`;
          output += `Entidades (${graph.entities.length}):\n`;
          for (const e of graph.entities.slice(0, 50)) {
            output += `  - ${e.name} (${e.type})\n`;
          }
          output += `Relaciones (${graph.relationships.length}):\n`;
          for (const r of graph.relationships.slice(0, 50)) {
            const src = graph.entities.find(e => e.id === r.sourceId);
            const tgt = graph.entities.find(e => e.id === r.targetId);
            output += `  - ${src?.name || '?'} -[${r.type}]-> ${tgt?.name || '?'}\n`;
          }
          return { success: true, output };
        }

        default:
          return { success: false, output: '', error: `Accion desconocida: ${action}` };
      }
    } catch (err: any) {
      return { success: false, output: '', error: err.message };
    }
  }
}
