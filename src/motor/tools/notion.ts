// ═══════════════════════════════════════
// ATLAS — Notion Integration Tool
// Read/write Notion pages and databases
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';

export class NotionTool implements Tool {
  definition: ToolDefinition = {
    name: 'notion',
    description: 'Integración con Notion. Acciones: search (buscar páginas/bases de datos), read_page (leer contenido), create_page (crear página), update_page (actualizar), query_database (consultar base de datos), add_to_database (agregar registro), list_databases (ver bases de datos).',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'read_page', 'create_page', 'update_page', 'query_database', 'add_to_database', 'list_databases'],
          description: 'Acción a realizar',
        },
        query: {
          type: 'string',
          description: 'Término de búsqueda (para action=search)',
        },
        page_id: {
          type: 'string',
          description: 'ID de la página (para read/update)',
        },
        database_id: {
          type: 'string',
          description: 'ID de la base de datos (para query/add)',
        },
        title: {
          type: 'string',
          description: 'Título de la página (para create/update)',
        },
        content: {
          type: 'string',
          description: 'Contenido en markdown (para create/update)',
        },
        parent_page_id: {
          type: 'string',
          description: 'ID de la página padre (para create_page)',
        },
        properties: {
          type: 'object',
          description: 'Propiedades para crear/filtrar registros en database. Ej: {"Status": "Done", "Priority": "High"}',
        },
        filter: {
          type: 'object',
          description: 'Filtro Notion para query_database. Ej: {"property": "Status", "status": {"equals": "In Progress"}}',
        },
      },
      required: ['action'],
    },
  };

  private getClient(): any {
    const apiKey = (config as any).notionApiKey;
    if (!apiKey) throw new Error('NOTION_API_KEY no configurada');
    const { Client } = require('@notionhq/client');
    return new Client({ auth: apiKey });
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || '');

    try {
      switch (action) {
        case 'search': return await this.search(String(params.query || ''));
        case 'read_page': return await this.readPage(String(params.page_id || ''));
        case 'create_page': return await this.createPage(params);
        case 'update_page': return await this.updatePage(params);
        case 'query_database': return await this.queryDatabase(params);
        case 'add_to_database': return await this.addToDatabase(params);
        case 'list_databases': return await this.listDatabases();
        default: return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      if (/Cannot find module/i.test(err.message)) {
        return { success: false, output: '', error: 'npm install @notionhq/client' };
      }
      logger.error('Notion error', { error: err, action });
      return { success: false, output: '', error: `Error Notion: ${err.message}` };
    }
  }

  private async search(query: string): Promise<ToolResult> {
    const notion = this.getClient();
    const response = await notion.search({
      query: query || undefined,
      page_size: 10,
    });

    const results = response.results.map((r: any) => {
      const title = this.extractTitle(r);
      const type = r.object;
      return `  [${type}] ${title} (${r.id})`;
    });

    return {
      success: true,
      output: results.length > 0
        ? `Resultados (${results.length}):\n${results.join('\n')}`
        : 'No se encontraron resultados.',
    };
  }

  private async readPage(pageId: string): Promise<ToolResult> {
    if (!pageId) return { success: false, output: '', error: 'Se requiere page_id' };

    const notion = this.getClient();
    const page = await notion.pages.retrieve({ page_id: pageId });
    const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });

    const title = this.extractTitle(page);
    const content = blocks.results.map((b: any) => this.blockToText(b)).filter(Boolean).join('\n');

    return {
      success: true,
      output: `📄 ${title}\n${'─'.repeat(40)}\n${content || '(Página vacía)'}`,
    };
  }

  private async createPage(params: Record<string, unknown>): Promise<ToolResult> {
    const title = String(params.title || '');
    if (!title) return { success: false, output: '', error: 'Se requiere title' };

    const notion = this.getClient();
    const content = String(params.content || '');
    const parentPageId = String(params.parent_page_id || '');
    const databaseId = String(params.database_id || '');

    let parent: any;
    if (databaseId) {
      parent = { database_id: databaseId };
    } else if (parentPageId) {
      parent = { page_id: parentPageId };
    } else {
      return { success: false, output: '', error: 'Se requiere parent_page_id o database_id' };
    }

    const properties: any = databaseId
      ? { Name: { title: [{ text: { content: title } }] }, ...this.buildProperties(params.properties as Record<string, string>) }
      : { title: { title: [{ text: { content: title } }] } };

    const children = content ? this.markdownToBlocks(content) : [];

    const page = await notion.pages.create({
      parent,
      properties,
      children,
    });

    return {
      success: true,
      output: `Página creada: ${title}\nID: ${page.id}\nURL: ${page.url}`,
    };
  }

  private async updatePage(params: Record<string, unknown>): Promise<ToolResult> {
    const pageId = String(params.page_id || '');
    if (!pageId) return { success: false, output: '', error: 'Se requiere page_id' };

    const notion = this.getClient();
    const content = String(params.content || '');

    if (content) {
      const blocks = this.markdownToBlocks(content);
      for (const block of blocks) {
        await notion.blocks.children.append({ block_id: pageId, children: [block] });
      }
    }

    if (params.properties) {
      await notion.pages.update({
        page_id: pageId,
        properties: this.buildProperties(params.properties as Record<string, string>),
      });
    }

    return { success: true, output: `Página ${pageId} actualizada.` };
  }

  private async queryDatabase(params: Record<string, unknown>): Promise<ToolResult> {
    const databaseId = String(params.database_id || '');
    if (!databaseId) return { success: false, output: '', error: 'Se requiere database_id' };

    const notion = this.getClient();
    const response = await notion.databases.query({
      database_id: databaseId,
      filter: params.filter as any || undefined,
      page_size: 20,
    });

    const rows = response.results.map((page: any) => {
      const title = this.extractTitle(page);
      const props = Object.entries(page.properties)
        .filter(([key]) => key !== 'Name' && key !== 'title')
        .map(([key, val]: [string, any]) => `${key}: ${this.extractPropertyValue(val)}`)
        .join(' | ');
      return `  ${title} — ${props}`;
    });

    return {
      success: true,
      output: rows.length > 0
        ? `Registros (${rows.length}):\n${rows.join('\n')}`
        : 'Base de datos vacía o sin resultados.',
    };
  }

  private async addToDatabase(params: Record<string, unknown>): Promise<ToolResult> {
    const databaseId = String(params.database_id || '');
    const title = String(params.title || '');
    if (!databaseId || !title) return { success: false, output: '', error: 'Se requiere database_id y title' };

    return this.createPage({ ...params, database_id: databaseId, title });
  }

  private async listDatabases(): Promise<ToolResult> {
    const notion = this.getClient();
    const response = await notion.search({
      filter: { property: 'object', value: 'database' },
      page_size: 20,
    });

    const dbs = response.results.map((db: any) => {
      const title = db.title?.[0]?.plain_text || 'Sin título';
      return `  ${title} (${db.id})`;
    });

    return {
      success: true,
      output: dbs.length > 0 ? `Bases de datos (${dbs.length}):\n${dbs.join('\n')}` : 'No se encontraron bases de datos.',
    };
  }

  // ── Helpers ──

  private extractTitle(obj: any): string {
    if (obj.properties?.Name?.title?.[0]?.plain_text) return obj.properties.Name.title[0].plain_text;
    if (obj.properties?.title?.title?.[0]?.plain_text) return obj.properties.title.title[0].plain_text;
    if (obj.title?.[0]?.plain_text) return obj.title[0].plain_text;
    return 'Sin título';
  }

  private extractPropertyValue(prop: any): string {
    if (!prop) return '';
    switch (prop.type) {
      case 'title': return prop.title?.[0]?.plain_text || '';
      case 'rich_text': return prop.rich_text?.[0]?.plain_text || '';
      case 'number': return String(prop.number ?? '');
      case 'select': return prop.select?.name || '';
      case 'multi_select': return prop.multi_select?.map((s: any) => s.name).join(', ') || '';
      case 'status': return prop.status?.name || '';
      case 'date': return prop.date?.start || '';
      case 'checkbox': return prop.checkbox ? '✓' : '✗';
      case 'url': return prop.url || '';
      case 'email': return prop.email || '';
      case 'phone_number': return prop.phone_number || '';
      default: return `(${prop.type})`;
    }
  }

  private buildProperties(props?: Record<string, string>): Record<string, any> {
    if (!props) return {};
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === 'boolean') {
        result[key] = { checkbox: value };
      } else if (typeof value === 'number') {
        result[key] = { number: value };
      } else {
        result[key] = { rich_text: [{ text: { content: String(value) } }] };
      }
    }
    return result;
  }

  private blockToText(block: any): string {
    const text = block[block.type]?.rich_text?.map((t: any) => t.plain_text).join('') || '';
    switch (block.type) {
      case 'paragraph': return text;
      case 'heading_1': return `# ${text}`;
      case 'heading_2': return `## ${text}`;
      case 'heading_3': return `### ${text}`;
      case 'bulleted_list_item': return `• ${text}`;
      case 'numbered_list_item': return `1. ${text}`;
      case 'to_do': return `[${block.to_do?.checked ? 'x' : ' '}] ${text}`;
      case 'code': return `\`\`\`${block.code?.language || ''}\n${text}\n\`\`\``;
      case 'quote': return `> ${text}`;
      case 'divider': return '───';
      default: return text;
    }
  }

  private markdownToBlocks(markdown: string): any[] {
    return markdown.split('\n').filter(Boolean).map(line => {
      if (line.startsWith('# ')) {
        return { object: 'block', type: 'heading_1', heading_1: { rich_text: [{ text: { content: line.slice(2) } }] } };
      }
      if (line.startsWith('## ')) {
        return { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: line.slice(3) } }] } };
      }
      if (line.startsWith('- ') || line.startsWith('* ')) {
        return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ text: { content: line.slice(2) } }] } };
      }
      return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: line } }] } };
    });
  }
}
