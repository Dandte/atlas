// ═══════════════════════════════════════
// ATLAS — Image Generation Tool
// DALL-E 3 via OpenAI API
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';

export class ImageGenerateTool implements Tool {
  definition: ToolDefinition = {
    name: 'image_generate',
    description: 'Genera imágenes usando DALL-E 3 de OpenAI. Puede crear ilustraciones, logos, arte conceptual, mockups, etc. Devuelve URL temporal de la imagen generada.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Descripción detallada de la imagen a generar (en inglés para mejores resultados)',
        },
        size: {
          type: 'string',
          enum: ['1024x1024', '1792x1024', '1024x1792'],
          description: 'Tamaño: 1024x1024 (cuadrada), 1792x1024 (paisaje), 1024x1792 (retrato). Default: 1024x1024',
        },
        quality: {
          type: 'string',
          enum: ['standard', 'hd'],
          description: 'Calidad: standard (rápido) o hd (más detalle). Default: standard',
        },
        style: {
          type: 'string',
          enum: ['vivid', 'natural'],
          description: 'Estilo: vivid (hyper-real/dramático) o natural (más sutil). Default: vivid',
        },
      },
      required: ['prompt'],
    },
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const prompt = String(params.prompt || '');
    const size = String(params.size || '1024x1024');
    const quality = String(params.quality || 'standard');
    const style = String(params.style || 'vivid');

    if (!prompt) {
      return { success: false, output: '', error: 'Se requiere un prompt para generar la imagen' };
    }

    if (!config.openaiApiKey) {
      return { success: false, output: '', error: 'Se requiere OPENAI_API_KEY para generar imágenes con DALL-E 3' };
    }

    try {
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey: config.openaiApiKey });

      logger.info('Generating image with DALL-E 3', { promptLength: prompt.length, size, quality, style });

      const response = await client.images.generate({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size,
        quality,
        style,
        response_format: 'url',
      });

      const imageUrl = response.data?.[0]?.url;
      const revisedPrompt = response.data?.[0]?.revised_prompt;

      if (!imageUrl) {
        return { success: false, output: '', error: 'No se recibió URL de imagen' };
      }

      const output = [
        `Imagen generada exitosamente.`,
        `URL: ${imageUrl}`,
        `Tamaño: ${size} | Calidad: ${quality} | Estilo: ${style}`,
      ];

      if (revisedPrompt && revisedPrompt !== prompt) {
        output.push(`Prompt revisado por DALL-E: ${revisedPrompt}`);
      }

      output.push(`\nNota: La URL expira en ~1 hora. Usá file download para guardarla permanentemente.`);

      return { success: true, output: output.join('\n') };
    } catch (err: any) {
      const msg = err?.message || String(err);
      logger.error('Image generation failed', { error: err });

      if (/content_policy/i.test(msg)) {
        return { success: false, output: '', error: 'El prompt fue rechazado por las políticas de contenido de OpenAI. Intentá reformularlo.' };
      }
      if (/billing|quota/i.test(msg)) {
        return { success: false, output: '', error: 'Sin créditos en OpenAI para generación de imágenes.' };
      }

      return { success: false, output: '', error: `Error generando imagen: ${msg}` };
    }
  }
}
