// ═══════════════════════════════════════
// ATLAS — Skill: Quick Translator
// Uses MyMemory API (free, no key needed)
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';

const LANG_CODES: Record<string, string> = {
  es: 'es', español: 'es', spanish: 'es',
  en: 'en', ingles: 'en', inglés: 'en', english: 'en',
  fr: 'fr', frances: 'fr', francés: 'fr', french: 'fr',
  pt: 'pt', portugues: 'pt', portugués: 'pt', portuguese: 'pt',
  de: 'de', aleman: 'de', alemán: 'de', german: 'de',
  it: 'it', italiano: 'it', italian: 'it',
  zh: 'zh', chino: 'zh', chinese: 'zh',
  ja: 'ja', japones: 'ja', japonés: 'ja', japanese: 'ja',
  ko: 'ko', coreano: 'ko', korean: 'ko',
};

export class TranslateTool implements Tool {
  definition = {
    name: 'translate',
    description:
      'Traducir texto entre idiomas. Soporta español, inglés, francés, portugués, alemán, italiano, chino, japonés, coreano. ' +
      'Usar cuando digan "traduce", "cómo se dice", "translate", "en inglés", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'Texto a traducir',
        },
        from: {
          type: 'string',
          description: 'Idioma origen: "es", "en", "fr", "pt", "de", "it", "zh", "ja", "ko". Default: auto-detect',
        },
        to: {
          type: 'string',
          description: 'Idioma destino. Default: si el texto está en español → "en", si está en otro idioma → "es"',
        },
      },
      required: ['text'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const text = String(params.text || '');
    if (!text) return { success: false, output: '', error: 'Necesito texto para traducir.' };

    let fromLang = params.from ? this.resolveLang(String(params.from)) : null;
    let toLang = params.to ? this.resolveLang(String(params.to)) : null;

    // Auto-detect direction
    if (!fromLang && !toLang) {
      const isSpanish = /[áéíóúñ¿¡]/.test(text) || /\b(que|para|con|por|los|las|del|como|esto|eso)\b/i.test(text);
      fromLang = isSpanish ? 'es' : 'en';
      toLang = isSpanish ? 'en' : 'es';
    } else if (!fromLang) {
      fromLang = toLang === 'es' ? 'en' : 'es';
    } else if (!toLang) {
      toLang = fromLang === 'es' ? 'en' : 'es';
    }

    try {
      const encoded = encodeURIComponent(text);
      const url = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=${fromLang}|${toLang}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await resp.json() as any;

      if (data.responseStatus !== 200 && data.responseStatus !== '200') {
        return { success: false, output: '', error: `Error de traducción: ${data.responseDetails || 'Unknown error'}` };
      }

      const translated = data.responseData?.translatedText || '';
      if (!translated) {
        return { success: false, output: '', error: 'No se obtuvo traducción.' };
      }

      // Get alternative translations if available
      const alternatives: string[] = [];
      if (data.matches && Array.isArray(data.matches)) {
        for (const match of data.matches.slice(0, 3)) {
          if (match.translation && match.translation !== translated && match.quality && parseInt(match.quality) > 50) {
            alternatives.push(match.translation);
          }
        }
      }

      let output = `${fromLang!.toUpperCase()} → ${toLang!.toUpperCase()}\n\n"${text}"\n→ "${translated}"`;
      if (alternatives.length > 0) {
        output += `\n\nAlternativas:\n${alternatives.map(a => `  - "${a}"`).join('\n')}`;
      }

      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: '', error: `Error: ${err.message}` };
    }
  }

  private resolveLang(input: string): string {
    const lower = input.toLowerCase().trim();
    return LANG_CODES[lower] || lower.substring(0, 2);
  }
}
