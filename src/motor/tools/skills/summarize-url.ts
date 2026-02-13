// ═══════════════════════════════════════
// ATLAS — Skill: Summarize URL
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';

export class SummarizeUrlTool implements Tool {
  definition = {
    name: 'summarize_url',
    description: 'Leer y resumir el contenido de una página web o artículo. Usar cuando pasen un link y pidan resumen, o cuando ATLAS necesite entender contenido de una URL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'URL de la página a resumir',
        },
        focus: {
          type: 'string',
          description: 'En qué enfocarse del contenido (opcional)',
        },
      },
      required: ['url'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const url = params.url as string;
    const focus = params.focus as string | undefined;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ATLAS/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        return { success: false, output: '', error: `HTTP ${response.status}: ${response.statusText}` };
      }

      let text = await response.text();

      // Strip HTML
      text = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();

      if (text.length > 4000) {
        text = text.substring(0, 4000) + '\n\n[...contenido truncado...]';
      }

      const focusNote = focus ? `\n\n(Enfoque solicitado: ${focus})` : '';

      return {
        success: true,
        output: `Contenido de ${url}:\n\n${text}${focusNote}`,
      };
    } catch (err: any) {
      return { success: false, output: '', error: `Error accediendo a ${url}: ${err.message}` };
    }
  }
}
