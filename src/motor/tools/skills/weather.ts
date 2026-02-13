// ═══════════════════════════════════════
// ATLAS — Skill: Weather (Open-Meteo)
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';

const WEATHER_CODES: Record<number, string> = {
  0: 'Despejado', 1: 'Mayormente despejado', 2: 'Parcialmente nublado',
  3: 'Nublado', 45: 'Niebla', 48: 'Niebla helada',
  51: 'Llovizna ligera', 53: 'Llovizna', 55: 'Llovizna fuerte',
  61: 'Lluvia ligera', 63: 'Lluvia moderada', 65: 'Lluvia fuerte',
  80: 'Chubascos ligeros', 81: 'Chubascos', 82: 'Chubascos fuertes',
  95: 'Tormenta', 96: 'Tormenta con granizo',
};

export class WeatherTool implements Tool {
  definition = {
    name: 'weather',
    description: 'Consultar el clima actual y pronóstico de cualquier ciudad. Usar cuando pregunten por el clima, temperatura, si va a llover, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: {
          type: 'string',
          description: 'Ciudad a consultar. Default: Medellín',
        },
      },
      required: [],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    try {
      const city = (params.city as string) || 'Medellín';

      // Geocoding
      const geoResp = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=es`,
        { signal: AbortSignal.timeout(10000) }
      );
      const geoData = await geoResp.json();

      if (!geoData.results || geoData.results.length === 0) {
        return { success: false, output: '', error: `Ciudad "${city}" no encontrada.` };
      }

      const { latitude, longitude, name, country } = geoData.results[0];

      // Weather
      const weatherResp = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
        `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
        `&timezone=America/Bogota&forecast_days=3`,
        { signal: AbortSignal.timeout(10000) }
      );
      const weather = await weatherResp.json();
      const current = weather.current;
      const daily = weather.daily;

      const desc = WEATHER_CODES[current.weather_code] || 'Sin datos';

      let output = `Clima en ${name}, ${country}:\n\n`;
      output += `Ahora: ${desc}\n`;
      output += `Temperatura: ${current.temperature_2m}°C\n`;
      output += `Humedad: ${current.relative_humidity_2m}%\n`;
      output += `Viento: ${current.wind_speed_10m} km/h\n\n`;
      output += `Próximos días:\n`;

      for (let i = 0; i < 3; i++) {
        const dayDesc = WEATHER_CODES[daily.weather_code[i]] || '';
        const dayName = i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : 'Pasado mañana';
        output += `${dayName}: ${daily.temperature_2m_min[i]}°–${daily.temperature_2m_max[i]}°C, `;
        output += `lluvia ${daily.precipitation_probability_max[i]}% ${dayDesc}\n`;
      }

      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: '', error: `Error consultando clima: ${err.message}` };
    }
  }
}
