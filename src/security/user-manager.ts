// ═══════════════════════════════════════
// ATLAS — User Manager
// v0.9 Feature 9: Multi-user with permissions
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { UserDefinition, UserRole } from '../types';
import logger from '../utils/logger';

export class UserManager {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        identifier TEXT UNIQUE NOT NULL,
        display_name TEXT,
        role TEXT DEFAULT 'user',
        channels TEXT DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS user_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        permission TEXT NOT NULL,
        allowed INTEGER DEFAULT 1,
        UNIQUE(role, permission)
      );
    `);

    // Seed default permissions if empty
    const count = (this.db.prepare('SELECT COUNT(*) as c FROM user_permissions').get() as any).c;
    if (count === 0) {
      this.seedPermissions();
    }

    logger.info('UserManager initialized');
  }

  private seedPermissions(): void {
    const perms = [
      // Owner — everything
      ['owner', 'tool:*', 1],
      ['owner', 'admin:*', 1],
      // Admin — most tools, no shell/db
      ['admin', 'tool:*', 1],
      ['admin', 'tool:shell', 0],
      ['admin', 'tool:database_query', 0],
      ['admin', 'admin:dashboard', 1],
      // User — safe tools only
      ['user', 'tool:web_search', 1],
      ['user', 'tool:web_fetch', 1],
      ['user', 'tool:memory_recall', 1],
      ['user', 'tool:calculator', 1],
      ['user', 'tool:weather', 1],
      ['user', 'tool:translate', 1],
      ['user', 'tool:notes', 1],
      ['user', 'tool:converter', 1],
      ['user', 'tool:trm_colombia', 1],
      // Guest — minimal
      ['guest', 'tool:web_search', 1],
      ['guest', 'tool:weather', 1],
      ['guest', 'tool:calculator', 1],
    ];

    const insert = this.db.prepare('INSERT OR IGNORE INTO user_permissions (role, permission, allowed) VALUES (?, ?, ?)');
    for (const [role, perm, allowed] of perms) {
      insert.run(role, perm, allowed);
    }
    logger.info('Default user permissions seeded');
  }

  // ── User CRUD ──

  getOrCreateUser(identifier: string, displayName?: string, channel?: string): UserDefinition {
    let row = this.db.prepare('SELECT * FROM users WHERE identifier = ?').get(identifier) as any;

    if (!row) {
      const id = uuid();
      this.db.prepare(`
        INSERT INTO users (id, identifier, display_name, role, channels)
        VALUES (?, ?, ?, 'user', ?)
      `).run(id, identifier, displayName || identifier, JSON.stringify(channel ? [channel] : []));
      row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      logger.info(`New user created: ${identifier} (${displayName || 'unknown'})`);
    } else {
      // Update last seen + add channel
      const channels: string[] = JSON.parse(row.channels || '[]');
      if (channel && !channels.includes(channel)) {
        channels.push(channel);
        this.db.prepare('UPDATE users SET channels = ?, last_seen = datetime(\'now\') WHERE id = ?')
          .run(JSON.stringify(channels), row.id);
      } else {
        this.db.prepare('UPDATE users SET last_seen = datetime(\'now\') WHERE id = ?').run(row.id);
      }
    }

    return this.rowToUser(row);
  }

  getUser(identifier: string): UserDefinition | null {
    const row = this.db.prepare('SELECT * FROM users WHERE identifier = ? OR id = ?').get(identifier, identifier) as any;
    return row ? this.rowToUser(row) : null;
  }

  setRole(identifier: string, role: UserRole): boolean {
    const result = this.db.prepare('UPDATE users SET role = ? WHERE identifier = ? OR id = ?').run(role, identifier, identifier);
    if (result.changes > 0) {
      logger.info(`User ${identifier} role changed to ${role}`);
    }
    return result.changes > 0;
  }

  listUsers(): UserDefinition[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY last_seen DESC').all() as any[];
    return rows.map(r => this.rowToUser(r));
  }

  deleteUser(identifier: string): boolean {
    const result = this.db.prepare('DELETE FROM users WHERE identifier = ? OR id = ?').run(identifier, identifier);
    return result.changes > 0;
  }

  // ── Permissions ──

  canUseTool(role: UserRole, toolName: string): boolean {
    if (role === 'owner') return true;

    // Check specific deny
    const deny = this.db.prepare(
      'SELECT allowed FROM user_permissions WHERE role = ? AND permission = ? AND allowed = 0'
    ).get(role, `tool:${toolName}`) as any;
    if (deny) return false;

    // Check specific allow
    const specific = this.db.prepare(
      'SELECT allowed FROM user_permissions WHERE role = ? AND permission = ?'
    ).get(role, `tool:${toolName}`) as any;
    if (specific) return specific.allowed === 1;

    // Check wildcard
    const wildcard = this.db.prepare(
      'SELECT allowed FROM user_permissions WHERE role = ? AND permission = ?'
    ).get(role, 'tool:*') as any;
    if (wildcard) return wildcard.allowed === 1;

    return false;
  }

  getPermissions(role: UserRole): Array<{ permission: string; allowed: boolean }> {
    const rows = this.db.prepare(
      'SELECT permission, allowed FROM user_permissions WHERE role = ? ORDER BY permission'
    ).all(role) as any[];
    return rows.map(r => ({ permission: r.permission, allowed: r.allowed === 1 }));
  }

  setPermission(role: UserRole, permission: string, allowed: boolean): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO user_permissions (role, permission, allowed) VALUES (?, ?, ?)
    `).run(role, permission, allowed ? 1 : 0);
  }

  private rowToUser(row: any): UserDefinition {
    return {
      id: row.id,
      identifier: row.identifier,
      displayName: row.display_name || row.identifier,
      role: row.role as UserRole,
      channels: JSON.parse(row.channels || '[]'),
      createdAt: row.created_at,
      lastSeen: row.last_seen,
    };
  }
}
