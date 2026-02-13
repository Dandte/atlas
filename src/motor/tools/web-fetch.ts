// ═══════════════════════════════════════
// ATLAS — Web Fetch Tool
// Fetch and extract content from URLs
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../types';
import logger from '../../utils/logger';

export class WebFetchTool implements Tool {
  definition = {
    name: 'web_fetch',
    description: 'Fetch the content of a web page or API endpoint. Use after web_search to read a full page, or to query public APIs. Strips HTML tags and returns readable text.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'Full URL to fetch',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST'],
          description: 'HTTP method (default GET)',
        },
        headers: {
          type: 'string',
          description: 'Additional headers as JSON string (optional)',
        },
        body: {
          type: 'string',
          description: 'Request body for POST (optional)',
        },
      },
      required: ['url'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const url = params.url as string;
    const method = (params.method as string) || 'GET';
    const headersStr = params.headers as string | undefined;
    const body = params.body as string | undefined;

    try {
      // Validate URL
      const parsed = new URL(url);

      // SSRF protection: block internal/private IPs and hostnames
      const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];
      const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // strip brackets from IPv6
      if (blockedHosts.includes(hostname)) {
        return { success: false, output: '', error: 'Acceso a hosts internos bloqueado por seguridad' };
      }
      // Block private IP ranges: 10.x, 172.16-31.x, 192.168.x, 169.254.x (link-local)
      const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (ipMatch) {
        const [, a, b] = ipMatch.map(Number);
        if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
          return { success: false, output: '', error: 'Acceso a redes privadas bloqueado por seguridad' };
        }
      }
      // Block file:// and other dangerous protocols
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { success: false, output: '', error: `Protocolo no permitido: ${parsed.protocol}` };
      }

      // Build headers
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ATLAS/0.1',
        'Accept': 'text/html,application/json,text/plain,*/*',
      };

      if (headersStr) {
        try {
          const extra = JSON.parse(headersStr) as Record<string, string>;
          Object.assign(headers, extra);
        } catch {
          return { success: false, output: '', error: 'Headers inválidos: no es JSON válido' };
        }
      }

      // Build request options
      const opts: RequestInit = {
        method,
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      };

      if (body && method === 'POST') {
        opts.body = body;
        if (!headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }
      }

      logger.debug(`Web fetch: ${method} ${url}`);
      const res = await fetch(url, opts);

      if (!res.ok) {
        return {
          success: false,
          output: '',
          error: `HTTP ${res.status} ${res.statusText}`,
        };
      }

      const contentType = res.headers.get('content-type') ?? '';
      let content: string;

      if (contentType.includes('application/json')) {
        // JSON — format nicely
        const json = await res.json();
        content = JSON.stringify(json, null, 2);
      } else {
        content = await res.text();

        if (contentType.includes('text/html')) {
          // HTML — strip tags and extract readable text
          content = this.stripHtml(content);
        }
      }

      // Truncate if too large
      if (content.length > 50000) {
        content = content.substring(0, 50000) + '\n\n... [contenido truncado a 50KB]';
      }

      return {
        success: true,
        output: content || '(respuesta vacía)',
      };
    } catch (err) {
      if (err instanceof TypeError && err.message.includes('Invalid URL')) {
        return { success: false, output: '', error: `URL inválida: ${url}` };
      }
      return {
        success: false,
        output: '',
        error: `Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** Strip HTML tags and extract readable text */
  private stripHtml(html: string): string {
    // Remove script and style blocks entirely
    let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
    text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
    text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
    text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');

    // Convert common elements to text equivalents
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<\/div>/gi, '\n');
    text = text.replace(/<\/h[1-6]>/gi, '\n\n');
    text = text.replace(/<li[^>]*>/gi, '• ');
    text = text.replace(/<\/li>/gi, '\n');
    text = text.replace(/<\/tr>/gi, '\n');
    text = text.replace(/<td[^>]*>/gi, '\t');

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    // Strip all remaining tags
    text = text.replace(/<[^>]+>/g, '');

    // Decode common HTML entities
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&#x27;/g, "'");
    text = text.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)));

    // Clean up whitespace
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.trim();

    if (title) {
      text = `Título: ${title}\n\n${text}`;
    }

    return text;
  }
}
