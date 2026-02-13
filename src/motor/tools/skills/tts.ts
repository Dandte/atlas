// ═══════════════════════════════════════
// ATLAS — Skill: Text-to-Speech
// OpenAI TTS + ElevenLabs support
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';
import { config } from '../../../config/config';
import path from 'path';
import fs from 'fs';

const OUTPUT_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'data', 'audio', 'tts');

export class TTSTool implements Tool {
  definition = {
    name: 'tts',
    description:
      'Convertir texto a audio (MP3). Genera archivos de voz usando OpenAI TTS o ElevenLabs. ' +
      'Usar cuando digan "leé esto en voz alta", "generá un audio", "convertí a voz".',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'Texto a convertir en audio',
        },
        voice: {
          type: 'string',
          description:
            'OpenAI: alloy, echo, fable, onyx, nova (default), shimmer. ' +
            'ElevenLabs: voice ID o nombre. Default: segun provider configurado.',
        },
        provider: {
          type: 'string',
          enum: ['openai', 'elevenlabs'],
          description: 'Proveedor TTS. Default: segun TTS_PROVIDER en config.',
        },
        model: {
          type: 'string',
          description:
            'OpenAI: tts-1 (rápido) o tts-1-hd (HD). ' +
            'ElevenLabs: eleven_multilingual_v2 (default), eleven_turbo_v2, etc.',
        },
        speed: {
          type: 'number',
          description: 'Velocidad (solo OpenAI): 0.25-4.0. Default: 1.0',
        },
        stability: {
          type: 'number',
          description: 'Estabilidad de voz (solo ElevenLabs): 0.0-1.0. Default: 0.5',
        },
        similarity: {
          type: 'number',
          description: 'Similitud de voz (solo ElevenLabs): 0.0-1.0. Default: 0.75',
        },
        filename: {
          type: 'string',
          description: 'Nombre del archivo (sin extensión). Default: auto-generado',
        },
      },
      required: ['text'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const text = String(params.text || '');
    if (!text) return { success: false, output: '', error: 'Necesito texto para convertir a audio.' };

    // Determine provider
    const provider = String(params.provider || config.ttsProvider || 'openai').trim();

    if (provider === 'elevenlabs') {
      return this.executeElevenLabs(text, params);
    }
    return this.executeOpenAI(text, params);
  }

  // ── OpenAI TTS ──

  private async executeOpenAI(text: string, params: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { success: false, output: '', error: 'OPENAI_API_KEY no configurado. Se necesita para TTS.' };
    }

    if (text.length > 4096) {
      return { success: false, output: '', error: 'El texto es muy largo (máx 4096 caracteres). Dividilo en partes.' };
    }

    const voice = String(params.voice || config.ttsDefaultVoice || 'nova');
    const model = String(params.model || 'tts-1');
    const speed = Math.max(0.25, Math.min(4.0, Number(params.speed || 1.0)));

    this.ensureOutputDir();

    try {
      const resp = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: text, voice, speed, response_format: 'mp3' }),
        signal: AbortSignal.timeout(60000),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as any;
        return { success: false, output: '', error: `TTS error: ${err.error?.message || resp.statusText}` };
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      const filePath = this.saveFile(buffer, params.filename);
      const durationEstimate = Math.round(text.length / (150 * speed / 60));

      let output = `Audio generado: ${filePath}\n`;
      output += `Provider: OpenAI | Voz: ${voice} | Modelo: ${model} | Velocidad: ${speed}x\n`;
      output += `Tamaño: ${(buffer.length / 1024).toFixed(0)} KB | ~${durationEstimate}s\n`;
      output += `Texto: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`;

      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: '', error: `Error TTS OpenAI: ${err.message}` };
    }
  }

  // ── ElevenLabs TTS ──

  private async executeElevenLabs(text: string, params: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = config.elevenlabsApiKey;
    if (!apiKey) {
      return { success: false, output: '', error: 'ELEVENLABS_API_KEY no configurado.' };
    }

    if (text.length > 5000) {
      return { success: false, output: '', error: 'El texto es muy largo (máx 5000 caracteres para ElevenLabs).' };
    }

    const voiceId = String(params.voice || config.elevenlabsVoiceId || '');
    if (!voiceId) {
      return { success: false, output: '', error: 'Se requiere voice ID para ElevenLabs. Configura ELEVENLABS_VOICE_ID o pasa voice.' };
    }

    const modelId = String(params.model || config.elevenlabsModelId || 'eleven_multilingual_v2');
    const stability = Math.max(0, Math.min(1, Number(params.stability ?? 0.5)));
    const similarity = Math.max(0, Math.min(1, Number(params.similarity ?? 0.75)));

    this.ensureOutputDir();

    try {
      const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: {
            stability,
            similarity_boost: similarity,
          },
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as any;
        const detail = err.detail?.message || err.detail || resp.statusText;
        return { success: false, output: '', error: `ElevenLabs error: ${detail}` };
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      const filePath = this.saveFile(buffer, params.filename);
      const durationEstimate = Math.round(text.length / 15); // ~15 chars per second speaking

      let output = `Audio generado: ${filePath}\n`;
      output += `Provider: ElevenLabs | Voice: ${voiceId} | Modelo: ${modelId}\n`;
      output += `Estabilidad: ${stability} | Similitud: ${similarity}\n`;
      output += `Tamaño: ${(buffer.length / 1024).toFixed(0)} KB | ~${durationEstimate}s\n`;
      output += `Texto: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`;

      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: '', error: `Error TTS ElevenLabs: ${err.message}` };
    }
  }

  // ── Helpers ──

  private ensureOutputDir(): void {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
  }

  private saveFile(buffer: Buffer, filename: unknown): string {
    const baseName = filename
      ? String(filename).replace(/[^a-zA-Z0-9-_]/g, '')
      : `tts-${Date.now()}`;
    const filePath = path.join(OUTPUT_DIR, `${baseName}.mp3`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }
}
