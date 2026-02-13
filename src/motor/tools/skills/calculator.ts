// ═══════════════════════════════════════
// ATLAS — Skill: Calculator
// Business math, percentages, IVA, margins
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';

export class CalculatorTool implements Tool {
  definition = {
    name: 'calculator',
    description:
      'Calculadora matemática. Evalúa expresiones, porcentajes, IVA, márgenes, descuentos. ' +
      'Usar cuando pidan calcular algo numérico: "cuánto es 15% de 3M", "sácale el IVA a 500mil", ' +
      '"margen de ganancia si compro a 200 y vendo a 350", "23 * 4500".',
    input_schema: {
      type: 'object' as const,
      properties: {
        expression: {
          type: 'string',
          description: 'Expresión matemática: "2500 * 12", "15% of 3800000", "sqrt(144)"',
        },
        action: {
          type: 'string',
          enum: ['eval', 'percentage', 'iva', 'margin', 'discount'],
          description: 'Tipo de cálculo. Default: eval',
        },
        amount: { type: 'number', description: 'Monto base (para iva, margin, discount)' },
        rate: { type: 'number', description: 'Porcentaje (para percentage, discount). Ej: 15 para 15%' },
        cost: { type: 'number', description: 'Costo de compra (para margin)' },
        price: { type: 'number', description: 'Precio de venta (para margin)' },
      },
      required: [],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = (params.action as string) || 'eval';

    switch (action) {
      case 'percentage': return this.percentage(params);
      case 'iva': return this.iva(params);
      case 'margin': return this.margin(params);
      case 'discount': return this.discount(params);
      default: return this.evaluate(params);
    }
  }

  private evaluate(params: Record<string, unknown>): ToolResult {
    const expr = String(params.expression || params.amount || '');
    if (!expr) return { success: false, output: '', error: 'Necesito una expresión para calcular.' };

    // Normalize: x→*, ÷→/, remove currency symbols and thousand separators
    let clean = expr
      .replace(/x/gi, '*')
      .replace(/÷/g, '/')
      .replace(/\$/g, '')
      .replace(/,/g, '')
      .replace(/\s/g, '');

    // Handle "X% of Y" patterns
    const pctOfMatch = clean.match(/^([\d.]+)%(?:of|de)([\d.]+)$/i);
    if (pctOfMatch) {
      const pct = parseFloat(pctOfMatch[1]);
      const base = parseFloat(pctOfMatch[2]);
      const result = (pct / 100) * base;
      return { success: true, output: `${pct}% de ${this.fmt(base)} = ${this.fmt(result)}` };
    }

    // Handle sqrt, pow
    clean = clean.replace(/sqrt\(([\d.]+)\)/gi, (_, n) => String(Math.sqrt(parseFloat(n))));
    clean = clean.replace(/pow\(([\d.]+),([\d.]+)\)/gi, (_, a, b) => String(Math.pow(parseFloat(a), parseFloat(b))));

    // Strict validation: only digits, operators, parentheses, dots
    if (!/^[0-9+\-*/.()]+$/.test(clean)) {
      return { success: false, output: '', error: `Expresión no válida: "${expr}"` };
    }

    try {
      const fn = new Function(`"use strict"; return (${clean});`);
      const result = fn();

      if (typeof result !== 'number' || !isFinite(result)) {
        return { success: false, output: '', error: 'Resultado no es un número válido.' };
      }

      return { success: true, output: `${expr} = ${this.fmt(result)}` };
    } catch {
      return { success: false, output: '', error: `No pude evaluar: "${expr}"` };
    }
  }

  private percentage(params: Record<string, unknown>): ToolResult {
    const amount = params.amount as number;
    const rate = params.rate as number;
    if (!amount || !rate) return { success: false, output: '', error: 'Necesito amount y rate.' };

    const result = (rate / 100) * amount;
    return {
      success: true,
      output: `${rate}% de ${this.fmt(amount)} = ${this.fmt(result)}`,
    };
  }

  private iva(params: Record<string, unknown>): ToolResult {
    const amount = params.amount as number;
    if (!amount) return { success: false, output: '', error: 'Necesito el monto.' };

    const ivaRate = 0.19; // Colombia 19%
    const iva = amount * ivaRate;
    const total = amount + iva;
    const sinIva = amount / (1 + ivaRate);
    const ivaIncluido = amount - sinIva;

    return {
      success: true,
      output:
        `Monto: ${this.fmt(amount)}\n` +
        `+ IVA (19%): ${this.fmt(iva)}\n` +
        `= Total con IVA: ${this.fmt(total)}\n\n` +
        `Si ${this.fmt(amount)} YA incluye IVA:\n` +
        `  Base: ${this.fmt(sinIva)}\n` +
        `  IVA: ${this.fmt(ivaIncluido)}`,
    };
  }

  private margin(params: Record<string, unknown>): ToolResult {
    const cost = params.cost as number;
    const price = params.price as number;
    if (!cost || !price) return { success: false, output: '', error: 'Necesito cost y price.' };

    const profit = price - cost;
    const marginPct = (profit / price) * 100;
    const markupPct = (profit / cost) * 100;

    return {
      success: true,
      output:
        `Costo: ${this.fmt(cost)}\n` +
        `Precio venta: ${this.fmt(price)}\n` +
        `Ganancia: ${this.fmt(profit)}\n` +
        `Margen: ${marginPct.toFixed(1)}%\n` +
        `Markup: ${markupPct.toFixed(1)}%`,
    };
  }

  private discount(params: Record<string, unknown>): ToolResult {
    const amount = params.amount as number;
    const rate = params.rate as number;
    if (!amount || !rate) return { success: false, output: '', error: 'Necesito amount y rate.' };

    const discountValue = (rate / 100) * amount;
    const final = amount - discountValue;

    return {
      success: true,
      output:
        `Precio original: ${this.fmt(amount)}\n` +
        `Descuento (${rate}%): -${this.fmt(discountValue)}\n` +
        `Precio final: ${this.fmt(final)}`,
    };
  }

  private fmt(n: number): string {
    return n.toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
}
