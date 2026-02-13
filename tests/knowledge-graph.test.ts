// ═══════════════════════════════════════
// ATLAS — KnowledgeGraph Tests
// ═══════════════════════════════════════

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../src/utils/logger', () => ({ __esModule: true, default: mockLogger }));

import Database from 'better-sqlite3';
import { KnowledgeGraph } from '../src/hippocampus/knowledge-graph';

describe('KnowledgeGraph', () => {
  let db: Database.Database;
  let kg: KnowledgeGraph;

  beforeEach(() => {
    db = new Database(':memory:');
    kg = new KnowledgeGraph(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
  });

  describe('Entities', () => {
    it('should add and retrieve entities', () => {
      const id = kg.addEntity('Jose', 'persona', { role: 'owner' });
      expect(id).toBeTruthy();

      const entity = kg.getEntity('Jose');
      expect(entity).toBeTruthy();
      expect(entity!.name).toBe('Jose');
      expect(entity!.type).toBe('persona');
      expect(entity!.properties.role).toBe('owner');
    });

    it('should upsert on duplicate name+type', () => {
      kg.addEntity('Jose', 'persona', { v: 1 });
      kg.addEntity('Jose', 'persona', { v: 2 });

      const entity = kg.getEntity('Jose');
      expect(entity!.properties.v).toBe(2);
    });

    it('should list entities by type', () => {
      kg.addEntity('Jose', 'persona');
      kg.addEntity('Ana', 'persona');
      kg.addEntity('Acme Corp', 'empresa');

      const personas = kg.getEntities('persona');
      expect(personas.length).toBe(2);

      const empresas = kg.getEntities('empresa');
      expect(empresas.length).toBe(1);
    });

    it('should delete entities and their relationships', () => {
      kg.addEntity('A', 'test');
      kg.addEntity('B', 'test');
      kg.addRelationship('A', 'B', 'knows');

      kg.deleteEntity('A');
      expect(kg.getEntity('A')).toBeNull();
      expect(kg.getRelationships('B').length).toBe(0);
    });
  });

  describe('Relationships', () => {
    it('should add and retrieve relationships', () => {
      kg.addEntity('Jose', 'persona');
      kg.addEntity('Acme Corp', 'empresa');
      kg.addRelationship('Jose', 'Acme Corp', 'es_dueño_de');

      const rels = kg.getRelationships('Jose');
      expect(rels.length).toBe(1);
      expect(rels[0].relationship.type).toBe('es_dueño_de');
      expect(rels[0].target.name).toBe('Acme Corp');
    });

    it('should support bidirectional relationships', () => {
      kg.addEntity('A', 'test');
      kg.addEntity('B', 'test');
      kg.addRelationship('A', 'B', 'friends', {}, true);

      const relsFromB = kg.getRelationships('B');
      expect(relsFromB.length).toBe(1);
      expect(relsFromB[0].relationship.bidirectional).toBe(true);
    });

    it('should delete relationships', () => {
      kg.addEntity('A', 'test');
      kg.addEntity('B', 'test');
      const relId = kg.addRelationship('A', 'B', 'knows');

      expect(kg.deleteRelationship(relId)).toBe(true);
      expect(kg.getRelationships('A').length).toBe(0);
    });

    it('should throw for non-existent entities', () => {
      kg.addEntity('A', 'test');
      expect(() => kg.addRelationship('A', 'NonExistent', 'knows')).toThrow();
    });
  });

  describe('Querying', () => {
    it('should find related entities by name', () => {
      kg.addEntity('ATLAS', 'sistema');
      kg.addEntity('Jose', 'persona');
      kg.addRelationship('Jose', 'ATLAS', 'usa');

      const results = kg.findRelatedEntities('Jose');
      expect(results.length).toBe(1);
      expect(results[0].entity.name).toBe('Jose');
      expect(results[0].relationships.length).toBeGreaterThan(0);
    });

    it('should find path between entities', () => {
      kg.addEntity('A', 'test');
      kg.addEntity('B', 'test');
      kg.addEntity('C', 'test');
      kg.addRelationship('A', 'B', 'to');
      kg.addRelationship('B', 'C', 'to');

      const path = kg.findPath('A', 'C');
      expect(path.length).toBe(3);
      expect(path[0].name).toBe('A');
      expect(path[2].name).toBe('C');
    });

    it('should return empty for no path', () => {
      kg.addEntity('A', 'test');
      kg.addEntity('B', 'test');
      // No relationship
      const path = kg.findPath('A', 'B');
      expect(path.length).toBe(0);
    });
  });

  describe('Stats', () => {
    it('should return correct stats', () => {
      kg.addEntity('A', 'persona');
      kg.addEntity('B', 'empresa');
      kg.addRelationship('A', 'B', 'works_at');

      const stats = kg.getStats();
      expect(stats.entityCount).toBe(2);
      expect(stats.relationshipCount).toBe(1);
      expect(stats.entityTypes.length).toBe(2);
    });
  });

  describe('Context for Query', () => {
    it('should generate context string', () => {
      kg.addEntity('Jose', 'persona');
      kg.addEntity('ATLAS', 'sistema');
      kg.addRelationship('Jose', 'ATLAS', 'usa');

      const context = kg.getContextForQuery('Jose');
      expect(context).toContain('Jose');
      expect(context).toContain('Knowledge Graph');
    });

    it('should return empty for no matches', () => {
      const context = kg.getContextForQuery('NonExistent');
      expect(context).toBe('');
    });
  });
});
