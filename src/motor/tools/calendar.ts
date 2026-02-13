// ═══════════════════════════════════════
// ATLAS — Google Calendar Tool
// Bidirectional calendar management
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';

export class CalendarTool implements Tool {
  definition: ToolDefinition = {
    name: 'calendar',
    description: 'Google Calendar: ver eventos, crear, modificar, eliminar. Necesita GOOGLE_CLIENT_ID + GOOGLE_REFRESH_TOKEN.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'today', 'week', 'create', 'update', 'delete', 'search'],
          description: 'list=próximos eventos, today=hoy, week=esta semana, create=crear, update=modificar, delete=eliminar, search=buscar',
        },
        // list/search params
        query: { type: 'string', description: 'Texto a buscar en eventos' },
        maxResults: { type: 'number', description: 'Máximo de resultados (default 10)' },
        // create/update params
        summary: { type: 'string', description: 'Título del evento' },
        description: { type: 'string', description: 'Descripción del evento' },
        start: { type: 'string', description: 'Inicio: ISO 8601 o "2025-01-15 14:00"' },
        end: { type: 'string', description: 'Fin: ISO 8601 o "2025-01-15 15:00"' },
        location: { type: 'string', description: 'Ubicación del evento' },
        attendees: { type: 'string', description: 'Emails separados por coma' },
        allDay: { type: 'boolean', description: 'Evento de día completo' },
        // update/delete params
        eventId: { type: 'string', description: 'ID del evento a modificar/eliminar' },
      },
      required: ['action'],
    },
  };

  private async getCalendarClient(): Promise<any> {
    const { google } = require('googleapis');

    const oauth2Client = new google.auth.OAuth2(
      config.googleClientId,
      config.googleClientSecret,
    );

    oauth2Client.setCredentials({
      refresh_token: config.googleRefreshToken,
    });

    return google.calendar({ version: 'v3', auth: oauth2Client });
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || '');

    if (!config.googleClientId || !config.googleRefreshToken) {
      return { success: false, output: '', error: 'Google Calendar no configurado. Se requiere GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y GOOGLE_REFRESH_TOKEN.' };
    }

    try {
      switch (action) {
        case 'list': return await this.listEvents(params);
        case 'today': return await this.listEvents({ ...params, _range: 'today' });
        case 'week': return await this.listEvents({ ...params, _range: 'week' });
        case 'create': return await this.createEvent(params);
        case 'update': return await this.updateEvent(params);
        case 'delete': return await this.deleteEvent(params);
        case 'search': return await this.searchEvents(params);
        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      logger.error('Calendar tool error', { action, error: err });
      if (/invalid_grant|token/i.test(err.message)) {
        return { success: false, output: '', error: 'Token de Google expirado. Regenerá el GOOGLE_REFRESH_TOKEN.' };
      }
      return { success: false, output: '', error: `Error de calendario: ${err.message}` };
    }
  }

  private async listEvents(params: Record<string, unknown>): Promise<ToolResult> {
    const calendar = await this.getCalendarClient();
    const maxResults = Number(params.maxResults) || 10;
    const range = String(params._range || '');

    const now = new Date();
    let timeMin = now.toISOString();
    let timeMax: string | undefined;

    if (range === 'today') {
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59, 999);
      timeMax = endOfDay.toISOString();
    } else if (range === 'week') {
      const endOfWeek = new Date(now);
      endOfWeek.setDate(endOfWeek.getDate() + 7);
      timeMax = endOfWeek.toISOString();
    }

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items || [];
    if (events.length === 0) {
      const rangeStr = range === 'today' ? 'hoy' : range === 'week' ? 'esta semana' : 'próximamente';
      return { success: true, output: `No hay eventos ${rangeStr}.` };
    }

    const formatted = events.map((e: any) => {
      const start = e.start?.dateTime
        ? new Date(e.start.dateTime).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })
        : e.start?.date || '';
      const end = e.end?.dateTime
        ? new Date(e.end.dateTime).toLocaleString('es-CO', { timeStyle: 'short' })
        : '';
      const loc = e.location ? ` 📍 ${e.location}` : '';
      return `${start}${end ? ' - ' + end : ''} | ${e.summary || '(sin título)'}${loc} [${e.id}]`;
    });

    const rangeLabel = range === 'today' ? 'Hoy' : range === 'week' ? 'Esta semana' : 'Próximos eventos';
    return {
      success: true,
      output: `📅 ${rangeLabel} (${events.length} eventos)\n${'─'.repeat(50)}\n${formatted.join('\n')}`,
    };
  }

  private async searchEvents(params: Record<string, unknown>): Promise<ToolResult> {
    const calendar = await this.getCalendarClient();
    const query = String(params.query || '');
    const maxResults = Number(params.maxResults) || 10;

    if (!query) return { success: false, output: '', error: 'Se requiere query para buscar.' };

    const now = new Date();
    const threeMonthsAgo = new Date(now);
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const res = await calendar.events.list({
      calendarId: 'primary',
      q: query,
      timeMin: threeMonthsAgo.toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items || [];
    if (events.length === 0) {
      return { success: true, output: `No se encontraron eventos con "${query}".` };
    }

    const formatted = events.map((e: any) => {
      const start = e.start?.dateTime
        ? new Date(e.start.dateTime).toLocaleString('es-CO')
        : e.start?.date || '';
      return `${start} | ${e.summary || '(sin título)'} [${e.id}]`;
    });

    return {
      success: true,
      output: `🔍 "${query}" — ${events.length} resultados\n${formatted.join('\n')}`,
    };
  }

  private async createEvent(params: Record<string, unknown>): Promise<ToolResult> {
    const calendar = await this.getCalendarClient();
    const summary = String(params.summary || '');
    const description = params.description ? String(params.description) : undefined;
    const location = params.location ? String(params.location) : undefined;
    const allDay = !!params.allDay;

    if (!summary) return { success: false, output: '', error: 'Se requiere summary (título).' };
    if (!params.start) return { success: false, output: '', error: 'Se requiere start (fecha inicio).' };

    const startDate = new Date(String(params.start));
    const endDate = params.end ? new Date(String(params.end)) : new Date(startDate.getTime() + 3600000);

    const event: any = {
      summary,
      description,
      location,
    };

    if (allDay) {
      event.start = { date: startDate.toISOString().split('T')[0] };
      event.end = { date: endDate.toISOString().split('T')[0] };
    } else {
      event.start = { dateTime: startDate.toISOString(), timeZone: 'America/Bogota' };
      event.end = { dateTime: endDate.toISOString(), timeZone: 'America/Bogota' };
    }

    if (params.attendees) {
      event.attendees = String(params.attendees).split(',').map(e => ({ email: e.trim() }));
    }

    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
    });

    return {
      success: true,
      output: `Evento creado: "${summary}"\nInicio: ${startDate.toLocaleString('es-CO')}\nID: ${res.data.id}\nLink: ${res.data.htmlLink}`,
    };
  }

  private async updateEvent(params: Record<string, unknown>): Promise<ToolResult> {
    const calendar = await this.getCalendarClient();
    const eventId = String(params.eventId || '');
    if (!eventId) return { success: false, output: '', error: 'Se requiere eventId.' };

    const updates: any = {};
    if (params.summary) updates.summary = String(params.summary);
    if (params.description) updates.description = String(params.description);
    if (params.location) updates.location = String(params.location);
    if (params.start) {
      const d = new Date(String(params.start));
      updates.start = { dateTime: d.toISOString(), timeZone: 'America/Bogota' };
    }
    if (params.end) {
      const d = new Date(String(params.end));
      updates.end = { dateTime: d.toISOString(), timeZone: 'America/Bogota' };
    }

    const res = await calendar.events.patch({
      calendarId: 'primary',
      eventId,
      requestBody: updates,
    });

    return {
      success: true,
      output: `Evento actualizado: "${res.data.summary}"\nID: ${res.data.id}`,
    };
  }

  private async deleteEvent(params: Record<string, unknown>): Promise<ToolResult> {
    const calendar = await this.getCalendarClient();
    const eventId = String(params.eventId || '');
    if (!eventId) return { success: false, output: '', error: 'Se requiere eventId.' };

    await calendar.events.delete({
      calendarId: 'primary',
      eventId,
    });

    return { success: true, output: `Evento eliminado: ${eventId}` };
  }
}
