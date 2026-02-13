// ═══════════════════════════════════════
// ATLAS — DM Pairing Security
// Unknown senders need a pairing code to talk
// ═══════════════════════════════════════

import type Database from 'better-sqlite3';
import logger from '../utils/logger';
import { v4 as uuid } from 'uuid';

// Alphabet without ambiguous chars (0/O, 1/I)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export interface PairingRequest {
  id: string;
  code: string;
  channel: string;
  senderId: string;
  senderName: string;
  status: 'pending' | 'approved' | 'expired';
  createdAt: string;
  expiresAt: string;
}

export interface AllowedSender {
  id: string;
  channel: string;
  senderId: string;
  displayName: string;
  approvedAt: string;
  approvedVia: string;
}

export class DMPairing {
  private db: Database.Database;
  private ttlMinutes: number;
  private maxPending: number;

  constructor(db: Database.Database, ttlMinutes: number = 60, maxPending: number = 3) {
    this.db = db;
    this.ttlMinutes = ttlMinutes;
    this.maxPending = maxPending;
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pairing_requests (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        channel TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL
      );

      CREATE TABLE IF NOT EXISTS allowed_senders (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        display_name TEXT DEFAULT '',
        approved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        approved_via TEXT DEFAULT 'pairing',
        UNIQUE(channel, sender_id)
      );

      CREATE INDEX IF NOT EXISTS idx_pairing_code ON pairing_requests(code);
      CREATE INDEX IF NOT EXISTS idx_pairing_sender ON pairing_requests(channel, sender_id);
      CREATE INDEX IF NOT EXISTS idx_allowed_sender ON allowed_senders(channel, sender_id);
    `);
  }

  /** Check if a sender is allowed to talk to ATLAS */
  isAllowed(channel: string, senderId: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM allowed_senders WHERE channel = ? AND sender_id = ?'
    ).get(channel, senderId);
    return !!row;
  }

  /** Add a sender to the allowed list directly (e.g. owner, manual approval) */
  allowSender(channel: string, senderId: string, displayName: string = '', via: string = 'manual'): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO allowed_senders (id, channel, sender_id, display_name, approved_via)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuid(), channel, senderId, displayName, via);
    logger.info(`DM Pairing: sender allowed`, { channel, senderId, displayName, via });
  }

  /** Revoke a sender's access */
  revokeSender(channel: string, senderId: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM allowed_senders WHERE channel = ? AND sender_id = ?'
    ).run(channel, senderId);
    return result.changes > 0;
  }

  /** Create a pairing request and return the code */
  createRequest(channel: string, senderId: string, senderName: string = ''): PairingRequest | null {
    // Check if already has too many pending requests
    const pendingCount = this.db.prepare(
      `SELECT COUNT(*) as count FROM pairing_requests
       WHERE channel = ? AND sender_id = ? AND status = 'pending' AND expires_at > datetime('now')`
    ).get(channel, senderId) as { count: number };

    if (pendingCount.count >= this.maxPending) {
      return null; // Too many pending requests
    }

    // Expire old requests for this sender
    this.db.prepare(
      `UPDATE pairing_requests SET status = 'expired'
       WHERE channel = ? AND sender_id = ? AND status = 'pending' AND expires_at <= datetime('now')`
    ).run(channel, senderId);

    const id = uuid();
    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + this.ttlMinutes * 60_000).toISOString();

    this.db.prepare(`
      INSERT INTO pairing_requests (id, code, channel, sender_id, sender_name, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, code, channel, senderId, senderName, expiresAt);

    logger.info('DM Pairing: request created', { channel, senderId, senderName, code });

    return {
      id,
      code,
      channel,
      senderId,
      senderName,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt,
    };
  }

  /** Validate a pairing code from a sender */
  validateCode(channel: string, senderId: string, code: string): boolean {
    const row = this.db.prepare(
      `SELECT id, sender_name FROM pairing_requests
       WHERE channel = ? AND sender_id = ? AND code = ? AND status = 'pending' AND expires_at > datetime('now')
       LIMIT 1`
    ).get(channel, senderId, code.toUpperCase().trim()) as { id: string; sender_name: string } | undefined;

    if (!row) return false;

    // Mark request as approved
    this.db.prepare(
      `UPDATE pairing_requests SET status = 'approved' WHERE id = ?`
    ).run(row.id);

    // Add to allowed senders
    this.allowSender(channel, senderId, row.sender_name, 'pairing');

    logger.info('DM Pairing: code validated, sender approved', { channel, senderId });
    return true;
  }

  /** Get all pending pairing requests */
  getPendingRequests(): PairingRequest[] {
    return this.db.prepare(
      `SELECT id, code, channel, sender_id as senderId, sender_name as senderName,
              status, created_at as createdAt, expires_at as expiresAt
       FROM pairing_requests
       WHERE status = 'pending' AND expires_at > datetime('now')
       ORDER BY created_at DESC`
    ).all() as PairingRequest[];
  }

  /** Get all allowed senders */
  getAllowedSenders(): AllowedSender[] {
    return this.db.prepare(
      `SELECT id, channel, sender_id as senderId, display_name as displayName,
              approved_at as approvedAt, approved_via as approvedVia
       FROM allowed_senders
       ORDER BY approved_at DESC`
    ).all() as AllowedSender[];
  }

  /** Check if a message text looks like a pairing code */
  looksLikeCode(text: string): boolean {
    const clean = text.trim().toUpperCase();
    return clean.length === CODE_LENGTH && /^[A-Z0-9]+$/.test(clean);
  }

  /** Cleanup expired requests */
  cleanup(): number {
    const result = this.db.prepare(
      `DELETE FROM pairing_requests WHERE status = 'pending' AND expires_at <= datetime('now')`
    ).run();
    return result.changes;
  }

  // ── Private ──

  private generateCode(): string {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    return code;
  }
}
