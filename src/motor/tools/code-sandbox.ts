// ═══════════════════════════════════════
// ATLAS — Code Sandbox Tool
// Safe code execution in isolated environment
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import logger from '../../utils/logger';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export class CodeSandboxTool implements Tool {
  definition: ToolDefinition = {
    name: 'code_sandbox',
    description: 'Ejecuta código de forma aislada y segura. Soporta: JavaScript/TypeScript (Node.js), Python, Bash/PowerShell. Usa Docker si está disponible para máximo aislamiento, sino ejecuta con restricciones. Ideal para probar snippets, cálculos, scripts rápidos.',
    input_schema: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['javascript', 'typescript', 'python', 'bash', 'powershell'],
          description: 'Lenguaje del código a ejecutar',
        },
        code: {
          type: 'string',
          description: 'Código fuente a ejecutar',
        },
        timeout: {
          type: 'number',
          description: 'Timeout en segundos. Default: 30. Máximo: 120',
        },
        use_docker: {
          type: 'boolean',
          description: 'Forzar uso de Docker para aislamiento. Default: auto (usa Docker si está disponible)',
        },
        stdin: {
          type: 'string',
          description: 'Input estándar para el programa',
        },
      },
      required: ['language', 'code'],
    },
  };

  private dockerAvailable: boolean | null = null;

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const language = String(params.language || 'javascript');
    const code = String(params.code || '');
    const timeoutSecs = Math.min(120, Math.max(5, Number(params.timeout || 30)));
    const useDocker = params.use_docker !== undefined ? Boolean(params.use_docker) : this.isDockerAvailable();
    const stdin = params.stdin ? String(params.stdin) : undefined;

    if (!code.trim()) {
      return { success: false, output: '', error: 'Se requiere código para ejecutar' };
    }

    logger.info('Code sandbox execution', { language, codeLength: code.length, docker: useDocker });

    try {
      if (useDocker) {
        return await this.executeInDocker(language, code, timeoutSecs, stdin);
      }
      return await this.executeLocal(language, code, timeoutSecs, stdin);
    } catch (err: any) {
      return { success: false, output: '', error: `Error ejecutando código: ${err.message}` };
    }
  }

  private async executeInDocker(
    language: string, code: string, timeout: number, stdin?: string
  ): Promise<ToolResult> {
    const images: Record<string, string> = {
      javascript: 'node:22-alpine',
      typescript: 'node:22-alpine',
      python: 'python:3.12-alpine',
      bash: 'alpine:latest',
      powershell: 'mcr.microsoft.com/powershell:alpine-3.20',
    };

    const image = images[language];
    if (!image) return { success: false, output: '', error: `Docker image no definida para ${language}` };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sandbox-'));
    const ext = this.getExtension(language);
    const codePath = path.join(tmpDir, `script${ext}`);
    fs.writeFileSync(codePath, code);

    const cmd = this.getRunCommand(language, `/sandbox/script${ext}`);
    const dockerArgs = [
      'run', '--rm',
      '--network=none', // No network
      '--memory=128m', // Max 128MB RAM
      '--cpus=0.5', // Max 0.5 CPU
      '--read-only', // Read-only filesystem
      '--tmpfs=/tmp:size=64m',
      '-v', `${tmpDir}:/sandbox:ro`,
      '-w', '/sandbox',
      image,
      ...cmd.split(' '),
    ];

    return this.runProcess('docker', dockerArgs, timeout, stdin);
  }

  private async executeLocal(
    language: string, code: string, timeout: number, stdin?: string
  ): Promise<ToolResult> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sandbox-'));
    const ext = this.getExtension(language);
    const codePath = path.join(tmpDir, `script${ext}`);

    let finalCode = code;
    if (language === 'typescript') {
      // Transpile TS to JS using tsx or direct node with --loader
      finalCode = code;
    }
    fs.writeFileSync(codePath, finalCode);

    const cmd = this.getRunCommand(language, codePath);
    const parts = cmd.split(' ');
    const result = await this.runProcess(parts[0], parts.slice(1), timeout, stdin);

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

    return result;
  }

  private async runProcess(
    command: string, args: string[], timeout: number, stdin?: string
  ): Promise<ToolResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const proc = spawn(command, args, {
        timeout: timeout * 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=128' },
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        if (stdout.length > 50000) {
          proc.kill();
          killed = true;
        }
      });
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      if (stdin) proc.stdin.write(stdin);
      proc.stdin.end();

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        killed = true;
      }, timeout * 1000);

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        const elapsed = Date.now() - startTime;

        if (killed && stdout.length > 50000) {
          resolve({
            success: false,
            output: stdout.substring(0, 50000),
            error: 'Output truncado (>50KB). Reducí la cantidad de output.',
          });
          return;
        }

        if (killed) {
          resolve({
            success: false,
            output: stdout,
            error: `Ejecución cancelada: timeout de ${timeout}s excedido`,
          });
          return;
        }

        const output = [
          stdout.trim(),
          stderr.trim() ? `\n--- stderr ---\n${stderr.trim()}` : '',
          `\n--- Ejecución completada en ${elapsed}ms (exit code: ${exitCode}) ---`,
        ].join('');

        resolve({
          success: exitCode === 0,
          output: output.substring(0, 50000),
          error: exitCode !== 0 ? `Exit code: ${exitCode}` : undefined,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          output: '',
          error: `Error ejecutando ${command}: ${err.message}`,
        });
      });
    });
  }

  private getExtension(language: string): string {
    const map: Record<string, string> = {
      javascript: '.js', typescript: '.ts', python: '.py',
      bash: '.sh', powershell: '.ps1',
    };
    return map[language] || '.txt';
  }

  private getRunCommand(language: string, filePath: string): string {
    const map: Record<string, string> = {
      javascript: `node ${filePath}`,
      typescript: `npx tsx ${filePath}`,
      python: `python ${filePath}`,
      bash: `bash ${filePath}`,
      powershell: `pwsh -File ${filePath}`,
    };
    return map[language] || `node ${filePath}`;
  }

  private isDockerAvailable(): boolean {
    if (this.dockerAvailable !== null) return this.dockerAvailable;
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 5000 });
      this.dockerAvailable = true;
    } catch {
      this.dockerAvailable = false;
    }
    return this.dockerAvailable;
  }
}
