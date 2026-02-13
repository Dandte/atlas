// ═══════════════════════════════════════
// ATLAS — ERP Integration Tool
// v0.9 Feature 12: Business operations
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';

export class ERPTool implements Tool {
  definition = {
    name: 'erp',
    description: 'Consultas de negocio: inventario, ventas, clientes, facturas, productos, deudas. Conecta con el sistema ERP del negocio.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['inventory_check', 'sales_report', 'customer_lookup', 'invoice_generate',
                 'low_stock', 'top_products', 'daily_summary', 'debt_check'],
          description: 'Accion a ejecutar',
        },
        product: { type: 'string', description: 'Nombre o codigo del producto (para inventory_check)' },
        customer: { type: 'string', description: 'Nombre, cedula o telefono del cliente' },
        date_from: { type: 'string', description: 'Fecha inicio (YYYY-MM-DD). Default: hoy' },
        date_to: { type: 'string', description: 'Fecha fin (YYYY-MM-DD). Default: hoy' },
        limit: { type: 'number', description: 'Limite de resultados. Default: 20' },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;
    const apiUrl = config.laravelApiUrl;

    if (!apiUrl) {
      return { success: false, output: '', error: 'LARAVEL_API_URL not configured' };
    }

    try {
      switch (action) {
        case 'inventory_check': {
          const product = params.product as string;
          if (!product) return { success: false, output: '', error: 'Se requiere product' };
          const data = await this.apiCall(`/api/inventory/search?q=${encodeURIComponent(product)}`);
          if (!data || data.length === 0) return { success: true, output: `No se encontro "${product}" en inventario.` };
          const lines = data.map((item: any) =>
            `- ${item.name}: ${item.stock} unidades, $${item.price?.toLocaleString() || 'N/A'}`
          );
          return { success: true, output: `Inventario para "${product}":\n${lines.join('\n')}` };
        }

        case 'sales_report': {
          const from = params.date_from as string || new Date().toISOString().split('T')[0];
          const to = params.date_to as string || from;
          const data = await this.apiCall(`/api/sales/report?from=${from}&to=${to}`);
          let output = `Reporte de ventas ${from}${from !== to ? ` a ${to}` : ''}:\n`;
          output += `Total: $${data.total?.toLocaleString() || 0}\n`;
          output += `Transacciones: ${data.count || 0}\n`;
          if (data.top_products) {
            output += `Top productos:\n`;
            for (const p of data.top_products.slice(0, 5)) {
              output += `  - ${p.name}: ${p.quantity} vendidos ($${p.revenue?.toLocaleString()})\n`;
            }
          }
          return { success: true, output };
        }

        case 'customer_lookup': {
          const customer = params.customer as string;
          if (!customer) return { success: false, output: '', error: 'Se requiere customer' };
          const data = await this.apiCall(`/api/customers/search?q=${encodeURIComponent(customer)}`);
          if (!data || data.length === 0) return { success: true, output: `Cliente "${customer}" no encontrado.` };
          const lines = data.map((c: any) =>
            `- ${c.name} (${c.id_number || 'sin cedula'}): tel ${c.phone || 'N/A'}, saldo $${c.balance?.toLocaleString() || 0}`
          );
          return { success: true, output: `Clientes encontrados:\n${lines.join('\n')}` };
        }

        case 'low_stock': {
          const limit = (params.limit as number) || 20;
          const data = await this.apiCall(`/api/inventory/low-stock?limit=${limit}`);
          if (!data || data.length === 0) return { success: true, output: 'No hay productos con stock bajo.' };
          const lines = data.map((item: any) =>
            `- ${item.name}: ${item.stock} unidades (min: ${item.min_stock || 'N/A'})`
          );
          return { success: true, output: `Productos con stock bajo (${data.length}):\n${lines.join('\n')}` };
        }

        case 'top_products': {
          const from = params.date_from as string || new Date().toISOString().split('T')[0];
          const to = params.date_to as string || from;
          const limit = (params.limit as number) || 10;
          const data = await this.apiCall(`/api/sales/top-products?from=${from}&to=${to}&limit=${limit}`);
          if (!data || data.length === 0) return { success: true, output: 'No hay datos de productos.' };
          const lines = data.map((p: any, i: number) =>
            `${i + 1}. ${p.name}: ${p.quantity} vendidos — $${p.revenue?.toLocaleString()}`
          );
          return { success: true, output: `Top ${data.length} productos (${from} a ${to}):\n${lines.join('\n')}` };
        }

        case 'daily_summary': {
          const date = params.date_from as string || new Date().toISOString().split('T')[0];
          const data = await this.apiCall(`/api/reports/daily?date=${date}`);
          let output = `Resumen del dia ${date}:\n`;
          output += `Ventas: $${data.sales_total?.toLocaleString() || 0} (${data.sales_count || 0} transacciones)\n`;
          output += `Clientes nuevos: ${data.new_customers || 0}\n`;
          output += `Creditos otorgados: $${data.credits_total?.toLocaleString() || 0}\n`;
          output += `Pagos recibidos: $${data.payments_total?.toLocaleString() || 0}\n`;
          return { success: true, output };
        }

        case 'debt_check': {
          const customer = params.customer as string;
          if (!customer) return { success: false, output: '', error: 'Se requiere customer' };
          const data = await this.apiCall(`/api/credits/check?customer=${encodeURIComponent(customer)}`);
          if (!data) return { success: true, output: `No se encontraron creditos para "${customer}".` };
          let output = `Creditos de ${data.customer_name || customer}:\n`;
          output += `Deuda total: $${data.total_debt?.toLocaleString() || 0}\n`;
          if (data.credits) {
            for (const c of data.credits) {
              output += `- ${c.id}: $${c.amount?.toLocaleString()} — cuota $${c.installment?.toLocaleString()}, ${c.status}\n`;
            }
          }
          return { success: true, output };
        }

        case 'invoice_generate': {
          return { success: false, output: '', error: 'Generacion de facturas requiere aprobacion manual. Usa el ERP directamente.' };
        }

        default:
          return { success: false, output: '', error: `Accion desconocida: ${action}` };
      }
    } catch (err: any) {
      return { success: false, output: '', error: `ERP error: ${err.message}` };
    }
  }

  private async apiCall(endpoint: string): Promise<any> {
    const url = `${config.laravelApiUrl}${endpoint}`;
    const headers: Record<string, string> = { 'Accept': 'application/json' };

    if (config.laravelApiToken) {
      headers['Authorization'] = `Bearer ${config.laravelApiToken}`;
    }

    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      throw new Error(`API returned ${resp.status}: ${resp.statusText}`);
    }

    const data = await resp.json();
    return data.data || data;
  }
}
