// ═══════════════════════════════════════
// ATLAS — System Info Tool
// CPU, RAM, disk, OS, processes
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../types';
import os from 'os';
import { exec } from 'child_process';
import logger from '../../utils/logger';

export class SystemInfoTool implements Tool {
  definition = {
    name: 'system_info',
    description: 'Get system information: CPU usage, RAM, disk space, OS details, uptime, and running processes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        detail: {
          type: 'string',
          enum: ['basic', 'full', 'processes'],
          description: 'Level of detail: "basic" (CPU, RAM, OS), "full" (basic + disk + network), "processes" (top processes by CPU/RAM)',
        },
      },
      required: [],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const detail = (params.detail as string) || 'basic';

    try {
      const info: string[] = [];

      // Basic info (always included)
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const cpus = os.cpus();
      const cpuModel = cpus[0]?.model ?? 'Unknown';
      const cpuCount = cpus.length;

      // Calculate CPU usage from load average (Unix) or approximate (Windows)
      const loadAvg = os.loadavg();
      const cpuUsagePercent = Math.round((loadAvg[0] / cpuCount) * 100);

      info.push('=== Sistema ===');
      info.push(`OS: ${os.type()} ${os.release()} (${os.arch()})`);
      info.push(`Hostname: ${os.hostname()}`);
      info.push(`Uptime: ${this.formatUptime(os.uptime())}`);
      info.push('');
      info.push('=== CPU ===');
      info.push(`Modelo: ${cpuModel}`);
      info.push(`Cores: ${cpuCount}`);
      info.push(`Carga promedio: ${loadAvg.map(l => l.toFixed(2)).join(', ')} (1m, 5m, 15m)`);
      if (process.platform !== 'win32') {
        info.push(`Uso estimado: ~${cpuUsagePercent}%`);
      }
      info.push('');
      info.push('=== Memoria ===');
      info.push(`Total: ${this.formatBytes(totalMem)}`);
      info.push(`Usada: ${this.formatBytes(usedMem)} (${Math.round((usedMem / totalMem) * 100)}%)`);
      info.push(`Libre: ${this.formatBytes(freeMem)}`);

      if (detail === 'full') {
        info.push('');
        info.push('=== Red ===');
        const nets = os.networkInterfaces();
        for (const [name, ifaces] of Object.entries(nets)) {
          if (!ifaces) continue;
          for (const iface of ifaces) {
            if (!iface.internal && iface.family === 'IPv4') {
              info.push(`${name}: ${iface.address}`);
            }
          }
        }

        // Disk space (platform-dependent)
        info.push('');
        info.push('=== Disco ===');
        const diskInfo = await this.getDiskInfo();
        info.push(diskInfo);
      }

      if (detail === 'processes') {
        info.push('');
        info.push('=== Procesos (Top 10 por memoria) ===');
        const procs = await this.getTopProcesses();
        info.push(procs);
      }

      info.push('');
      info.push(`Fecha/Hora: ${new Date().toLocaleString('es-CO')}`);

      return { success: true, output: info.join('\n') };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private formatBytes(bytes: number): string {
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)} MB`;
  }

  private formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    parts.push(`${mins}m`);
    return parts.join(' ');
  }

  private getDiskInfo(): Promise<string> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32'
        ? 'wmic logicaldisk get size,freespace,caption'
        : 'df -h --output=target,size,used,avail,pcent 2>/dev/null || df -h';

      exec(cmd, { timeout: 5000 }, (error, stdout) => {
        if (error) {
          resolve('(no disponible)');
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  private getTopProcesses(): Promise<string> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32'
        ? 'tasklist /FO TABLE /NH | sort /R /+65'
        : 'ps aux --sort=-%mem | head -11';

      exec(cmd, { timeout: 5000 }, (error, stdout) => {
        if (error) {
          resolve('(no disponible)');
          return;
        }
        // Truncate if too long
        const output = stdout.trim();
        if (output.length > 3000) {
          resolve(output.substring(0, 3000) + '\n...');
        } else {
          resolve(output);
        }
      });
    });
  }
}
