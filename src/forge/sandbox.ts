// ═══════════════════════════════════════
// ATLAS — Sandbox (Phase 6)
// Secure code execution via Worker Threads
// Static analysis, compile check, test execution
// ═══════════════════════════════════════

import { Worker } from 'worker_threads';
import vm from 'vm';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { SandboxResult, ValidationResult, ToolParameter, TestCase, SkillRuntimeContext, ToolResult } from '../types';
import { config } from '../config/config';
import logger from '../utils/logger';

export class Sandbox {
  private tempDir: string;
  private defaultTimeout: number;
  private maxMemoryMB: number;

  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'atlas-sandbox');
    this.defaultTimeout = config.sandboxTimeout;
    this.maxMemoryMB = config.sandboxMaxMemory;
  }

  async init(): Promise<void> {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  // ── Validate code without executing ──

  async validate(
    code: { handlerCode: string },
    spec: { parameters?: ToolParameter[]; testCases?: TestCase[] }
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Static analysis — detect dangerous patterns
    const forbidden = [
      { pattern: /process\.exit/g, msg: 'No puede usar process.exit()' },
      { pattern: /require\s*\(\s*['"]child_process['"]\s*\)/g, msg: 'No puede usar child_process' },
      { pattern: /eval\s*\(/g, msg: 'No puede usar eval()' },
      { pattern: /new\s+Function\s*\(/g, msg: 'No puede usar new Function()' },
      { pattern: /process\.env/g, msg: 'No puede acceder a process.env directamente' },
      { pattern: /while\s*\(\s*true\s*\)/g, msg: 'No puede tener loops infinitos explícitos' },
      { pattern: /import\s.*from\s+['"]child_process['"]/g, msg: 'No puede importar child_process' },
      { pattern: /import\s.*from\s+['"]cluster['"]/g, msg: 'No puede importar cluster' },
    ];

    for (const rule of forbidden) {
      if (rule.pattern.test(code.handlerCode)) {
        errors.push(`Bloqueado: ${rule.msg}`);
      }
      // Reset regex lastIndex since we use /g flag
      rule.pattern.lastIndex = 0;
    }

    // 2. Verify required structure
    if (!code.handlerCode.includes('export async function execute')) {
      errors.push('Debe exportar función "execute" como async');
    }

    if (!code.handlerCode.includes('success:') && !code.handlerCode.includes('success :')) {
      errors.push('Debe retornar objeto con campo "success"');
    }

    if (!code.handlerCode.includes('try')) {
      warnings.push('Debería tener manejo de errores (try/catch)');
    }

    // 3. Verify size
    if (code.handlerCode.length > 15000) {
      errors.push('Código excede 15,000 caracteres (máximo ~200 líneas)');
    }

    // 4. Compile check (only if no static errors)
    if (errors.length === 0) {
      try {
        await this.compileCheck(code.handlerCode);
      } catch (err: any) {
        errors.push(`Error de compilación: ${err.message.substring(0, 300)}`);
      }
    }

    // 5. Execute test cases (only if no errors so far)
    if (errors.length === 0 && spec.testCases && spec.testCases.length > 0) {
      for (const test of spec.testCases) {
        try {
          const result = await this.execute(
            code.handlerCode,
            test.input,
            test.timeout || 15000
          );

          if (!result.success) {
            errors.push(`Test "${test.description}" falló: ${result.error}`);
          }
        } catch (err: any) {
          errors.push(`Test "${test.description}" tiró error: ${err.message}`);
        }
      }
    }

    return { passed: errors.length === 0, errors, warnings };
  }

  // ── Compile check via tsc ──

  private async compileCheck(code: string): Promise<void> {
    const tmpFile = path.join(this.tempDir, `check_${Date.now()}.ts`);

    // Clean code for standalone compilation in temp dir:
    // 1. Strip "import type" lines (ToolResult is provided inline below)
    // 2. Strip relative imports (can't resolve from temp dir)
    // 3. Convert npm package imports to declarations (may not be installed yet)
    let cleanCode = code
      .replace(/^import\s+type\s+.*$/gm, '')
      .replace(/^import\s+.*from\s+['"]\.\.?\/[^'"]*['"]\s*;?\s*$/gm, '');

    // Replace "import * as X from 'pkg'" and "import X from 'pkg'" with declare const
    cleanCode = cleanCode.replace(
      /^import\s+(?:\*\s+as\s+(\w+)|(\w+))\s+from\s+['"]([^'"./][^'"]*)['"]\s*;?\s*$/gm,
      (_m, starName, defaultName) => `declare const ${starName || defaultName}: any;`
    );
    // Replace "import { a, b } from 'pkg'" with declare const for each name
    cleanCode = cleanCode.replace(
      /^import\s+\{([^}]+)\}\s+from\s+['"]([^'"./][^'"]*)['"]\s*;?\s*$/gm,
      (_m, names) => names.split(',')
        .map((n: string) => `declare const ${n.trim().split(/\s+as\s+/).pop()!.trim()}: any;`)
        .join('\n')
    );

    const wrapped = `
interface ToolResult { success: boolean; output: string; error?: string; }
${cleanCode}
`;

    fs.writeFileSync(tmpFile, wrapped);

    try {
      execSync(
        `npx tsc --noEmit --esModuleInterop --target ES2022 --module commonjs --moduleResolution node --skipLibCheck "${tmpFile}" 2>&1`,
        { timeout: 15000, cwd: config.rootDir }
      );
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  // ── Execute code in Worker Thread ──

  async execute(
    code: string,
    params: Record<string, any>,
    timeout?: number
  ): Promise<SandboxResult> {
    const executionTimeout = timeout || this.defaultTimeout;
    const startTime = Date.now();

    const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const codeFile = path.join(this.tempDir, `${executionId}.mjs`);

    // Wrap code for Worker Thread
    const wrappedCode = `
import { parentPort, workerData } from "worker_threads";

${code
  .replace(/^import type.*$/gm, '')
  .replace(/export async function execute/, 'async function execute')}

try {
  const result = await execute(workerData.params);
  parentPort.postMessage({ success: true, result });
} catch (err) {
  parentPort.postMessage({ success: false, error: err.message || String(err) });
}
`;

    fs.writeFileSync(codeFile, wrappedCode);

    return new Promise<SandboxResult>((resolve) => {
      let resolved = false;

      const worker = new Worker(codeFile, {
        workerData: { params },
        resourceLimits: {
          maxOldGenerationSizeMb: this.maxMemoryMB,
          maxYoungGenerationSizeMb: Math.floor(this.maxMemoryMB / 4),
        },
      });

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          worker.terminate();
          resolve({
            success: false,
            output: '',
            error: `Timeout: ejecución excedió ${executionTimeout}ms`,
            executionMs: executionTimeout,
            memoryUsedMB: 0,
          });
        }
      }, executionTimeout);

      worker.on('message', (msg) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);

        const output = msg.success
          ? (typeof msg.result === 'object' ? msg.result : { success: true, output: String(msg.result) })
          : { success: false, output: '', error: msg.error };

        resolve({
          success: output.success ?? msg.success,
          output: output.output ?? '',
          error: output.error,
          executionMs: Date.now() - startTime,
          memoryUsedMB: 0,
        });
      });

      worker.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve({
          success: false,
          output: '',
          error: err.message,
          executionMs: Date.now() - startTime,
          memoryUsedMB: 0,
        });
      });

      worker.on('exit', (exitCode) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve({
          success: false,
          output: '',
          error: `Worker exited with code ${exitCode}`,
          executionMs: Date.now() - startTime,
          memoryUsedMB: 0,
        });
      });

      // Cleanup temp file after resolution
      const origResolve = resolve;
      const cleanup = () => {
        try { fs.unlinkSync(codeFile); } catch {}
      };
      // Use a microtask to clean up after promise resolves
      setTimeout(() => cleanup(), executionTimeout + 1000);
    });
  }

  // ── Execute composable code via vm (with callTool bridge) ──

  async executeComposable(
    code: string,
    params: Record<string, any>,
    runtimeContext: SkillRuntimeContext | null,
    callToolFn: (name: string, toolParams: Record<string, any>) => Promise<ToolResult>,
    timeout?: number
  ): Promise<SandboxResult> {
    const executionTimeout = timeout || config.forgeComposableTimeout;
    const startTime = Date.now();
    const maxCallTool = config.forgeMaxCallTool;
    let callToolCount = 0;

    // Rate-limited callTool bridge
    const callToolBridge = async (name: string, toolParams: Record<string, any>): Promise<ToolResult> => {
      callToolCount++;
      if (callToolCount > maxCallTool) {
        throw new Error(`callTool limit exceeded (max ${maxCallTool} calls per execution)`);
      }

      // Per-call timeout (5s)
      const callTimeout = 5000;
      const callStart = Date.now();

      try {
        const result = await Promise.race([
          callToolFn(name, toolParams),
          new Promise<ToolResult>((_, reject) =>
            setTimeout(() => reject(new Error(`callTool("${name}") timeout (${callTimeout}ms)`)), callTimeout)
          ),
        ]);
        logger.debug(`Composable callTool: ${name} → ${result.success ? 'OK' : 'FAIL'} (${Date.now() - callStart}ms)`);
        return result;
      } catch (err: any) {
        return { success: false, output: '', error: err.message };
      }
    };

    try {
      // Strip TypeScript-specific syntax for vm execution
      const jsCode = code
        .replace(/^import type.*$/gm, '')
        .replace(/import\s+type\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?/g, '')
        .replace(/:\s*(string|number|boolean|any|void|Record<[^>]*>|Promise<[^>]*>|ToolResult|Params|SkillRuntimeContext)\s*(?=[,)\]=;{])/g, '')
        .replace(/:\s*(string|number|boolean|any|void|Record<[^>]*>|Promise<[^>]*>|ToolResult|Params|SkillRuntimeContext)\s*$/gm, '')
        .replace(/^interface\s+\w+\s*\{[\s\S]*?\}/gm, '')
        .replace(/^declare\s+.*$/gm, '')
        .replace(/<[^>]*>/g, '')
        .replace(/as\s+\w+/g, '')
        .replace(/export async function execute/, 'async function execute');

      // Build vm sandbox context
      // Expand context with memory access methods
      const expandedContext: Record<string, any> = {
        ...(runtimeContext || {}),
        getFact: async (key: string) => {
          const mm = (runtimeContext as any)?.memoryManager;
          if (!mm) return null;
          const fact = mm.getFact(key);
          return fact?.value || null;
        },
        searchFacts: async (query: string, limit?: number) => {
          const mm = (runtimeContext as any)?.memoryManager;
          if (!mm) return [];
          return (mm.searchFacts(query, limit || 5) || [])
            .map((f: any) => ({ key: f.key, value: f.value }));
        },
        saveFact: async (key: string, value: string) => {
          const mm = (runtimeContext as any)?.memoryManager;
          if (mm) mm.saveFact(key, value, 0.7);
        },
      };

      const sandbox: Record<string, any> = {
        console: {
          log: (...args: any[]) => logger.debug('Composable log:', ...args),
          error: (...args: any[]) => logger.debug('Composable error:', ...args),
          warn: (...args: any[]) => logger.debug('Composable warn:', ...args),
        },
        callTool: callToolBridge,
        context: expandedContext,
        fetch: globalThis.fetch,
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        JSON,
        Date,
        Math,
        Array,
        Object,
        String,
        Number,
        Boolean,
        RegExp,
        Error,
        Map,
        Set,
        Promise,
        URL,
        URLSearchParams,
        Buffer,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        encodeURI,
        decodeURI,
      };

      const vmContext = vm.createContext(sandbox);

      // Wrap code to call execute() and capture result
      const wrappedCode = `
        (async () => {
          ${jsCode}
          return await execute(${JSON.stringify(params)});
        })()
      `;

      const script = new vm.Script(wrappedCode, {
        filename: 'composable-skill.js',
      });

      const resultPromise = script.runInContext(vmContext, {
        timeout: executionTimeout,
      });

      const result = await Promise.race([
        resultPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Composable timeout: ${executionTimeout}ms`)), executionTimeout)
        ),
      ]) as any;

      return {
        success: result?.success ?? false,
        output: typeof result?.output === 'string' ? result.output : JSON.stringify(result?.output ?? ''),
        error: result?.error,
        executionMs: Date.now() - startTime,
        memoryUsedMB: 0,
      };
    } catch (err: any) {
      return {
        success: false,
        output: '',
        error: err.message,
        executionMs: Date.now() - startTime,
        memoryUsedMB: 0,
      };
    }
  }
}
