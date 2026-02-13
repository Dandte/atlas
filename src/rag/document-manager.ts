// ═══════════════════════════════════════
// ATLAS — Document Manager (RAG)
// Parse, chunk, embed, and search documents
// ═══════════════════════════════════════

import { MemoryManager } from '../hippocampus/memory-manager';
import { config } from '../config/config';
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';

export interface DocumentRecord {
  id: string;
  filename: string;
  originalPath: string;
  mimeType: string;
  fileSize: number;
  chunkCount: number;
  status: 'indexed' | 'error';
  indexedAt: string;
}

export class DocumentManager {
  private memory: MemoryManager;

  constructor(memory: MemoryManager) {
    this.memory = memory;
  }

  async init(): Promise<void> {
    this.memory.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        original_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER DEFAULT 0,
        chunk_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'indexed',
        indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_documents_filename ON documents(filename);
    `);
    logger.info('DocumentManager initialized');
  }

  /** Ingest a file: parse → chunk → embed → store metadata */
  async ingest(filePath: string): Promise<DocumentRecord> {
    if (!this.memory.vectorStore) {
      throw new Error('VectorStore not available — cannot index documents without embeddings');
    }

    const filename = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const stat = fs.statSync(filePath);
    const mimeType = this.getMimeType(ext);

    logger.info(`Ingesting document: ${filename} (${mimeType})`);

    // 1. Parse document to text
    let text: string;
    try {
      text = await this.parseFile(filePath, ext);
    } catch (err: any) {
      throw new Error(`Failed to parse ${filename}: ${err.message}`);
    }

    if (!text || text.trim().length === 0) {
      throw new Error(`No text extracted from ${filename}`);
    }

    // 2. Chunk the text
    const chunks = this.chunkText(text);

    // 3. Create document record
    const docId = uuid();
    const doc: DocumentRecord = {
      id: docId,
      filename,
      originalPath: filePath,
      mimeType,
      fileSize: stat.size,
      chunkCount: chunks.length,
      status: 'indexed',
      indexedAt: new Date().toISOString(),
    };

    // 4. Embed each chunk in VectorStore
    for (let i = 0; i < chunks.length; i++) {
      await this.memory.vectorStore.add(
        `doc_${docId}_chunk_${i}`,
        chunks[i],
        {
          type: 'document_chunk',
          documentId: docId,
          filename,
          chunkIndex: i,
          totalChunks: chunks.length,
        }
      );
    }

    // 5. Save metadata to SQLite
    this.memory.db.prepare(`
      INSERT INTO documents (id, filename, original_path, mime_type, file_size, chunk_count, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(docId, filename, filePath, mimeType, stat.size, chunks.length, 'indexed');

    logger.info(`Document indexed: ${filename} (${chunks.length} chunks)`);
    return doc;
  }

  /** Search across indexed documents */
  async search(query: string, limit: number = 5, filenameFilter?: string): Promise<Array<{
    text: string;
    filename: string;
    chunkIndex: number;
    distance: number;
  }>> {
    if (!this.memory.vectorStore) return [];

    const results = await this.memory.vectorStore.searchWithFilter(
      query,
      limit,
      (meta) => {
        if (meta.type !== 'document_chunk') return false;
        if (filenameFilter && !meta.filename?.toLowerCase().includes(filenameFilter.toLowerCase())) return false;
        return true;
      }
    );

    return results.map(r => ({
      text: r.text,
      filename: r.metadata.filename || 'unknown',
      chunkIndex: r.metadata.chunkIndex || 0,
      distance: r.distance,
    }));
  }

  /** Remove a document and its chunks */
  async removeDocument(id: string): Promise<boolean> {
    const doc = this.getDocument(id);
    if (!doc) return false;

    // Delete chunks from VectorStore
    if (this.memory.vectorStore) {
      for (let i = 0; i < doc.chunkCount; i++) {
        await this.memory.vectorStore.delete(`doc_${id}_chunk_${i}`);
      }
    }

    // Delete from SQLite
    this.memory.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    logger.info(`Document removed: ${doc.filename}`);
    return true;
  }

  /** Reindex a document */
  async reindex(id: string): Promise<DocumentRecord | null> {
    const doc = this.getDocument(id);
    if (!doc) return null;

    // Remove old chunks
    await this.removeDocument(id);

    // Re-ingest if file still exists
    if (fs.existsSync(doc.originalPath)) {
      return this.ingest(doc.originalPath);
    }

    return null;
  }

  /** List all indexed documents */
  listDocuments(): DocumentRecord[] {
    return this.memory.db
      .prepare(
        `SELECT id, filename, original_path as originalPath, mime_type as mimeType,
                file_size as fileSize, chunk_count as chunkCount, status,
                indexed_at as indexedAt
         FROM documents ORDER BY indexed_at DESC`
      )
      .all() as DocumentRecord[];
  }

  /** Get a single document by ID */
  getDocument(id: string): DocumentRecord | null {
    return (this.memory.db
      .prepare(
        `SELECT id, filename, original_path as originalPath, mime_type as mimeType,
                file_size as fileSize, chunk_count as chunkCount, status,
                indexed_at as indexedAt
         FROM documents WHERE id = ?`
      )
      .get(id) as DocumentRecord) || null;
  }

  /** Get document count */
  async getDocumentCount(): Promise<number> {
    const row = this.memory.db.prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number };
    return row.cnt;
  }

  // ── Parsers ──

  private async parseFile(filePath: string, ext: string): Promise<string> {
    switch (ext) {
      case '.pdf':
        return this.parsePDF(filePath);
      case '.docx':
        return this.parseDOCX(filePath);
      case '.html':
      case '.htm':
        return this.parseHTML(filePath);
      case '.txt':
      case '.md':
      case '.csv':
      case '.json':
      case '.log':
        return fs.readFileSync(filePath, 'utf-8');
      default:
        // Try reading as text
        return fs.readFileSync(filePath, 'utf-8');
    }
  }

  private async parsePDF(filePath: string): Promise<string> {
    const pdfParse = require('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  }

  private async parseDOCX(filePath: string): Promise<string> {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  private parseHTML(filePath: string): string {
    const html = fs.readFileSync(filePath, 'utf-8');
    // Strip HTML tags
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ── Chunking ──

  private chunkText(text: string): string[] {
    const chunkSize = config.ragChunkSize;
    const overlap = config.ragChunkOverlap;

    // Split by paragraphs first
    const paragraphs = text.split(/\n\s*\n/);
    const chunks: string[] = [];
    let current = '';

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;

      if (current.length + trimmed.length + 1 > chunkSize && current.length > 0) {
        chunks.push(current.trim());
        // Keep overlap from end of current chunk
        const words = current.split(' ');
        const overlapWords = Math.ceil(overlap / 5); // ~5 chars per word
        current = words.slice(-overlapWords).join(' ') + '\n\n' + trimmed;
      } else {
        current += (current ? '\n\n' : '') + trimmed;
      }
    }

    if (current.trim()) {
      chunks.push(current.trim());
    }

    // If we got no chunks from paragraph splitting (single block of text), split by size
    if (chunks.length === 0 && text.trim().length > 0) {
      for (let i = 0; i < text.length; i += chunkSize - overlap) {
        chunks.push(text.substring(i, i + chunkSize).trim());
      }
    }

    return chunks.filter(c => c.length > 0);
  }

  // ── Helpers ──

  private getMimeType(ext: string): string {
    const map: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.csv': 'text/csv',
      '.html': 'text/html',
      '.htm': 'text/html',
      '.json': 'application/json',
      '.log': 'text/plain',
    };
    return map[ext] || 'application/octet-stream';
  }
}
