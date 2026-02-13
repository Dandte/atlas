// ═══════════════════════════════════════
// ATLAS — Skill: PDF Generator
// Create PDFs: quotes, reports, documents
// Uses PDFKit (optional dependency)
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';
import path from 'path';
import fs from 'fs';

let PDFDocument: any = null;
try {
  PDFDocument = require('pdfkit');
} catch {
  // pdfkit not installed — tool will report gracefully
}

const OUTPUT_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'data', 'documents', 'generated');

export class PDFGeneratorTool implements Tool {
  definition = {
    name: 'pdf',
    description:
      'Generar documentos PDF: cotizaciones, reportes, documentos de texto. ' +
      'Acciones: create (documento libre), quote (cotización de financiamiento), report (tabla de datos). ' +
      'Usar cuando digan "generá un PDF", "hacé una cotización", "creá un reporte".',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'quote', 'report'],
          description: 'Tipo de PDF a generar',
        },
        title: {
          type: 'string',
          description: 'Título del documento',
        },
        content: {
          type: 'string',
          description: 'Contenido del documento (texto libre, se respetan saltos de línea)',
        },
        filename: {
          type: 'string',
          description: 'Nombre del archivo (sin .pdf). Default: auto-generado',
        },
        // Quote-specific
        client_name: { type: 'string', description: 'Nombre del cliente (para cotización)' },
        client_id: { type: 'string', description: 'Cédula/NIT del cliente' },
        amount: { type: 'number', description: 'Monto del crédito/cotización' },
        term: { type: 'number', description: 'Plazo en meses' },
        rate: { type: 'number', description: 'Tasa mensual (ej: 2.5 para 2.5%)' },
        product: { type: 'string', description: 'Producto cotizado (ej: Samsung Galaxy S24)' },
        // Report-specific
        headers: {
          type: 'array',
          description: 'Encabezados de columnas para reporte',
          items: { type: 'string' },
        },
        rows: {
          type: 'array',
          description: 'Filas de datos (array de arrays)',
          items: { type: 'array', items: { type: 'string' } },
        },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    if (!PDFDocument) {
      return { success: false, output: '', error: 'pdfkit no instalado. Ejecutá: npm install pdfkit' };
    }

    const action = String(params.action || 'create');

    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    try {
      switch (action) {
        case 'create':
          return this.createDocument(params);
        case 'quote':
          return this.createQuote(params);
        case 'report':
          return this.createReport(params);
        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      return { success: false, output: '', error: `Error generando PDF: ${err.message}` };
    }
  }

  private async createDocument(params: Record<string, unknown>): Promise<ToolResult> {
    const title = String(params.title || 'Documento');
    const content = String(params.content || '');
    if (!content) return { success: false, output: '', error: 'Necesito contenido para el documento.' };

    const filename = this.getFilename(params.filename as string, title);
    const filePath = path.join(OUTPUT_DIR, filename);

    return new Promise((resolve) => {
      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      // Header
      doc.fontSize(20).font('Helvetica-Bold').text(title, { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica').fillColor('#666')
        .text(`Generado: ${new Date().toLocaleString('es-CO')}`, { align: 'center' });
      doc.moveDown(1);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ccc');
      doc.moveDown(1);

      // Content
      doc.fontSize(12).font('Helvetica').fillColor('#000');
      const lines = content.split('\n');
      for (const line of lines) {
        if (line.startsWith('## ')) {
          doc.moveDown(0.5).fontSize(16).font('Helvetica-Bold').text(line.substring(3));
          doc.fontSize(12).font('Helvetica');
        } else if (line.startsWith('# ')) {
          doc.moveDown(0.5).fontSize(18).font('Helvetica-Bold').text(line.substring(2));
          doc.fontSize(12).font('Helvetica');
        } else if (line.startsWith('- ')) {
          doc.text(`  •  ${line.substring(2)}`);
        } else if (line.trim() === '') {
          doc.moveDown(0.5);
        } else {
          doc.text(line);
        }
      }

      doc.end();
      stream.on('finish', () => {
        resolve({ success: true, output: `PDF generado: ${filePath}\nTamaño: ${(fs.statSync(filePath).size / 1024).toFixed(1)} KB` });
      });
      stream.on('error', (err: any) => {
        resolve({ success: false, output: '', error: `Error escribiendo PDF: ${err.message}` });
      });
    });
  }

  private async createQuote(params: Record<string, unknown>): Promise<ToolResult> {
    const clientName = String(params.client_name || 'Cliente');
    const clientId = String(params.client_id || '');
    const amount = Number(params.amount || 0);
    const term = Number(params.term || 12);
    const rate = Number(params.rate || 2.5);
    const product = String(params.product || '');

    if (!amount) return { success: false, output: '', error: 'Necesito el monto del crédito.' };

    // Calculate loan
    const monthlyRate = rate / 100;
    const payment = amount * (monthlyRate * Math.pow(1 + monthlyRate, term)) / (Math.pow(1 + monthlyRate, term) - 1);
    const totalPaid = payment * term;
    const totalInterest = totalPaid - amount;

    const title = 'Cotización de Crédito';
    const filename = this.getFilename(params.filename as string, `cotizacion-${clientName.replace(/\s+/g, '-')}`);
    const filePath = path.join(OUTPUT_DIR, filename);

    return new Promise((resolve) => {
      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      // Header
      doc.fontSize(24).font('Helvetica-Bold').fillColor('#1a237e').text('ATLAS Finance', { align: 'center' });
      doc.fontSize(10).font('Helvetica').fillColor('#666').text('Financiamiento de equipos', { align: 'center' });
      doc.moveDown(1);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#1a237e');
      doc.moveDown(1);

      doc.fontSize(16).font('Helvetica-Bold').fillColor('#333').text(title, { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica').fillColor('#666')
        .text(`Fecha: ${new Date().toLocaleDateString('es-CO')}  |  Válida por 15 días`, { align: 'center' });
      doc.moveDown(1);

      // Client info
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a237e').text('Datos del Cliente');
      doc.fontSize(11).font('Helvetica').fillColor('#333');
      doc.text(`Nombre: ${clientName}`);
      if (clientId) doc.text(`Cédula/NIT: ${clientId}`);
      doc.moveDown(1);

      // Product
      if (product) {
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a237e').text('Producto');
        doc.fontSize(11).font('Helvetica').fillColor('#333').text(product);
        doc.moveDown(1);
      }

      // Loan details
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a237e').text('Detalle del Crédito');
      doc.fontSize(11).font('Helvetica').fillColor('#333');

      const fmt = (n: number) => '$' + n.toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

      const details = [
        ['Monto financiado', fmt(amount)],
        ['Plazo', `${term} meses`],
        ['Tasa mensual', `${rate}%`],
        ['Cuota mensual', fmt(Math.round(payment))],
        ['Total a pagar', fmt(Math.round(totalPaid))],
        ['Total intereses', fmt(Math.round(totalInterest))],
      ];

      const tableTop = doc.y + 5;
      const col1X = 60;
      const col2X = 350;
      const rowHeight = 22;

      for (let i = 0; i < details.length; i++) {
        const y = tableTop + i * rowHeight;
        if (i % 2 === 0) {
          doc.rect(col1X - 5, y - 3, 490, rowHeight).fill('#f5f5f5');
        }
        doc.fillColor('#333').font('Helvetica').fontSize(11)
          .text(details[i][0], col1X, y)
          .font('Helvetica-Bold').text(details[i][1], col2X, y);
      }

      doc.y = tableTop + details.length * rowHeight + 15;
      doc.moveDown(1);

      // Amortization table (first 6 months)
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a237e').text('Tabla de Amortización (primeros 6 meses)');
      doc.moveDown(0.5);

      const headers = ['Mes', 'Cuota', 'Capital', 'Interés', 'Saldo'];
      const headerY = doc.y;
      const colWidths = [40, 100, 100, 100, 100];
      let xPos = 60;

      doc.rect(55, headerY - 3, 490, 18).fill('#1a237e');
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff');
      for (let i = 0; i < headers.length; i++) {
        doc.text(headers[i], xPos, headerY, { width: colWidths[i], align: 'center' });
        xPos += colWidths[i];
      }

      let balance = amount;
      const showMonths = Math.min(6, term);
      doc.font('Helvetica').fontSize(9).fillColor('#333');

      for (let m = 1; m <= showMonths; m++) {
        const interest = balance * monthlyRate;
        const principal = payment - interest;
        balance -= principal;

        const y = headerY + 18 + (m - 1) * 18;
        if (m % 2 === 0) doc.rect(55, y - 3, 490, 18).fill('#f8f8f8');
        doc.fillColor('#333');

        xPos = 60;
        const rowData = [
          String(m),
          fmt(Math.round(payment)),
          fmt(Math.round(principal)),
          fmt(Math.round(interest)),
          fmt(Math.max(0, Math.round(balance))),
        ];
        for (let i = 0; i < rowData.length; i++) {
          doc.text(rowData[i], xPos, y, { width: colWidths[i], align: 'center' });
          xPos += colWidths[i];
        }
      }

      // Footer
      doc.y = headerY + 18 + showMonths * 18 + 30;
      doc.fontSize(8).font('Helvetica').fillColor('#999')
        .text('Esta cotización es informativa y no constituye una aprobación de crédito.', { align: 'center' })
        .text('Sujeta a verificación y aprobación.', { align: 'center' });

      doc.end();
      stream.on('finish', () => {
        resolve({
          success: true,
          output: `Cotización PDF generada: ${filePath}\n` +
            `Cliente: ${clientName}\n` +
            `Monto: ${fmt(amount)} | ${term} meses | Cuota: ${fmt(Math.round(payment))}\n` +
            `Tamaño: ${(fs.statSync(filePath).size / 1024).toFixed(1)} KB`,
        });
      });
      stream.on('error', (err: any) => {
        resolve({ success: false, output: '', error: err.message });
      });
    });
  }

  private async createReport(params: Record<string, unknown>): Promise<ToolResult> {
    const title = String(params.title || 'Reporte');
    const headers = (params.headers || []) as string[];
    const rows = (params.rows || []) as string[][];

    if (headers.length === 0) return { success: false, output: '', error: 'Necesito headers para el reporte.' };
    if (rows.length === 0) return { success: false, output: '', error: 'Necesito filas de datos.' };

    const filename = this.getFilename(params.filename as string, title);
    const filePath = path.join(OUTPUT_DIR, filename);

    return new Promise((resolve) => {
      const doc = new PDFDocument({ margin: 40, layout: headers.length > 5 ? 'landscape' : 'portrait' });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      // Header
      doc.fontSize(18).font('Helvetica-Bold').text(title, { align: 'center' });
      doc.fontSize(9).font('Helvetica').fillColor('#666')
        .text(`Generado: ${new Date().toLocaleString('es-CO')} | ${rows.length} registros`, { align: 'center' });
      doc.moveDown(1);

      // Table
      const pageWidth = doc.page.width - 80;
      const colWidth = pageWidth / headers.length;
      const tableTop = doc.y;

      // Header row
      doc.rect(40, tableTop - 3, pageWidth, 20).fill('#2196f3');
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff');
      for (let i = 0; i < headers.length; i++) {
        doc.text(headers[i], 45 + i * colWidth, tableTop, { width: colWidth - 5, align: 'center' });
      }

      // Data rows
      doc.font('Helvetica').fontSize(8).fillColor('#333');
      for (let r = 0; r < rows.length; r++) {
        const y = tableTop + 20 + r * 16;

        if (y > doc.page.height - 60) {
          doc.addPage();
          break; // Simple page break — show what fits
        }

        if (r % 2 === 0) doc.rect(40, y - 2, pageWidth, 16).fill('#f5f5f5');
        doc.fillColor('#333');

        for (let c = 0; c < headers.length; c++) {
          const val = rows[r]?.[c] || '';
          doc.text(val, 45 + c * colWidth, y, { width: colWidth - 5, align: 'center' });
        }
      }

      // Summary
      doc.y = tableTop + 20 + Math.min(rows.length, 40) * 16 + 20;
      if (params.content) {
        doc.fontSize(10).font('Helvetica').fillColor('#333').text(String(params.content));
      }

      doc.end();
      stream.on('finish', () => {
        resolve({
          success: true,
          output: `Reporte PDF generado: ${filePath}\n` +
            `${rows.length} filas × ${headers.length} columnas\n` +
            `Tamaño: ${(fs.statSync(filePath).size / 1024).toFixed(1)} KB`,
        });
      });
      stream.on('error', (err: any) => {
        resolve({ success: false, output: '', error: err.message });
      });
    });
  }

  private getFilename(custom: string | undefined, fallback: string): string {
    const base = (custom || fallback)
      .toLowerCase()
      .replace(/[^a-z0-9áéíóúñ\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);
    const date = new Date().toISOString().split('T')[0];
    return `${base}-${date}.pdf`;
  }
}
