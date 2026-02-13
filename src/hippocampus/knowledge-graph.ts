// ═══════════════════════════════════════
// ATLAS — Knowledge Graph
// v0.9 Feature 8: Entity-Relationship Store
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { KGEntity, KGRelationship, ModelProvider } from '../types';
import logger from '../utils/logger';

export class KnowledgeGraph {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kg_entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        properties TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(name, type)
      );
      CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(type);
      CREATE INDEX IF NOT EXISTS idx_kg_entities_name ON kg_entities(name);

      CREATE TABLE IF NOT EXISTS kg_relationships (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL,
        properties TEXT DEFAULT '{}',
        bidirectional INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (source_id) REFERENCES kg_entities(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES kg_entities(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_kg_rel_source ON kg_relationships(source_id);
      CREATE INDEX IF NOT EXISTS idx_kg_rel_target ON kg_relationships(target_id);
      CREATE INDEX IF NOT EXISTS idx_kg_rel_type ON kg_relationships(type);
    `);
    logger.info('KnowledgeGraph tables initialized');
  }

  // ── Entity CRUD ──

  addEntity(name: string, type: string, properties: Record<string, any> = {}): string {
    const id = uuid();
    try {
      this.db.prepare(`
        INSERT INTO kg_entities (id, name, type, properties) VALUES (?, ?, ?, ?)
      `).run(id, name, type, JSON.stringify(properties));
      logger.info(`KG: entity added "${name}" (${type})`);
      return id;
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint')) {
        // Update existing
        this.db.prepare(`
          UPDATE kg_entities SET properties = ?, updated_at = datetime('now')
          WHERE name = ? AND type = ?
        `).run(JSON.stringify(properties), name, type);
        const existing = this.db.prepare(
          'SELECT id FROM kg_entities WHERE name = ? AND type = ?'
        ).get(name, type) as { id: string };
        return existing.id;
      }
      throw err;
    }
  }

  getEntity(nameOrId: string): KGEntity | null {
    const row = this.db.prepare(
      'SELECT * FROM kg_entities WHERE id = ? OR name = ? LIMIT 1'
    ).get(nameOrId, nameOrId) as any;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      properties: JSON.parse(row.properties || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getEntities(type?: string, limit: number = 100): KGEntity[] {
    const query = type
      ? 'SELECT * FROM kg_entities WHERE type = ? ORDER BY name LIMIT ?'
      : 'SELECT * FROM kg_entities ORDER BY name LIMIT ?';
    const args = type ? [type, limit] : [limit];
    const rows = this.db.prepare(query).all(...args) as any[];
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      properties: JSON.parse(r.properties || '{}'),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  deleteEntity(nameOrId: string): boolean {
    const entity = this.getEntity(nameOrId);
    if (!entity) return false;
    this.db.prepare('DELETE FROM kg_relationships WHERE source_id = ? OR target_id = ?').run(entity.id, entity.id);
    this.db.prepare('DELETE FROM kg_entities WHERE id = ?').run(entity.id);
    logger.info(`KG: entity deleted "${entity.name}"`);
    return true;
  }

  // ── Relationship CRUD ──

  addRelationship(
    sourceName: string,
    targetName: string,
    type: string,
    properties: Record<string, any> = {},
    bidirectional: boolean = false
  ): string {
    const source = this.getEntity(sourceName);
    const target = this.getEntity(targetName);
    if (!source) throw new Error(`Entity not found: "${sourceName}"`);
    if (!target) throw new Error(`Entity not found: "${targetName}"`);

    const id = uuid();
    this.db.prepare(`
      INSERT INTO kg_relationships (id, source_id, target_id, type, properties, bidirectional)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, source.id, target.id, type, JSON.stringify(properties), bidirectional ? 1 : 0);
    logger.info(`KG: relationship "${source.name}" -[${type}]-> "${target.name}"`);
    return id;
  }

  getRelationships(entityNameOrId: string): Array<{ relationship: KGRelationship; source: KGEntity; target: KGEntity }> {
    const entity = this.getEntity(entityNameOrId);
    if (!entity) return [];

    const rows = this.db.prepare(`
      SELECT r.*,
        s.name as source_name, s.type as source_type, s.properties as source_props,
        t.name as target_name, t.type as target_type, t.properties as target_props
      FROM kg_relationships r
      JOIN kg_entities s ON r.source_id = s.id
      JOIN kg_entities t ON r.target_id = t.id
      WHERE r.source_id = ? OR r.target_id = ?
      OR (r.bidirectional = 1 AND (r.source_id = ? OR r.target_id = ?))
    `).all(entity.id, entity.id, entity.id, entity.id) as any[];

    return rows.map(r => ({
      relationship: {
        id: r.id,
        sourceId: r.source_id,
        targetId: r.target_id,
        type: r.type,
        properties: JSON.parse(r.properties || '{}'),
        bidirectional: r.bidirectional === 1,
        createdAt: r.created_at,
      },
      source: {
        id: r.source_id,
        name: r.source_name,
        type: r.source_type,
        properties: JSON.parse(r.source_props || '{}'),
        createdAt: '', updatedAt: '',
      },
      target: {
        id: r.target_id,
        name: r.target_name,
        type: r.target_type,
        properties: JSON.parse(r.target_props || '{}'),
        createdAt: '', updatedAt: '',
      },
    }));
  }

  deleteRelationship(id: string): boolean {
    const result = this.db.prepare('DELETE FROM kg_relationships WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ── Query ──

  findRelatedEntities(query: string, limit: number = 5): Array<{ entity: KGEntity; relationships: string[] }> {
    // Search entities by name similarity
    const entities = this.db.prepare(`
      SELECT * FROM kg_entities
      WHERE name LIKE ? OR name LIKE ? OR type LIKE ?
      ORDER BY name LIMIT ?
    `).all(`%${query}%`, `${query}%`, `%${query}%`, limit) as any[];

    return entities.map(e => {
      const rels = this.db.prepare(`
        SELECT r.type, CASE WHEN r.source_id = ? THEN t.name ELSE s.name END as related
        FROM kg_relationships r
        JOIN kg_entities s ON r.source_id = s.id
        JOIN kg_entities t ON r.target_id = t.id
        WHERE r.source_id = ? OR r.target_id = ?
        LIMIT 10
      `).all(e.id, e.id, e.id) as any[];

      return {
        entity: {
          id: e.id,
          name: e.name,
          type: e.type,
          properties: JSON.parse(e.properties || '{}'),
          createdAt: e.created_at,
          updatedAt: e.updated_at,
        },
        relationships: rels.map((r: any) => `${r.type} → ${r.related}`),
      };
    });
  }

  findPath(fromName: string, toName: string, maxDepth: number = 4): KGEntity[] {
    const from = this.getEntity(fromName);
    const to = this.getEntity(toName);
    if (!from || !to) return [];

    // BFS path finding
    const visited = new Set<string>();
    const queue: Array<{ id: string; path: string[] }> = [{ id: from.id, path: [from.id] }];
    visited.add(from.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.id === to.id) {
        return current.path.map(id => this.getEntityById(id)!).filter(Boolean);
      }
      if (current.path.length >= maxDepth) continue;

      const neighbors = this.db.prepare(`
        SELECT CASE WHEN source_id = ? THEN target_id ELSE source_id END as neighbor_id
        FROM kg_relationships
        WHERE source_id = ? OR target_id = ?
      `).all(current.id, current.id, current.id) as Array<{ neighbor_id: string }>;

      for (const n of neighbors) {
        if (!visited.has(n.neighbor_id)) {
          visited.add(n.neighbor_id);
          queue.push({ id: n.neighbor_id, path: [...current.path, n.neighbor_id] });
        }
      }
    }

    return [];
  }

  private getEntityById(id: string): KGEntity | null {
    const row = this.db.prepare('SELECT * FROM kg_entities WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id, name: row.name, type: row.type,
      properties: JSON.parse(row.properties || '{}'),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  getGraph(entityType?: string): { entities: KGEntity[]; relationships: KGRelationship[] } {
    const entities = this.getEntities(entityType, 500);
    const entityIds = entities.map(e => e.id);

    let relationships: KGRelationship[] = [];
    if (entityIds.length > 0) {
      const placeholders = entityIds.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT * FROM kg_relationships
        WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
      `).all(...entityIds, ...entityIds) as any[];

      relationships = rows.map(r => ({
        id: r.id,
        sourceId: r.source_id,
        targetId: r.target_id,
        type: r.type,
        properties: JSON.parse(r.properties || '{}'),
        bidirectional: r.bidirectional === 1,
        createdAt: r.created_at,
      }));
    }

    return { entities, relationships };
  }

  getStats(): { entityCount: number; relationshipCount: number; entityTypes: Array<{ type: string; count: number }> } {
    const entityCount = (this.db.prepare('SELECT COUNT(*) as c FROM kg_entities').get() as any).c;
    const relationshipCount = (this.db.prepare('SELECT COUNT(*) as c FROM kg_relationships').get() as any).c;
    const entityTypes = this.db.prepare(
      'SELECT type, COUNT(*) as count FROM kg_entities GROUP BY type ORDER BY count DESC'
    ).all() as Array<{ type: string; count: number }>;
    return { entityCount, relationshipCount, entityTypes };
  }

  // ── AI Entity Extraction ──

  private modelProvider: ModelProvider | null = null;

  /** Set the model provider for AI extraction */
  setModelProvider(provider: ModelProvider): void {
    this.modelProvider = provider;
  }

  /**
   * Extract entities and relationships from a conversation using AI.
   * Runs async after each interaction — non-blocking.
   */
  async extractFromConversation(userMessage: string, assistantResponse: string, channel: string): Promise<{
    entitiesAdded: number;
    relationshipsAdded: number;
  }> {
    if (!this.modelProvider) return { entitiesAdded: 0, relationshipsAdded: 0 };

    try {
      // Get existing entity types for context
      const existingTypes = this.db.prepare(
        'SELECT DISTINCT type FROM kg_entities ORDER BY type'
      ).all() as Array<{ type: string }>;
      const typesList = existingTypes.map(t => t.type).join(', ') || 'persona, empresa, lugar, producto, servicio, concepto';

      const response = await this.modelProvider.chat(
        `Eres un extractor de entidades y relaciones para un knowledge graph. Analizás conversaciones y extraés información estructurada.

Tipos de entidad existentes: ${typesList}

Respondé ÚNICAMENTE con JSON válido (sin markdown):
{
  "entities": [
    { "name": "Nombre", "type": "tipo", "properties": { "key": "value" } }
  ],
  "relationships": [
    { "source": "Nombre1", "target": "Nombre2", "type": "relación", "bidirectional": false }
  ]
}

Reglas:
- Solo extraé entidades CONCRETAS mencionadas (personas, empresas, lugares, productos, conceptos clave)
- No extraigas conceptos genéricos ni verbos
- El tipo de relación debe ser descriptivo: "trabaja_en", "es_dueño_de", "ubicado_en", "usa", "conoce"
- Si no hay entidades relevantes, devolvé arrays vacíos
- Nombres propios en su forma canónica (José, no jose)`,
        [{
          role: 'user',
          content: `Extractar entidades de esta conversación:\n\nUsuario: ${userMessage.substring(0, 500)}\n\nAsistente: ${assistantResponse.substring(0, 500)}`,
        }],
        undefined,
        { temperature: 0.1, maxTokens: 1000 }
      );

      const parsed = JSON.parse(response.content.replace(/```json?|```/g, '').trim());
      let entitiesAdded = 0;
      let relationshipsAdded = 0;

      // Add entities
      for (const e of parsed.entities || []) {
        if (!e.name || !e.type) continue;
        try {
          this.addEntity(e.name, e.type.toLowerCase(), e.properties || {});
          entitiesAdded++;
        } catch (err) {
          logger.debug(`KG extraction: entity "${e.name}" skipped`, { error: err });
        }
      }

      // Add relationships
      for (const r of parsed.relationships || []) {
        if (!r.source || !r.target || !r.type) continue;
        try {
          // Only add if both entities exist
          const source = this.getEntity(r.source);
          const target = this.getEntity(r.target);
          if (source && target) {
            // Check if relationship already exists
            const existing = this.db.prepare(`
              SELECT 1 FROM kg_relationships
              WHERE source_id = ? AND target_id = ? AND type = ?
            `).get(source.id, target.id, r.type);
            if (!existing) {
              this.addRelationship(r.source, r.target, r.type, {}, r.bidirectional || false);
              relationshipsAdded++;
            }
          }
        } catch (err) {
          logger.debug(`KG extraction: relationship "${r.source}->${r.target}" skipped`, { error: err });
        }
      }

      if (entitiesAdded > 0 || relationshipsAdded > 0) {
        logger.info(`KG extraction: +${entitiesAdded} entities, +${relationshipsAdded} relationships`);
      }

      return { entitiesAdded, relationshipsAdded };
    } catch (err) {
      logger.debug('KG extraction failed (non-critical)', { error: err });
      return { entitiesAdded: 0, relationshipsAdded: 0 };
    }
  }

  /** Get context string for system prompt injection (entities + relationships related to query) */
  getContextForQuery(query: string, limit: number = 5): string {
    const results = this.findRelatedEntities(query, limit);
    if (results.length === 0) return '';

    const lines = results.map(r => {
      const rels = r.relationships.length > 0 ? ` (${r.relationships.join('; ')})` : '';
      return `• ${r.entity.name} [${r.entity.type}]${rels}`;
    });
    return `Knowledge Graph:\n${lines.join('\n')}`;
  }
}
