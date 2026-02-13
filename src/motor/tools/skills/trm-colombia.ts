// ═══════════════════════════════════════
// ATLAS — Skill: TRM Colombia (USD/COP)
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';

export class TrmColombiaTool implements Tool {
  definition = {
    name: 'trm_colombia',
    description: 'Consultar la Tasa Representativa del Mercado (TRM) del dólar en Colombia. Retorna el precio del dólar USD/COP oficial. Usar cuando pregunten por el dólar, la TRM, o el precio del dólar hoy.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: {
          type: 'string',
          description: 'Fecha a consultar (YYYY-MM-DD). Default: hoy.',
        },
      },
      required: [],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    try {
      const date = (params.date as string) || new Date().toISOString().split('T')[0];

      const response = await fetch(
        `https://www.datos.gov.co/resource/32sa-8pi3.json?vigenciadesde=${date}`,
        { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) }
      );

      if (!response.ok) {
        // Fallback: exchangerate API
        const fallback = await fetch(
          `https://api.exchangerate-api.com/v4/latest/USD`,
          { signal: AbortSignal.timeout(10000) }
        );
        const data = await fallback.json();
        const cop = data.rates?.COP;
        if (cop) {
          return {
            success: true,
            output: `TRM USD/COP: $${parseFloat(cop).toLocaleString('es-CO', { minimumFractionDigits: 2 })} (ExchangeRate API)`,
          };
        }
        throw new Error('No se pudo obtener la TRM');
      }

      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        const trm = parseFloat(data[0].valor);
        return {
          success: true,
          output: `TRM Colombia (${date}): $${trm.toLocaleString('es-CO', { minimumFractionDigits: 2 })} COP/USD\nFuente: Superintendencia Financiera`,
        };
      }

      return { success: true, output: `No hay TRM disponible para ${date}. Puede ser fin de semana o festivo.` };
    } catch (err: any) {
      return { success: false, output: '', error: `Error consultando TRM: ${err.message}` };
    }
  }
}
