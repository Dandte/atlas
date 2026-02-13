// ═══════════════════════════════════════
// ATLAS — Skill: DNS / Network Lookup
// Domain info, IP lookup, port check
// ═══════════════════════════════════════

import dns from 'dns';
import net from 'net';
import { Tool, ToolResult } from '../../../types';

export class DnsLookupTool implements Tool {
  definition = {
    name: 'dns_lookup',
    description:
      'Consultar DNS de dominios, resolver IPs, verificar si un puerto está abierto. ' +
      'Útil para diagnóstico de servidores y redes. ' +
      'Usar cuando pregunten "qué IP tiene X", "resolve domain", "está abierto el puerto X", "whois", "dns de X".',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['resolve', 'reverse', 'port_check', 'full'],
          description: 'resolve=DNS lookup, reverse=IP→hostname, port_check=verificar puerto, full=todo',
        },
        target: {
          type: 'string',
          description: 'Dominio o IP a consultar',
        },
        port: {
          type: 'number',
          description: 'Puerto a verificar (para port_check). Default: 80',
        },
      },
      required: ['target'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = (params.action as string) || 'full';
    const target = String(params.target || '');
    if (!target) return { success: false, output: '', error: 'Necesito un dominio o IP.' };

    switch (action) {
      case 'resolve': return this.resolve(target);
      case 'reverse': return this.reverse(target);
      case 'port_check': return this.portCheck(target, (params.port as number) || 80);
      case 'full': return this.full(target);
      default: return { success: false, output: '', error: `Acción no reconocida: ${action}` };
    }
  }

  private resolve(domain: string): Promise<ToolResult> {
    return new Promise((resolve) => {
      dns.resolve(domain, 'A', (err, addresses) => {
        if (err) {
          resolve({ success: false, output: '', error: `DNS error: ${err.code || err.message}` });
          return;
        }

        dns.resolve(domain, 'MX', (_, mx) => {
          dns.resolve(domain, 'NS', (__, ns) => {
            dns.resolve(domain, 'TXT', (___, txt) => {
              const lines = [`DNS para ${domain}:`, ''];
              lines.push(`A Records: ${addresses.join(', ')}`);
              if (mx && mx.length > 0) {
                lines.push(`MX Records: ${mx.map(m => `${m.exchange} (pri: ${m.priority})`).join(', ')}`);
              }
              if (ns && ns.length > 0) {
                lines.push(`NS Records: ${ns.join(', ')}`);
              }
              if (txt && txt.length > 0) {
                lines.push(`TXT Records: ${txt.slice(0, 3).map(t => t.join('')).join(' | ')}`);
              }
              resolve({ success: true, output: lines.join('\n') });
            });
          });
        });
      });
    });
  }

  private reverse(ip: string): Promise<ToolResult> {
    return new Promise((resolve) => {
      dns.reverse(ip, (err, hostnames) => {
        if (err) {
          resolve({ success: false, output: '', error: `Reverse DNS error: ${err.code || err.message}` });
          return;
        }
        resolve({
          success: true,
          output: `Reverse DNS para ${ip}:\n${hostnames.join('\n')}`,
        });
      });
    });
  }

  private portCheck(host: string, port: number): Promise<ToolResult> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const timeout = 5000;

      socket.setTimeout(timeout);

      socket.on('connect', () => {
        socket.destroy();
        resolve({
          success: true,
          output: `${host}:${port} — ABIERTO (conexión exitosa)`,
        });
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve({
          success: true,
          output: `${host}:${port} — TIMEOUT (no respondió en ${timeout / 1000}s)`,
        });
      });

      socket.on('error', (err: any) => {
        resolve({
          success: true,
          output: `${host}:${port} — CERRADO (${err.code || err.message})`,
        });
      });

      socket.connect(port, host);
    });
  }

  private async full(target: string): Promise<ToolResult> {
    const isIP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(target);
    const lines: string[] = [`Lookup: ${target}`, ''];

    if (isIP) {
      // Reverse DNS
      const rev = await this.reverse(target);
      lines.push(rev.output || rev.error || '');

      // Check common ports
      const ports = [80, 443, 22, 3306];
      const portResults = await Promise.all(
        ports.map(p => this.portCheck(target, p))
      );
      lines.push('\nPuertos:');
      portResults.forEach(r => lines.push(`  ${r.output}`));
    } else {
      // DNS resolve
      const dnsResult = await this.resolve(target);
      lines.push(dnsResult.output || dnsResult.error || '');

      // Check HTTP/HTTPS
      const ports = [80, 443];
      const portResults = await Promise.all(
        ports.map(p => this.portCheck(target, p))
      );
      lines.push('\nPuertos:');
      portResults.forEach(r => lines.push(`  ${r.output}`));
    }

    return { success: true, output: lines.join('\n') };
  }
}
