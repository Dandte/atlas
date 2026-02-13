// ═══════════════════════════════════════
// ATLAS — Skill: Loan Calculator
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';

const DEFAULT_RATES: Record<number, number> = {
  3: 24, 6: 28, 9: 30, 12: 32, 18: 34, 24: 36,
};

export class LoanCalculatorTool implements Tool {
  definition = {
    name: 'loan_calculator',
    description: 'Calcular cuotas de financiamiento. Calcula cuota mensual, total a pagar, e intereses. Usar cuando pregunten cuánto queda la cuota, simulación de crédito, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        price: {
          type: 'number',
          description: 'Precio del equipo en COP',
        },
        down_payment: {
          type: 'number',
          description: 'Cuota inicial en COP. Default: 0',
        },
        months: {
          type: 'number',
          description: 'Plazo en meses (3, 6, 9, 12, 18, 24). Default: 12',
        },
        annual_rate: {
          type: 'number',
          description: 'Tasa de interés anual en %. Default: usa la tasa configurada según plazo.',
        },
      },
      required: ['price'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const price = params.price as number;
    const downPayment = (params.down_payment as number) || 0;
    const months = (params.months as number) || 12;

    const annualRate = (params.annual_rate as number) || DEFAULT_RATES[months] || 32;
    const monthlyRate = annualRate / 100 / 12;
    const principal = price - downPayment;

    if (principal <= 0) {
      return { success: true, output: 'La cuota inicial cubre el precio total. No se necesita financiamiento.' };
    }

    // French amortization
    const monthlyPayment = principal * (monthlyRate * Math.pow(1 + monthlyRate, months))
      / (Math.pow(1 + monthlyRate, months) - 1);

    const totalPayment = monthlyPayment * months + downPayment;
    const totalInterest = totalPayment - price;

    const fmt = (n: number) => n.toLocaleString('es-CO', { maximumFractionDigits: 0 });

    let output = `Simulación de Financiamiento\n\n`;
    output += `Equipo: $${fmt(price)}\n`;
    output += `Cuota inicial: $${fmt(downPayment)}\n`;
    output += `A financiar: $${fmt(principal)}\n`;
    output += `Plazo: ${months} meses\n`;
    output += `Tasa: ${annualRate}% EA (${(monthlyRate * 100).toFixed(2)}% mensual)\n\n`;
    output += `Cuota mensual: $${fmt(monthlyPayment)}\n`;
    output += `Total a pagar: $${fmt(totalPayment)}\n`;
    output += `Intereses: $${fmt(totalInterest)}`;

    return { success: true, output };
  }
}
