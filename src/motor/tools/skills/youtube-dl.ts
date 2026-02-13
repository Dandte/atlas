// ═══════════════════════════════════════
// ATLAS — Skill: YouTube Downloader
// Download video/audio via yt-dlp CLI
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';

const OUTPUT_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'data', 'downloads');

export class YouTubeDlTool implements Tool {
  definition = {
    name: 'youtube_dl',
    description:
      'Descargar videos o audio de YouTube y otras plataformas (Twitter, Instagram, TikTok, etc.). ' +
      'Usar cuando digan "bajá este video", "descargá el audio", "bajá de YouTube".',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['video', 'audio', 'info'],
          description: 'video: descargar video, audio: solo audio (MP3), info: metadata sin descargar',
        },
        url: {
          type: 'string',
          description: 'URL del video a descargar',
        },
        quality: {
          type: 'string',
          enum: ['best', '1080', '720', '480', '360'],
          description: 'Calidad del video. Default: best',
        },
        filename: {
          type: 'string',
          description: 'Nombre del archivo (sin extensión). Default: título del video',
        },
      },
      required: ['url'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const url = String(params.url || '');
    if (!url) return { success: false, output: '', error: 'Necesito la URL del video.' };

    const action = String(params.action || 'video');

    // Check yt-dlp is installed
    const ytdlp = await this.findYtDlp();
    if (!ytdlp) {
      return {
        success: false, output: '',
        error: 'yt-dlp no encontrado. Instalalo:\n  Windows: winget install yt-dlp\n  Mac: brew install yt-dlp\n  Linux: pip install yt-dlp',
      };
    }

    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    try {
      switch (action) {
        case 'info':
          return this.getInfo(ytdlp, url);
        case 'audio':
          return this.downloadAudio(ytdlp, url, params);
        case 'video':
        default:
          return this.downloadVideo(ytdlp, url, params);
      }
    } catch (err: any) {
      return { success: false, output: '', error: `Error: ${err.message}` };
    }
  }

  private async findYtDlp(): Promise<string | null> {
    const candidates = ['yt-dlp', 'yt-dlp.exe'];
    for (const cmd of candidates) {
      try {
        await this.run(`${cmd} --version`);
        return cmd;
      } catch { /* not found */ }
    }
    return null;
  }

  private async getInfo(ytdlp: string, url: string): Promise<ToolResult> {
    const cmd = `${ytdlp} --dump-json --no-download "${url}"`;
    const result = await this.run(cmd, 30000);
    const data = JSON.parse(result);

    const duration = data.duration || 0;
    const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

    let output = `📹 ${data.title || 'Sin título'}\n`;
    output += `Canal: ${data.uploader || data.channel || '?'}\n`;
    output += `Duración: ${fmt(duration)}\n`;
    output += `Vistas: ${(data.view_count || 0).toLocaleString()}\n`;
    output += `Fecha: ${data.upload_date || '?'}\n`;
    if (data.description) {
      output += `\nDescripción:\n${data.description.substring(0, 300)}${data.description.length > 300 ? '...' : ''}`;
    }

    return { success: true, output };
  }

  private async downloadVideo(ytdlp: string, url: string, params: Record<string, unknown>): Promise<ToolResult> {
    const quality = String(params.quality || 'best');
    const filenameTemplate = params.filename
      ? `${String(params.filename)}.%(ext)s`
      : '%(title)s.%(ext)s';

    let formatOpt = '-f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"';
    if (quality !== 'best') {
      formatOpt = `-f "bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${quality}]/best"`;
    }

    const outputPath = path.join(OUTPUT_DIR, filenameTemplate);
    const cmd = `${ytdlp} ${formatOpt} --merge-output-format mp4 -o "${outputPath}" "${url}"`;

    const result = await this.run(cmd, 300000); // 5 min timeout

    // Find the downloaded file
    const downloaded = this.findLatestFile(OUTPUT_DIR, ['.mp4', '.mkv', '.webm']);

    let output = 'Video descargado.\n';
    if (downloaded) {
      const size = fs.statSync(downloaded).size;
      output = `Video descargado: ${downloaded}\nTamaño: ${(size / 1024 / 1024).toFixed(1)} MB`;
    } else {
      output += result.substring(0, 300);
    }

    return { success: true, output };
  }

  private async downloadAudio(ytdlp: string, url: string, params: Record<string, unknown>): Promise<ToolResult> {
    const filenameTemplate = params.filename
      ? `${String(params.filename)}.%(ext)s`
      : '%(title)s.%(ext)s';

    const outputPath = path.join(OUTPUT_DIR, filenameTemplate);
    const cmd = `${ytdlp} -x --audio-format mp3 --audio-quality 0 -o "${outputPath}" "${url}"`;

    const result = await this.run(cmd, 300000);

    const downloaded = this.findLatestFile(OUTPUT_DIR, ['.mp3', '.m4a', '.opus', '.wav']);

    let output = 'Audio descargado.\n';
    if (downloaded) {
      const size = fs.statSync(downloaded).size;
      output = `Audio descargado: ${downloaded}\nTamaño: ${(size / 1024 / 1024).toFixed(1)} MB`;
    } else {
      output += result.substring(0, 300);
    }

    return { success: true, output };
  }

  private findLatestFile(dir: string, extensions: string[]): string | null {
    try {
      const files = fs.readdirSync(dir)
        .filter(f => extensions.some(ext => f.toLowerCase().endsWith(ext)))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      return files[0] ? path.join(dir, files[0].name) : null;
    } catch { return null; }
  }

  private run(cmd: string, timeout = 15000): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(cmd, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
  }
}
