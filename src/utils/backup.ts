// ═══════════════════════════════════════
// ATLAS — Backup Manager
// Automated backups of SQLite, skills, docs
// ═══════════════════════════════════════

import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import type Database from 'better-sqlite3';
import logger from './logger';

const fsPromises = fs.promises;

export interface BackupConfig {
  enabled: boolean;
  backupDir: string;
  retainDays: number;
  compressBackups: boolean;
  backupDatabase: boolean;
  backupSkills: boolean;
  backupDocuments: boolean;
  backupWhatsappMedia: boolean;
  backupConfig: boolean;
}

export interface BackupResult {
  success: boolean;
  backupName: string;
  files: string[];
  totalSizeMB: number;
  durationMs: number;
  errors: string[];
}

export class BackupManager {
  private config: BackupConfig;
  private db: Database.Database;

  constructor(db: Database.Database, config: Partial<BackupConfig> = {}) {
    this.db = db;
    this.config = {
      enabled: true,
      backupDir: './backups',
      retainDays: 14,
      compressBackups: true,
      backupDatabase: true,
      backupSkills: true,
      backupDocuments: true,
      backupWhatsappMedia: false,
      backupConfig: true,
      ...config,
    };

    // Ensure backup_history table exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS backup_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backup_name TEXT NOT NULL,
        size_mb REAL,
        duration_ms INTEGER,
        success INTEGER DEFAULT 1,
        errors TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Ensure backup directory exists
    if (!fs.existsSync(this.config.backupDir)) {
      fs.mkdirSync(this.config.backupDir, { recursive: true });
    }
  }

  async runBackup(): Promise<BackupResult> {
    const startTime = Date.now();
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');

    const backupName = `atlas-backup-${dateStr}_${timeStr}`;
    const backupPath = path.join(this.config.backupDir, backupName);

    await fsPromises.mkdir(backupPath, { recursive: true });

    const files: string[] = [];
    const errors: string[] = [];

    logger.info(`Backup starting: ${backupName}`);

    // 1. DATABASE (most important)
    if (this.config.backupDatabase) {
      try {
        const dbBackupPath = path.join(backupPath, 'atlas.db');
        this.db.exec(`VACUUM INTO '${dbBackupPath.replace(/'/g, "''")}'`);
        files.push(dbBackupPath);
        logger.info('  Backup: database OK');
      } catch (err: any) {
        // Fallback: WAL checkpoint + file copy
        try {
          this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          const dbPath = this.db.name;
          await fsPromises.copyFile(dbPath, path.join(backupPath, 'atlas.db'));
          files.push(path.join(backupPath, 'atlas.db'));
          logger.info('  Backup: database OK (fallback copy)');
        } catch (err2: any) {
          errors.push(`Database: ${err2.message}`);
          logger.error(`  Backup: database FAILED: ${err2.message}`);
        }
      }
    }

    // 2. DYNAMIC SKILLS
    if (this.config.backupSkills) {
      try {
        const skillsDir = path.resolve('skills', 'dynamic');
        if (fs.existsSync(skillsDir)) {
          const destDir = path.join(backupPath, 'skills');
          await this.copyDirectory(skillsDir, destDir);
          files.push(destDir);
          logger.info('  Backup: skills OK');
        }
      } catch (err: any) {
        errors.push(`Skills: ${err.message}`);
      }
    }

    // 3. RAG DOCUMENTS
    if (this.config.backupDocuments) {
      try {
        const docsDir = path.resolve('data', 'documents');
        if (fs.existsSync(docsDir)) {
          const destDir = path.join(backupPath, 'documents');
          await this.copyDirectory(docsDir, destDir);
          files.push(destDir);
          logger.info('  Backup: documents OK');
        }
      } catch (err: any) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          errors.push(`Documents: ${err.message}`);
        }
      }
    }

    // 4. WHATSAPP MEDIA (if enabled)
    if (this.config.backupWhatsappMedia) {
      try {
        const mediaDir = path.resolve('data', 'whatsapp', 'media');
        if (fs.existsSync(mediaDir)) {
          const destDir = path.join(backupPath, 'whatsapp-media');
          await this.copyDirectory(mediaDir, destDir);
          files.push(destDir);
          logger.info('  Backup: WhatsApp media OK');
        }
      } catch (err: any) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          errors.push(`WhatsApp media: ${err.message}`);
        }
      }
    }

    // 5. CONFIG (redact secrets)
    if (this.config.backupConfig) {
      try {
        const configDir = path.join(backupPath, 'config');
        await fsPromises.mkdir(configDir, { recursive: true });

        // Copy .env with redacted secrets
        try {
          const envContent = await fsPromises.readFile('.env', 'utf-8');
          const redacted = envContent.replace(
            /(API_KEY|PASSWORD|SECRET|TOKEN)=.*/gi,
            '$1=[REDACTED]'
          );
          await fsPromises.writeFile(path.join(configDir, '.env.backup'), redacted);
        } catch {}

        // Copy package.json
        try {
          await fsPromises.copyFile('package.json', path.join(configDir, 'package.json'));
        } catch {}

        // Copy custom agents
        try {
          const customDir = path.resolve('agents', 'custom');
          if (fs.existsSync(customDir)) {
            await this.copyDirectory(customDir, path.join(configDir, 'custom-agents'));
          }
        } catch {}

        files.push(configDir);
        logger.info('  Backup: config OK');
      } catch (err: any) {
        errors.push(`Config: ${err.message}`);
      }
    }

    // 6. COMPRESS
    if (this.config.compressBackups) {
      try {
        const tarFile = `${backupPath}.tar.gz`;
        execSync(
          `tar -czf "${tarFile}" -C "${this.config.backupDir}" "${backupName}"`,
          { timeout: 120000 }
        );
        // Remove uncompressed directory
        await fsPromises.rm(backupPath, { recursive: true, force: true });
        files.length = 0;
        files.push(tarFile);
        logger.info('  Backup: compressed OK');
      } catch (err: any) {
        errors.push(`Compress: ${err.message}`);
        logger.warn(`  Backup: compression failed: ${err.message}`);
      }
    }

    // 7. CLEAN OLD BACKUPS
    await this.cleanOldBackups();

    // Calculate total size
    const totalSize = await this.calculateSize(
      this.config.compressBackups ? `${backupPath}.tar.gz` : backupPath
    );

    const result: BackupResult = {
      success: errors.length === 0,
      backupName,
      files,
      totalSizeMB: totalSize,
      durationMs: Date.now() - startTime,
      errors,
    };

    // Record in DB
    try {
      this.db.prepare(`
        INSERT INTO backup_history (backup_name, size_mb, duration_ms, success, errors)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        backupName,
        totalSize,
        result.durationMs,
        result.success ? 1 : 0,
        errors.length > 0 ? JSON.stringify(errors) : null
      );
    } catch {}

    logger.info(
      `Backup completed: ${totalSize.toFixed(1)}MB in ${result.durationMs}ms ` +
      `(${errors.length} errors)`
    );

    return result;
  }

  async listBackups(): Promise<Array<{
    name: string;
    sizeMB: number;
    date: Date;
    compressed: boolean;
  }>> {
    try {
      const entries = await fsPromises.readdir(this.config.backupDir);
      const backups = [];

      for (const entry of entries) {
        if (!entry.startsWith('atlas-backup-')) continue;

        const fullPath = path.join(this.config.backupDir, entry);
        const stat = await fsPromises.stat(fullPath);

        backups.push({
          name: entry,
          sizeMB: Math.round(stat.size / (1024 * 1024) * 100) / 100,
          date: stat.mtime,
          compressed: entry.endsWith('.tar.gz'),
        });
      }

      return backups.sort((a, b) => b.date.getTime() - a.date.getTime());
    } catch {
      return [];
    }
  }

  getBackupHistory(limit: number = 20): any[] {
    return this.db.prepare(`
      SELECT * FROM backup_history ORDER BY created_at DESC LIMIT ?
    `).all(limit);
  }

  private async cleanOldBackups(): Promise<void> {
    try {
      const entries = await fsPromises.readdir(this.config.backupDir);
      const now = Date.now();
      const maxAge = this.config.retainDays * 24 * 60 * 60 * 1000;
      let cleaned = 0;

      for (const entry of entries) {
        if (!entry.startsWith('atlas-backup-')) continue;

        const fullPath = path.join(this.config.backupDir, entry);
        const stat = await fsPromises.stat(fullPath);

        if (now - stat.mtimeMs > maxAge) {
          await fsPromises.rm(fullPath, { recursive: true, force: true });
          cleaned++;
        }
      }

      if (cleaned > 0) {
        logger.info(`Backup cleanup: ${cleaned} old backups removed (> ${this.config.retainDays} days)`);
      }
    } catch (err: any) {
      logger.warn(`Error cleaning old backups: ${err.message}`);
    }
  }

  private async copyDirectory(src: string, dest: string): Promise<void> {
    await fsPromises.mkdir(dest, { recursive: true });
    const entries = await fsPromises.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await fsPromises.copyFile(srcPath, destPath);
      }
    }
  }

  private async calculateSize(filePath: string): Promise<number> {
    try {
      const stat = await fsPromises.stat(filePath);
      if (stat.isDirectory()) {
        let total = 0;
        const entries = await fsPromises.readdir(filePath, { withFileTypes: true });
        for (const entry of entries) {
          total += await this.calculateSize(path.join(filePath, entry.name));
        }
        return total / (1024 * 1024);
      }
      return stat.size / (1024 * 1024);
    } catch {
      return 0;
    }
  }
}
