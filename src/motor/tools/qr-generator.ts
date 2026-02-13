// ═══════════════════════════════════════
// ATLAS — QR Code Generator Tool
// Generate QR codes for URLs, WiFi, vCards, text
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';
import fs from 'fs';
import path from 'path';

export class QRGeneratorTool implements Tool {
  definition: ToolDefinition = {
    name: 'qr_generate',
    description: 'Genera códigos QR en formato PNG. Soporta: URLs, texto, WiFi (auto-connect), vCards (contacto), email, teléfono. Ideal para compartir links, datos de contacto, etc.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['url', 'text', 'wifi', 'vcard', 'email', 'phone'],
          description: 'Tipo de QR. Default: auto-detecta por contenido',
        },
        content: {
          type: 'string',
          description: 'Contenido del QR. Para URL: la URL. Para texto: el texto. Para wifi/vcard: ver parámetros específicos.',
        },
        // WiFi params
        wifi_ssid: { type: 'string', description: 'Nombre de la red WiFi (para type=wifi)' },
        wifi_password: { type: 'string', description: 'Contraseña WiFi (para type=wifi)' },
        wifi_encryption: { type: 'string', enum: ['WPA', 'WEP', 'nopass'], description: 'Tipo de encriptación WiFi. Default: WPA' },
        // vCard params
        name: { type: 'string', description: 'Nombre completo (para type=vcard)' },
        phone: { type: 'string', description: 'Teléfono (para type=vcard/phone)' },
        email: { type: 'string', description: 'Email (para type=vcard/email)' },
        company: { type: 'string', description: 'Empresa (para type=vcard)' },
        title: { type: 'string', description: 'Cargo (para type=vcard)' },
        website: { type: 'string', description: 'Sitio web (para type=vcard)' },
        // Display
        size: { type: 'number', description: 'Tamaño en pixels. Default: 400' },
        dark_color: { type: 'string', description: 'Color del QR en hex. Default: #000000' },
        light_color: { type: 'string', description: 'Color de fondo en hex. Default: #FFFFFF' },
      },
      required: ['content'],
    },
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const content = String(params.content || '').trim();
    if (!content && !params.wifi_ssid && !params.name) {
      return { success: false, output: '', error: 'Se requiere contenido para generar el QR' };
    }

    try {
      const QRCode = require('qrcode');

      // Build QR data based on type
      let qrData: string;
      let typeLabel: string;
      const type = String(params.type || this.detectType(content));

      switch (type) {
        case 'wifi': {
          const ssid = String(params.wifi_ssid || content);
          const password = String(params.wifi_password || '');
          const encryption = String(params.wifi_encryption || 'WPA');
          qrData = `WIFI:T:${encryption};S:${ssid};P:${password};;`;
          typeLabel = `WiFi: ${ssid}`;
          break;
        }
        case 'vcard': {
          const name = String(params.name || content);
          const phone = String(params.phone || '');
          const email = String(params.email || '');
          const company = String(params.company || '');
          const titleStr = String(params.title || '');
          const website = String(params.website || '');
          qrData = [
            'BEGIN:VCARD',
            'VERSION:3.0',
            `FN:${name}`,
            phone ? `TEL:${phone}` : '',
            email ? `EMAIL:${email}` : '',
            company ? `ORG:${company}` : '',
            titleStr ? `TITLE:${titleStr}` : '',
            website ? `URL:${website}` : '',
            'END:VCARD',
          ].filter(Boolean).join('\n');
          typeLabel = `vCard: ${name}`;
          break;
        }
        case 'email': {
          const emailAddr = String(params.email || content);
          qrData = `mailto:${emailAddr}`;
          typeLabel = `Email: ${emailAddr}`;
          break;
        }
        case 'phone': {
          const phoneNum = String(params.phone || content);
          qrData = `tel:${phoneNum}`;
          typeLabel = `Teléfono: ${phoneNum}`;
          break;
        }
        case 'url':
          qrData = content.startsWith('http') ? content : `https://${content}`;
          typeLabel = `URL: ${qrData}`;
          break;
        default:
          qrData = content;
          typeLabel = `Texto (${content.length} chars)`;
      }

      // Generate QR
      const size = Number(params.size || 400);
      const darkColor = String(params.dark_color || '#000000');
      const lightColor = String(params.light_color || '#FFFFFF');

      const outputDir = path.join(config.dataDir, 'qr');
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

      const filename = `qr_${Date.now()}.png`;
      const outputPath = path.join(outputDir, filename);

      await QRCode.toFile(outputPath, qrData, {
        width: Math.min(2000, Math.max(100, size)),
        color: { dark: darkColor, light: lightColor },
        errorCorrectionLevel: 'M',
        margin: 2,
      });

      const stats = fs.statSync(outputPath);
      return {
        success: true,
        output: `QR generado exitosamente.\nTipo: ${typeLabel}\nArchivo: ${outputPath} (${(stats.size / 1024).toFixed(1)} KB)\nTamaño: ${size}x${size}px`,
      };
    } catch (err: any) {
      if (/Cannot find module/i.test(err.message)) {
        return { success: false, output: '', error: 'Módulo qrcode no instalado. Ejecutá: npm install qrcode' };
      }
      logger.error('QR generation failed', { error: err });
      return { success: false, output: '', error: `Error generando QR: ${err.message}` };
    }
  }

  private detectType(content: string): string {
    if (/^https?:\/\//i.test(content) || /\.(com|org|net|io|co|dev)/i.test(content)) return 'url';
    if (/^[\w.+-]+@[\w.-]+\.\w+$/.test(content)) return 'email';
    if (/^\+?\d[\d\s()-]{6,}$/.test(content)) return 'phone';
    return 'text';
  }
}
