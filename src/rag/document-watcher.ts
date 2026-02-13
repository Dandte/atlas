// ═══════════════════════════════════════
// ATLAS — Document Watcher (RAG)
// Watches inbox/ for new files, auto-ingests
// ═══════════════════════════════════════

import { DocumentManager } from './document-manager';
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.md', '.csv', '.html', '.htm', '.json']);

export class DocumentWatcher {
  private docManager: DocumentManager;
  private inboxDir: string;
  private processedDir: string;
  private watcher: any = null;

  constructor(docManager: DocumentManager, documentsDir: string) {
    this.docManager = docManager;
    this.inboxDir = path.join(documentsDir, 'inbox');
    this.processedDir = path.join(documentsDir, 'processed');

    // Ensure directories exist
    for (const dir of [this.inboxDir, this.processedDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /** Start watching the inbox directory */
  start(): void {
    try {
      const chokidar = require('chokidar');

      this.watcher = chokidar.watch(this.inboxDir, {
        ignoreInitial: false, // Process existing files on startup
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
        depth: 0, // Only watch top-level
      });

      this.watcher.on('add', (filePath: string) => {
        this.handleNewFile(filePath);
      });

      logger.info(`DocumentWatcher started: watching ${this.inboxDir}`);
    } catch (err) {
      logger.error('DocumentWatcher: chokidar not available', { error: err });
    }
  }

  /** Stop watching */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      logger.info('DocumentWatcher stopped');
    }
  }

  /** Handle a new file in the inbox */
  private async handleNewFile(filePath: string): Promise<void> {
    const ext = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);

    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      logger.debug(`DocumentWatcher: skipping unsupported file ${filename}`);
      return;
    }

    try {
      logger.info(`DocumentWatcher: auto-ingesting ${filename}`);
      await this.docManager.ingest(filePath);

      // Move to processed/
      const destPath = path.join(this.processedDir, filename);
      fs.renameSync(filePath, destPath);
      logger.info(`DocumentWatcher: ${filename} moved to processed/`);
    } catch (err: any) {
      logger.error(`DocumentWatcher: failed to ingest ${filename}`, { error: err.message });
    }
  }
}
