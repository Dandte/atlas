// ═══════════════════════════════════════
// ATLAS — Watchdog (Phase 5)
// Auto-fix known problems before notifying
// Extends health check with remediation
// ═══════════════════════════════════════

import { AutoFix } from '../types';
import { ToolRegistry } from '../motor/tool-registry';
import { ChannelManager } from '../channels/channel-manager';
import { config } from '../config/config';
import logger from '../utils/logger';

const DEFAULT_AUTO_FIXES: AutoFix[] = [
  {
    condition: 'disk_space_low',
    action: 'Limpiar logs y archivos temporales',
    command: 'sudo journalctl --vacuum-time=3d && sudo apt-get clean',
    requiresApproval: true,
  },
  {
    condition: 'high_memory',
    action: 'Reiniciar proceso con mayor consumo de RAM',
    requiresApproval: true,
  },
  {
    condition: 'service_down',
    action: 'Intentar reiniciar el servicio',
    command: 'sudo systemctl restart {service_name}',
    requiresApproval: true,
  },
  {
    condition: 'nginx_502',
    action: 'Reiniciar PHP-FPM y Nginx',
    command: 'sudo systemctl restart php8.3-fpm && sudo systemctl restart nginx',
    requiresApproval: false,
  },
];

export class Watchdog {
  private toolRegistry: ToolRegistry;
  private channelManager: ChannelManager;
  private autoFixes: AutoFix[];

  constructor(toolRegistry: ToolRegistry, channelManager: ChannelManager) {
    this.toolRegistry = toolRegistry;
    this.channelManager = channelManager;
    this.autoFixes = [...DEFAULT_AUTO_FIXES];
  }

  /** Add a custom auto-fix rule */
  addAutoFix(fix: AutoFix): void {
    this.autoFixes.push(fix);
    logger.info(`Watchdog: added auto-fix for "${fix.condition}"`);
  }

  /** Process health check issues and attempt auto-fixes */
  async processIssues(issues: string[]): Promise<string[]> {
    const resolvedIssues: string[] = [];
    const remainingIssues: string[] = [];

    for (const issue of issues) {
      const fix = this.findAutoFix(issue);

      if (fix && !fix.requiresApproval && fix.command) {
        // Auto-fix without approval
        const result = await this.executeFix(fix, issue);
        if (result) {
          resolvedIssues.push(`[Auto-fixed] ${issue}: ${fix.action}`);
          logger.info(`Watchdog auto-fixed: ${fix.condition} — ${fix.action}`);
        } else {
          remainingIssues.push(issue);
        }
      } else if (fix && fix.requiresApproval) {
        // Needs approval — add hint to the issue
        remainingIssues.push(`${issue}\n  → Posible fix: ${fix.action}`);
      } else {
        remainingIssues.push(issue);
      }
    }

    // Combine resolved and remaining
    const allIssues = [...resolvedIssues, ...remainingIssues];
    return allIssues;
  }

  /** Find a matching auto-fix for an issue description */
  private findAutoFix(issue: string): AutoFix | null {
    const issueLower = issue.toLowerCase();

    for (const fix of this.autoFixes) {
      switch (fix.condition) {
        case 'disk_space_low':
          if (issueLower.includes('disco') || issueLower.includes('disk') || issueLower.includes('storage')) {
            return fix;
          }
          break;
        case 'high_memory':
          if (issueLower.includes('ram') && (issueLower.includes('90%') || issueLower.includes('95%') || issueLower.includes('99%'))) {
            return fix;
          }
          break;
        case 'service_down':
          if (issueLower.includes('no responde') || issueLower.includes('down') || issueLower.includes('not responding')) {
            return fix;
          }
          break;
        case 'nginx_502':
          if (issueLower.includes('502') || issueLower.includes('bad gateway')) {
            return fix;
          }
          break;
        default:
          // Custom conditions — check if condition string appears in issue
          if (issueLower.includes(fix.condition.toLowerCase())) {
            return fix;
          }
          break;
      }
    }
    return null;
  }

  /** Execute an auto-fix command */
  private async executeFix(fix: AutoFix, issue: string): Promise<boolean> {
    if (!fix.command) return false;

    const shellTool = this.toolRegistry.get('shell');
    if (!shellTool) return false;

    try {
      const result = await shellTool.execute({ command: fix.command });
      return result.success;
    } catch (err) {
      logger.error(`Watchdog fix failed for "${fix.condition}"`, { error: err });
      return false;
    }
  }
}
