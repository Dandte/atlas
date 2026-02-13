// ═══════════════════════════════════════
// ATLAS — Skill: OCR (Optical Character Recognition)
// Extract text from images via OpenAI Vision API
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';
import fs from 'fs';
import path from 'path';

export class OCRTool implements Tool {
  definition = {
    name: 'ocr',
    description:
      'Extraer texto de imágenes (OCR). Lee fotos de documentos, recibos, capturas de pantalla, facturas. ' +
      'Usar cuando digan "leé esta imagen", "qué dice esta foto", "extraé el texto", "escaneá este documento".',
    input_schema: {
      type: 'object' as const,
      properties: {
        file: {
          type: 'string',
          description: 'Ruta a la imagen (PNG, JPG, WEBP, GIF)',
        },
        prompt: {
          type: 'string',
          description: 'Instrucción adicional (ej: "extraé solo los números", "es una factura, listá los items"). Default: extraer todo el texto',
        },
        detail: {
          type: 'string',
          enum: ['low', 'high', 'auto'],
          description: 'Detalle de análisis: low (rápido), high (mejor para texto pequeño), auto. Default: high',
        },
      },
      required: ['file'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { success: false, output: '', error: 'OPENAI_API_KEY no configurado. Se necesita para OCR (Vision).' };
    }

    const filePath = String(params.file || '');
    if (!filePath) return { success: false, output: '', error: 'Necesito la ruta de la imagen.' };

    if (!fs.existsSync(filePath)) {
      return { success: false, output: '', error: `Archivo no encontrado: ${filePath}` };
    }

    const ext = path.extname(filePath).toLowerCase();
    const supported = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
    if (!supported.includes(ext)) {
      return { success: false, output: '', error: `Formato no soportado: ${ext}. Soportados: ${supported.join(', ')}` };
    }

    const stat = fs.statSync(filePath);
    if (stat.size > 20 * 1024 * 1024) {
      return { success: false, output: '', error: 'Imagen muy grande (máx 20MB).' };
    }

    const prompt = String(params.prompt || 'Extract ALL text from this image. Preserve the original layout and structure as much as possible. If there are tables, format them clearly. Return ONLY the extracted text, nothing else.');
    const detail = String(params.detail || 'high');

    try {
      const imageBuffer = fs.readFileSync(filePath);
      const base64 = imageBuffer.toString('base64');

      const mimeMap: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.webp': 'image/webp', '.gif': 'image/gif',
      };
      const mimeType = mimeMap[ext] || 'image/png';

      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64}`,
                  detail,
                },
              },
            ],
          }],
          max_tokens: 4096,
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as any;
        return { success: false, output: '', error: `OCR error: ${err.error?.message || resp.statusText}` };
      }

      const data = await resp.json() as any;
      const text = data.choices?.[0]?.message?.content || '';

      if (!text) {
        return { success: true, output: 'No se detectó texto en la imagen.' };
      }

      let output = `OCR de ${path.basename(filePath)}:\n\n${text}`;
      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: '', error: `Error OCR: ${err.message}` };
    }
  }
}
