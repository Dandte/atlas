// ═══════════════════════════════════════
// ATLAS — Clipboard Tool
// Read/write system clipboard
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import logger from '../../utils/logger';
import { execSync } from 'child_process';

export class ClipboardTool implements Tool {
  definition: ToolDefinition = {
    name: 'clipboard',
    description: 'Lee y escribe el portapapeles del sistema (clipboard). Acciones: read (leer contenido actual), write (escribir texto), append (agregar al final del contenido actual).',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write', 'append'],
          description: 'Acción: read (leer), write (escribir/reemplazar), append (agregar al final)',
        },
        text: {
          type: 'string',
          description: 'Texto a copiar al clipboard (requerido para write/append)',
        },
      },
      required: ['action'],
    },
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || 'read');

    try {
      switch (action) {
        case 'read':
          return this.readClipboard();
        case 'write':
          return this.writeClipboard(String(params.text || ''));
        case 'append': {
          const current = this.getClipboardContent();
          const newText = current + (params.text ? '\n' + String(params.text) : '');
          return this.writeClipboard(newText);
        }
        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      logger.error('Clipboard operation failed', { error: err, action });
      return { success: false, output: '', error: `Error clipboard: ${err.message}` };
    }
  }

  private readClipboard(): ToolResult {
    const content = this.getClipboardContent();
    if (!content) {
      return { success: true, output: '(Clipboard vacío)' };
    }
    const lines = content.split('\n').length;
    const chars = content.length;
    return {
      success: true,
      output: `Contenido del clipboard (${chars} caracteres, ${lines} líneas):\n\n${content}`,
    };
  }

  private writeClipboard(text: string): ToolResult {
    if (!text) {
      return { success: false, output: '', error: 'Se requiere texto para escribir al clipboard' };
    }

    const platform = process.platform;

    if (platform === 'win32') {
      // Use PowerShell's Set-Clipboard for reliable Unicode support
      const encoded = Buffer.from(text, 'utf-8').toString('base64');
      execSync(
        `powershell -NoProfile -Command "[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encoded}')) | Set-Clipboard"`,
        { timeout: 5000, stdio: 'pipe' }
      );
    } else if (platform === 'darwin') {
      execSync('pbcopy', { input: text, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      // Linux — try xclip, xsel, wl-copy
      try {
        execSync('xclip -selection clipboard', { input: text, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        try {
          execSync('xsel --clipboard --input', { input: text, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch {
          execSync('wl-copy', { input: text, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
        }
      }
    }

    const lines = text.split('\n').length;
    return {
      success: true,
      output: `Copiado al clipboard: ${text.length} caracteres, ${lines} líneas.`,
    };
  }

  private getClipboardContent(): string {
    const platform = process.platform;

    try {
      if (platform === 'win32') {
        return execSync('powershell -NoProfile -Command "Get-Clipboard"', {
          timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } else if (platform === 'darwin') {
        return execSync('pbpaste', {
          timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } else {
        try {
          return execSync('xclip -selection clipboard -o', {
            timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
        } catch {
          return execSync('xsel --clipboard --output', {
            timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
        }
      }
    } catch {
      return '';
    }
  }
}
