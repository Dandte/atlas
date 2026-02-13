// ═══════════════════════════════════════
// ATLAS — Laravel API Tool
// Connect to user's Laravel REST APIs
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';

export class LaravelApiTool implements Tool {
  definition = {
    name: 'laravel_api',
    description: 'Query the user\'s Laravel API. Supports GET, POST, PUT, DELETE to any endpoint. Uses the configured base URL and authentication token.',
    input_schema: {
      type: 'object' as const,
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE'],
          description: 'HTTP method',
        },
        endpoint: {
          type: 'string',
          description: 'API endpoint without base URL (e.g., "users", "sales/today", "products?page=1")',
        },
        query_params: {
          type: 'string',
          description: 'Query parameters (e.g., "page=1&limit=10")',
        },
        body: {
          type: 'string',
          description: 'JSON body for POST/PUT requests',
        },
      },
      required: ['method', 'endpoint'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const method = (params.method as string) || 'GET';
    const endpoint = (params.endpoint as string).replace(/^\//, '');
    const queryParams = params.query_params as string | undefined;
    const body = params.body as string | undefined;

    if (!config.laravelApiUrl) {
      return { success: false, output: '', error: 'LARAVEL_API_URL no está configurado en .env' };
    }

    try {
      // Build full URL
      let url = `${config.laravelApiUrl.replace(/\/$/, '')}/${endpoint}`;
      if (queryParams) {
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}${queryParams}`;
      }

      // Build headers
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      };

      if (config.laravelApiToken) {
        headers['Authorization'] = `Bearer ${config.laravelApiToken}`;
      }

      // Build request
      const opts: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(30000),
      };

      if (body && (method === 'POST' || method === 'PUT')) {
        // Validate body is valid JSON
        try {
          JSON.parse(body);
          opts.body = body;
        } catch {
          return { success: false, output: '', error: 'Body inválido: no es JSON válido' };
        }
      }

      logger.debug(`Laravel API: ${method} ${url}`);
      const res = await fetch(url, opts);

      const contentType = res.headers.get('content-type') ?? '';
      let responseBody: string;

      if (contentType.includes('application/json')) {
        const json = await res.json();
        responseBody = JSON.stringify(json, null, 2);
      } else {
        responseBody = await res.text();
      }

      if (!res.ok) {
        const errorMsgs: Record<number, string> = {
          401: 'No autorizado — revisá LARAVEL_API_TOKEN',
          403: 'Prohibido — no tenés permisos para este endpoint',
          404: `Endpoint no encontrado: ${endpoint}`,
          422: 'Error de validación',
          500: 'Error interno del servidor',
        };
        const hint = errorMsgs[res.status] ?? `HTTP ${res.status}`;

        return {
          success: false,
          output: responseBody,
          error: `${hint}\nRespuesta: ${responseBody.substring(0, 2000)}`,
        };
      }

      // Truncate large responses
      if (responseBody.length > 50000) {
        responseBody = responseBody.substring(0, 50000) + '\n... [truncado]';
      }

      return {
        success: true,
        output: `${method} ${endpoint} → ${res.status}\n\n${responseBody}`,
      };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: `Error en Laravel API: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
