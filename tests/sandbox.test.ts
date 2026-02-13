// ═══════════════════════════════════════
// ATLAS — Sandbox Tests
// ═══════════════════════════════════════

jest.mock('../src/config/config', () => ({
  config: {
    sandboxTimeout: 5000,
    sandboxMaxMemory: 64,
  },
}));

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../src/utils/logger', () => ({ __esModule: true, default: mockLogger }));

import { Sandbox } from '../src/forge/sandbox';

describe('Sandbox', () => {
  let sandbox: Sandbox;

  beforeAll(async () => {
    sandbox = new Sandbox();
    await sandbox.init();
  });

  describe('Validation', () => {
    it('should reject code with process.exit', async () => {
      const result = await sandbox.validate(
        { handlerCode: 'process.exit(1)' },
        {}
      );
      expect(result.passed).toBe(false);
      expect(result.errors.some(e => e.includes('process.exit'))).toBe(true);
    });

    it('should reject code with child_process', async () => {
      const result = await sandbox.validate(
        { handlerCode: 'const cp = require("child_process"); cp.exec("ls")' },
        {}
      );
      expect(result.passed).toBe(false);
      expect(result.errors.some(e => e.includes('child_process'))).toBe(true);
    });

    it('should reject code with eval', async () => {
      const result = await sandbox.validate(
        { handlerCode: 'const x = eval("1+1")' },
        {}
      );
      expect(result.passed).toBe(false);
      expect(result.errors.some(e => e.includes('eval'))).toBe(true);
    });

    it('should reject code with new Function', async () => {
      const result = await sandbox.validate(
        { handlerCode: 'const fn = new Function("return 1")' },
        {}
      );
      expect(result.passed).toBe(false);
      expect(result.errors.some(e => e.includes('Function'))).toBe(true);
    });

    it('should reject code with process.env', async () => {
      const result = await sandbox.validate(
        { handlerCode: 'const key = process.env.API_KEY' },
        {}
      );
      expect(result.passed).toBe(false);
    });

    it('should reject infinite loops', async () => {
      const result = await sandbox.validate(
        { handlerCode: 'while(true) { console.log("loop") }' },
        {}
      );
      expect(result.passed).toBe(false);
    });

    it('should pass static analysis for safe code', async () => {
      const code = `
export async function execute(input: any): Promise<{ success: boolean; output: string }> {
  try {
    const sum = (input.a || 0) + (input.b || 0);
    return { success: true, output: String(sum) };
  } catch (err: any) {
    return { success: false, output: '', error: err.message };
  }
}`;
      const result = await sandbox.validate({ handlerCode: code }, { parameters: [] });
      // Static analysis should find no forbidden patterns
      const staticErrors = result.errors.filter(e =>
        e.startsWith('Bloqueado:') || e.includes('Debe exportar') || e.includes('Debe retornar')
      );
      expect(staticErrors.length).toBe(0);
    });

    it('should detect that code has required structure', async () => {
      // Code with export async function execute + success: + try
      const code = `
export async function execute(input: any) {
  try {
    return { success: true, output: 'hello' };
  } catch (e: any) {
    return { success: false, output: '', error: e.message };
  }
}`;
      const result = await sandbox.validate({ handlerCode: code }, {});
      // No structural errors (may fail compile check, but structure is correct)
      const structuralErrors = result.errors.filter(e =>
        e.includes('Debe exportar') || e.includes('Debe retornar')
      );
      expect(structuralErrors.length).toBe(0);
    });
  });
});
