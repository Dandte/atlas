// ═══════════════════════════════════════
// ATLAS — Permission Checker
// v0.9 Feature 9: Role-based tool restrictions
// ═══════════════════════════════════════

import { UserManager } from './user-manager';
import { UserRole } from '../types';
import logger from '../utils/logger';

export class PermissionChecker {
  private userManager: UserManager;

  constructor(userManager: UserManager) {
    this.userManager = userManager;
  }

  /** Check if a user role can use a specific tool */
  canUseTool(role: UserRole, toolName: string): boolean {
    return this.userManager.canUseTool(role, toolName);
  }

  /** Check if a user (by identifier) can use a tool */
  canUserUseTool(identifier: string, toolName: string): boolean {
    const user = this.userManager.getUser(identifier);
    if (!user) return false; // Unknown users denied
    return this.canUseTool(user.role, toolName);
  }

  /** Get restricted tools for a role */
  getRestrictedTools(role: UserRole): string[] {
    // Return tools that are explicitly denied
    const perms = this.userManager.getPermissions(role);
    return perms
      .filter(p => !p.allowed && p.permission.startsWith('tool:'))
      .map(p => p.permission.replace('tool:', ''));
  }

  /** Log a permission denial */
  logDenial(identifier: string, role: UserRole, toolName: string): void {
    logger.warn(`Permission denied: user "${identifier}" (${role}) tried to use tool "${toolName}"`);
  }
}
