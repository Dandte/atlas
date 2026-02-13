// ═══════════════════════════════════════
// ATLAS — Browser Agent Tool
// v0.9 Feature 10: Autonomous multi-step browsing
// ═══════════════════════════════════════

import { Tool, ToolResult, ModelProvider } from '../../types';
import { ToolRegistry } from '../tool-registry';
import { config } from '../../config/config';
import logger from '../../utils/logger';

export class BrowserAgentTool implements Tool {
  private registry: ToolRegistry;
  private modelRouter: ModelProvider;

  definition = {
    name: 'browser_agent',
    description: 'Ejecutar tareas autonomas de navegacion web multi-paso. ATLAS navega, toma screenshots, analiza con vision, y extrae informacion. Ideal para: scraping, llenado de formularios, investigacion visual.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task: {
          type: 'string',
          description: 'Describe la tarea completa. Ej: "Entra a example.com, busca precios de iPhone, extrae el precio mas bajo"',
        },
        url: { type: 'string', description: 'URL inicial (opcional)' },
        max_steps: { type: 'number', description: 'Maximo de pasos. Default: 10' },
      },
      required: ['task'],
    },
    dangerous: true,
  };

  constructor(registry: ToolRegistry, modelRouter: ModelProvider) {
    this.registry = registry;
    this.modelRouter = modelRouter;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const browser = this.registry.get('browser');
    if (!browser) {
      return { success: false, output: '', error: 'Browser tool not available. Install puppeteer.' };
    }

    const task = params.task as string;
    const startUrl = params.url as string;
    const maxSteps = Math.min(
      (params.max_steps as number) || config.browserAgentMaxSteps,
      config.browserAgentMaxSteps
    );

    logger.info(`BrowserAgent: starting task "${task.substring(0, 100)}" (max ${maxSteps} steps)`);

    const steps: string[] = [];
    let currentUrl = startUrl || '';
    let lastScreenshot = '';
    let extractedData = '';

    try {
      // Navigate to initial URL if provided
      if (startUrl) {
        const navResult = await browser.execute({ action: 'navigate', url: startUrl });
        if (!navResult.success) {
          return { success: false, output: '', error: `Failed to navigate: ${navResult.error}` };
        }
        steps.push(`Navegado a ${startUrl}`);
      }

      // Autonomous loop
      for (let i = 0; i < maxSteps; i++) {
        // Take screenshot
        const screenshotResult = await browser.execute({ action: 'screenshot' });
        if (screenshotResult.success && screenshotResult.output) {
          lastScreenshot = screenshotResult.output;
        }

        // Get page content summary
        const contentResult = await browser.execute({ action: 'extract_text' });
        const pageContent = contentResult.success ? contentResult.output.substring(0, 3000) : '';

        // Ask AI what to do next
        const prompt = `Tarea: ${task}
URL actual: ${currentUrl}
Paso ${i + 1}/${maxSteps}
Pasos realizados: ${steps.join('; ') || 'Ninguno'}

Contenido de la pagina (resumen):
${pageContent.substring(0, 2000)}

¿Cual es la siguiente accion? Responde con UNA de estas acciones:
- CLICK: selector_css (ej: "CLICK: #search-btn")
- TYPE: selector_css | texto (ej: "TYPE: #search-input | iPhone precios")
- NAVIGATE: url (ej: "NAVIGATE: https://example.com/page2")
- SCROLL: down/up
- EXTRACT: descripcion de que extraer
- DONE: resultado final

Responde SOLO la accion, sin explicaciones.`;

        const aiResponse = await this.modelRouter.chat(
          'Eres un agente de navegacion web. Responde solo con la accion exacta.',
          [{ role: 'user', content: prompt }],
          undefined,
          { temperature: 0.2, maxTokens: 200 }
        );

        const action = aiResponse.content.trim();
        logger.debug(`BrowserAgent step ${i + 1}: ${action}`);

        // Parse and execute action
        if (action.startsWith('DONE:')) {
          extractedData = action.substring(5).trim();
          steps.push(`Resultado: ${extractedData.substring(0, 200)}`);
          break;
        } else if (action.startsWith('CLICK:')) {
          const selector = action.substring(6).trim();
          const clickResult = await browser.execute({ action: 'click', selector });
          steps.push(`Click: ${selector} (${clickResult.success ? 'OK' : 'Error'})`);
        } else if (action.startsWith('TYPE:')) {
          const parts = action.substring(5).split('|').map((s: string) => s.trim());
          if (parts.length >= 2) {
            await browser.execute({ action: 'type', selector: parts[0], text: parts[1] });
            steps.push(`Escribir "${parts[1]}" en ${parts[0]}`);
          }
        } else if (action.startsWith('NAVIGATE:')) {
          const url = action.substring(9).trim();
          const navResult = await browser.execute({ action: 'navigate', url });
          currentUrl = url;
          steps.push(`Navegar a ${url} (${navResult.success ? 'OK' : 'Error'})`);
        } else if (action.startsWith('SCROLL:')) {
          const direction = action.substring(7).trim().toLowerCase();
          const js = direction === 'up' ? 'window.scrollBy(0, -600)' : 'window.scrollBy(0, 600)';
          await browser.execute({ action: 'evaluate', js });
          steps.push(`Scroll ${direction}`);
        } else if (action.startsWith('EXTRACT:')) {
          const what = action.substring(8).trim();
          // Re-get content for extraction
          const content = await browser.execute({ action: 'extract_text' });
          extractedData = content.output?.substring(0, 5000) || '';
          steps.push(`Extraer: ${what}`);
        } else {
          steps.push(`Accion no reconocida: ${action.substring(0, 50)}`);
        }

        // Small delay between steps
        await new Promise(r => setTimeout(r, 500));
      }

      // Build result
      let output = `Tarea: ${task}\n`;
      output += `Pasos ejecutados: ${steps.length}\n\n`;
      output += `Pasos:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`;
      if (extractedData) {
        output += `\nDatos extraidos:\n${extractedData}`;
      }

      return { success: true, output };
    } catch (err: any) {
      return {
        success: false,
        output: `Pasos completados: ${steps.join('; ')}`,
        error: `BrowserAgent error: ${err.message}`,
      };
    }
  }
}
