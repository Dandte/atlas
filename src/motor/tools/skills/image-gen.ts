// ═══════════════════════════════════════
// ATLAS — Skill: Image Generation
// Generate images via OpenAI DALL-E or Flux
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';
import path from 'path';
import fs from 'fs';

const OUTPUT_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'data', 'images', 'generated');

export class ImageGenTool implements Tool {
  definition = {
    name: 'image_gen',
    description:
      'Generar imágenes con IA (DALL-E 3). Crear imágenes para marketing, redes sociales, logos, etc. ' +
      'Usar cuando digan "generá una imagen", "creá un banner", "hacé un diseño".',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: {
          type: 'string',
          description: 'Descripción detallada de la imagen a generar (en inglés da mejores resultados)',
        },
        size: {
          type: 'string',
          enum: ['1024x1024', '1792x1024', '1024x1792'],
          description: 'Tamaño: 1024x1024 (cuadrada), 1792x1024 (horizontal/banner), 1024x1792 (vertical/story). Default: 1024x1024',
        },
        quality: {
          type: 'string',
          enum: ['standard', 'hd'],
          description: 'Calidad: standard (rápido, más barato) o hd (más detalle). Default: standard',
        },
        style: {
          type: 'string',
          enum: ['vivid', 'natural'],
          description: 'Estilo: vivid (más dramático) o natural (más realista). Default: vivid',
        },
        filename: {
          type: 'string',
          description: 'Nombre del archivo (sin extensión). Default: auto-generado',
        },
      },
      required: ['prompt'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { success: false, output: '', error: 'OPENAI_API_KEY no configurado. Se necesita para DALL-E.' };
    }

    const prompt = String(params.prompt || '');
    if (!prompt) return { success: false, output: '', error: 'Necesito una descripción de la imagen.' };

    const size = String(params.size || '1024x1024');
    const quality = String(params.quality || 'standard');
    const style = String(params.style || 'vivid');

    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    try {
      // Call OpenAI DALL-E 3 API directly (avoid importing the full SDK)
      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'dall-e-3',
          prompt,
          n: 1,
          size,
          quality,
          style,
          response_format: 'url',
        }),
        signal: AbortSignal.timeout(120000), // 2 min timeout for image generation
      });

      if (!response.ok) {
        const err = await response.json() as any;
        return { success: false, output: '', error: `DALL-E error: ${err.error?.message || response.statusText}` };
      }

      const data = await response.json() as any;
      const imageUrl = data.data?.[0]?.url;
      const revisedPrompt = data.data?.[0]?.revised_prompt;

      if (!imageUrl) {
        return { success: false, output: '', error: 'No se recibió URL de imagen.' };
      }

      // Download image
      const imageResp = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
      if (!imageResp.ok) {
        return { success: false, output: '', error: 'Error descargando la imagen generada.' };
      }

      const buffer = Buffer.from(await imageResp.arrayBuffer());

      // Save to file
      const baseName = params.filename
        ? String(params.filename).replace(/[^a-zA-Z0-9-_]/g, '')
        : `img-${Date.now()}`;
      const filename = `${baseName}.png`;
      const filePath = path.join(OUTPUT_DIR, filename);

      fs.writeFileSync(filePath, buffer);

      let output = `Imagen generada: ${filePath}\n`;
      output += `Tamaño: ${size} | Calidad: ${quality} | Estilo: ${style}\n`;
      output += `Archivo: ${(buffer.length / 1024).toFixed(0)} KB\n`;
      if (revisedPrompt && revisedPrompt !== prompt) {
        output += `\nPrompt refinado por DALL-E:\n${revisedPrompt}`;
      }

      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: '', error: `Error generando imagen: ${err.message}` };
    }
  }
}
