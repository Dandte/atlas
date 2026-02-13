// ═══════════════════════════════════════
// ATLAS — SessionManager Tests
// ═══════════════════════════════════════

import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';

const tmpDir = path.join(os.tmpdir(), `atlas-session-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
const testDbPath = path.join(tmpDir, 'test.sqlite');

jest.mock('../src/config/config', () => ({
  config: {
    telegramOwnerChatId: '123456',
    whatsappOwnerNumber: '573001234567',
    discordOwnerId: 'discord-owner-id',
    slackOwnerId: 'slack-owner-id',
    sessionTimeoutHours: 4,
  },
}));

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../src/utils/logger', () => ({ __esModule: true, default: mockLogger }));

import { SessionManager } from '../src/cortex/session-manager';

describe('SessionManager', () => {
  let db: Database.Database;
  let manager: SessionManager;

  beforeEach(() => {
    try { fs.unlinkSync(testDbPath); } catch {}
    db = new Database(testDbPath);
    // Create sessions table (normally done by MemoryManager)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    manager = new SessionManager(db, 4);
  });

  afterEach(() => {
    try { db.close(); } catch {}
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  describe('Owner Detection', () => {
    it('should always identify CLI as owner', () => {
      expect(manager.isOwnerUser('anyone', 'cli')).toBe(true);
    });

    it('should always identify web as owner', () => {
      expect(manager.isOwnerUser('anyone', 'web')).toBe(true);
    });

    it('should identify telegram owner by chatId', () => {
      expect(manager.isOwnerUser('123456', 'telegram')).toBe(true);
      expect(manager.isOwnerUser('999999', 'telegram')).toBe(false);
    });

    it('should identify whatsapp owner by number', () => {
      expect(manager.isOwnerUser('573001234567', 'whatsapp')).toBe(true);
      expect(manager.isOwnerUser('573001234567@s.whatsapp.net', 'whatsapp')).toBe(true);
      expect(manager.isOwnerUser('573009999999', 'whatsapp')).toBe(false);
    });

    it('should identify discord owner', () => {
      expect(manager.isOwnerUser('discord-owner-id', 'discord')).toBe(true);
      expect(manager.isOwnerUser('someone-else', 'discord')).toBe(false);
    });

    it('should return false for unknown channels', () => {
      expect(manager.isOwnerUser('anyone', 'unknown')).toBe(false);
    });
  });

  describe('Session Management', () => {
    it('should create a new owner session', () => {
      const session = manager.getSession('jose', 'cli');
      expect(session).toBeTruthy();
      expect(session.isOwner).toBe(true);
      expect(session.userId).toBe('jose');
      expect(session.channel).toBe('cli');
      expect(session.messageCount).toBe(1);
    });

    it('should reuse owner session across channels', () => {
      const s1 = manager.getSession('jose', 'cli');
      const s2 = manager.getSession('jose', 'web'); // web + cli = both always owner

      expect(s1.id).toBe(s2.id);
      expect(s2.channel).toBe('web'); // Updated to latest channel
      expect(s2.messageCount).toBe(2); // Incremented
    });

    it('should create separate sessions for non-owner users', () => {
      const s1 = manager.getSession('user1', 'telegram');
      const s2 = manager.getSession('user2', 'telegram');

      expect(s1.id).not.toBe(s2.id);
      expect(s1.isOwner).toBe(false);
      expect(s2.isOwner).toBe(false);
    });

    it('should reset session on /clear', () => {
      const s1 = manager.getSession('jose', 'cli');
      const s2 = manager.resetSession('jose', 'cli');

      expect(s2.id).not.toBe(s1.id);
      expect(s2.messageCount).toBe(1);
    });

    it('should return owner session info', () => {
      manager.getSession('jose', 'cli');
      const info = manager.getOwnerSessionInfo();
      expect(info).toBeTruthy();
      expect(info!.isOwner).toBe(true);
    });

    it('should return null when no owner session exists', () => {
      expect(manager.getOwnerSessionInfo()).toBeNull();
    });
  });
});
