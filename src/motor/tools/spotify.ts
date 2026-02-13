// ═══════════════════════════════════════
// ATLAS — Spotify Control Tool
// Play, pause, search, playlists, now playing
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';

export class SpotifyTool implements Tool {
  definition: ToolDefinition = {
    name: 'spotify',
    description: 'Control de Spotify: play, pause, next, previous, buscar, ver qué suena, crear playlists.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['play', 'pause', 'next', 'previous', 'now_playing', 'search', 'queue', 'volume', 'shuffle', 'repeat', 'devices', 'recent', 'playlist_create', 'playlist_add'],
          description: 'Acción: play, pause, next, previous, now_playing, search, queue, volume, shuffle, repeat, devices, recent, playlist_create, playlist_add',
        },
        query: { type: 'string', description: 'Búsqueda: nombre de canción, artista o álbum' },
        uri: { type: 'string', description: 'Spotify URI (spotify:track:xxx) para play o queue' },
        type: { type: 'string', enum: ['track', 'artist', 'album', 'playlist'], description: 'Tipo de búsqueda (default: track)' },
        volume: { type: 'number', description: 'Volumen 0-100' },
        deviceId: { type: 'string', description: 'ID del dispositivo de reproducción' },
        playlistName: { type: 'string', description: 'Nombre del playlist a crear' },
        playlistId: { type: 'string', description: 'ID del playlist para agregar tracks' },
        trackUris: { type: 'string', description: 'URIs de tracks separados por coma (para playlist_add)' },
      },
      required: ['action'],
    },
  };

  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64')}`,
      },
      body: `grant_type=refresh_token&refresh_token=${config.spotifyRefreshToken}`,
    });

    if (!response.ok) {
      throw new Error(`Spotify token refresh failed: ${response.status}`);
    }

    const data = await response.json() as any;
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return this.accessToken!;
  }

  private async spotifyApi(method: string, endpoint: string, body?: any): Promise<any> {
    const token = await this.getAccessToken();
    const opts: any = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`https://api.spotify.com/v1${endpoint}`, opts);

    if (res.status === 204) return null;
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Spotify API ${res.status}: ${errText.substring(0, 200)}`);
    }
    return res.json();
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || '');

    if (!config.spotifyClientId || !config.spotifyRefreshToken) {
      return { success: false, output: '', error: 'Spotify no configurado. Se requiere SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET y SPOTIFY_REFRESH_TOKEN.' };
    }

    try {
      switch (action) {
        case 'now_playing': return await this.nowPlaying();
        case 'play': return await this.play(params);
        case 'pause': return await this.pause();
        case 'next': return await this.skipNext();
        case 'previous': return await this.skipPrevious();
        case 'search': return await this.search(params);
        case 'queue': return await this.addToQueue(params);
        case 'volume': return await this.setVolume(params);
        case 'shuffle': return await this.toggleShuffle();
        case 'repeat': return await this.toggleRepeat();
        case 'devices': return await this.getDevices();
        case 'recent': return await this.recentlyPlayed();
        case 'playlist_create': return await this.createPlaylist(params);
        case 'playlist_add': return await this.addToPlaylist(params);
        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      logger.error('Spotify tool error', { action, error: err });
      if (/premium/i.test(err.message)) {
        return { success: false, output: '', error: 'Se requiere Spotify Premium para controlar la reproducción.' };
      }
      return { success: false, output: '', error: `Error de Spotify: ${err.message}` };
    }
  }

  private async nowPlaying(): Promise<ToolResult> {
    const data = await this.spotifyApi('GET', '/me/player/currently-playing');
    if (!data || !data.item) {
      return { success: true, output: 'No se está reproduciendo nada en Spotify.' };
    }

    const track = data.item;
    const artists = track.artists?.map((a: any) => a.name).join(', ') || 'Unknown';
    const album = track.album?.name || '';
    const progress = Math.floor((data.progress_ms || 0) / 1000);
    const duration = Math.floor((track.duration_ms || 0) / 1000);
    const isPlaying = data.is_playing ? '▶' : '⏸';

    return {
      success: true,
      output: `${isPlaying} ${track.name}\n🎤 ${artists}\n💿 ${album}\n⏱ ${Math.floor(progress / 60)}:${(progress % 60).toString().padStart(2, '0')} / ${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, '0')}\nURI: ${track.uri}`,
    };
  }

  private async play(params: Record<string, unknown>): Promise<ToolResult> {
    const uri = params.uri ? String(params.uri) : null;
    const query = params.query ? String(params.query) : null;
    const deviceId = params.deviceId ? String(params.deviceId) : undefined;

    let body: any = undefined;

    if (uri) {
      if (uri.includes(':track:')) {
        body = { uris: [uri] };
      } else {
        body = { context_uri: uri };
      }
    } else if (query) {
      // Search and play first result
      const searchResult = await this.spotifyApi('GET', `/search?q=${encodeURIComponent(query)}&type=track&limit=1`);
      const track = searchResult?.tracks?.items?.[0];
      if (!track) return { success: false, output: '', error: `No se encontró: "${query}"` };
      body = { uris: [track.uri] };
    }

    const endpoint = deviceId ? `/me/player/play?device_id=${deviceId}` : '/me/player/play';
    await this.spotifyApi('PUT', endpoint, body);

    if (query) {
      return { success: true, output: `Reproduciendo: "${query}"` };
    }
    return { success: true, output: uri ? `Reproduciendo: ${uri}` : 'Reproducción reanudada.' };
  }

  private async pause(): Promise<ToolResult> {
    await this.spotifyApi('PUT', '/me/player/pause');
    return { success: true, output: 'Spotify pausado.' };
  }

  private async skipNext(): Promise<ToolResult> {
    await this.spotifyApi('POST', '/me/player/next');
    return { success: true, output: 'Siguiente canción.' };
  }

  private async skipPrevious(): Promise<ToolResult> {
    await this.spotifyApi('POST', '/me/player/previous');
    return { success: true, output: 'Canción anterior.' };
  }

  private async search(params: Record<string, unknown>): Promise<ToolResult> {
    const query = String(params.query || '');
    const type = String(params.type || 'track');
    if (!query) return { success: false, output: '', error: 'Se requiere query para buscar.' };

    const data = await this.spotifyApi('GET', `/search?q=${encodeURIComponent(query)}&type=${type}&limit=5`);
    const key = type + 's'; // tracks, artists, albums, playlists
    const items = data?.[key]?.items || [];

    if (items.length === 0) {
      return { success: true, output: `No se encontraron resultados para "${query}".` };
    }

    const formatted = items.map((item: any, i: number) => {
      if (type === 'track') {
        const artists = item.artists?.map((a: any) => a.name).join(', ') || '';
        return `${i + 1}. ${item.name} — ${artists} (${item.uri})`;
      }
      return `${i + 1}. ${item.name} (${item.uri})`;
    });

    return {
      success: true,
      output: `🔍 "${query}" (${type})\n${formatted.join('\n')}`,
    };
  }

  private async addToQueue(params: Record<string, unknown>): Promise<ToolResult> {
    const uri = String(params.uri || '');
    if (!uri) return { success: false, output: '', error: 'Se requiere uri del track.' };
    await this.spotifyApi('POST', `/me/player/queue?uri=${encodeURIComponent(uri)}`);
    return { success: true, output: `Agregado a la cola: ${uri}` };
  }

  private async setVolume(params: Record<string, unknown>): Promise<ToolResult> {
    const vol = Math.max(0, Math.min(100, Number(params.volume) || 50));
    await this.spotifyApi('PUT', `/me/player/volume?volume_percent=${vol}`);
    return { success: true, output: `Volumen: ${vol}%` };
  }

  private async toggleShuffle(): Promise<ToolResult> {
    const current = await this.spotifyApi('GET', '/me/player');
    const newState = !(current?.shuffle_state);
    await this.spotifyApi('PUT', `/me/player/shuffle?state=${newState}`);
    return { success: true, output: `Shuffle: ${newState ? 'ON' : 'OFF'}` };
  }

  private async toggleRepeat(): Promise<ToolResult> {
    const current = await this.spotifyApi('GET', '/me/player');
    const states = ['off', 'context', 'track'];
    const currentIdx = states.indexOf(current?.repeat_state || 'off');
    const next = states[(currentIdx + 1) % states.length];
    await this.spotifyApi('PUT', `/me/player/repeat?state=${next}`);
    return { success: true, output: `Repeat: ${next}` };
  }

  private async getDevices(): Promise<ToolResult> {
    const data = await this.spotifyApi('GET', '/me/player/devices');
    const devices = data?.devices || [];
    if (devices.length === 0) {
      return { success: true, output: 'No hay dispositivos activos de Spotify.' };
    }
    const formatted = devices.map((d: any) => {
      const active = d.is_active ? ' ✅' : '';
      return `${d.name} (${d.type}) — Vol: ${d.volume_percent}%${active} [${d.id}]`;
    });
    return { success: true, output: `🔊 Dispositivos Spotify\n${formatted.join('\n')}` };
  }

  private async recentlyPlayed(): Promise<ToolResult> {
    const data = await this.spotifyApi('GET', '/me/player/recently-played?limit=10');
    const items = data?.items || [];
    const formatted = items.map((item: any) => {
      const track = item.track;
      const artists = track.artists?.map((a: any) => a.name).join(', ') || '';
      const playedAt = new Date(item.played_at).toLocaleString('es-CO', { timeStyle: 'short', dateStyle: 'short' });
      return `${playedAt} | ${track.name} — ${artists}`;
    });
    return { success: true, output: `🎵 Recientes\n${formatted.join('\n')}` };
  }

  private async createPlaylist(params: Record<string, unknown>): Promise<ToolResult> {
    const name = String(params.playlistName || '');
    if (!name) return { success: false, output: '', error: 'Se requiere playlistName.' };

    const user = await this.spotifyApi('GET', '/me');
    const playlist = await this.spotifyApi('POST', `/users/${user.id}/playlists`, {
      name,
      description: `Creado por ATLAS`,
      public: false,
    });

    return { success: true, output: `Playlist creado: "${name}"\nID: ${playlist.id}\nURI: ${playlist.uri}` };
  }

  private async addToPlaylist(params: Record<string, unknown>): Promise<ToolResult> {
    const playlistId = String(params.playlistId || '');
    const trackUris = String(params.trackUris || '').split(',').map(u => u.trim()).filter(Boolean);

    if (!playlistId) return { success: false, output: '', error: 'Se requiere playlistId.' };
    if (trackUris.length === 0) return { success: false, output: '', error: 'Se requiere trackUris.' };

    await this.spotifyApi('POST', `/playlists/${playlistId}/tracks`, { uris: trackUris });
    return { success: true, output: `${trackUris.length} track(s) agregados al playlist ${playlistId}.` };
  }
}
