// ═══════════════════════════════════════
// ATLAS — Cloud Backup Tool
// Backup to S3, Google Drive, or local
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export class CloudBackupTool implements Tool {
  definition: ToolDefinition = {
    name: 'cloud_backup',
    description: 'Gestiona backups de ATLAS en la nube. Soporta: S3 (AWS/compatible), Google Drive (via rclone), local. Acciones: create (crear backup), list (listar backups), restore (restaurar), status (estado del backup), schedule (configurar backup automático).',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'restore', 'status', 'cleanup'],
          description: 'Acción a realizar',
        },
        provider: {
          type: 'string',
          enum: ['s3', 'gdrive', 'local'],
          description: 'Proveedor de backup. Default: local',
        },
        backup_id: {
          type: 'string',
          description: 'ID del backup para restaurar (para action=restore)',
        },
        include_media: {
          type: 'boolean',
          description: 'Incluir archivos de media (audio, imágenes, QR). Default: false (solo DB)',
        },
        retention_days: {
          type: 'number',
          description: 'Días de retención para cleanup. Default: 30',
        },
      },
      required: ['action'],
    },
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || 'status');
    const provider = String(params.provider || 'local');

    try {
      switch (action) {
        case 'create': return await this.createBackup(provider, Boolean(params.include_media));
        case 'list': return this.listBackups(provider);
        case 'restore': return await this.restoreBackup(String(params.backup_id || ''), provider);
        case 'status': return this.getStatus();
        case 'cleanup': return this.cleanup(provider, Number(params.retention_days || 30));
        default: return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      logger.error('Cloud backup error', { error: err, action, provider });
      return { success: false, output: '', error: `Error backup: ${err.message}` };
    }
  }

  private async createBackup(provider: string, includeMedia: boolean): Promise<ToolResult> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const backupName = `atlas-backup-${timestamp}`;
    const backupDir = path.join(config.dataDir, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const localPath = path.join(backupDir, `${backupName}.tar.gz`);

    // 1. Create SQLite backup via VACUUM INTO
    const dbBackupPath = path.join(backupDir, `${backupName}.db`);
    const Database = require('better-sqlite3');
    const sourceDb = new Database(path.join(config.dataDir, 'atlas.db'), { readonly: true });
    sourceDb.exec(`VACUUM INTO '${dbBackupPath.replace(/\\/g, '/')}'`);
    sourceDb.close();

    // 2. Create tar.gz
    const filesToInclude = [dbBackupPath];

    if (includeMedia) {
      const mediaDirs = ['audio', 'qr', 'media', 'documents'];
      for (const dir of mediaDirs) {
        const fullPath = path.join(config.dataDir, dir);
        if (fs.existsSync(fullPath)) filesToInclude.push(fullPath);
      }
    }

    // Build tar command
    const isWin = process.platform === 'win32';
    if (isWin) {
      // Use PowerShell Compress-Archive on Windows
      const itemsArg = filesToInclude.map(f => `'${f}'`).join(',');
      const zipPath = localPath.replace('.tar.gz', '.zip');
      execSync(
        `powershell -NoProfile -Command "Compress-Archive -Path ${itemsArg} -DestinationPath '${zipPath}' -Force"`,
        { timeout: 120000, stdio: 'pipe' }
      );
      // Rename to track
      if (fs.existsSync(zipPath)) {
        fs.renameSync(zipPath, localPath.replace('.tar.gz', '.zip'));
      }
    } else {
      const fileArgs = filesToInclude.map(f => `"${f}"`).join(' ');
      execSync(`tar -czf "${localPath}" ${fileArgs}`, { timeout: 120000, stdio: 'pipe' });
    }

    // Cleanup temp DB backup
    if (fs.existsSync(dbBackupPath)) fs.unlinkSync(dbBackupPath);

    const finalPath = isWin ? localPath.replace('.tar.gz', '.zip') : localPath;
    const stats = fs.existsSync(finalPath) ? fs.statSync(finalPath) : null;
    const sizeMB = stats ? (stats.size / 1024 / 1024).toFixed(2) : '?';

    // 3. Upload to cloud if needed
    let cloudResult = '';
    if (provider === 's3') {
      cloudResult = await this.uploadToS3(finalPath, backupName);
    } else if (provider === 'gdrive') {
      cloudResult = await this.uploadToGDrive(finalPath, backupName);
    }

    // Save backup metadata
    this.saveBackupMetadata(backupName, provider, finalPath, Number(sizeMB), includeMedia);

    return {
      success: true,
      output: [
        `Backup creado: ${backupName}`,
        `Archivo local: ${finalPath} (${sizeMB} MB)`,
        `Media incluida: ${includeMedia ? 'sí' : 'no'}`,
        cloudResult ? `Cloud: ${cloudResult}` : `Proveedor: local`,
      ].join('\n'),
    };
  }

  private async uploadToS3(filePath: string, backupName: string): Promise<string> {
    const bucket = (config as any).s3BackupBucket;
    const region = (config as any).s3BackupRegion || 'us-east-1';
    const endpoint = (config as any).s3BackupEndpoint;

    if (!bucket) return 'S3 no configurado (S3_BACKUP_BUCKET)';

    try {
      let cmd = `aws s3 cp "${filePath}" "s3://${bucket}/atlas/${backupName}${path.extname(filePath)}"`;
      if (endpoint) cmd += ` --endpoint-url ${endpoint}`;
      cmd += ` --region ${region}`;
      execSync(cmd, { timeout: 300000, stdio: 'pipe' });
      return `Subido a s3://${bucket}/atlas/${backupName}`;
    } catch (err: any) {
      return `Error S3: ${err.message}. Instalá AWS CLI con: pip install awscli`;
    }
  }

  private async uploadToGDrive(filePath: string, backupName: string): Promise<string> {
    try {
      const folder = (config as any).gdriveBackupFolder || 'ATLAS-Backups';
      execSync(`rclone copy "${filePath}" "gdrive:${folder}/"`, { timeout: 300000, stdio: 'pipe' });
      return `Subido a Google Drive: ${folder}/${backupName}`;
    } catch (err: any) {
      return `Error GDrive: ${err.message}. Instalá rclone: https://rclone.org/install/`;
    }
  }

  private listBackups(provider: string): ToolResult {
    const backupDir = path.join(config.dataDir, 'backups');
    if (!fs.existsSync(backupDir)) {
      return { success: true, output: 'No hay backups.' };
    }

    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('atlas-backup-'))
      .sort()
      .reverse();

    if (files.length === 0) return { success: true, output: 'No hay backups locales.' };

    const lines = files.map(f => {
      const stats = fs.statSync(path.join(backupDir, f));
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      const date = f.replace('atlas-backup-', '').replace(/\.(tar\.gz|zip)$/, '').replace(/-/g, ':').substring(0, 19);
      return `  ${f} — ${sizeMB} MB — ${date}`;
    });

    return { success: true, output: `Backups locales (${files.length}):\n${lines.join('\n')}` };
  }

  private async restoreBackup(backupId: string, _provider: string): Promise<ToolResult> {
    if (!backupId) return { success: false, output: '', error: 'Se requiere backup_id' };

    const backupDir = path.join(config.dataDir, 'backups');
    const files = fs.readdirSync(backupDir).filter(f => f.includes(backupId));

    if (files.length === 0) {
      return { success: false, output: '', error: `Backup "${backupId}" no encontrado` };
    }

    return {
      success: true,
      output: `⚠️ RESTAURAR BACKUP: ${files[0]}\nEsto reemplazará la base de datos actual.\nPara confirmar, ejecutá manualmente:\n  cp "${path.join(backupDir, files[0])}" → descomprimir → reemplazar atlas.db\n\nPor seguridad, la restauración requiere intervención manual.`,
    };
  }

  private getStatus(): ToolResult {
    const backupDir = path.join(config.dataDir, 'backups');
    if (!fs.existsSync(backupDir)) {
      return { success: true, output: 'Sin backups. Ejecutá cloud_backup con action=create.' };
    }

    const files = fs.readdirSync(backupDir).filter(f => f.startsWith('atlas-backup-')).sort().reverse();
    const totalSize = files.reduce((sum, f) => {
      try { return sum + fs.statSync(path.join(backupDir, f)).size; } catch { return sum; }
    }, 0);

    const lastBackup = files[0] || 'ninguno';
    const dbPath = path.join(config.dataDir, 'atlas.db');
    const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;

    return {
      success: true,
      output: [
        `Estado de backups:`,
        `  Último backup: ${lastBackup}`,
        `  Total backups: ${files.length}`,
        `  Espacio usado: ${(totalSize / 1024 / 1024).toFixed(2)} MB`,
        `  Tamaño DB actual: ${(dbSize / 1024 / 1024).toFixed(2)} MB`,
        `  Directorio: ${backupDir}`,
      ].join('\n'),
    };
  }

  private cleanup(provider: string, retentionDays: number): ToolResult {
    const backupDir = path.join(config.dataDir, 'backups');
    if (!fs.existsSync(backupDir)) return { success: true, output: 'Sin backups para limpiar.' };

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(backupDir).filter(f => f.startsWith('atlas-backup-'));
    let removed = 0;
    let freedBytes = 0;

    for (const f of files) {
      const filePath = path.join(backupDir, f);
      const stats = fs.statSync(filePath);
      if (stats.mtimeMs < cutoff) {
        freedBytes += stats.size;
        fs.unlinkSync(filePath);
        removed++;
      }
    }

    return {
      success: true,
      output: `Cleanup completado: ${removed} backups eliminados (${(freedBytes / 1024 / 1024).toFixed(2)} MB liberados). Retención: ${retentionDays} días.`,
    };
  }

  private saveBackupMetadata(name: string, provider: string, localPath: string, sizeMB: number, includeMedia: boolean): void {
    const metaPath = path.join(config.dataDir, 'backups', 'metadata.json');
    let metadata: any[] = [];
    if (fs.existsSync(metaPath)) {
      try { metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { /* ignore */ }
    }
    metadata.push({ name, provider, localPath, sizeMB, includeMedia, timestamp: new Date().toISOString() });
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
  }
}
