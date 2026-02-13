// ═══════════════════════════════════════
// ATLAS — Approval Context (AsyncLocalStorage)
// Propagates channel+chatId through async chain
// ═══════════════════════════════════════

import { AsyncLocalStorage } from 'async_hooks';

export interface ApprovalContextData {
  channel: string;
  chatId: string;
}

export const approvalContext = new AsyncLocalStorage<ApprovalContextData>();
