// ═══════════════════════════════════════
// ATLAS — Skill: Google Calendar
// Manage calendar events via Google Calendar API
// Requires: googleapis (optional dependency)
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';

let google: any = null;
try {
  google = require('googleapis').google;
} catch {
  // googleapis not installed — tool will report gracefully
}

export class GoogleCalendarTool implements Tool {
  private calendar: any = null;

  definition = {
    name: 'calendar',
    description:
      'Gestionar Google Calendar: ver agenda del día, crear eventos, listar próximos eventos, eliminar eventos. ' +
      'Usar cuando digan "qué tengo hoy", "agendá reunión", "creá un evento", "agenda del día".',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['today', 'list', 'create', 'delete', 'search'],
          description: 'Acción: today (agenda de hoy), list (próximos N eventos), create (nuevo evento), delete, search',
        },
        title: {
          type: 'string',
          description: 'Título del evento (para create)',
        },
        date: {
          type: 'string',
          description: 'Fecha: YYYY-MM-DD. Para create es obligatorio. Para list filtra.',
        },
        time_start: {
          type: 'string',
          description: 'Hora inicio: HH:MM (24h). Default: evento de día completo',
        },
        time_end: {
          type: 'string',
          description: 'Hora fin: HH:MM. Default: 1 hora después del inicio',
        },
        description: {
          type: 'string',
          description: 'Descripción del evento',
        },
        location: {
          type: 'string',
          description: 'Ubicación del evento',
        },
        limit: {
          type: 'number',
          description: 'Número de eventos a listar. Default: 10',
        },
        event_id: {
          type: 'string',
          description: 'ID del evento (para delete)',
        },
        query: {
          type: 'string',
          description: 'Texto a buscar en eventos (para search)',
        },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  private getCalendar(): any {
    if (this.calendar) return this.calendar;
    if (!google) return null;

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) return null;

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    this.calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    return this.calendar;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    if (!google) {
      return { success: false, output: '', error: 'googleapis no instalado. Ejecutá: npm install googleapis' };
    }

    const cal = this.getCalendar();
    if (!cal) {
      return {
        success: false, output: '',
        error: 'Google Calendar no configurado. Necesitás:\n' +
          '  GOOGLE_CLIENT_ID=...\n  GOOGLE_CLIENT_SECRET=...\n  GOOGLE_REFRESH_TOKEN=...\nen el .env',
      };
    }

    const action = String(params.action || 'today');

    try {
      switch (action) {
        case 'today': return this.getToday(cal);
        case 'list': return this.listEvents(cal, params);
        case 'create': return this.createEvent(cal, params);
        case 'delete': return this.deleteEvent(cal, params);
        case 'search': return this.searchEvents(cal, params);
        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      return { success: false, output: '', error: `Error Calendar: ${err.message}` };
    }
  }

  private async getToday(cal: any): Promise<ToolResult> {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items || [];
    if (events.length === 0) {
      return { success: true, output: 'No hay eventos hoy. Día libre.' };
    }

    let output = `Agenda de hoy (${now.toLocaleDateString('es-CO')}):\n\n`;
    for (const ev of events) {
      const start = ev.start?.dateTime
        ? new Date(ev.start.dateTime).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
        : 'Todo el día';
      const end = ev.end?.dateTime
        ? new Date(ev.end.dateTime).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
        : '';

      output += `• ${start}${end ? ` - ${end}` : ''}: ${ev.summary || '(sin título)'}`;
      if (ev.location) output += ` 📍 ${ev.location}`;
      output += '\n';
    }

    return { success: true, output };
  }

  private async listEvents(cal: any, params: Record<string, unknown>): Promise<ToolResult> {
    const limit = Number(params.limit || 10);
    const opts: any = {
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: limit,
      singleEvents: true,
      orderBy: 'startTime',
    };

    if (params.date) {
      const d = new Date(String(params.date));
      opts.timeMin = d.toISOString();
      opts.timeMax = new Date(d.getTime() + 24 * 60 * 60 * 1000).toISOString();
    }

    const res = await cal.events.list(opts);
    const events = res.data.items || [];

    if (events.length === 0) {
      return { success: true, output: 'No hay eventos próximos.' };
    }

    let output = `Próximos ${events.length} eventos:\n\n`;
    for (const ev of events) {
      const start = ev.start?.dateTime
        ? new Date(ev.start.dateTime).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })
        : ev.start?.date || '?';

      output += `• [${start}] ${ev.summary || '(sin título)'}`;
      if (ev.location) output += ` (${ev.location})`;
      output += `  [ID: ${ev.id}]\n`;
    }

    return { success: true, output };
  }

  private async createEvent(cal: any, params: Record<string, unknown>): Promise<ToolResult> {
    const title = String(params.title || '');
    if (!title) return { success: false, output: '', error: 'Necesito el título del evento.' };

    const date = String(params.date || new Date().toISOString().split('T')[0]);

    let event: any = {
      summary: title,
      description: params.description ? String(params.description) : undefined,
      location: params.location ? String(params.location) : undefined,
    };

    if (params.time_start) {
      const startStr = `${date}T${String(params.time_start)}:00`;
      const start = new Date(startStr);

      let end: Date;
      if (params.time_end) {
        end = new Date(`${date}T${String(params.time_end)}:00`);
      } else {
        end = new Date(start.getTime() + 60 * 60 * 1000); // +1 hour
      }

      event.start = { dateTime: start.toISOString(), timeZone: 'America/Bogota' };
      event.end = { dateTime: end.toISOString(), timeZone: 'America/Bogota' };
    } else {
      // All-day event
      event.start = { date };
      const nextDay = new Date(date);
      nextDay.setDate(nextDay.getDate() + 1);
      event.end = { date: nextDay.toISOString().split('T')[0] };
    }

    const res = await cal.events.insert({
      calendarId: 'primary',
      requestBody: event,
    });

    const created = res.data;
    let output = `Evento creado:\n`;
    output += `  Título: ${created.summary}\n`;
    output += `  Cuándo: ${created.start?.dateTime || created.start?.date}\n`;
    if (created.location) output += `  Dónde: ${created.location}\n`;
    output += `  Link: ${created.htmlLink}\n`;
    output += `  ID: ${created.id}`;

    return { success: true, output };
  }

  private async deleteEvent(cal: any, params: Record<string, unknown>): Promise<ToolResult> {
    const eventId = String(params.event_id || '');
    if (!eventId) return { success: false, output: '', error: 'Necesito el event_id para eliminar.' };

    await cal.events.delete({
      calendarId: 'primary',
      eventId,
    });

    return { success: true, output: `Evento ${eventId} eliminado.` };
  }

  private async searchEvents(cal: any, params: Record<string, unknown>): Promise<ToolResult> {
    const query = String(params.query || '');
    if (!query) return { success: false, output: '', error: 'Necesito un texto para buscar.' };

    const res = await cal.events.list({
      calendarId: 'primary',
      q: query,
      timeMin: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // Last 30 days
      timeMax: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // Next 90 days
      maxResults: 10,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items || [];
    if (events.length === 0) {
      return { success: true, output: `No encontré eventos con "${query}".` };
    }

    let output = `${events.length} evento(s) con "${query}":\n\n`;
    for (const ev of events) {
      const start = ev.start?.dateTime
        ? new Date(ev.start.dateTime).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })
        : ev.start?.date || '?';

      output += `• [${start}] ${ev.summary || '(sin título)'}  [ID: ${ev.id}]\n`;
    }

    return { success: true, output };
  }
}
