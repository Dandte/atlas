// ═══════════════════════════════════════
// ATLAS — Skill: URL Shortener
// Shorten URLs using free APIs (no key needed)
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';

export class UrlShortenerTool implements Tool {
  definition = {
    name: 'shorten_url',
    description:
      'Acortar URLs largos. Usa servicios gratuitos. ' +
      'Usar cuando digan "acortá este link", "hacé un link corto", "shorten".',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'URL a acortar',
        },
        service: {
          type: 'string',
          enum: ['isgd', 'vgd', 'tinyurl', 'clckru'],
          description: 'Servicio a usar. Default: isgd',
        },
      },
      required: ['url'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const url = String(params.url || '');
    if (!url) return { success: false, output: '', error: 'Necesito una URL para acortar.' };

    if (!url.match(/^https?:\/\//)) {
      return { success: false, output: '', error: 'La URL debe empezar con http:// o https://' };
    }

    const service = String(params.service || 'isgd');

    const services: Record<string, () => Promise<string>> = {
      isgd: () => this.fetchText(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`),
      vgd: () => this.fetchText(`https://v.gd/create.php?format=simple&url=${encodeURIComponent(url)}`),
      tinyurl: () => this.fetchText(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`),
      clckru: async () => {
        const resp = await fetch(`https://clck.ru/--?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(10000) });
        return resp.text();
      },
    };

    // Try requested service first, then fallback
    const order = [service, ...Object.keys(services).filter(s => s !== service)];

    for (const svc of order) {
      if (!services[svc]) continue;
      try {
        const short = await services[svc]();
        if (short && short.startsWith('http')) {
          return {
            success: true,
            output: `URL acortada (${svc}):\n  ${url}\n  → ${short.trim()}`,
          };
        }
      } catch { /* try next */ }
    }

    return { success: false, output: '', error: 'Ningún servicio de acortamiento respondió. Intentá más tarde.' };
  }

  private async fetchText(apiUrl: string): Promise<string> {
    const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
  }
}
