// ═══════════════════════════════════════
// ATLAS — Skill: Spotify Control
// Play, pause, search, queue via Spotify Web API
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';

export class SpotifyTool implements Tool {
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  definition = {
    name: 'spotify',
    description:
      'Controlar Spotify: play, pause, next, previous, buscar, cola, volumen, qué suena. ' +
      'Usar cuando digan "poné música", "qué suena", "pausá", "siguiente canción", "buscá tal canción".',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['play', 'pause', 'next', 'previous', 'current', 'search', 'queue', 'volume', 'devices', 'shuffle', 'repeat'],
          description: 'Acción a realizar',
        },
        query: {
          type: 'string',
          description: 'Búsqueda: nombre de canción, artista, o playlist (para search/play)',
        },
        uri: {
          type: 'string',
          description: 'Spotify URI (spotify:track:xxx) para play/queue. Obtenerlo de search.',
        },
        volume: {
          type: 'number',
          description: 'Volumen 0-100 (para volume)',
        },
        device_id: {
          type: 'string',
          description: 'ID del dispositivo (para transferir reproducción)',
        },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  private async getToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.tokenExpiry) return this.accessToken;

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) return null;

    try {
      const resp = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        },
        body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) return null;
      const data = await resp.json() as any;
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
      return this.accessToken;
    } catch {
      return null;
    }
  }

  private async api(method: string, endpoint: string, body?: any): Promise<any> {
    const token = await this.getToken();
    if (!token) throw new Error('Spotify no configurado. Necesitás SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN en .env');

    const opts: RequestInit = {
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    };
    if (body) opts.body = JSON.stringify(body);

    const resp = await fetch(`https://api.spotify.com/v1${endpoint}`, opts);

    if (resp.status === 204) return {};
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as any;
      throw new Error(err.error?.message || `Spotify API error ${resp.status}`);
    }
    if (resp.headers.get('content-length') === '0') return {};
    return resp.json();
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || '');

    try {
      switch (action) {
        case 'current': {
          const data = await this.api('GET', '/me/player');
          if (!data?.item) return { success: true, output: 'No hay nada reproduciéndose.' };
          const track = data.item;
          const artists = track.artists?.map((a: any) => a.name).join(', ') || '?';
          const progress = Math.floor((data.progress_ms || 0) / 1000);
          const duration = Math.floor((track.duration_ms || 0) / 1000);
          const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
          let out = `🎵 ${track.name}\n   ${artists}\n   ${track.album?.name || ''}\n   ${fmt(progress)} / ${fmt(duration)}`;
          out += `\n   ${data.is_playing ? '▶️ Reproduciendo' : '⏸️ Pausado'} | Vol: ${data.device?.volume_percent}%`;
          out += `\n   URI: ${track.uri}`;
          return { success: true, output: out };
        }

        case 'play': {
          const body: any = {};
          if (params.uri) {
            const uri = String(params.uri);
            if (uri.includes(':track:') || uri.includes(':episode:')) {
              body.uris = [uri];
            } else {
              body.context_uri = uri;
            }
          } else if (params.query) {
            // Search first, then play top result
            const results = await this.api('GET', `/search?q=${encodeURIComponent(String(params.query))}&type=track&limit=1`);
            const track = results.tracks?.items?.[0];
            if (!track) return { success: false, output: '', error: `No encontré "${params.query}" en Spotify.` };
            body.uris = [track.uri];
            await this.api('PUT', '/me/player/play', body);
            return { success: true, output: `▶️ ${track.name} — ${track.artists[0]?.name}` };
          }
          const opts = params.device_id ? `?device_id=${params.device_id}` : '';
          await this.api('PUT', `/me/player/play${opts}`, Object.keys(body).length > 0 ? body : undefined);
          return { success: true, output: '▶️ Reproduciendo' };
        }

        case 'pause': {
          await this.api('PUT', '/me/player/pause');
          return { success: true, output: '⏸️ Pausado' };
        }

        case 'next': {
          await this.api('POST', '/me/player/next');
          // Wait a moment and get current
          await new Promise(r => setTimeout(r, 500));
          return this.execute({ action: 'current' });
        }

        case 'previous': {
          await this.api('POST', '/me/player/previous');
          await new Promise(r => setTimeout(r, 500));
          return this.execute({ action: 'current' });
        }

        case 'search': {
          const query = String(params.query || '');
          if (!query) return { success: false, output: '', error: 'Necesito qué buscar.' };
          const data = await this.api('GET', `/search?q=${encodeURIComponent(query)}&type=track,artist,playlist&limit=5`);
          let out = `Resultados para "${query}":\n\n`;

          if (data.tracks?.items?.length) {
            out += 'Canciones:\n';
            for (const t of data.tracks.items) {
              out += `  • ${t.name} — ${t.artists[0]?.name} [${t.uri}]\n`;
            }
          }
          if (data.artists?.items?.length) {
            out += '\nArtistas:\n';
            for (const a of data.artists.items.slice(0, 3)) {
              out += `  • ${a.name} [${a.uri}]\n`;
            }
          }
          if (data.playlists?.items?.length) {
            out += '\nPlaylists:\n';
            for (const p of data.playlists.items.slice(0, 3)) {
              out += `  • ${p.name} (${p.tracks?.total || '?'} tracks) [${p.uri}]\n`;
            }
          }
          return { success: true, output: out };
        }

        case 'queue': {
          const uri = String(params.uri || '');
          if (!uri) {
            if (params.query) {
              const results = await this.api('GET', `/search?q=${encodeURIComponent(String(params.query))}&type=track&limit=1`);
              const track = results.tracks?.items?.[0];
              if (!track) return { success: false, output: '', error: `No encontré "${params.query}".` };
              await this.api('POST', `/me/player/queue?uri=${encodeURIComponent(track.uri)}`);
              return { success: true, output: `Agregado a la cola: ${track.name} — ${track.artists[0]?.name}` };
            }
            return { success: false, output: '', error: 'Necesito URI o query para agregar a la cola.' };
          }
          await this.api('POST', `/me/player/queue?uri=${encodeURIComponent(uri)}`);
          return { success: true, output: 'Agregado a la cola.' };
        }

        case 'volume': {
          const vol = Number(params.volume ?? 50);
          await this.api('PUT', `/me/player/volume?volume_percent=${Math.max(0, Math.min(100, vol))}`);
          return { success: true, output: `🔊 Volumen: ${vol}%` };
        }

        case 'devices': {
          const data = await this.api('GET', '/me/player/devices');
          if (!data.devices?.length) return { success: true, output: 'No hay dispositivos activos.' };
          let out = 'Dispositivos:\n';
          for (const d of data.devices) {
            out += `  ${d.is_active ? '▶️' : '○'} ${d.name} (${d.type}) — Vol: ${d.volume_percent}% [ID: ${d.id}]\n`;
          }
          return { success: true, output: out };
        }

        case 'shuffle': {
          const current = await this.api('GET', '/me/player');
          const newState = !current?.shuffle_state;
          await this.api('PUT', `/me/player/shuffle?state=${newState}`);
          return { success: true, output: `🔀 Shuffle: ${newState ? 'ON' : 'OFF'}` };
        }

        case 'repeat': {
          const current = await this.api('GET', '/me/player');
          const states = ['off', 'context', 'track'];
          const currentIdx = states.indexOf(current?.repeat_state || 'off');
          const next = states[(currentIdx + 1) % states.length];
          await this.api('PUT', `/me/player/repeat?state=${next}`);
          return { success: true, output: `🔁 Repeat: ${next}` };
        }

        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      return { success: false, output: '', error: `Spotify error: ${err.message}` };
    }
  }
}
