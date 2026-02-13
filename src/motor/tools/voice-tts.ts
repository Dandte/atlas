// ═══════════════════════════════════════
// ATLAS — Voice TTS Tool
// Text-to-Speech via OpenAI, ElevenLabs, or edge-tts
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export class VoiceTTSTool implements Tool {
  definition: ToolDefinition = {
    name: 'voice_tts',
    description: 'Convierte texto a voz (Text-to-Speech). Soporta OpenAI TTS (alloy, echo, fable, onyx, nova, shimmer), ElevenLabs, y edge-tts (gratis). Devuelve ruta al archivo de audio generado.',
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Texto a convertir en voz',
        },
        provider: {
          type: 'string',
          enum: ['openai', 'elevenlabs', 'edge'],
          description: 'Proveedor TTS. Default: openai si hay API key, sino edge-tts (gratis)',
        },
        voice: {
          type: 'string',
          description: 'Voz a usar. OpenAI: alloy/echo/fable/onyx/nova/shimmer. ElevenLabs: voice_id. Edge: es-CO-GonzaloNeural, es-CO-SalomeNeural, en-US-GuyNeural, etc.',
        },
        model: {
          type: 'string',
          enum: ['tts-1', 'tts-1-hd'],
          description: 'Modelo OpenAI. tts-1 (rápido) o tts-1-hd (alta calidad). Default: tts-1',
        },
        speed: {
          type: 'number',
          description: 'Velocidad: 0.25 a 4.0 (solo OpenAI). Default: 1.0',
        },
        format: {
          type: 'string',
          enum: ['mp3', 'opus', 'aac', 'flac', 'wav'],
          description: 'Formato de salida. Default: mp3',
        },
      },
      required: ['text'],
    },
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const text = String(params.text || '').trim();
    if (!text) {
      return { success: false, output: '', error: 'Se requiere texto para generar voz' };
    }

    const format = String(params.format || 'mp3');
    const outputDir = path.join(config.dataDir, 'audio');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const filename = `tts_${Date.now()}.${format}`;
    const outputPath = path.join(outputDir, filename);

    // Auto-detect provider
    let provider = String(params.provider || '');
    if (!provider) {
      if (config.openaiApiKey) provider = 'openai';
      else if ((config as any).elevenLabsApiKey) provider = 'elevenlabs';
      else provider = 'edge';
    }

    try {
      switch (provider) {
        case 'openai':
          return await this.openaiTTS(text, params, outputPath, format);
        case 'elevenlabs':
          return await this.elevenLabsTTS(text, params, outputPath);
        case 'edge':
          return await this.edgeTTS(text, params, outputPath);
        default:
          return { success: false, output: '', error: `Proveedor desconocido: ${provider}` };
      }
    } catch (err: any) {
      logger.error('TTS failed', { error: err, provider });
      return { success: false, output: '', error: `Error TTS (${provider}): ${err.message}` };
    }
  }

  private async openaiTTS(
    text: string, params: Record<string, unknown>,
    outputPath: string, format: string
  ): Promise<ToolResult> {
    if (!config.openaiApiKey) {
      return { success: false, output: '', error: 'OPENAI_API_KEY requerida para OpenAI TTS' };
    }

    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey: config.openaiApiKey });

    const voice = String(params.voice || 'nova');
    const model = String(params.model || 'tts-1');
    const speed = Number(params.speed || 1.0);

    logger.info('Generating TTS with OpenAI', { voice, model, textLength: text.length });

    const response = await client.audio.speech.create({
      model,
      voice,
      input: text.substring(0, 4096), // OpenAI limit
      speed: Math.max(0.25, Math.min(4.0, speed)),
      response_format: format === 'wav' ? 'wav' : format === 'flac' ? 'flac' : format === 'opus' ? 'opus' : format === 'aac' ? 'aac' : 'mp3',
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);

    const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
    return {
      success: true,
      output: `Audio generado con OpenAI TTS.\nVoz: ${voice} | Modelo: ${model} | Velocidad: ${speed}x\nArchivo: ${outputPath} (${sizeMB} MB)\nTexto: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`,
    };
  }

  private async elevenLabsTTS(
    text: string, params: Record<string, unknown>, outputPath: string
  ): Promise<ToolResult> {
    const apiKey = (config as any).elevenLabsApiKey;
    if (!apiKey) {
      return { success: false, output: '', error: 'ELEVENLABS_API_KEY requerida' };
    }

    const voiceId = String(params.voice || '21m00Tcm4TlvDq8ikWAM'); // Rachel default
    const https = require('https');

    const body = JSON.stringify({
      text: text.substring(0, 5000),
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.5 },
    });

    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${voiceId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
          'Accept': 'audio/mpeg',
        },
      }, (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve({ success: false, output: '', error: `ElevenLabs API error: ${res.statusCode}` });
            return;
          }
          const buffer = Buffer.concat(chunks);
          fs.writeFileSync(outputPath, buffer);
          const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
          resolve({
            success: true,
            output: `Audio generado con ElevenLabs.\nVoice ID: ${voiceId}\nArchivo: ${outputPath} (${sizeMB} MB)`,
          });
        });
      });
      req.on('error', (err: any) => {
        resolve({ success: false, output: '', error: `ElevenLabs error: ${err.message}` });
      });
      req.write(body);
      req.end();
    });
  }

  private async edgeTTS(
    text: string, params: Record<string, unknown>, outputPath: string
  ): Promise<ToolResult> {
    const voice = String(params.voice || 'es-CO-GonzaloNeural');

    // edge-tts via Python package (pip install edge-tts)
    const safeText = text.replace(/"/g, '\\"').replace(/\n/g, ' ').substring(0, 5000);
    const cmd = `edge-tts --voice "${voice}" --text "${safeText}" --write-media "${outputPath}"`;

    try {
      execSync(cmd, { timeout: 30000, stdio: 'pipe' });

      if (!fs.existsSync(outputPath)) {
        return { success: false, output: '', error: 'edge-tts no generó archivo. Instalá con: pip install edge-tts' };
      }

      const stats = fs.statSync(outputPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      return {
        success: true,
        output: `Audio generado con edge-tts (gratis).\nVoz: ${voice}\nArchivo: ${outputPath} (${sizeMB} MB)\nTexto: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`,
      };
    } catch (err: any) {
      if (/not recognized|not found|command not found/i.test(err.message)) {
        return { success: false, output: '', error: 'edge-tts no instalado. Instalá con: pip install edge-tts' };
      }
      return { success: false, output: '', error: `edge-tts error: ${err.message}` };
    }
  }
}
