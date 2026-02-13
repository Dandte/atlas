// ═══════════════════════════════════════
// ATLAS — Skill: Voice Speech-to-Text
// Transcribe audio via OpenAI Whisper or Groq (free)
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';
import { config } from '../../../config/config';
import fs from 'fs';
import path from 'path';

interface STTProviderConfig {
  apiKey: string;
  url: string;
  model: string;
  label: string;
}

function getSTTProvider(): STTProviderConfig | null {
  const provider = config.sttProvider || 'openai';

  if (provider === 'groq' && config.groqApiKey) {
    return {
      apiKey: config.groqApiKey,
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      model: 'whisper-large-v3-turbo',
      label: 'Groq',
    };
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      apiKey: process.env.OPENAI_API_KEY,
      url: 'https://api.openai.com/v1/audio/transcriptions',
      model: 'whisper-1',
      label: 'OpenAI',
    };
  }

  // Fallback: try Groq even if provider is openai (free alternative)
  if (config.groqApiKey) {
    return {
      apiKey: config.groqApiKey,
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      model: 'whisper-large-v3-turbo',
      label: 'Groq (fallback)',
    };
  }

  return null;
}

export class VoiceSTTTool implements Tool {
  definition = {
    name: 'voice_stt',
    description:
      'Transcribir audio a texto usando Whisper (OpenAI o Groq). Soporta MP3, WAV, M4A, OGG, WEBM. ' +
      'Usar cuando recibas un archivo de audio o digan "transcribí este audio", "qué dice este audio".',
    input_schema: {
      type: 'object' as const,
      properties: {
        file: {
          type: 'string',
          description: 'Ruta al archivo de audio a transcribir',
        },
        language: {
          type: 'string',
          description: 'Idioma del audio (ISO 639-1): es, en, pt, fr, etc. Default: auto-detect',
        },
        translate: {
          type: 'boolean',
          description: 'Si true, traduce al inglés además de transcribir (solo OpenAI). Default: false',
        },
      },
      required: ['file'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const provider = getSTTProvider();
    if (!provider) {
      return {
        success: false, output: '',
        error: 'No hay proveedor STT configurado. Configurá OPENAI_API_KEY o GROQ_API_KEY (gratis en groq.com).',
      };
    }

    const filePath = String(params.file || '');
    if (!filePath) return { success: false, output: '', error: 'Necesito la ruta al archivo de audio.' };

    if (!fs.existsSync(filePath)) {
      return { success: false, output: '', error: `Archivo no encontrado: ${filePath}` };
    }

    const stat = fs.statSync(filePath);
    if (stat.size > 25 * 1024 * 1024) {
      return { success: false, output: '', error: 'Archivo muy grande (máx 25MB).' };
    }

    const ext = path.extname(filePath).toLowerCase();
    const supported = ['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm', '.ogg'];
    if (!supported.includes(ext)) {
      return { success: false, output: '', error: `Formato no soportado: ${ext}. Soportados: ${supported.join(', ')}` };
    }

    try {
      const translate = params.translate === true;

      // Translation only supported by OpenAI
      const endpoint = (translate && provider.label === 'OpenAI')
        ? 'https://api.openai.com/v1/audio/translations'
        : provider.url;

      const fileBuffer = fs.readFileSync(filePath);
      const blob = new Blob([fileBuffer], { type: `audio/${ext.substring(1)}` });

      // Reject audio too small (likely silence/noise, causes hallucination)
      if (fileBuffer.length < 5000) {
        return { success: false, output: '', error: 'Audio demasiado corto. Grabá al menos 1 segundo.' };
      }

      const formData = new FormData();
      formData.append('file', blob, path.basename(filePath));
      formData.append('model', provider.model);
      formData.append('response_format', 'verbose_json');
      formData.append('temperature', '0');
      formData.append('prompt', 'Este es un mensaje de voz en español.');

      if (params.language && !translate) {
        formData.append('language', String(params.language));
      }

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${provider.apiKey}` },
        body: formData,
        signal: AbortSignal.timeout(120000),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as any;
        return { success: false, output: '', error: `${provider.label} STT error: ${err.error?.message || resp.statusText}` };
      }

      const data = await resp.json() as any;

      let output = `Provider: ${provider.label}\n`;
      if (data.language) output += `Idioma detectado: ${data.language}\n`;
      if (data.duration) output += `Duración: ${Math.round(data.duration)}s\n`;
      output += `\nTranscripción:\n${data.text}`;

      if (translate && data.text) {
        output += '\n\n(Traducido al inglés)';
      }

      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: '', error: `Error transcribiendo (${provider.label}): ${err.message}` };
    }
  }
}

/**
 * Utility function for channel integration.
 * Call from telegram.ts / whatsapp.ts when receiving voice messages.
 */
export async function transcribeAudioFile(filePath: string, language?: string): Promise<string | null> {
  const provider = getSTTProvider();
  if (!provider || !fs.existsSync(filePath)) return null;

  try {
    const ext = path.extname(filePath).toLowerCase();
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: `audio/${ext.substring(1)}` });

    if (fileBuffer.length < 5000) return null;

    const formData = new FormData();
    formData.append('file', blob, path.basename(filePath));
    formData.append('model', provider.model);
    formData.append('temperature', '0');
    formData.append('prompt', 'Este es un mensaje de voz en español.');
    if (language) formData.append('language', language);

    const resp = await fetch(provider.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${provider.apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(60000),
    });

    if (!resp.ok) return null;
    const data = await resp.json() as any;
    return data.text || null;
  } catch {
    return null;
  }
}
