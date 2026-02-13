// ═══════════════════════════════════════
// ATLAS — Web Search Tool
// DuckDuckGo, Brave Search, SearXNG
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export class WebSearchTool implements Tool {
  definition = {
    name: 'web_search',
    description: 'Search the internet for information. Use when you need current data, news, documentation, or anything you don\'t know. Returns titles, URLs, and snippets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        num_results: {
          type: 'number',
          description: 'Number of results to return (default 5, max 10)',
        },
      },
      required: ['query'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const query = params.query as string;
    const numResults = Math.min((params.num_results as number) || 5, 10);

    try {
      let results: SearchResult[];

      switch (config.searchEngine) {
        case 'brave':
          results = await this.searchBrave(query, numResults);
          break;
        case 'searxng':
          results = await this.searchSearXNG(query, numResults);
          break;
        case 'duckduckgo':
        default:
          results = await this.searchDuckDuckGo(query, numResults);
          break;
      }

      if (results.length === 0) {
        return { success: true, output: `No se encontraron resultados para: "${query}"` };
      }

      const formatted = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join('\n\n');

      return {
        success: true,
        output: `${results.length} resultado(s) para "${query}":\n\n${formatted}`,
      };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: `Error en búsqueda web: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** DuckDuckGo HTML scraping (free, no API key) */
  private async searchDuckDuckGo(query: string, numResults: number): Promise<SearchResult[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `q=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);

    const html = await res.text();
    const results: SearchResult[] = [];

    // Parse result blocks from DDG HTML
    // Results are in <div class="result ..."> blocks
    const resultBlocks = html.split(/class="result\s/g).slice(1);

    for (const block of resultBlocks) {
      if (results.length >= numResults) break;

      // Extract title and URL from <a class="result__a"
      const titleMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      if (!titleMatch) continue;

      let rawUrl = titleMatch[1];
      const title = titleMatch[2].replace(/<[^>]*>/g, '').trim();

      // DDG wraps URLs in a redirect — extract the actual URL
      const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        rawUrl = decodeURIComponent(uddgMatch[1]);
      }

      // Extract snippet from <a class="result__snippet"
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const snippet = snippetMatch
        ? snippetMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
        : '';

      if (title && rawUrl && !rawUrl.startsWith('/')) {
        results.push({ title, url: rawUrl, snippet });
      }
    }

    return results;
  }

  /** Brave Search API (needs API key) */
  private async searchBrave(query: string, numResults: number): Promise<SearchResult[]> {
    if (!config.braveSearchApiKey) {
      throw new Error('BRAVE_SEARCH_API_KEY no está configurado');
    }

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${numResults}`;

    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': config.braveSearchApiKey,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error(`Brave Search returned ${res.status}`);

    const data = await res.json() as {
      web?: { results?: Array<{ title: string; url: string; description: string }> };
    };

    return (data.web?.results ?? []).slice(0, numResults).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    }));
  }

  /** SearXNG self-hosted (needs SEARXNG_URL) */
  private async searchSearXNG(query: string, numResults: number): Promise<SearchResult[]> {
    const searxngUrl = config.searxngUrl;
    if (!searxngUrl) {
      throw new Error('SEARXNG_URL no está configurado');
    }

    const url = `${searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);

    const data = await res.json() as {
      results?: Array<{ title: string; url: string; content: string }>;
    };

    return (data.results ?? []).slice(0, numResults).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));
  }
}
