// ═══════════════════════════════════════
// ATLAS — Google Sheets Tool
// Read/write Google Spreadsheets
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';

export class GoogleSheetsTool implements Tool {
  definition: ToolDefinition = {
    name: 'google_sheets',
    description: 'Lee y escribe Google Spreadsheets. Ideal para reportes financieros, inventarios, datos del negocio. Acciones: read (leer rango), write (escribir datos), append (agregar fila), create (crear hoja), list (ver hojas), search (buscar en hoja).',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write', 'append', 'create', 'list', 'search', 'clear'],
          description: 'Acción a realizar',
        },
        spreadsheet_id: {
          type: 'string',
          description: 'ID del spreadsheet (de la URL: /d/{ID}/edit). Requerido para read/write/append/search/clear.',
        },
        range: {
          type: 'string',
          description: 'Rango en formato A1. Ej: "Sheet1!A1:D10", "Hoja1!A:C". Default: primera hoja completa.',
        },
        values: {
          type: 'array',
          description: 'Datos a escribir. Array de arrays (filas). Ej: [["Nombre","Valor"],["Item1",100]]',
        },
        title: {
          type: 'string',
          description: 'Título del spreadsheet (para create)',
        },
        query: {
          type: 'string',
          description: 'Texto a buscar (para search)',
        },
      },
      required: ['action'],
    },
  };

  private async getAuth(): Promise<any> {
    const { google } = require('googleapis');

    if (!config.googleClientId || !config.googleRefreshToken) {
      throw new Error('Google OAuth no configurado. Se requiere GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN');
    }

    const oauth2 = new google.auth.OAuth2(
      config.googleClientId,
      (config as any).googleClientSecret
    );
    oauth2.setCredentials({ refresh_token: config.googleRefreshToken });
    return oauth2;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || '');

    try {
      switch (action) {
        case 'read': return await this.readRange(params);
        case 'write': return await this.writeRange(params);
        case 'append': return await this.appendRows(params);
        case 'create': return await this.createSpreadsheet(String(params.title || 'ATLAS Export'));
        case 'list': return await this.listSheets(String(params.spreadsheet_id || ''));
        case 'search': return await this.searchInSheet(params);
        case 'clear': return await this.clearRange(params);
        default: return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      if (/Cannot find module/i.test(err.message)) {
        return { success: false, output: '', error: 'npm install googleapis' };
      }
      logger.error('Google Sheets error', { error: err, action });
      return { success: false, output: '', error: `Error Sheets: ${err.message}` };
    }
  }

  private async readRange(params: Record<string, unknown>): Promise<ToolResult> {
    const spreadsheetId = String(params.spreadsheet_id || '');
    if (!spreadsheetId) return { success: false, output: '', error: 'Se requiere spreadsheet_id' };

    const { google } = require('googleapis');
    const auth = await this.getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const range = String(params.range || 'A1:Z1000');
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const rows = response.data.values || [];
    if (rows.length === 0) return { success: true, output: 'Rango vacío.' };

    // Format as table
    const header = rows[0];
    const maxWidths = header.map((_: any, i: number) =>
      Math.max(...rows.map((r: any[]) => String(r[i] || '').length), 3)
    );

    const lines: string[] = [];
    lines.push(header.map((h: string, i: number) => String(h).padEnd(maxWidths[i])).join(' | '));
    lines.push(maxWidths.map((w: number) => '─'.repeat(w)).join('─┼─'));

    for (let r = 1; r < Math.min(rows.length, 100); r++) {
      lines.push(header.map((_: any, i: number) =>
        String(rows[r]?.[i] || '').padEnd(maxWidths[i])
      ).join(' | '));
    }

    const truncated = rows.length > 100 ? `\n... (${rows.length - 100} filas más)` : '';
    return {
      success: true,
      output: `Rango: ${range} (${rows.length} filas, ${header.length} columnas)\n\n${lines.join('\n')}${truncated}`,
    };
  }

  private async writeRange(params: Record<string, unknown>): Promise<ToolResult> {
    const spreadsheetId = String(params.spreadsheet_id || '');
    const values = params.values as any[][];
    if (!spreadsheetId || !values) return { success: false, output: '', error: 'Se requiere spreadsheet_id y values' };

    const { google } = require('googleapis');
    const auth = await this.getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const range = String(params.range || 'A1');
    const response = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });

    return {
      success: true,
      output: `Datos escritos: ${response.data.updatedRows} filas, ${response.data.updatedColumns} columnas en ${range}`,
    };
  }

  private async appendRows(params: Record<string, unknown>): Promise<ToolResult> {
    const spreadsheetId = String(params.spreadsheet_id || '');
    const values = params.values as any[][];
    if (!spreadsheetId || !values) return { success: false, output: '', error: 'Se requiere spreadsheet_id y values' };

    const { google } = require('googleapis');
    const auth = await this.getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const range = String(params.range || 'A1');
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });

    return {
      success: true,
      output: `${values.length} fila(s) agregada(s) al final de ${range}`,
    };
  }

  private async createSpreadsheet(title: string): Promise<ToolResult> {
    const { google } = require('googleapis');
    const auth = await this.getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: [{ properties: { title: 'Datos' } }],
      },
    });

    return {
      success: true,
      output: `Spreadsheet creado: ${title}\nID: ${response.data.spreadsheetId}\nURL: ${response.data.spreadsheetUrl}`,
    };
  }

  private async listSheets(spreadsheetId: string): Promise<ToolResult> {
    if (!spreadsheetId) return { success: false, output: '', error: 'Se requiere spreadsheet_id' };

    const { google } = require('googleapis');
    const auth = await this.getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetList = response.data.sheets?.map((s: any) => {
      const props = s.properties;
      return `  ${props.title} (${props.sheetId}) — ${props.gridProperties?.rowCount || 0} filas x ${props.gridProperties?.columnCount || 0} cols`;
    }) || [];

    return {
      success: true,
      output: `Spreadsheet: ${response.data.properties?.title}\nHojas (${sheetList.length}):\n${sheetList.join('\n')}`,
    };
  }

  private async searchInSheet(params: Record<string, unknown>): Promise<ToolResult> {
    const spreadsheetId = String(params.spreadsheet_id || '');
    const query = String(params.query || '');
    if (!spreadsheetId || !query) return { success: false, output: '', error: 'Se requiere spreadsheet_id y query' };

    // Read all data and search locally
    const readResult = await this.readRange({ spreadsheet_id: spreadsheetId, range: params.range || 'A1:Z10000' });
    if (!readResult.success) return readResult;

    const lowerQuery = query.toLowerCase();
    const lines = readResult.output.split('\n');
    const matches = lines.filter(line => line.toLowerCase().includes(lowerQuery));

    if (matches.length === 0) return { success: true, output: `No se encontró "${query}" en la hoja.` };

    return {
      success: true,
      output: `Resultados para "${query}" (${matches.length}):\n${matches.slice(0, 50).join('\n')}`,
    };
  }

  private async clearRange(params: Record<string, unknown>): Promise<ToolResult> {
    const spreadsheetId = String(params.spreadsheet_id || '');
    const range = String(params.range || '');
    if (!spreadsheetId || !range) return { success: false, output: '', error: 'Se requiere spreadsheet_id y range' };

    const { google } = require('googleapis');
    const auth = await this.getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    await sheets.spreadsheets.values.clear({ spreadsheetId, range });
    return { success: true, output: `Rango ${range} limpiado.` };
  }
}
