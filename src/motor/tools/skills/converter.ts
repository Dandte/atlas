// ═══════════════════════════════════════
// ATLAS — Skill: Currency & Unit Converter
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';

const CURRENCIES = ['USD', 'COP', 'EUR', 'GBP', 'MXN', 'BRL', 'ARS', 'PEN', 'CLP', 'BTC', 'ETH'];

const UNIT_CONVERSIONS: Record<string, Record<string, (n: number) => number>> = {
  KM: { MI: (n) => n * 0.621371, M: (n) => n * 1000 },
  MI: { KM: (n) => n * 1.60934 },
  KG: { LB: (n) => n * 2.20462, G: (n) => n * 1000 },
  LB: { KG: (n) => n * 0.453592, OZ: (n) => n * 16 },
  CM: { IN: (n) => n * 0.393701, M: (n) => n / 100 },
  IN: { CM: (n) => n * 2.54 },
  C: { F: (n) => n * 9 / 5 + 32 },
  F: { C: (n) => (n - 32) * 5 / 9 },
  L: { GAL: (n) => n * 0.264172, ML: (n) => n * 1000 },
  GAL: { L: (n) => n * 3.78541 },
  GB: { MB: (n) => n * 1024, TB: (n) => n / 1024 },
  MB: { GB: (n) => n / 1024 },
  TB: { GB: (n) => n * 1024 },
};

export class ConverterTool implements Tool {
  definition = {
    name: 'converter',
    description: 'Convertir entre monedas (USD, COP, EUR, BTC, etc.) y unidades (temperatura, distancia, peso, datos). Usar cuando pidan convertir algo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        amount: { type: 'number', description: 'Cantidad a convertir' },
        from: { type: 'string', description: 'Moneda/unidad origen (ej: USD, EUR, km, lb, C)' },
        to: { type: 'string', description: 'Moneda/unidad destino (ej: COP, USD, mi, kg, F)' },
      },
      required: ['amount', 'from', 'to'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const amount = params.amount as number;
    const fromU = (params.from as string).toUpperCase();
    const toU = (params.to as string).toUpperCase();

    if (CURRENCIES.includes(fromU) && CURRENCIES.includes(toU)) {
      return this.convertCurrency(amount, fromU, toU);
    }

    return this.convertUnit(amount, fromU, toU);
  }

  private async convertCurrency(amount: number, from: string, to: string): Promise<ToolResult> {
    try {
      const resp = await fetch(
        `https://api.exchangerate-api.com/v4/latest/${from}`,
        { signal: AbortSignal.timeout(10000) }
      );
      const data = await resp.json();
      const rate = data.rates?.[to];

      if (!rate) {
        return { success: false, output: '', error: `No encontré tasa para ${from} -> ${to}` };
      }

      const result = amount * rate;
      const fmt = (n: number) => n.toLocaleString('es-CO', {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      });

      return {
        success: true,
        output: `${fmt(amount)} ${from} = ${fmt(result)} ${to}\nTasa: 1 ${from} = ${fmt(rate)} ${to}`,
      };
    } catch (err: any) {
      return { success: false, output: '', error: `Error consultando tasa: ${err.message}` };
    }
  }

  private convertUnit(amount: number, from: string, to: string): ToolResult {
    const fn = UNIT_CONVERSIONS[from]?.[to];
    if (!fn) {
      return { success: false, output: '', error: `No sé convertir ${from} a ${to}` };
    }

    const result = fn(amount);
    return {
      success: true,
      output: `${amount} ${from} = ${result.toLocaleString('es-CO', { maximumFractionDigits: 4 })} ${to}`,
    };
  }
}
