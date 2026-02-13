// ═══════════════════════════════════════
// ATLAS — Transcription Tool
// Audio/Video transcription via Whisper (OpenAI/Groq)
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';
import fs from 'fs';
import path from 'path';
import os from 'os';

export class TranscribeTool implements Tool {
  definition: ToolDefinition = {
    name: 'transcribe',
    description: 'Transcribir audio/video a texto usando Whisper (OpenAI o Groq). Soporta archivos locales y URLs de YouTube.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Ruta al archivo de audio/video (mp3, wav, m4a, mp4, webm, ogg)',
        },
        url: {
          type: 'string',
          description: 'URL de YouTube o enlace directo a audio/video',
        },
        language: {
          type: 'string',
          description: 'Código de idioma ISO 639-1 (ej: es, en, pt). Default: auto-detect',
        },
        format: {
          type: 'string',
          enum: ['text', 'srt', 'vtt', 'verbose'],
          description: 'Formato de salida: text (plano), srt (subtítulos), vtt (WebVTT), verbose (con timestamps)',
        },
        translate: {
          type: 'boolean',
          description: 'Traducir a inglés automáticamente (solo OpenAI)',
        },
      },
      required: [],
    },
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const filePath = params.file_path ? String(params.file_path) : null;
    const url = params.url ? String(params.url) : null;
    const language = params.language ? String(params.language) : undefined;
    const format = String(params.format || 'text');
    const translate = !!params.translate;

    if (!filePath && !url) {
      return { success: false, output: '', error: 'Se requiere file_path o url.' };
    }

    if (!config.openaiApiKey && !config.groqApiKey) {
      return { success: false, output: '', error: 'Se requiere OPENAI_API_KEY o GROQ_API_KEY para transcripción.' };
    }

    try {
      let audioPath: string;
      let cleanup = false;

      if (url) {
        // Download audio from URL
        audioPath = await this.downloadAudio(url);
        cleanup = true;
      } else {
        const resolved = filePath!.startsWith('~')
          ? filePath!.replace('~', os.homedir())
          : path.resolve(filePath!);

        if (!fs.existsSync(resolved)) {
          return { success: false, output: '', error: `Archivo no encontrado: ${resolved}` };
        }
        audioPath = resolved;
      }

      try {
        let result: string;

        if (config.groqApiKey && config.sttProvider === 'groq') {
          result = await this.transcribeWithGroq(audioPath, language, format);
        } else {
          result = await this.transcribeWithOpenAI(audioPath, language, format, translate);
        }

        return { success: true, output: result };
      } finally {
        if (cleanup && fs.existsSync(audioPath)) {
          fs.unlinkSync(audioPath);
        }
      }
    } catch (err: any) {
      logger.error('Transcription failed', { error: err });
      return { success: false, output: '', error: `Error de transcripción: ${err.message}` };
    }
  }

  private async downloadAudio(url: string): Promise<string> {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `atlas_transcribe_${Date.now()}.mp3`);

    // Check if it's a YouTube URL
    if (/youtube\.com|youtu\.be/i.test(url)) {
      // Try yt-dlp first, then youtube-dl
      const { execSync } = require('child_process');
      try {
        execSync(
          `yt-dlp -x --audio-format mp3 --audio-quality 5 -o "${tmpFile.replace('.mp3', '.%(ext)s')}" "${url}"`,
          { timeout: 120000, stdio: 'pipe' }
        );
        // yt-dlp may add extension
        const actualFile = tmpFile.replace('.mp3', '.mp3');
        if (fs.existsSync(actualFile)) return actualFile;

        // Check for other formats
        const dir = path.dirname(tmpFile);
        const base = path.basename(tmpFile, '.mp3');
        const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
        if (files.length > 0) return path.join(dir, files[0]);

        throw new Error('yt-dlp no generó archivo de salida');
      } catch (err: any) {
        if (/not found|no reconoce/i.test(err.message)) {
          throw new Error('yt-dlp no está instalado. Instalálo con: pip install yt-dlp');
        }
        throw err;
      }
    }

    // Direct URL download
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(tmpFile, buffer);
    return tmpFile;
  }

  private async transcribeWithOpenAI(
    filePath: string,
    language?: string,
    format: string = 'text',
    translate: boolean = false
  ): Promise<string> {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey: config.openaiApiKey });

    const fileStream = fs.createReadStream(filePath);

    const responseFormat = format === 'srt' ? 'srt'
      : format === 'vtt' ? 'vtt'
      : format === 'verbose' ? 'verbose_json'
      : 'text';

    const endpoint = translate ? 'translations' : 'transcriptions';

    const params: any = {
      file: fileStream,
      model: 'whisper-1',
      response_format: responseFormat,
    };

    if (language && !translate) {
      params.language = language;
    }

    const result = translate
      ? await client.audio.translations.create(params)
      : await client.audio.transcriptions.create(params);

    if (format === 'verbose' && typeof result === 'object') {
      const segments = result.segments || [];
      const lines = segments.map((s: any) => {
        const start = this.formatTimestamp(s.start);
        const end = this.formatTimestamp(s.end);
        return `[${start} → ${end}] ${s.text}`;
      });
      return `Idioma detectado: ${result.language || 'unknown'}\nDuración: ${result.duration ? Math.round(result.duration) + 's' : 'unknown'}\n\n${lines.join('\n')}`;
    }

    return typeof result === 'string' ? result : result.text || JSON.stringify(result);
  }

  private async transcribeWithGroq(
    filePath: string,
    language?: string,
    format: string = 'text'
  ): Promise<string> {
    const Groq = require('groq-sdk');
    const client = new Groq({ apiKey: config.groqApiKey });

    const fileStream = fs.createReadStream(filePath);

    const responseFormat = format === 'srt' ? 'srt'
      : format === 'vtt' ? 'vtt'
      : format === 'verbose' ? 'verbose_json'
      : 'text';

    const params: any = {
      file: fileStream,
      model: 'whisper-large-v3',
      response_format: responseFormat,
    };

    if (language) {
      params.language = language;
    }

    const result = await client.audio.transcriptions.create(params);

    if (format === 'verbose' && typeof result === 'object') {
      const segments = result.segments || [];
      const lines = segments.map((s: any) => {
        const start = this.formatTimestamp(s.start);
        const end = this.formatTimestamp(s.end);
        return `[${start} → ${end}] ${s.text}`;
      });
      return `Idioma: ${result.language || 'unknown'}\nDuración: ${result.duration ? Math.round(result.duration) + 's' : 'unknown'}\n\n${lines.join('\n')}`;
    }

    return typeof result === 'string' ? result : result.text || JSON.stringify(result);
  }

  private formatTimestamp(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  }
}
