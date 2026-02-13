// ═══════════════════════════════════════
// ATLAS — Pipeline Engine
// v0.9 Feature 3: Event-driven automation
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { PipelineDefinition, PipelineStep, ToolResult } from '../types';
import { ToolRegistry } from '../motor/tool-registry';
import { ChannelManager } from '../channels/channel-manager';
import { dashboardEvents } from '../dashboard/events';
import { config } from '../config/config';
import logger from '../utils/logger';

export class PipelineEngine {
  private db: Database.Database;
  private registry: ToolRegistry;
  private channelManager: ChannelManager;
  private running: boolean = false;

  constructor(
    db: Database.Database,
    registry: ToolRegistry,
    channelManager: ChannelManager
  ) {
    this.db = db;
    this.registry = registry;
    this.channelManager = channelManager;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pipelines (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        trigger_event TEXT NOT NULL,
        trigger_filter TEXT,
        steps TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        run_count INTEGER DEFAULT 0,
        last_run DATETIME,
        last_result TEXT,
        created_by TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS pipeline_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pipeline_id TEXT NOT NULL,
        trigger_data TEXT,
        steps_completed INTEGER DEFAULT 0,
        total_steps INTEGER,
        success INTEGER,
        result TEXT,
        execution_ms INTEGER,
        executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (pipeline_id) REFERENCES pipelines(id)
      );
    `);
    logger.info('PipelineEngine tables initialized');
  }

  /** Start listening for events */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Subscribe to dashboard events
    dashboardEvents.on('tool_execution', (data: any) => {
      this.triggerEvent('tool_executed', data);
    });

    dashboardEvents.on('agent_routing', (data: any) => {
      this.triggerEvent('agent_routed', data);
    });

    dashboardEvents.on('channel_status', (data: any) => {
      const event = data.status === 'connected' ? 'channel_connected' : 'channel_disconnected';
      this.triggerEvent(event, data);
    });

    dashboardEvents.on('task_execution', (data: any) => {
      this.triggerEvent('schedule_triggered', data);
    });

    dashboardEvents.on('device_state_changed', (data: any) => {
      this.triggerEvent('device_state_changed', data);
    });

    // Webhook-triggered pipelines
    dashboardEvents.on('webhook_received', (data: any) => {
      if (data.pipelineId) {
        this.triggerManual(data.pipelineId, data.payload).catch(err => {
          logger.error(`Pipeline webhook trigger failed`, { pipelineId: data.pipelineId, error: err });
        });
      } else {
        this.triggerEvent('webhook_received', data);
      }
    });

    logger.info('PipelineEngine started — listening for events');
  }

  stop(): void {
    this.running = false;
    dashboardEvents.removeAllListeners('tool_execution');
    dashboardEvents.removeAllListeners('agent_routing');
    dashboardEvents.removeAllListeners('channel_status');
    dashboardEvents.removeAllListeners('task_execution');
    dashboardEvents.removeAllListeners('device_state_changed');
    dashboardEvents.removeAllListeners('webhook_received');
  }

  /** Trigger pipelines matching an event */
  private async triggerEvent(eventName: string, data: any): Promise<void> {
    if (!this.running) return;

    const pipelines = this.db.prepare(
      'SELECT * FROM pipelines WHERE trigger_event = ? AND enabled = 1'
    ).all(eventName) as any[];

    for (const pipeline of pipelines) {
      // Check trigger filter
      if (pipeline.trigger_filter) {
        try {
          const filter = JSON.parse(pipeline.trigger_filter);
          if (!this.matchesFilter(data, filter)) continue;
        } catch { continue; }
      }

      // Execute pipeline asynchronously
      this.executePipeline(pipeline, data).catch(err => {
        logger.error(`Pipeline "${pipeline.name}" execution failed`, { error: err });
      });
    }
  }

  /** Execute a pipeline's steps */
  private async executePipeline(pipeline: any, triggerData: any): Promise<void> {
    const startTime = Date.now();
    const steps: PipelineStep[] = JSON.parse(pipeline.steps);
    const maxSteps = config.pipelineMaxSteps;
    let stepsCompleted = 0;
    let lastResult: any = null;
    let success = true;

    logger.info(`Pipeline "${pipeline.name}" triggered by ${pipeline.trigger_event}`);

    const context: Record<string, any> = { trigger: triggerData, results: [] };

    for (let i = 0; i < Math.min(steps.length, maxSteps); i++) {
      const step = steps[i];
      try {
        lastResult = await this.executeStep(step, context);
        context.results.push({ step: i, result: lastResult });
        stepsCompleted++;
      } catch (err: any) {
        logger.error(`Pipeline "${pipeline.name}" step ${i} failed`, { error: err.message });
        success = false;
        lastResult = { error: err.message };
        break;
      }
    }

    const executionMs = Date.now() - startTime;

    // Log execution
    this.db.prepare(`
      INSERT INTO pipeline_executions (pipeline_id, trigger_data, steps_completed, total_steps, success, result, execution_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      pipeline.id,
      JSON.stringify(triggerData),
      stepsCompleted,
      steps.length,
      success ? 1 : 0,
      JSON.stringify(lastResult),
      executionMs
    );

    // Update pipeline stats
    this.db.prepare(`
      UPDATE pipelines SET run_count = run_count + 1, last_run = datetime('now'),
      last_result = ? WHERE id = ?
    `).run(success ? 'OK' : 'ERROR', pipeline.id);

    logger.info(`Pipeline "${pipeline.name}" completed: ${stepsCompleted}/${steps.length} steps, ${executionMs}ms`);
  }

  /** Execute a single pipeline step */
  private async executeStep(step: PipelineStep, context: Record<string, any>): Promise<any> {
    switch (step.type) {
      case 'call_tool': {
        const tool = this.registry.get(step.params.tool);
        if (!tool) throw new Error(`Tool not found: ${step.params.tool}`);
        const input = this.resolveParams(step.params.input || {}, context);
        const result = await tool.execute(input);
        return result;
      }

      case 'send_message': {
        const channel = step.params.channel as string;
        const message = this.resolveTemplate(step.params.message as string, context);
        const chatId = step.params.chatId as string;
        await this.channelManager.sendToChannel(channel, message, chatId);
        return { sent: true, channel };
      }

      case 'save_fact': {
        const key = this.resolveTemplate(step.params.key as string, context);
        const value = this.resolveTemplate(step.params.value as string, context);
        // Use direct DB insert since we don't have MemoryManager reference
        this.db.prepare(`
          INSERT OR REPLACE INTO facts (id, key, value, category, source, confidence, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'pipeline', 0.7, datetime('now'), datetime('now'))
        `).run(uuid(), key, value, step.params.category || 'pipeline');
        return { saved: true, key };
      }

      case 'wait': {
        const ms = step.params.ms as number || 1000;
        await new Promise(resolve => setTimeout(resolve, Math.min(ms, 30000)));
        return { waited: ms };
      }

      case 'condition': {
        const field = step.params.field as string;
        const operator = step.params.operator as string;
        const expected = step.params.value;
        const actual = this.getNestedValue(context, field);

        let passed = false;
        switch (operator) {
          case 'equals': passed = actual === expected; break;
          case 'contains': passed = String(actual).includes(String(expected)); break;
          case 'gt': passed = Number(actual) > Number(expected); break;
          case 'lt': passed = Number(actual) < Number(expected); break;
          default: passed = !!actual;
        }

        if (!passed && step.params.failAction === 'abort') {
          throw new Error(`Condition failed: ${field} ${operator} ${expected}`);
        }
        return { passed, field, actual };
      }

      case 'route_to_agent': {
        const agentId = step.params.agent as string;
        const message = this.resolveTemplate(step.params.message as string, context);
        // Delegate to the processor (Coordinator) via channelManager
        const result = await this.channelManager.processMessage({
          id: uuid(),
          channel: 'pipeline',
          chatId: 'pipeline-internal',
          userId: 'pipeline',
          text: agentId ? `@${agentId} ${message}` : message,
          timestamp: new Date(),
        });
        return { agent: agentId, response: result.response.substring(0, 1000) };
      }

      case 'call_n8n': {
        const n8nTool = this.registry.get('n8n');
        if (!n8nTool) throw new Error('n8n tool not registered. Set N8N_ENABLED=true');
        const workflowId = this.resolveTemplate(step.params.workflow_id || '', context);
        const webhookPath = this.resolveTemplate(step.params.webhook_path || '', context);
        const payload = this.resolveParams(step.params.payload || {}, context);
        const triggerParams: Record<string, unknown> = { action: 'trigger', payload };
        if (workflowId) triggerParams.workflow_id = workflowId;
        if (webhookPath) triggerParams.webhook_path = webhookPath;
        const result = await n8nTool.execute(triggerParams);
        if (!result.success) throw new Error(result.error || 'n8n trigger failed');
        return result;
      }

      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  }

  private matchesFilter(data: any, filter: Record<string, any>): boolean {
    for (const [key, expected] of Object.entries(filter)) {
      const actual = this.getNestedValue(data, key);
      if (actual !== expected) return false;
    }
    return true;
  }

  private resolveParams(params: Record<string, any>, context: Record<string, any>): Record<string, any> {
    const resolved: Record<string, any> = {};
    for (const [key, value] of Object.entries(params)) {
      resolved[key] = typeof value === 'string' ? this.resolveTemplate(value, context) : value;
    }
    return resolved;
  }

  private resolveTemplate(template: string, context: Record<string, any>): string {
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, path) => {
      return String(this.getNestedValue(context, path) ?? '');
    });
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  // ── CRUD ──

  createPipeline(name: string, description: string, triggerEvent: string, steps: PipelineStep[], triggerFilter?: Record<string, any>): string {
    const id = uuid();
    this.db.prepare(`
      INSERT INTO pipelines (id, name, description, trigger_event, trigger_filter, steps)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, description, triggerEvent, triggerFilter ? JSON.stringify(triggerFilter) : null, JSON.stringify(steps));
    logger.info(`Pipeline created: "${name}" (trigger: ${triggerEvent})`);
    return id;
  }

  listPipelines(): PipelineDefinition[] {
    const rows = this.db.prepare('SELECT * FROM pipelines ORDER BY created_at DESC').all() as any[];
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      triggerEvent: r.trigger_event,
      triggerFilter: r.trigger_filter ? JSON.parse(r.trigger_filter) : undefined,
      steps: JSON.parse(r.steps),
      enabled: r.enabled === 1,
      runCount: r.run_count,
      lastRun: r.last_run,
      lastResult: r.last_result,
      createdBy: r.created_by,
    }));
  }

  deletePipeline(id: string): boolean {
    this.db.prepare('DELETE FROM pipeline_executions WHERE pipeline_id = ?').run(id);
    const result = this.db.prepare('DELETE FROM pipelines WHERE id = ?').run(id);
    return result.changes > 0;
  }

  togglePipeline(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE pipelines SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  getExecutions(pipelineId?: string, limit: number = 50): any[] {
    if (pipelineId) {
      return this.db.prepare(
        'SELECT * FROM pipeline_executions WHERE pipeline_id = ? ORDER BY executed_at DESC LIMIT ?'
      ).all(pipelineId, limit);
    }
    return this.db.prepare(
      'SELECT * FROM pipeline_executions ORDER BY executed_at DESC LIMIT ?'
    ).all(limit);
  }

  /** Manually trigger a pipeline */
  async triggerManual(pipelineId: string, data?: any): Promise<void> {
    const pipeline = this.db.prepare('SELECT * FROM pipelines WHERE id = ?').get(pipelineId) as any;
    if (!pipeline) throw new Error(`Pipeline not found: ${pipelineId}`);
    await this.executePipeline(pipeline, data || {});
  }
}
