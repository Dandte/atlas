// ═══════════════════════════════════════
// ATLAS — Skill: QR Code Generator
// Generate QR codes for URLs, text, payments
// Uses qrcode npm package (optional)
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';
import path from 'path';
import fs from 'fs';

let QRCode: any = null;
try {
  QRCode = require('qrcode');
} catch {
  // qrcode not installed
}

const OUTPUT_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'data', 'images', 'qr');

export class QRCodeTool implements Tool {
  definition = {
    name: 'qr_code',
    description:
      'Generar códigos QR como imagen PNG. Para URLs, texto, datos de contacto, links de pago, WhatsApp. ' +
      'Usar cuando digan "generá un QR", "hacé un código QR", "QR para este link".',
    input_schema: {
      type: 'object' as const,
      properties: {
        data: {
          type: 'string',
          description: 'Contenido del QR: URL, texto, teléfono, etc.',
        },
        type: {
          type: 'string',
          enum: ['url', 'text', 'whatsapp', 'wifi', 'vcard'],
          description: 'Tipo de QR. Default: auto-detecta si es URL.',
        },
        filename: {
          type: 'string',
          description: 'Nombre del archivo (sin extensión). Default: auto-generado.',
        },
        size: {
          type: 'number',
          description: 'Tamaño en px (ancho=alto). Default: 400.',
        },
        // WhatsApp-specific
        phone: { type: 'string', description: 'Número de teléfono (para type=whatsapp)' },
        message: { type: 'string', description: 'Mensaje pre-cargado (para type=whatsapp)' },
        // WiFi-specific
        ssid: { type: 'string', description: 'Nombre de la red WiFi' },
        password: { type: 'string', description: 'Contraseña WiFi' },
        encryption: { type: 'string', description: 'Tipo: WPA, WEP, nopass. Default: WPA' },
        // vCard
        name: { type: 'string', description: 'Nombre (para vcard)' },
        email: { type: 'string', description: 'Email (para vcard)' },
        tel: { type: 'string', description: 'Teléfono (para vcard)' },
        org: { type: 'string', description: 'Empresa (para vcard)' },
      },
      required: ['data'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    if (!QRCode) {
      return { success: false, output: '', error: 'qrcode no instalado. Ejecutá: npm install qrcode' };
    }

    let data = String(params.data || '');
    if (!data && !params.type) return { success: false, output: '', error: 'Necesito datos para el QR.' };

    const type = String(params.type || (data.match(/^https?:\/\//) ? 'url' : 'text'));

    // Build QR content based on type
    switch (type) {
      case 'whatsapp': {
        const phone = String(params.phone || data).replace(/[^0-9]/g, '');
        const msg = params.message ? `?text=${encodeURIComponent(String(params.message))}` : '';
        data = `https://wa.me/${phone}${msg}`;
        break;
      }
      case 'wifi': {
        const ssid = String(params.ssid || data);
        const pass = String(params.password || '');
        const enc = String(params.encryption || 'WPA');
        data = `WIFI:T:${enc};S:${ssid};P:${pass};;`;
        break;
      }
      case 'vcard': {
        const name = String(params.name || data);
        const tel = params.tel ? String(params.tel) : '';
        const email = params.email ? String(params.email) : '';
        const org = params.org ? String(params.org) : '';
        data = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}`;
        if (tel) data += `\nTEL:${tel}`;
        if (email) data += `\nEMAIL:${email}`;
        if (org) data += `\nORG:${org}`;
        data += `\nEND:VCARD`;
        break;
      }
    }

    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const size = Number(params.size || 400);
    const baseName = params.filename
      ? String(params.filename).replace(/[^a-zA-Z0-9-_]/g, '')
      : `qr-${Date.now()}`;
    const filePath = path.join(OUTPUT_DIR, `${baseName}.png`);

    try {
      await QRCode.toFile(filePath, data, {
        width: size,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });

      const fileSize = fs.statSync(filePath).size;
      let output = `QR generado: ${filePath}\n`;
      output += `Tipo: ${type} | Tamaño: ${size}px | ${(fileSize / 1024).toFixed(1)} KB\n`;
      output += `Contenido: ${data.substring(0, 100)}${data.length > 100 ? '...' : ''}`;

      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: '', error: `Error generando QR: ${err.message}` };
    }
  }
}
