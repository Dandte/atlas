// ═══════════════════════════════════════
// ATLAS — CRM Tool
// Customer Relationship Management (HubSpot, custom)
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';
import Database from 'better-sqlite3';

interface Contact {
  id: number;
  name: string;
  email: string;
  phone: string;
  company: string;
  status: string;
  source: string;
  notes: string;
  tags: string;
  last_contact: string;
  created_at: string;
  updated_at: string;
}

interface Deal {
  id: number;
  title: string;
  contact_id: number;
  amount: number;
  currency: string;
  stage: string;
  probability: number;
  expected_close: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export class CRMTool implements Tool {
  private db: Database.Database;

  definition: ToolDefinition = {
    name: 'crm',
    description: 'Sistema CRM integrado para gestión de contactos y negocios. Acciones: add_contact, search_contacts, update_contact, add_deal, list_deals, update_deal, pipeline (resumen del pipeline), dashboard (métricas), follow_ups (seguimientos pendientes), import (importar desde HubSpot).',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add_contact', 'search_contacts', 'update_contact', 'remove_contact',
                 'add_deal', 'list_deals', 'update_deal', 'pipeline',
                 'dashboard', 'follow_ups', 'add_interaction', 'contact_history'],
          description: 'Acción a realizar',
        },
        // Contact fields
        name: { type: 'string', description: 'Nombre completo del contacto' },
        email: { type: 'string', description: 'Email del contacto' },
        phone: { type: 'string', description: 'Teléfono' },
        company: { type: 'string', description: 'Empresa' },
        status: { type: 'string', enum: ['lead', 'prospect', 'customer', 'churned', 'inactive'], description: 'Estado del contacto' },
        source: { type: 'string', description: 'Origen: web, referral, whatsapp, cold_call, social, etc.' },
        tags: { type: 'string', description: 'Tags separados por coma. Ej: retail,premium,bogota' },
        notes: { type: 'string', description: 'Notas del contacto o deal' },
        // Deal fields
        title: { type: 'string', description: 'Título del negocio' },
        contact_id: { type: 'number', description: 'ID del contacto asociado' },
        amount: { type: 'number', description: 'Monto del negocio en COP' },
        stage: { type: 'string', enum: ['qualification', 'proposal', 'negotiation', 'closed_won', 'closed_lost'], description: 'Etapa del negocio' },
        probability: { type: 'number', description: 'Probabilidad de cierre (0-100)' },
        expected_close: { type: 'string', description: 'Fecha esperada de cierre (YYYY-MM-DD)' },
        // Search/filter
        query: { type: 'string', description: 'Término de búsqueda (nombre, email, teléfono, empresa)' },
        id: { type: 'number', description: 'ID del registro a actualizar/ver' },
        // Interaction
        interaction_type: { type: 'string', enum: ['call', 'email', 'whatsapp', 'meeting', 'note'], description: 'Tipo de interacción' },
      },
      required: ['action'],
    },
  };

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS crm_contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        company TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'lead',
        source TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        tags TEXT DEFAULT '',
        last_contact TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS crm_deals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        contact_id INTEGER REFERENCES crm_contacts(id),
        amount REAL DEFAULT 0,
        currency TEXT DEFAULT 'COP',
        stage TEXT NOT NULL DEFAULT 'qualification',
        probability INTEGER DEFAULT 0,
        expected_close TEXT,
        notes TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS crm_interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id INTEGER NOT NULL REFERENCES crm_contacts(id),
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || '');

    try {
      switch (action) {
        case 'add_contact': return this.addContact(params);
        case 'search_contacts': return this.searchContacts(String(params.query || ''));
        case 'update_contact': return this.updateContact(params);
        case 'remove_contact': return this.removeContact(Number(params.id || 0));
        case 'add_deal': return this.addDeal(params);
        case 'list_deals': return this.listDeals(String(params.stage || ''));
        case 'update_deal': return this.updateDeal(params);
        case 'pipeline': return this.getPipeline();
        case 'dashboard': return this.getDashboard();
        case 'follow_ups': return this.getFollowUps();
        case 'add_interaction': return this.addInteraction(params);
        case 'contact_history': return this.contactHistory(Number(params.id || params.contact_id || 0));
        default: return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      logger.error('CRM error', { error: err, action });
      return { success: false, output: '', error: `Error CRM: ${err.message}` };
    }
  }

  private addContact(params: Record<string, unknown>): ToolResult {
    const name = String(params.name || '');
    if (!name) return { success: false, output: '', error: 'Se requiere name' };

    const result = this.db.prepare(
      `INSERT INTO crm_contacts (name, email, phone, company, status, source, notes, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      name,
      String(params.email || ''),
      String(params.phone || ''),
      String(params.company || ''),
      String(params.status || 'lead'),
      String(params.source || ''),
      String(params.notes || ''),
      String(params.tags || '')
    );

    return {
      success: true,
      output: `Contacto creado: ${name} (ID: ${result.lastInsertRowid})\nEstado: ${params.status || 'lead'} | Empresa: ${params.company || 'N/A'}`,
    };
  }

  private searchContacts(query: string): ToolResult {
    const contacts = query
      ? this.db.prepare(
          `SELECT * FROM crm_contacts WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? OR company LIKE ? OR tags LIKE ? ORDER BY updated_at DESC LIMIT 20`
        ).all(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`) as Contact[]
      : this.db.prepare('SELECT * FROM crm_contacts ORDER BY updated_at DESC LIMIT 20').all() as Contact[];

    if (contacts.length === 0) return { success: true, output: query ? `No se encontraron contactos para "${query}".` : 'No hay contactos.' };

    const lines = contacts.map(c => {
      const tags = c.tags ? ` [${c.tags}]` : '';
      return `  #${c.id} ${c.name} — ${c.status} | ${c.company || 'Sin empresa'} | ${c.phone || c.email || 'Sin datos'}${tags}`;
    });

    return { success: true, output: `Contactos (${contacts.length}):\n${lines.join('\n')}` };
  }

  private updateContact(params: Record<string, unknown>): ToolResult {
    const id = Number(params.id || 0);
    if (!id) return { success: false, output: '', error: 'Se requiere id' };

    const existing = this.db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(id) as Contact | undefined;
    if (!existing) return { success: false, output: '', error: `Contacto #${id} no encontrado` };

    this.db.prepare(
      `UPDATE crm_contacts SET name=?, email=?, phone=?, company=?, status=?, source=?, notes=?, tags=?, updated_at=datetime('now') WHERE id=?`
    ).run(
      params.name ? String(params.name) : existing.name,
      params.email ? String(params.email) : existing.email,
      params.phone ? String(params.phone) : existing.phone,
      params.company ? String(params.company) : existing.company,
      params.status ? String(params.status) : existing.status,
      params.source ? String(params.source) : existing.source,
      params.notes ? String(params.notes) : existing.notes,
      params.tags ? String(params.tags) : existing.tags,
      id
    );

    return { success: true, output: `Contacto #${id} (${existing.name}) actualizado.` };
  }

  private removeContact(id: number): ToolResult {
    if (!id) return { success: false, output: '', error: 'Se requiere id' };
    const result = this.db.prepare('DELETE FROM crm_contacts WHERE id = ?').run(id);
    return result.changes > 0
      ? { success: true, output: `Contacto #${id} eliminado.` }
      : { success: false, output: '', error: `Contacto #${id} no encontrado.` };
  }

  private addDeal(params: Record<string, unknown>): ToolResult {
    const title = String(params.title || '');
    if (!title) return { success: false, output: '', error: 'Se requiere title' };

    const result = this.db.prepare(
      `INSERT INTO crm_deals (title, contact_id, amount, stage, probability, expected_close, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      title,
      params.contact_id ? Number(params.contact_id) : null,
      Number(params.amount || 0),
      String(params.stage || 'qualification'),
      Number(params.probability || 0),
      params.expected_close ? String(params.expected_close) : null,
      String(params.notes || '')
    );

    const amountStr = Number(params.amount || 0).toLocaleString('es-CO');
    return {
      success: true,
      output: `Deal creado: ${title} (ID: ${result.lastInsertRowid})\nMonto: $${amountStr} COP | Etapa: ${params.stage || 'qualification'} | Prob: ${params.probability || 0}%`,
    };
  }

  private listDeals(stage: string): ToolResult {
    const deals = stage
      ? this.db.prepare(
          `SELECT d.*, c.name as contact_name FROM crm_deals d LEFT JOIN crm_contacts c ON d.contact_id = c.id WHERE d.stage = ? ORDER BY d.amount DESC`
        ).all(stage) as any[]
      : this.db.prepare(
          `SELECT d.*, c.name as contact_name FROM crm_deals d LEFT JOIN crm_contacts c ON d.contact_id = c.id ORDER BY d.stage, d.amount DESC`
        ).all() as any[];

    if (deals.length === 0) return { success: true, output: 'No hay deals.' };

    const lines = deals.map(d => {
      const amount = Number(d.amount).toLocaleString('es-CO');
      return `  #${d.id} ${d.title} — $${amount} COP | ${d.stage} (${d.probability}%) | ${d.contact_name || 'Sin contacto'}`;
    });

    const totalAmount = deals.reduce((sum, d) => sum + Number(d.amount), 0);
    return {
      success: true,
      output: `Deals (${deals.length}) — Total: $${totalAmount.toLocaleString('es-CO')} COP:\n${lines.join('\n')}`,
    };
  }

  private updateDeal(params: Record<string, unknown>): ToolResult {
    const id = Number(params.id || 0);
    if (!id) return { success: false, output: '', error: 'Se requiere id' };

    const existing = this.db.prepare('SELECT * FROM crm_deals WHERE id = ?').get(id) as Deal | undefined;
    if (!existing) return { success: false, output: '', error: `Deal #${id} no encontrado` };

    this.db.prepare(
      `UPDATE crm_deals SET title=?, amount=?, stage=?, probability=?, expected_close=?, notes=?, updated_at=datetime('now') WHERE id=?`
    ).run(
      params.title ? String(params.title) : existing.title,
      params.amount !== undefined ? Number(params.amount) : existing.amount,
      params.stage ? String(params.stage) : existing.stage,
      params.probability !== undefined ? Number(params.probability) : existing.probability,
      params.expected_close ? String(params.expected_close) : existing.expected_close,
      params.notes ? String(params.notes) : existing.notes,
      id
    );

    return { success: true, output: `Deal #${id} (${existing.title}) actualizado.` };
  }

  private getPipeline(): ToolResult {
    const stages = ['qualification', 'proposal', 'negotiation', 'closed_won', 'closed_lost'];
    const lines: string[] = ['Pipeline de Ventas:\n'];

    for (const stage of stages) {
      const deals = this.db.prepare(
        'SELECT COUNT(*) as count, COALESCE(SUM(amount),0) as total FROM crm_deals WHERE stage = ?'
      ).get(stage) as { count: number; total: number };

      const bar = '█'.repeat(Math.min(20, deals.count));
      const total = Number(deals.total).toLocaleString('es-CO');
      lines.push(`  ${stage.padEnd(15)} ${String(deals.count).padStart(3)} deals | $${total} COP ${bar}`);
    }

    const weighted = this.db.prepare(
      `SELECT COALESCE(SUM(amount * probability / 100.0), 0) as weighted FROM crm_deals WHERE stage NOT IN ('closed_won', 'closed_lost')`
    ).get() as { weighted: number };

    lines.push(`\n  Pipeline ponderado: $${Number(weighted.weighted).toLocaleString('es-CO')} COP`);
    return { success: true, output: lines.join('\n') };
  }

  private getDashboard(): ToolResult {
    const totalContacts = (this.db.prepare('SELECT COUNT(*) as c FROM crm_contacts').get() as any).c;
    const byStatus = this.db.prepare('SELECT status, COUNT(*) as c FROM crm_contacts GROUP BY status').all() as { status: string; c: number }[];
    const totalDeals = (this.db.prepare('SELECT COUNT(*) as c FROM crm_deals').get() as any).c;
    const wonDeals = this.db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(amount),0) as total FROM crm_deals WHERE stage = ?').get('closed_won') as { c: number; total: number };
    const recentContacts = this.db.prepare('SELECT COUNT(*) as c FROM crm_contacts WHERE created_at > datetime("now", "-30 days")').get() as { c: number };
    const recentInteractions = this.db.prepare('SELECT COUNT(*) as c FROM crm_interactions WHERE created_at > datetime("now", "-7 days")').get() as { c: number };

    const statusLines = byStatus.map(s => `    ${s.status}: ${s.c}`).join('\n');
    const wonTotal = Number(wonDeals.total).toLocaleString('es-CO');

    return {
      success: true,
      output: [
        `Dashboard CRM:`,
        `  Contactos: ${totalContacts} (${recentContacts.c} nuevos últimos 30d)`,
        `  Por estado:\n${statusLines}`,
        `  Deals: ${totalDeals} total | ${wonDeals.c} ganados ($${wonTotal} COP)`,
        `  Interacciones última semana: ${recentInteractions.c}`,
      ].join('\n'),
    };
  }

  private getFollowUps(): ToolResult {
    // Contacts without interaction in 7+ days
    const stale = this.db.prepare(`
      SELECT c.id, c.name, c.status, c.company, c.last_contact,
        (SELECT MAX(created_at) FROM crm_interactions WHERE contact_id = c.id) as last_interaction
      FROM crm_contacts c
      WHERE c.status IN ('lead', 'prospect', 'customer')
      AND (c.last_contact IS NULL OR c.last_contact < datetime('now', '-7 days'))
      ORDER BY c.last_contact ASC
      LIMIT 20
    `).all() as any[];

    if (stale.length === 0) return { success: true, output: 'Todos los contactos están al día.' };

    const lines = stale.map(c => {
      const lastDate = c.last_interaction || c.last_contact || 'nunca';
      return `  #${c.id} ${c.name} (${c.status}) — ${c.company || 'N/A'} — último contacto: ${lastDate}`;
    });

    return { success: true, output: `Seguimientos pendientes (${stale.length}):\n${lines.join('\n')}` };
  }

  private addInteraction(params: Record<string, unknown>): ToolResult {
    const contactId = Number(params.contact_id || params.id || 0);
    const type = String(params.interaction_type || 'note');
    const content = String(params.notes || params.message || '');

    if (!contactId) return { success: false, output: '', error: 'Se requiere contact_id' };
    if (!content) return { success: false, output: '', error: 'Se requiere notes/content' };

    this.db.prepare('INSERT INTO crm_interactions (contact_id, type, content) VALUES (?, ?, ?)').run(contactId, type, content);
    this.db.prepare("UPDATE crm_contacts SET last_contact = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(contactId);

    return { success: true, output: `Interacción (${type}) registrada para contacto #${contactId}.` };
  }

  private contactHistory(contactId: number): ToolResult {
    if (!contactId) return { success: false, output: '', error: 'Se requiere id/contact_id' };

    const contact = this.db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(contactId) as Contact | undefined;
    if (!contact) return { success: false, output: '', error: `Contacto #${contactId} no encontrado` };

    const interactions = this.db.prepare(
      'SELECT * FROM crm_interactions WHERE contact_id = ? ORDER BY created_at DESC LIMIT 20'
    ).all(contactId) as { type: string; content: string; created_at: string }[];

    const deals = this.db.prepare(
      'SELECT * FROM crm_deals WHERE contact_id = ? ORDER BY created_at DESC'
    ).all(contactId) as Deal[];

    const lines = [
      `Contacto: ${contact.name} (#${contact.id})`,
      `  Email: ${contact.email || 'N/A'} | Tel: ${contact.phone || 'N/A'}`,
      `  Empresa: ${contact.company || 'N/A'} | Estado: ${contact.status}`,
      `  Tags: ${contact.tags || 'ninguno'} | Fuente: ${contact.source || 'N/A'}`,
      contact.notes ? `  Notas: ${contact.notes}` : '',
      '',
    ];

    if (deals.length > 0) {
      lines.push(`Deals (${deals.length}):`);
      for (const d of deals) {
        lines.push(`  #${d.id} ${d.title} — $${Number(d.amount).toLocaleString('es-CO')} COP | ${d.stage}`);
      }
      lines.push('');
    }

    if (interactions.length > 0) {
      lines.push(`Interacciones recientes (${interactions.length}):`);
      for (const i of interactions) {
        lines.push(`  [${i.created_at.substring(0, 10)}] (${i.type}) ${i.content.substring(0, 100)}`);
      }
    }

    return { success: true, output: lines.filter(Boolean).join('\n') };
  }
}
