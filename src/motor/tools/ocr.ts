// ═══════════════════════════════════════
// ATLAS — OCR Tool (Vision-based)
// Extract text from images using Claude Vision or OpenAI Vision
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';
import fs from 'fs';
import path from 'path';

export class OCRTool implements Tool {
  definition: ToolDefinition = {
    name: 'ocr',
    description: 'Extrae texto de imágenes usando AI Vision (Claude o GPT-4o). Ideal para documentos, capturas, fotos de texto, recibos, facturas.',
    input_schema: {
      type: 'object',
      properties: {
        image_path: {
          type: 'string',
          description: 'Ruta al archivo de imagen (PNG, JPG, WebP)',
        },
        image_base64: {
          type: 'string',
          description: 'Imagen en base64 (alternativa a image_path)',
        },
        language: {
          type: 'string',
          description: 'Idioma esperado del texto (default: español)',
        },
        format: {
          type: 'string',
          enum: ['text', 'json', 'table', 'structured'],
          description: 'Formato de salida: text (plano), json (datos estructurados), table (tabla), structured (con secciones)',
        },
      },
      required: [],
    },
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const imagePath = params.image_path ? String(params.image_path) : null;
    const imageBase64 = params.image_base64 ? String(params.image_base64) : null;
    const language = String(params.language || 'español');
    const format = String(params.format || 'text');

    if (!imagePath && !imageBase64) {
      return { success: false, output: '', error: 'Se requiere image_path o image_base64.' };
    }

    let base64Data: string;
    let mimeType: string = 'image/png';

    if (imagePath) {
      const resolvedPath = imagePath.startsWith('~')
        ? imagePath.replace('~', require('os').homedir())
        : path.resolve(imagePath);

      if (!fs.existsSync(resolvedPath)) {
        return { success: false, output: '', error: `Archivo no encontrado: ${resolvedPath}` };
      }

      const ext = path.extname(resolvedPath).toLowerCase();
      if (['.jpg', '.jpeg'].includes(ext)) mimeType = 'image/jpeg';
      else if (ext === '.webp') mimeType = 'image/webp';
      else if (ext === '.gif') mimeType = 'image/gif';

      base64Data = fs.readFileSync(resolvedPath).toString('base64');
    } else {
      base64Data = imageBase64!;
    }

    // Build prompt based on format
    let extractPrompt = `Extract ALL text from this image. Language: ${language}.`;
    switch (format) {
      case 'json':
        extractPrompt += ' Return the extracted data as a JSON object with meaningful keys.';
        break;
      case 'table':
        extractPrompt += ' If the image contains a table, reproduce it in markdown table format. Otherwise extract text normally.';
        break;
      case 'structured':
        extractPrompt += ' Organize the extracted text into sections with headers. Preserve the visual hierarchy.';
        break;
      default:
        extractPrompt += ' Return the text exactly as it appears, preserving line breaks and formatting.';
    }

    try {
      // Try Claude first, then OpenAI
      if (config.anthropicApiKey) {
        return await this.extractWithClaude(base64Data, mimeType, extractPrompt);
      } else if (config.openaiApiKey) {
        return await this.extractWithOpenAI(base64Data, mimeType, extractPrompt);
      } else {
        return { success: false, output: '', error: 'Se requiere ANTHROPIC_API_KEY o OPENAI_API_KEY para OCR.' };
      }
    } catch (err: any) {
      logger.error('OCR failed', { error: err });
      return { success: false, output: '', error: `Error en OCR: ${err.message}` };
    }
  }

  private async extractWithClaude(base64Data: string, mimeType: string, prompt: string): Promise<ToolResult> {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: config.anthropicApiKey });

    const response = await client.messages.create({
      model: config.claudeModel || 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: base64Data },
          },
          { type: 'text', text: prompt },
        ],
      }],
    });

    const text = response.content
      ?.filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n') || '';

    return { success: true, output: text || 'No se pudo extraer texto de la imagen.' };
  }

  private async extractWithOpenAI(base64Data: string, mimeType: string, prompt: string): Promise<ToolResult> {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey: config.openaiApiKey });

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64Data}` },
          },
          { type: 'text', text: prompt },
        ],
      }],
    });

    const text = response.choices?.[0]?.message?.content || '';
    return { success: true, output: text || 'No se pudo extraer texto de la imagen.' };
  }
}
