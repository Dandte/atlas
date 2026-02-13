// ═══════════════════════════════════════════════════════
// ATLAS — Session Manager
// Unified session for Jose across all channels
// ═══════════════════════════════════════════════════════
//
// Jose has ONE active session regardless of channel.
// Other users get separate sessions per userId.
// Sessions persist across restarts via SQLite.

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { config } from '../config/config';
import logger from '../utils/logger';

export interface Session {
  id: string;
  userId: string;
  isOwner: boolean;
  startedAt: Date;
  lastActivityAt: Date;
  channel: string;
  messageCount: number;
}

export class SessionManager {
  private db: Database.Database;
  private ownerSession: Session | null = null;
  private otherSessions: Map<string, Session> = new Map();
  private sessionTimeoutMs: number;
  private otherTimeoutMs: number;

  constructor(db: Database.Database, timeoutHours: number = 4) {
    this.db = db;
    this.sessionTimeoutMs = timeoutHours * 60 * 60 * 1000;
    this.otherTimeoutMs = 1 * 60 * 60 * 1000; // 1h for other users
    this.initialize();
  }

  private initialize(): void {
    // Migrate sessions table to support unified sessions
    // Check if user_id column exists
    const tableInfo = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
    const hasUserId = tableInfo.some(col => col.name === 'user_id');

    if (!hasUserId) {
      // Add new columns to existing sessions table
      this.db.exec(`
        ALTER TABLE sessions ADD COLUMN user_id TEXT DEFAULT 'unknown';
        ALTER TABLE sessions ADD COLUMN is_owner INTEGER DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN message_count INTEGER DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN closed_at DATETIME;
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, last_active);
      `);
      logger.info('Sessions table migrated for unified sessions');
    }
  }

  /** Get or create a session for a user+channel combination */
  getSession(userId: string, channel: string): Session {
    const isOwner = this.isOwnerUser(userId, channel);

    if (isOwner) {
      return this.getOwnerSession(channel);
    } else {
      return this.getOtherSession(userId, channel);
    }
  }

  /** Get the current owner session (if any) */
  getOwnerSessionInfo(): Session | null {
    return this.ownerSession;
  }

  /** Force create a new session (for /clear command) */
  resetSession(userId: string, channel: string): Session {
    const isOwner = this.isOwnerUser(userId, channel);

    if (isOwner && this.ownerSession) {
      this.closeSession(this.ownerSession);
      this.ownerSession = null;
    } else if (!isOwner) {
      const existing = this.otherSessions.get(userId);
      if (existing) {
        this.closeSession(existing);
        this.otherSessions.delete(userId);
      }
    }

    return this.getSession(userId, channel);
  }

  /** Load last owner session from SQLite on startup */
  loadLastOwnerSession(): void {
    try {
      const lastSession = this.db.prepare(`
        SELECT id, user_id, is_owner, started_at, last_active, channel, message_count
        FROM sessions
        WHERE user_id = 'jose' AND is_owner = 1 AND closed_at IS NULL
        ORDER BY last_active DESC
        LIMIT 1
      `).get() as any;

      if (lastSession) {
        const elapsed = Date.now() - new Date(lastSession.last_active).getTime();

        if (elapsed < this.sessionTimeoutMs) {
          this.ownerSession = {
            id: lastSession.id,
            userId: 'jose',
            isOwner: true,
            startedAt: new Date(lastSession.started_at),
            lastActivityAt: new Date(lastSession.last_active),
            channel: lastSession.channel,
            messageCount: lastSession.message_count || 0,
          };
          logger.info(`Session restored: ${this.ownerSession.id} (${this.ownerSession.messageCount} msgs, last channel: ${this.ownerSession.channel})`);
        } else {
          // Expired — close it
          this.db.prepare('UPDATE sessions SET closed_at = datetime(\'now\') WHERE id = ?')
            .run(lastSession.id);
          logger.debug('Previous owner session expired, will create new one on first message');
        }
      }
    } catch (err) {
      logger.error('Failed to load last owner session', { error: err });
    }
  }

  /** Check if a userId+channel maps to the owner (Jose) */
  isOwnerUser(userId: string, channel: string): boolean {
    switch (channel) {
      case 'cli':
      case 'web':
      case 'dashboard':
        return true; // Always Jose

      case 'telegram':
        return userId === config.telegramOwnerChatId;

      case 'whatsapp': {
        const ownerNum = config.whatsappOwnerNumber;
        return userId === ownerNum
          || userId === `${ownerNum}@s.whatsapp.net`;
      }

      case 'discord':
        return !!config.discordOwnerId && userId === config.discordOwnerId;

      case 'slack':
        return !!config.slackOwnerId && userId === config.slackOwnerId;

      default:
        return false;
    }
  }

  // ── Owner Session ──

  private getOwnerSession(channel: string): Session {
    const now = new Date();

    if (this.ownerSession) {
      const elapsed = now.getTime() - this.ownerSession.lastActivityAt.getTime();

      if (elapsed < this.sessionTimeoutMs) {
        // Session still active — update channel and timestamp
        this.ownerSession.lastActivityAt = now;
        this.ownerSession.channel = channel;
        this.ownerSession.messageCount++;
        this.persistSession(this.ownerSession);
        return this.ownerSession;
      }

      // Timeout: close old, create new
      this.closeSession(this.ownerSession);
    }

    // Create new session
    this.ownerSession = {
      id: uuid(),
      userId: 'jose',
      isOwner: true,
      startedAt: now,
      lastActivityAt: now,
      channel,
      messageCount: 1,
    };

    this.persistSession(this.ownerSession);
    logger.info(`New owner session: ${this.ownerSession.id} (channel: ${channel})`);
    return this.ownerSession;
  }

  // ── Other Users ──

  private getOtherSession(userId: string, channel: string): Session {
    const now = new Date();
    const existing = this.otherSessions.get(userId);

    if (existing) {
      const elapsed = now.getTime() - existing.lastActivityAt.getTime();

      if (elapsed < this.otherTimeoutMs) {
        existing.lastActivityAt = now;
        existing.messageCount++;
        return existing;
      }

      this.closeSession(existing);
    }

    const session: Session = {
      id: uuid(),
      userId,
      isOwner: false,
      startedAt: now,
      lastActivityAt: now,
      channel,
      messageCount: 1,
    };

    this.otherSessions.set(userId, session);
    this.persistSession(session);
    return session;
  }

  // ── Persistence ──

  private persistSession(session: Session): void {
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO sessions (id, channel, started_at, last_active, user_id, is_owner, message_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.id,
        session.channel,
        session.startedAt.toISOString(),
        session.lastActivityAt.toISOString(),
        session.userId,
        session.isOwner ? 1 : 0,
        session.messageCount
      );
    } catch (err) {
      logger.error('Failed to persist session', { error: err });
    }
  }

  private closeSession(session: Session): void {
    try {
      this.db.prepare(`
        UPDATE sessions SET closed_at = datetime('now'), last_active = datetime('now') WHERE id = ?
      `).run(session.id);
    } catch (err) {
      logger.error('Failed to close session', { error: err });
    }
  }
}
