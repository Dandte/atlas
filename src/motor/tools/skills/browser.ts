// ═══════════════════════════════════════
// ATLAS — Skill: Browser Automation
// Puppeteer-based: navigate, screenshot, scrape, fill forms
// Requires: npm install puppeteer (optional — tool skips if not installed)
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';
import path from 'path';
import fs from 'fs';
import logger from '../../../utils/logger';

let puppeteer: any = null;
try {
  puppeteer = require('puppeteer');
} catch {
  try {
    puppeteer = require('puppeteer-core');
  } catch {
    // Not installed — tool will return error on use
  }
}

export class BrowserTool implements Tool {
  private browser: any = null;
  private page: any = null;
  private screenshotDir: string;

  definition = {
    name: 'browser',
    description:
      'Automatizar navegador web: abrir páginas, tomar screenshots, extraer texto/datos, hacer click, llenar formularios. ' +
      'Usar cuando pidan "abrí tal página", "screenshot de X URL", "sacá los precios de tal sitio", "llená el formulario".',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'screenshot', 'extract_text', 'extract_links', 'click', 'type', 'evaluate', 'close'],
          description: 'Acción: navigate=ir a URL, screenshot=captura, extract_text=sacar texto, extract_links=extraer links, click=click en selector, type=escribir en campo, evaluate=ejecutar JS, close=cerrar',
        },
        url: { type: 'string', description: 'URL a navegar (para navigate/screenshot)' },
        selector: { type: 'string', description: 'CSS selector (para click, type, extract)' },
        text: { type: 'string', description: 'Texto a escribir (para type)' },
        js: { type: 'string', description: 'JavaScript a ejecutar en la página (para evaluate)' },
        wait: { type: 'number', description: 'Milisegundos a esperar después de la acción. Default: 1000' },
        full_page: { type: 'boolean', description: 'Screenshot de página completa. Default: true' },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  constructor() {
    this.screenshotDir = path.join(process.cwd(), 'data', 'screenshots');
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    if (!puppeteer) {
      return {
        success: false, output: '',
        error: 'Puppeteer no está instalado. Ejecutá: npm install puppeteer',
      };
    }

    const action = params.action as string;
    const wait = (params.wait as number) || 1000;

    try {
      switch (action) {
        case 'navigate': return await this.navigate(params, wait);
        case 'screenshot': return await this.screenshot(params, wait);
        case 'extract_text': return await this.extractText(params);
        case 'extract_links': return await this.extractLinks(params);
        case 'click': return await this.click(params, wait);
        case 'type': return await this.typeText(params, wait);
        case 'evaluate': return await this.evaluate(params);
        case 'close': return await this.closeBrowser();
        default: return { success: false, output: '', error: `Acción no reconocida: ${action}` };
      }
    } catch (err: any) {
      return { success: false, output: '', error: `Browser error: ${err.message}` };
    }
  }

  private async ensureBrowser(): Promise<any> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1280, height: 800 });
      await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    }
    return this.page;
  }

  private async navigate(params: Record<string, unknown>, wait: number): Promise<ToolResult> {
    const url = String(params.url || '');
    if (!url) return { success: false, output: '', error: 'URL requerida.' };

    const page = await this.ensureBrowser();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    const title = await page.title();
    return { success: true, output: `Navegado a: ${url}\nTítulo: ${title}` };
  }

  private async screenshot(params: Record<string, unknown>, wait: number): Promise<ToolResult> {
    const url = params.url ? String(params.url) : null;
    const fullPage = params.full_page !== false;

    const page = await this.ensureBrowser();

    if (url) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }

    const filename = `screenshot_${Date.now()}.png`;
    const filepath = path.join(this.screenshotDir, filename);

    await page.screenshot({ path: filepath, fullPage });

    const title = await page.title();
    return {
      success: true,
      output: `Screenshot guardado: ${filepath}\nPágina: ${title}\nURL: ${page.url()}`,
    };
  }

  private async extractText(params: Record<string, unknown>): Promise<ToolResult> {
    const selector = params.selector ? String(params.selector) : 'body';
    const page = await this.ensureBrowser();

    const text = await page.$eval(selector, (el: any) => el.innerText).catch(() => null);

    if (!text) {
      return { success: false, output: '', error: `No encontré elemento: ${selector}` };
    }

    // Truncate if too long
    const truncated = text.length > 3000 ? text.substring(0, 3000) + '\n...[truncado]' : text;
    return { success: true, output: truncated };
  }

  private async extractLinks(params: Record<string, unknown>): Promise<ToolResult> {
    const selector = params.selector ? String(params.selector) : 'a';
    const page = await this.ensureBrowser();

    const links = await page.$$eval(selector, (els: any[]) =>
      els.slice(0, 50).map((el: any) => ({
        text: (el.innerText || '').trim().substring(0, 80),
        href: el.href || '',
      })).filter((l: any) => l.href && l.href.startsWith('http'))
    );

    if (links.length === 0) {
      return { success: true, output: 'No se encontraron links.' };
    }

    const formatted = links.map((l: any) => `${l.text || '(sin texto)'} → ${l.href}`).join('\n');
    return { success: true, output: `${links.length} links encontrados:\n\n${formatted}` };
  }

  private async click(params: Record<string, unknown>, wait: number): Promise<ToolResult> {
    const selector = String(params.selector || '');
    if (!selector) return { success: false, output: '', error: 'Selector requerido.' };

    const page = await this.ensureBrowser();
    await page.click(selector);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    return { success: true, output: `Click en: ${selector}` };
  }

  private async typeText(params: Record<string, unknown>, wait: number): Promise<ToolResult> {
    const selector = String(params.selector || '');
    const text = String(params.text || '');
    if (!selector || !text) return { success: false, output: '', error: 'Selector y texto requeridos.' };

    const page = await this.ensureBrowser();
    await page.click(selector);
    await page.type(selector, text, { delay: 50 });
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    return { success: true, output: `Escrito "${text}" en ${selector}` };
  }

  private async evaluate(params: Record<string, unknown>): Promise<ToolResult> {
    const js = String(params.js || '');
    if (!js) return { success: false, output: '', error: 'JavaScript requerido.' };

    const page = await this.ensureBrowser();
    const result = await page.evaluate(js);

    return {
      success: true,
      output: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
    };
  }

  private async closeBrowser(): Promise<ToolResult> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
    return { success: true, output: 'Navegador cerrado.' };
  }
}

export function isBrowserAvailable(): boolean {
  return puppeteer !== null;
}
