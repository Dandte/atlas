// ═══════════════════════════════════════
// ATLAS — Dashboard Events (Singleton)
// EventEmitter for real-time dashboard updates
// ═══════════════════════════════════════

import { EventEmitter } from 'events';

class DashboardEvents extends EventEmitter {
  emitLog(level: string, message: string, meta?: Record<string, any>): void {
    this.emit('log', { level, message, meta, timestamp: new Date().toISOString() });
  }

  emitToolExecution(toolName: string, params: Record<string, unknown>, success: boolean, durationMs: number): void {
    this.emit('tool_execution', { toolName, params, success, durationMs, timestamp: new Date().toISOString() });
  }

  emitAgentRouting(agentId: string, mode: string, confidence: number, reasoning: string): void {
    this.emit('agent_routing', { agentId, mode, confidence, reasoning, timestamp: new Date().toISOString() });
  }

  emitSystemStats(stats: Record<string, any>): void {
    this.emit('system_stats', { ...stats, timestamp: new Date().toISOString() });
  }

  emitTaskExecution(taskName: string, success: boolean, result?: string): void {
    this.emit('task_execution', { taskName, success, result, timestamp: new Date().toISOString() });
  }

  // ── Channel events (multi-instance WhatsApp) ──

  emitChannelStatus(data: { channelId: string; status: string; displayName: string; phoneHint?: string }): void {
    this.emit('channel_status', { ...data, timestamp: new Date().toISOString() });
  }

  emitChannelQR(data: { channelId: string; qrDataUrl: string }): void {
    this.emit('channel_qr', { ...data, timestamp: new Date().toISOString() });
  }

  emitChannelList(data: { channels: Array<{ id: string; type: string; status: string; displayName: string }> }): void {
    this.emit('channel_list', { ...data, timestamp: new Date().toISOString() });
  }

  // ── v0.9 Pipeline events ──

  emitPipelineTriggered(pipelineName: string, event: string, stepCount: number): void {
    this.emit('pipeline_triggered', { pipelineName, event, stepCount, timestamp: new Date().toISOString() });
  }

  emitPipelineCompleted(pipelineName: string, success: boolean, executionMs: number): void {
    this.emit('pipeline_completed', { pipelineName, success, executionMs, timestamp: new Date().toISOString() });
  }

  emitGoalProgress(goalName: string, progress: number, step: string): void {
    this.emit('goal_progress', { goalName, progress, step, timestamp: new Date().toISOString() });
  }

  // ── Streaming / Live conversation events ──

  emitStreamDelta(data: { sessionId: string; channel: string; text: string }): void {
    this.emit('stream_delta', { ...data, timestamp: new Date().toISOString() });
  }

  emitConversationStart(data: { sessionId: string; channel: string; userMessage: string }): void {
    this.emit('conversation_start', { ...data, timestamp: new Date().toISOString() });
  }

  emitConversationEnd(data: { sessionId: string; channel: string; response: string; processingTime: number; model: string; toolsUsed: string[] }): void {
    this.emit('conversation_end', { ...data, timestamp: new Date().toISOString() });
  }

  // ── Domótica events ──

  emitDeviceStateChanged(data: {
    deviceId: string; deviceName: string; deviceType: string;
    property: string; oldValue: unknown; newValue: unknown;
  }): void {
    this.emit('device_state_changed', { ...data, timestamp: new Date().toISOString() });
  }

  // ── n8n events ──

  emitN8nWorkflowTriggered(data: {
    workflowId: string; workflowName?: string; success: boolean;
  }): void {
    this.emit('n8n_workflow_triggered', { ...data, timestamp: new Date().toISOString() });
  }

  emitN8nWorkflowCompleted(data: {
    workflowId: string; success: boolean; result?: any;
  }): void {
    this.emit('n8n_workflow_completed', { ...data, timestamp: new Date().toISOString() });
  }
}

/** Singleton instance — import directly from any module */
export const dashboardEvents = new DashboardEvents();
