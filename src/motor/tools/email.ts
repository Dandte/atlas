// ═══════════════════════════════════════
// ATLAS — Email Tool (IMAP + SMTP)
// Read inbox, search, send, reply
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';

export class EmailTool implements Tool {
  definition: ToolDefinition = {
    name: 'email',
    description: 'Gestión de email: leer bandeja, buscar, enviar, responder. Soporta IMAP (lectura) y SMTP (envío).',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['inbox', 'search', 'send', 'reply', 'read'],
          description: 'inbox=últimos emails, search=buscar, send=enviar, reply=responder, read=leer email específico',
        },
        // inbox/search params
        limit: { type: 'number', description: 'Cantidad de emails a retornar (default 10)' },
        query: { type: 'string', description: 'Búsqueda: texto libre, desde, asunto, etc.' },
        folder: { type: 'string', description: 'Carpeta IMAP (default INBOX)' },
        // read params
        uid: { type: 'number', description: 'UID del email a leer completo' },
        // send/reply params
        to: { type: 'string', description: 'Destinatario(s) separados por coma' },
        subject: { type: 'string', description: 'Asunto del email' },
        body: { type: 'string', description: 'Cuerpo del email (texto plano)' },
        html: { type: 'string', description: 'Cuerpo HTML (opcional, alternativo a body)' },
        inReplyTo: { type: 'string', description: 'Message-ID al que se responde' },
      },
      required: ['action'],
    },
  };

  private async getImapClient(): Promise<any> {
    const { ImapFlow } = require('imapflow');
    const client = new ImapFlow({
      host: config.imapHost,
      port: config.imapPort,
      secure: config.imapSecure,
      auth: {
        user: config.imapUser || config.smtpUser,
        pass: config.imapPass || config.smtpPass,
      },
      logger: false,
    });
    await client.connect();
    return client;
  }

  private async getTransporter(): Promise<any> {
    const nodemailer = require('nodemailer');
    return nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: {
        user: config.smtpUser,
        pass: config.smtpPass,
      },
    });
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || '');

    if (!config.smtpHost && !config.imapHost) {
      return { success: false, output: '', error: 'Email no configurado. Se requiere SMTP_HOST o IMAP_HOST en .env' };
    }

    try {
      switch (action) {
        case 'inbox': return await this.readInbox(params);
        case 'search': return await this.searchEmails(params);
        case 'read': return await this.readEmail(params);
        case 'send': return await this.sendEmail(params);
        case 'reply': return await this.sendEmail(params);
        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}. Usa: inbox, search, read, send, reply` };
      }
    } catch (err: any) {
      logger.error('Email tool error', { action, error: err });
      return { success: false, output: '', error: `Error de email: ${err.message}` };
    }
  }

  private async readInbox(params: Record<string, unknown>): Promise<ToolResult> {
    if (!config.imapHost) {
      return { success: false, output: '', error: 'IMAP no configurado. Se requiere IMAP_HOST.' };
    }

    const limit = Number(params.limit) || 10;
    const folder = String(params.folder || 'INBOX');
    const client = await this.getImapClient();

    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const messages: string[] = [];
        let count = 0;

        // Get latest messages
        for await (const msg of client.fetch(`${Math.max(1, client.mailbox.exists - limit + 1)}:*`, {
          envelope: true,
          flags: true,
        })) {
          const from = msg.envelope?.from?.[0];
          const fromStr = from ? `${from.name || ''} <${from.address}>`.trim() : 'unknown';
          const date = msg.envelope?.date ? new Date(msg.envelope.date).toLocaleString('es-CO') : '';
          const seen = msg.flags?.has('\\Seen') ? '' : ' [NO LEÍDO]';
          messages.push(`${msg.uid} | ${date} | ${fromStr} | ${msg.envelope?.subject || '(sin asunto)'}${seen}`);
          count++;
        }

        lock.release();
        messages.reverse(); // Most recent first

        return {
          success: true,
          output: `📧 ${folder} — ${count} emails (de ${client.mailbox.exists} totales)\n` +
            `UID | Fecha | De | Asunto\n` +
            `${'─'.repeat(60)}\n` +
            messages.join('\n') +
            `\n\nUsá email read con el UID para ver el contenido completo.`,
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  private async searchEmails(params: Record<string, unknown>): Promise<ToolResult> {
    if (!config.imapHost) {
      return { success: false, output: '', error: 'IMAP no configurado.' };
    }

    const query = String(params.query || '');
    const limit = Number(params.limit) || 10;
    const folder = String(params.folder || 'INBOX');

    if (!query) {
      return { success: false, output: '', error: 'Se requiere query para buscar.' };
    }

    const client = await this.getImapClient();
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        // Build IMAP search criteria
        const searchCriteria: any = { or: [
          { subject: query },
          { from: query },
          { body: query },
        ]};

        const uids = await client.search(searchCriteria);
        const results: string[] = [];

        if (uids.length === 0) {
          return { success: true, output: `No se encontraron emails con: "${query}"` };
        }

        const fetchUids = uids.slice(-limit);
        for await (const msg of client.fetch(fetchUids, { envelope: true, flags: true })) {
          const from = msg.envelope?.from?.[0];
          const fromStr = from ? `${from.name || ''} <${from.address}>`.trim() : 'unknown';
          const date = msg.envelope?.date ? new Date(msg.envelope.date).toLocaleString('es-CO') : '';
          results.push(`${msg.uid} | ${date} | ${fromStr} | ${msg.envelope?.subject || '(sin asunto)'}`);
        }

        lock.release();
        results.reverse();

        return {
          success: true,
          output: `🔍 "${query}" — ${uids.length} resultados (mostrando ${results.length})\n` +
            results.join('\n'),
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  private async readEmail(params: Record<string, unknown>): Promise<ToolResult> {
    if (!config.imapHost) {
      return { success: false, output: '', error: 'IMAP no configurado.' };
    }

    const uid = Number(params.uid);
    if (!uid) {
      return { success: false, output: '', error: 'Se requiere uid del email a leer.' };
    }

    const folder = String(params.folder || 'INBOX');
    const client = await this.getImapClient();

    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const msg = await client.fetchOne(String(uid), {
          envelope: true,
          source: true,
        });

        if (!msg) {
          return { success: false, output: '', error: `Email UID ${uid} no encontrado.` };
        }

        // Parse the email content
        const { simpleParser } = require('mailparser');
        const parsed = await simpleParser(msg.source);

        const from = parsed.from?.text || 'unknown';
        const to = parsed.to?.text || '';
        const subject = parsed.subject || '(sin asunto)';
        const date = parsed.date ? new Date(parsed.date).toLocaleString('es-CO') : '';
        const text = parsed.text || parsed.html?.replace(/<[^>]+>/g, ' ').substring(0, 3000) || '(vacío)';
        const attachments = parsed.attachments || [];
        const messageId = parsed.messageId || '';

        const output = [
          `De: ${from}`,
          `Para: ${to}`,
          `Asunto: ${subject}`,
          `Fecha: ${date}`,
          messageId ? `Message-ID: ${messageId}` : '',
          attachments.length > 0 ? `Adjuntos: ${attachments.map((a: any) => `${a.filename} (${Math.round(a.size / 1024)}KB)`).join(', ')}` : '',
          `${'─'.repeat(60)}`,
          text.substring(0, 4000),
        ].filter(Boolean).join('\n');

        lock.release();
        return { success: true, output };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  private async sendEmail(params: Record<string, unknown>): Promise<ToolResult> {
    if (!config.smtpHost) {
      return { success: false, output: '', error: 'SMTP no configurado. Se requiere SMTP_HOST.' };
    }

    const to = String(params.to || '');
    const subject = String(params.subject || '');
    const body = String(params.body || '');
    const html = params.html ? String(params.html) : undefined;
    const inReplyTo = params.inReplyTo ? String(params.inReplyTo) : undefined;

    if (!to) return { success: false, output: '', error: 'Se requiere destinatario (to).' };
    if (!subject) return { success: false, output: '', error: 'Se requiere asunto (subject).' };
    if (!body && !html) return { success: false, output: '', error: 'Se requiere cuerpo (body o html).' };

    const transporter = await this.getTransporter();

    const mailOptions: any = {
      from: config.smtpFrom || config.smtpUser,
      to,
      subject,
    };

    if (html) {
      mailOptions.html = html;
      if (body) mailOptions.text = body;
    } else {
      mailOptions.text = body;
    }

    if (inReplyTo) {
      mailOptions.inReplyTo = inReplyTo;
      mailOptions.references = inReplyTo;
    }

    const result = await transporter.sendMail(mailOptions);
    logger.info('Email sent', { to, subject, messageId: result.messageId });

    return {
      success: true,
      output: `Email enviado exitosamente.\nPara: ${to}\nAsunto: ${subject}\nMessage-ID: ${result.messageId}`,
    };
  }
}
