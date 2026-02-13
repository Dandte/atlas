// ═══════════════════════════════════════
// ATLAS — Skill: Email
// Send emails via SMTP (nodemailer)
// Requires: npm install nodemailer (optional)
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';
import logger from '../../../utils/logger';

let nodemailer: any = null;
try {
  nodemailer = require('nodemailer');
} catch {
  // Not installed
}

export class EmailTool implements Tool {
  private transporter: any = null;

  definition = {
    name: 'email',
    description:
      'Enviar correos electrónicos por SMTP. ' +
      'Usar cuando digan "mandá un email", "enviá un correo", "escríbele un mail a X".',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['send', 'status'],
          description: 'send=enviar email, status=verificar conexión SMTP',
        },
        to: {
          type: 'string',
          description: 'Destinatario(s) separados por coma',
        },
        subject: {
          type: 'string',
          description: 'Asunto del correo',
        },
        body: {
          type: 'string',
          description: 'Contenido del correo (texto plano o HTML)',
        },
        html: {
          type: 'boolean',
          description: 'true=enviar como HTML, false=texto plano. Default: false',
        },
        cc: {
          type: 'string',
          description: 'CC (copia) separados por coma. Opcional.',
        },
        attachments: {
          type: 'string',
          description: 'Rutas de archivos adjuntos separadas por coma. Opcional.',
        },
      },
      required: ['action'],
    },
    dangerous: true, // Sending email is potentially dangerous
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    if (!nodemailer) {
      return {
        success: false, output: '',
        error: 'nodemailer no está instalado. Ejecutá: npm install nodemailer',
      };
    }

    const action = params.action as string;

    if (action === 'status') return this.checkStatus();
    if (action === 'send') return this.send(params);
    return { success: false, output: '', error: `Acción no reconocida: ${action}` };
  }

  private getTransporter(): any {
    if (this.transporter) return this.transporter;

    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || '587');
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!host || !user || !pass) {
      throw new Error(
        'SMTP no configurado. Agregá a .env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM'
      );
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });

    return this.transporter;
  }

  private async checkStatus(): Promise<ToolResult> {
    try {
      const transporter = this.getTransporter();
      await transporter.verify();
      return {
        success: true,
        output: `SMTP conectado: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT} (${process.env.SMTP_USER})`,
      };
    } catch (err: any) {
      return { success: false, output: '', error: `SMTP error: ${err.message}` };
    }
  }

  private async send(params: Record<string, unknown>): Promise<ToolResult> {
    const to = String(params.to || '');
    const subject = String(params.subject || '');
    const body = String(params.body || '');
    const isHtml = params.html === true;
    const cc = params.cc ? String(params.cc) : undefined;

    if (!to) return { success: false, output: '', error: 'Destinatario requerido (to).' };
    if (!subject) return { success: false, output: '', error: 'Asunto requerido (subject).' };
    if (!body) return { success: false, output: '', error: 'Cuerpo requerido (body).' };

    const from = process.env.SMTP_FROM || process.env.SMTP_USER;

    try {
      const transporter = this.getTransporter();

      const mailOptions: any = {
        from,
        to,
        subject,
        cc,
      };

      if (isHtml) {
        mailOptions.html = body;
      } else {
        mailOptions.text = body;
      }

      // Attachments
      if (params.attachments) {
        const paths = String(params.attachments).split(',').map(p => p.trim());
        mailOptions.attachments = paths.map(p => ({ path: p }));
      }

      const info = await transporter.sendMail(mailOptions);
      logger.info(`Email sent to ${to}: ${info.messageId}`);

      return {
        success: true,
        output: `Email enviado a ${to}\nAsunto: ${subject}\nID: ${info.messageId}`,
      };
    } catch (err: any) {
      return { success: false, output: '', error: `Error enviando email: ${err.message}` };
    }
  }
}

export function isEmailAvailable(): boolean {
  return nodemailer !== null && !!process.env.SMTP_HOST;
}
