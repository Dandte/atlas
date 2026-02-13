// ═══════════════════════════════════════
// ATLAS — Skill: Countdown / Date Calculator
// Date differences, deadlines, business days
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';

// Colombian public holidays (fixed dates — movable holidays approximated)
const CO_HOLIDAYS_FIXED = [
  '01-01', '05-01', '07-20', '08-07', '12-08', '12-25',
];

export class CountdownTool implements Tool {
  definition = {
    name: 'countdown',
    description:
      'Calcular diferencias entre fechas, cuánto falta para algo, sumar/restar días a una fecha, días hábiles. ' +
      'Usar cuando pregunten "cuánto falta para X", "qué fecha es en 45 días", "cuántos días entre X y Y", "días hábiles".',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['until', 'between', 'add', 'business_days', 'info'],
          description: 'until=cuánto falta para fecha, between=diferencia entre 2 fechas, add=sumar/restar días, business_days=días hábiles entre fechas, info=info de una fecha',
        },
        date: {
          type: 'string',
          description: 'Fecha principal. Formatos: "2026-03-15", "15/03/2026", "mañana", "fin de mes", "fin de año", "navidad"',
        },
        date2: {
          type: 'string',
          description: 'Segunda fecha (para "between")',
        },
        days: {
          type: 'number',
          description: 'Días a sumar (positivo) o restar (negativo) para action "add"',
        },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;

    switch (action) {
      case 'until': return this.until(params);
      case 'between': return this.between(params);
      case 'add': return this.add(params);
      case 'business_days': return this.businessDays(params);
      case 'info': return this.dateInfo(params);
      default: return { success: false, output: '', error: `Acción no reconocida: ${action}` };
    }
  }

  private until(params: Record<string, unknown>): ToolResult {
    const target = this.parseDate(String(params.date || ''));
    if (!target) return { success: false, output: '', error: 'No pude entender la fecha.' };

    const now = new Date();
    const diffMs = target.getTime() - now.getTime();
    const isPast = diffMs < 0;
    const absDiffMs = Math.abs(diffMs);

    const days = Math.floor(absDiffMs / 86400000);
    const hours = Math.floor((absDiffMs % 86400000) / 3600000);
    const minutes = Math.floor((absDiffMs % 3600000) / 60000);

    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30.44);

    let output = isPast ? `Ya pasó hace ` : `Faltan `;

    if (days === 0) {
      output += `${hours}h ${minutes}m`;
    } else if (days < 7) {
      output += `${days} día${days > 1 ? 's' : ''} y ${hours}h`;
    } else if (days < 60) {
      output += `${days} días (${weeks} semana${weeks > 1 ? 's' : ''})`;
    } else {
      output += `${days} días (~${months} mes${months > 1 ? 'es' : ''})`;
    }

    output += `\nFecha: ${this.fmtDate(target)}`;

    return { success: true, output };
  }

  private between(params: Record<string, unknown>): ToolResult {
    const d1 = this.parseDate(String(params.date || ''));
    const d2 = this.parseDate(String(params.date2 || ''));
    if (!d1 || !d2) return { success: false, output: '', error: 'Necesito dos fechas válidas (date y date2).' };

    const diffMs = Math.abs(d2.getTime() - d1.getTime());
    const days = Math.floor(diffMs / 86400000);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30.44);

    return {
      success: true,
      output:
        `${this.fmtDate(d1)} → ${this.fmtDate(d2)}\n` +
        `${days} días | ${weeks} semanas | ~${months} meses`,
    };
  }

  private add(params: Record<string, unknown>): ToolResult {
    const base = this.parseDate(String(params.date || 'hoy'));
    const days = params.days as number;
    if (!base || days === undefined) return { success: false, output: '', error: 'Necesito date y days.' };

    const result = new Date(base);
    result.setDate(result.getDate() + days);

    const label = days >= 0 ? `${days} días después` : `${Math.abs(days)} días antes`;

    return {
      success: true,
      output: `${this.fmtDate(base)} + (${label})\n= ${this.fmtDate(result)}`,
    };
  }

  private businessDays(params: Record<string, unknown>): ToolResult {
    const d1 = this.parseDate(String(params.date || 'hoy'));
    const d2 = this.parseDate(String(params.date2 || ''));
    if (!d1 || !d2) return { success: false, output: '', error: 'Necesito dos fechas (date y date2).' };

    let count = 0;
    const current = new Date(d1 < d2 ? d1 : d2);
    const end = d1 < d2 ? d2 : d1;

    while (current <= end) {
      const dow = current.getDay();
      if (dow !== 0 && dow !== 6) {
        const mmdd = `${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
        if (!CO_HOLIDAYS_FIXED.includes(mmdd)) {
          count++;
        }
      }
      current.setDate(current.getDate() + 1);
    }

    return {
      success: true,
      output:
        `${this.fmtDate(d1)} → ${this.fmtDate(d2)}\n` +
        `${count} días hábiles (excluyendo fines de semana y festivos fijos de Colombia)`,
    };
  }

  private dateInfo(params: Record<string, unknown>): ToolResult {
    const d = this.parseDate(String(params.date || 'hoy'));
    if (!d) return { success: false, output: '', error: 'No pude entender la fecha.' };

    const dayOfYear = Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86400000);
    const daysInYear = this.isLeapYear(d.getFullYear()) ? 366 : 365;
    const weekNumber = Math.ceil(dayOfYear / 7);
    const quarter = Math.ceil((d.getMonth() + 1) / 3);

    return {
      success: true,
      output:
        `Fecha: ${this.fmtDate(d)}\n` +
        `Día del año: ${dayOfYear}/${daysInYear}\n` +
        `Semana: ${weekNumber}\n` +
        `Trimestre: Q${quarter}\n` +
        `Año bisiesto: ${this.isLeapYear(d.getFullYear()) ? 'Sí' : 'No'}`,
    };
  }

  private parseDate(input: string): Date | null {
    const s = input.toLowerCase().trim();
    const now = new Date();

    // Named dates
    if (s === 'hoy' || s === 'today') return now;
    if (s === 'mañana' || s === 'tomorrow') { const d = new Date(now); d.setDate(d.getDate() + 1); return d; }
    if (s === 'ayer' || s === 'yesterday') { const d = new Date(now); d.setDate(d.getDate() - 1); return d; }
    if (s === 'fin de mes' || s === 'end of month') return new Date(now.getFullYear(), now.getMonth() + 1, 0);
    if (s === 'fin de año' || s === 'end of year') return new Date(now.getFullYear(), 11, 31);
    if (s === 'navidad' || s === 'christmas') return new Date(now.getFullYear(), 11, 25);
    if (s === 'año nuevo' || s === 'new year') return new Date(now.getFullYear() + 1, 0, 1);

    // DD/MM/YYYY
    const dmy = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
    if (dmy) return new Date(parseInt(dmy[3]), parseInt(dmy[2]) - 1, parseInt(dmy[1]));

    // YYYY-MM-DD
    const ymd = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (ymd) return new Date(parseInt(ymd[1]), parseInt(ymd[2]) - 1, parseInt(ymd[3]));

    // Try native parsing
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) return parsed;

    return null;
  }

  private fmtDate(d: Date): string {
    return d.toLocaleDateString('es-CO', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
  }

  private isLeapYear(year: number): boolean {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  }
}
