// ═══════════════════════════════════════
// ATLAS — Skill: Random / Dice / Picker
// Random decisions, dice rolls, coin flips
// ═══════════════════════════════════════

import crypto from 'crypto';
import { Tool, ToolResult } from '../../../types';

export class RandomTool implements Tool {
  definition = {
    name: 'random',
    description:
      'Generar números aleatorios, tirar dados, lanzar moneda, elegir de una lista. ' +
      'Usar cuando digan "tirá un dado", "cara o sello", "elegí uno", "número random", "sorteo", "quién paga".',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['number', 'dice', 'coin', 'pick', 'shuffle', 'uuid'],
          description: 'number=rango, dice=dados, coin=moneda, pick=elegir de lista, shuffle=mezclar lista, uuid=generar UUID',
        },
        min: { type: 'number', description: 'Mínimo para number. Default: 1' },
        max: { type: 'number', description: 'Máximo para number. Default: 100' },
        count: { type: 'number', description: 'Cuántos resultados. Default: 1' },
        sides: { type: 'number', description: 'Lados del dado. Default: 6' },
        options: {
          type: 'string',
          description: 'Opciones separadas por coma para pick/shuffle. Ej: "pizza,sushi,hamburguesa"',
        },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;

    switch (action) {
      case 'number': return this.randomNumber(params);
      case 'dice': return this.dice(params);
      case 'coin': return this.coin(params);
      case 'pick': return this.pick(params);
      case 'shuffle': return this.shuffle(params);
      case 'uuid': return this.uuid(params);
      default: return { success: false, output: '', error: `Acción no reconocida: ${action}` };
    }
  }

  private randomNumber(params: Record<string, unknown>): ToolResult {
    const min = (params.min as number) ?? 1;
    const max = (params.max as number) ?? 100;
    const count = Math.min((params.count as number) || 1, 20);

    if (min >= max) return { success: false, output: '', error: 'min debe ser menor que max.' };

    const results: number[] = [];
    for (let i = 0; i < count; i++) {
      results.push(crypto.randomInt(min, max + 1));
    }

    if (count === 1) {
      return { success: true, output: `Número aleatorio (${min}-${max}): ${results[0]}` };
    }
    return {
      success: true,
      output: `${count} números aleatorios (${min}-${max}):\n${results.join(', ')}`,
    };
  }

  private dice(params: Record<string, unknown>): ToolResult {
    const sides = (params.sides as number) || 6;
    const count = Math.min((params.count as number) || 1, 20);

    const rolls: number[] = [];
    for (let i = 0; i < count; i++) {
      rolls.push(crypto.randomInt(1, sides + 1));
    }

    const total = rolls.reduce((a, b) => a + b, 0);
    const diceStr = `${count}d${sides}`;

    if (count === 1) {
      return { success: true, output: `🎲 ${diceStr}: ${rolls[0]}` };
    }
    return {
      success: true,
      output: `🎲 ${diceStr}: [${rolls.join(', ')}] = ${total}`,
    };
  }

  private coin(params: Record<string, unknown>): ToolResult {
    const count = Math.min((params.count as number) || 1, 20);

    const flips: string[] = [];
    let heads = 0;
    for (let i = 0; i < count; i++) {
      const result = crypto.randomInt(0, 2) === 0 ? 'Cara' : 'Sello';
      if (result === 'Cara') heads++;
      flips.push(result);
    }

    if (count === 1) {
      return { success: true, output: `🪙 ${flips[0]}` };
    }
    return {
      success: true,
      output: `🪙 ${count} lanzamientos: ${flips.join(', ')}\n(${heads} caras, ${count - heads} sellos)`,
    };
  }

  private pick(params: Record<string, unknown>): ToolResult {
    const options = String(params.options || '');
    if (!options) return { success: false, output: '', error: 'Necesito opciones separadas por coma.' };

    const items = options.split(',').map(s => s.trim()).filter(Boolean);
    if (items.length < 2) return { success: false, output: '', error: 'Necesito al menos 2 opciones.' };

    const count = Math.min((params.count as number) || 1, items.length);
    const picks: string[] = [];
    const available = [...items];

    for (let i = 0; i < count; i++) {
      const idx = crypto.randomInt(0, available.length);
      picks.push(available[idx]);
      available.splice(idx, 1);
    }

    if (count === 1) {
      return { success: true, output: `🎯 De [${items.join(', ')}] → ${picks[0]}` };
    }
    return {
      success: true,
      output: `🎯 ${count} elegidos de [${items.join(', ')}]:\n${picks.map((p, i) => `${i + 1}. ${p}`).join('\n')}`,
    };
  }

  private shuffle(params: Record<string, unknown>): ToolResult {
    const options = String(params.options || '');
    if (!options) return { success: false, output: '', error: 'Necesito opciones separadas por coma.' };

    const items = options.split(',').map(s => s.trim()).filter(Boolean);
    if (items.length < 2) return { success: false, output: '', error: 'Necesito al menos 2 opciones.' };

    // Fisher-Yates shuffle with crypto random
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return {
      success: true,
      output: `🔀 Orden aleatorio:\n${shuffled.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    };
  }

  private uuid(params: Record<string, unknown>): ToolResult {
    const count = Math.min((params.count as number) || 1, 10);
    const uuids: string[] = [];

    for (let i = 0; i < count; i++) {
      uuids.push(crypto.randomUUID());
    }

    return {
      success: true,
      output: count === 1
        ? `UUID: ${uuids[0]}`
        : `${count} UUIDs:\n${uuids.map((u, i) => `${i + 1}. ${u}`).join('\n')}`,
    };
  }
}
