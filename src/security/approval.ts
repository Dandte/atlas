// ═══════════════════════════════════════
// ATLAS — Approval System
// Multi-channel approval for dangerous actions
// ═══════════════════════════════════════

import { ApprovalHandler } from '../types';
import { approvalContext } from './approval-context';
import logger from '../utils/logger';

/**
 * Manages approval for dangerous tool executions.
 * Each channel registers its own handler via setChannelHandler().
 * requestApproval() reads the AsyncLocalStorage context to route
 * the approval request to the correct channel.
 */
export class ApprovalSystem {
  private defaultHandler: ApprovalHandler | null = null;
  private channelHandlers: Map<string, ApprovalHandler> = new Map();

  /** @deprecated Use setChannelHandler instead. Kept as fallback. */
  setHandler(handler: ApprovalHandler): void {
    this.defaultHandler = handler;
  }

  /** Register an approval handler for a specific channel */
  setChannelHandler(channelName: string, handler: ApprovalHandler): void {
    this.channelHandlers.set(channelName, handler);
    logger.debug(`Approval handler registered for channel: ${channelName}`);
  }

  /** Request approval for a dangerous action */
  async requestApproval(tool: string, params: Record<string, unknown>, description: string): Promise<boolean> {
    const ctx = approvalContext.getStore();
    const channelName = ctx?.channel;

    // Try channel-specific handler first
    let handler: ApprovalHandler | null = null;
    if (channelName) {
      handler = this.channelHandlers.get(channelName) ?? null;
    }

    // Fallback to default handler (legacy CLI)
    if (!handler) {
      handler = this.defaultHandler;
    }

    if (!handler) {
      logger.warn(`No approval handler for channel="${channelName || 'unknown'}" — denying: ${tool}`);
      return false;
    }

    try {
      const approved = await handler({ tool, params, description });
      logger.info(`Approval ${approved ? 'granted' : 'denied'} for ${tool} (channel=${channelName || 'default'})`, { params });
      return approved;
    } catch (err) {
      logger.error('Error requesting approval', { error: err });
      return false;
    }
  }
}

export const approvalSystem = new ApprovalSystem();
