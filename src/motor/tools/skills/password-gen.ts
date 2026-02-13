// ═══════════════════════════════════════
// ATLAS — Skill: Password Generator
// ═══════════════════════════════════════

import crypto from 'crypto';
import { Tool, ToolResult } from '../../../types';

const CHARSETS: Record<string, string> = {
  full: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+[]{}|;:,.<>?',
  alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  pin: '0123456789',
};

const PASSPHRASE_WORDS = [
  'sol', 'luna', 'casa', 'gato', 'perro', 'mesa', 'lago', 'rojo', 'azul', 'verde',
  'alto', 'bajo', 'norte', 'sur', 'flor', 'nube', 'viento', 'fuego', 'tierra', 'agua',
  'carro', 'tren', 'avion', 'barco', 'moto', 'cafe', 'mate', 'vino', 'pan', 'sal',
  'rio', 'mar', 'playa', 'monte', 'campo', 'ciudad', 'pueblo', 'torre', 'puente', 'arco',
];

export class PasswordGenTool implements Tool {
  definition = {
    name: 'password_gen',
    description: 'Generar passwords seguros aleatorios. Usar cuando pidan un password, contraseña, o clave segura.',
    input_schema: {
      type: 'object' as const,
      properties: {
        length: {
          type: 'number',
          description: 'Longitud del password. Default: 16',
        },
        count: {
          type: 'number',
          description: 'Cuántos passwords generar. Default: 3',
        },
        type: {
          type: 'string',
          enum: ['full', 'alphanumeric', 'pin', 'passphrase'],
          description: 'Tipo: full (todo), alphanumeric (sin símbolos), pin (solo números), passphrase (palabras). Default: full',
        },
      },
      required: [],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const length = (params.length as number) || 16;
    const count = Math.min((params.count as number) || 3, 10);
    const type = (params.type as string) || 'full';

    const passwords: string[] = [];

    if (type === 'passphrase') {
      for (let i = 0; i < count; i++) {
        const wordCount = Math.max(4, Math.floor(length / 5));
        const phrase = Array.from({ length: wordCount }, () => {
          const idx = crypto.randomInt(0, PASSPHRASE_WORDS.length);
          return PASSPHRASE_WORDS[idx];
        });
        const num = crypto.randomInt(10, 99);
        phrase[0] = phrase[0].charAt(0).toUpperCase() + phrase[0].slice(1);
        passwords.push(`${phrase.join('-')}-${num}`);
      }
    } else {
      const charset = CHARSETS[type] || CHARSETS.full;
      for (let i = 0; i < count; i++) {
        let password = '';
        for (let j = 0; j < length; j++) {
          const idx = crypto.randomInt(0, charset.length);
          password += charset[idx];
        }
        passwords.push(password);
      }
    }

    const formatted = passwords.map((p, i) => `${i + 1}. \`${p}\``).join('\n');
    const strength = length >= 16 ? 'Muy fuerte' : length >= 12 ? 'Fuerte' : 'Débil';

    return {
      success: true,
      output: `Passwords generados (${type}, ${length} chars, ${strength}):\n\n${formatted}`,
    };
  }
}
