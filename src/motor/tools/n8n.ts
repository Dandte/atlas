// ═══════════════════════════════════════
// ATLAS — n8n Integration Tool
// Bidirectional workflow automation with remote n8n
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { dashboardEvents } from '../../dashboard/events';
import { config } from '../../config/config';
import logger from '../../utils/logger';

export class N8nTool implements Tool {
  private baseUrl: string;
  private apiKey: string;
  private webhookBaseUrl: string;
  private getWebhookServer: (() => any) | null;

  definition: ToolDefinition = {
    name: 'n8n',
    description: 'Integración con n8n para automatización de workflows. Acciones: trigger (ejecutar workflow), list (listar workflows), status (estado/ejecuciones), activate, deactivate, executions (historial global), create_webhook (crear webhook ATLAS para callback de n8n)',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['trigger', 'list', 'status', 'activate', 'deactivate', 'executions', 'create_webhook'],
          description: 'Acción a ejecutar',
        },
        workflow_id: {
          type: 'string',
          description: 'ID del workflow (para trigger, status, activate, deactivate)',
        },
        webhook_path: {
          type: 'string',
          description: 'Path del webhook de n8n (alternativa a workflow_id para trigger)',
        },
        payload: {
          type: 'object',
          description: 'Datos a enviar al workflow (para trigger)',
        },
        limit: {
          type: 'number',
          description: 'Límite de resultados (default: 10)',
        },
        webhook_name: {
          type: 'string',
          description: 'Nombre del webhook a crear en ATLAS (para create_webhook)',
        },
        webhook_action: {
          type: 'string',
          enum: ['notify', 'message', 'pipeline'],
          description: 'Acción del webhook ATLAS: notify, message, pipeline. Default: notify',
        },
        webhook_channel: {
          type: 'string',
          description: 'Canal destino para notificaciones del webhook. Default: telegram',
        },
        pipeline_id: {
          type: 'string',
          description: 'ID del pipeline a disparar (si webhook_action=pipeline)',
        },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  constructor(getWebhookServer?: () => any) {
    this.baseUrl = (config.n8nUrl || 'http://localhost:5678').replace(/\/$/, '');
    this.apiKey = config.n8nApiKey || '';
    this.webhookBaseUrl = config.n8nWebhookBaseUrl
      ? config.n8nWebhookBaseUrl.replace(/\/$/, '')
      : this.baseUrl;
    this.getWebhookServer = getWebhookServer || null;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;

    if (!this.baseUrl || !this.apiKey) {
      return { success: false, output: '', error: 'n8n no configurado. Definí N8N_URL y N8N_API_KEY en .env' };
    }

    try {
      switch (action) {
        case 'list': return this.listWorkflows(params.limit as number | undefined);
        case 'trigger': return this.triggerWorkflow(params);
        case 'status': return this.workflowStatus(params);
        case 'activate': return this.setWorkflowActive(params.workflow_id as string, true);
        case 'deactivate': return this.setWorkflowActive(params.workflow_id as string, false);
        case 'executions': return this.globalExecutions(params.limit as number | undefined);
        case 'create_webhook': return this.createAtlasWebhook(params);
        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      logger.error('N8nTool error', { action, error: err.message });
      return { success: false, output: '', error: `Error n8n: ${err.message}` };
    }
  }

  // ── HTTP Client ──

  private async n8nRequest(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: any,
    isWebhook: boolean = false
  ): Promise<{ ok: boolean; data?: any; error?: string }> {
    const base = isWebhook ? this.webhookBaseUrl : this.baseUrl;
    const url = `${base}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (!isWebhook) {
      headers['X-N8N-API-KEY'] = this.apiKey;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const resp = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        if (resp.status === 401) return { ok: false, error: 'Autenticación fallida. Verificá N8N_API_KEY.' };
        if (resp.status === 404) return { ok: false, error: `No encontrado: ${path}` };
        return { ok: false, error: `HTTP ${resp.status}: ${text.substring(0, 200)}` };
      }

      const data = await resp.json().catch(() => ({}));
      return { ok: true, data };
    } catch (err: any) {
      if (err.name === 'AbortError') return { ok: false, error: 'Timeout (30s) conectando a n8n' };
      if (err.code === 'ECONNREFUSED') return { ok: false, error: `n8n no accesible en ${base}` };
      return { ok: false, error: `Error de conexión: ${err.message}` };
    }
  }

  // ── Actions ──

  private async listWorkflows(limit?: number): Promise<ToolResult> {
    const n = limit || 20;
    const resp = await this.n8nRequest('GET', `/api/v1/workflows?limit=${n}`);
    if (!resp.ok) return { success: false, output: '', error: resp.error };

    const workflows = resp.data?.data || resp.data || [];
    const lines = workflows.map((w: any) =>
      `- ${w.active ? '✅' : '⏸️'} **${w.name}** (ID: ${w.id})${w.updatedAt ? ` — updated ${new Date(w.updatedAt).toLocaleDateString()}` : ''}`
    );

    return {
      success: true,
      output: workflows.length > 0
        ? `Workflows en n8n (${workflows.length}):\n${lines.join('\n')}`
        : 'No hay workflows en n8n.',
    };
  }

  private async triggerWorkflow(params: Record<string, unknown>): Promise<ToolResult> {
    const workflowId = params.workflow_id as string | undefined;
    const webhookPath = params.webhook_path as string | undefined;
    const payload = (params.payload as Record<string, any>) || {};

    if (!workflowId && !webhookPath) {
      return { success: false, output: '', error: 'Se necesita workflow_id o webhook_path' };
    }

    let resp;
    let identifier: string;

    if (webhookPath) {
      // Trigger via n8n webhook endpoint (no API key needed)
      const path = webhookPath.startsWith('/') ? webhookPath : `/webhook/${webhookPath}`;
      resp = await this.n8nRequest('POST', path, payload, true);
      identifier = webhookPath;
    } else {
      // Trigger via n8n REST API
      resp = await this.n8nRequest('POST', `/api/v1/workflows/${workflowId}/run`, { payload });
      identifier = workflowId!;
    }

    dashboardEvents.emitN8nWorkflowTriggered({
      workflowId: identifier,
      success: resp.ok,
    });

    if (!resp.ok) return { success: false, output: '', error: resp.error };

    const executionId = resp.data?.data?.executionId || resp.data?.executionId || 'unknown';
    return {
      success: true,
      output: `Workflow ${identifier} ejecutado. Execution ID: ${executionId}`,
    };
  }

  private async workflowStatus(params: Record<string, unknown>): Promise<ToolResult> {
    const id = params.workflow_id as string;
    if (!id) return { success: false, output: '', error: 'Se necesita workflow_id' };

    const limit = (params.limit as number) || 5;

    // Get workflow info + recent executions in parallel
    const [wfResp, exResp] = await Promise.all([
      this.n8nRequest('GET', `/api/v1/workflows/${id}`),
      this.n8nRequest('GET', `/api/v1/executions?workflowId=${id}&limit=${limit}`),
    ]);

    if (!wfResp.ok) return { success: false, output: '', error: wfResp.error };

    const wf = wfResp.data;
    const executions = exResp.data?.data || [];

    let output = `**${wf.name}** (ID: ${wf.id})\n`;
    output += `Estado: ${wf.active ? 'Activo ✅' : 'Inactivo ⏸️'}\n`;
    output += `Nodos: ${wf.nodes?.length || 0}\n`;
    if (wf.updatedAt) output += `Última modificación: ${new Date(wf.updatedAt).toLocaleString()}\n`;

    if (executions.length > 0) {
      output += `\nÚltimas ${executions.length} ejecuciones:\n`;
      for (const ex of executions) {
        const status = ex.finished
          ? (ex.stoppedAt ? '✅ Completada' : '❌ Fallida')
          : '⏳ En progreso';
        output += `- #${ex.id} ${status} — ${new Date(ex.startedAt).toLocaleString()}\n`;
      }
    } else {
      output += '\nSin ejecuciones recientes.';
    }

    return { success: true, output };
  }

  private async setWorkflowActive(id: string, active: boolean): Promise<ToolResult> {
    if (!id) return { success: false, output: '', error: 'Se necesita workflow_id' };

    const endpoint = active
      ? `/api/v1/workflows/${id}/activate`
      : `/api/v1/workflows/${id}/deactivate`;
    const resp = await this.n8nRequest('POST', endpoint);
    if (!resp.ok) return { success: false, output: '', error: resp.error };

    return {
      success: true,
      output: `Workflow ${id} ${active ? 'activado ✅' : 'desactivado ⏸️'}`,
    };
  }

  private async globalExecutions(limit?: number): Promise<ToolResult> {
    const n = limit || 10;
    const resp = await this.n8nRequest('GET', `/api/v1/executions?limit=${n}`);
    if (!resp.ok) return { success: false, output: '', error: resp.error };

    const executions = resp.data?.data || [];
    if (executions.length === 0) {
      return { success: true, output: 'Sin ejecuciones recientes.' };
    }

    const lines = executions.map((ex: any) => {
      const status = ex.finished
        ? (ex.stoppedAt ? '✅' : '❌')
        : '⏳';
      const name = ex.workflowData?.name || `Workflow ${ex.workflowId}`;
      return `- ${status} #${ex.id} **${name}** — ${new Date(ex.startedAt).toLocaleString()}`;
    });

    return {
      success: true,
      output: `Últimas ${executions.length} ejecuciones:\n${lines.join('\n')}`,
    };
  }

  private async createAtlasWebhook(params: Record<string, unknown>): Promise<ToolResult> {
    const ws = this.getWebhookServer?.();
    if (!ws) {
      return { success: false, output: '', error: 'WebhookServer no disponible. Habilitá WEBHOOK_ENABLED=true' };
    }

    const name = (params.webhook_name as string) || 'n8n-callback';
    const action = (params.webhook_action as string) || 'notify';
    const channel = (params.webhook_channel as string) || 'telegram';
    const pipelineId = params.pipeline_id as string | undefined;

    const webhookId = `n8n-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    const secret = this.generateSecret();

    const actionParams: Record<string, any> = {};
    if (action === 'pipeline' && pipelineId) {
      actionParams.pipelineId = pipelineId;
    }

    try {
      ws.createWebhook(webhookId, `n8n: ${name}`, action, channel, secret, actionParams);
    } catch (err: any) {
      if (err.message?.includes('already exists') || err.message?.includes('UNIQUE')) {
        return { success: false, output: '', error: `Webhook "${webhookId}" ya existe. Usá otro nombre.` };
      }
      throw err;
    }

    const webhookUrl = `http://<ATLAS_HOST>:${config.webhookPort}/webhook/${webhookId}`;

    return {
      success: true,
      output: [
        `Webhook creado: **${webhookId}**`,
        `URL: ${webhookUrl}`,
        `Secret: ${secret}`,
        `Acción: ${action} → ${channel}`,
        '',
        'Para configurar en n8n:',
        '1. Añadí un nodo "HTTP Request" al workflow',
        `2. URL: ${webhookUrl}`,
        '3. Method: POST',
        `4. Header: x-webhook-secret = ${secret}`,
        '5. Body: JSON con los datos que quieras enviar',
      ].join('\n'),
    };
  }

  private generateSecret(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let result = '';
    for (let i = 0; i < 32; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
  }
}
