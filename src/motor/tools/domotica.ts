// ═══════════════════════════════════════
// ATLAS — Domótica Tool (Tuya/Smart Life)
// Control de dispositivos del hogar inteligente
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { dashboardEvents } from '../../dashboard/events';
import { config } from '../../config/config';
import logger from '../../utils/logger';

let TuyaContext: any;
try {
  TuyaContext = require('@tuya/tuya-connector-nodejs').TuyaContext;
} catch {
  // Will fail at runtime if not installed
}

// Common switch codes by device category — tried in order
const SWITCH_CODES = [
  'switch_led',   // Lights (dj)
  'switch_1',     // Plugs (cz), switches (kg), power strips (pc)
  'switch',       // Fans (fs), heaters (qn), generic
  'switch_on',    // Some generic devices
  'Power',        // Some older devices
];

export class DomoticaTool implements Tool {
  private client: any;
  /** Cache: deviceId → detected switch code */
  private switchCodeCache: Map<string, string> = new Map();
  /** Cache: device name (lowercase) → tuya device ID */
  private nameToIdCache: Map<string, string> = new Map();
  private namesCacheLoaded: boolean = false;

  definition: ToolDefinition = {
    name: 'domotica',
    description: 'Control de dispositivos del hogar inteligente (luces, termostato, sensores, cortinas, cerraduras) via Tuya/Smart Life. Acciones: devices, status, turn_on, turn_off, set_brightness, set_color, set_temperature, open, close, scene, sensor',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['devices', 'status', 'turn_on', 'turn_off', 'set_brightness', 'set_color', 'set_temperature', 'open', 'close', 'scene', 'sensor'],
          description: 'Acción a ejecutar',
        },
        device_id: {
          type: 'string',
          description: 'ID del dispositivo Tuya (requerido para status, turn_on, turn_off, set_brightness, set_color, set_temperature, open, close, sensor)',
        },
        scene_id: {
          type: 'string',
          description: 'ID de la escena Tuya (requerido para action=scene)',
        },
        value: {
          type: ['string', 'number'],
          description: 'Valor a establecer (brillo 0-100, color hex #RRGGBB, temperatura en grados)',
        },
        switch_code: {
          type: 'string',
          description: 'Código de switch específico para multi-gang (ej: switch_1, switch_2). Si no se especifica, se auto-detecta',
        },
      },
      required: ['action'],
    },
  };

  constructor() {
    if (!TuyaContext) {
      throw new Error('Dependencia @tuya/tuya-connector-nodejs no disponible');
    }
    this.client = new TuyaContext({
      baseUrl: config.tuyaApiUrl,
      accessKey: config.tuyaAccessKey,
      secretKey: config.tuyaSecretKey,
    });
  }

  /**
   * Resolve a device identifier — accepts Tuya device ID or device name.
   * If input doesn't look like a Tuya ID (20-char alphanum), searches by name.
   */
  private async resolveDeviceId(input: string): Promise<string | null> {
    // Tuya IDs are typically 20+ lowercase alphanumeric chars
    if (/^[a-z0-9]{15,}$/.test(input)) return input;

    // Check name cache
    const lowerInput = input.toLowerCase().trim();
    if (this.nameToIdCache.has(lowerInput)) return this.nameToIdCache.get(lowerInput)!;

    // Load names from Tuya API (once, then cached)
    if (!this.namesCacheLoaded) {
      await this.loadDeviceNames();
    }

    // Exact match (case-insensitive)
    if (this.nameToIdCache.has(lowerInput)) return this.nameToIdCache.get(lowerInput)!;

    // Partial match: find names that contain the input
    for (const [name, id] of this.nameToIdCache) {
      if (name.includes(lowerInput) || lowerInput.includes(name)) return id;
    }

    return null;
  }

  /** Fetch all devices from Tuya API and populate the name→ID cache */
  private async loadDeviceNames(): Promise<void> {
    try {
      const uid = config.tuyaDeviceId;
      let response: any;

      if (uid) {
        response = await this.client.request({ path: `/v1.0/users/${uid}/devices`, method: 'GET' });
      }
      if (!response?.success) {
        response = await this.client.request({
          path: '/v1.0/iot-01/associated-users/devices', method: 'GET',
          query: { last_row_key: '', size: 100 },
        });
      }

      if (response?.success) {
        const devices = Array.isArray(response.result) ? response.result : (response.result?.devices || []);
        for (const d of devices) {
          if (d.id && d.name) {
            this.nameToIdCache.set(d.name.toLowerCase().trim(), d.id);
          }
        }
        logger.debug(`Domotica: cached ${this.nameToIdCache.size} device names`);
      }
    } catch (err) {
      logger.error('Domotica: failed to load device names', { error: err });
    }
    this.namesCacheLoaded = true;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;
    const rawDeviceId = params.device_id as string | undefined;
    const sceneId = params.scene_id as string | undefined;
    const value = params.value;
    const switchCode = params.switch_code as string | undefined;

    // Resolve device name → ID if needed
    let deviceId = rawDeviceId;
    if (rawDeviceId && action !== 'devices' && action !== 'scene') {
      const resolved = await this.resolveDeviceId(rawDeviceId);
      if (!resolved) {
        const knownNames = Array.from(this.nameToIdCache.entries())
          .map(([name, id]) => `  "${name}" → ${id}`)
          .join('\n');
        return {
          success: false, output: '',
          error: `No se encontró dispositivo "${rawDeviceId}". Dispositivos conocidos:\n${knownNames || '(ninguno — usá action=devices primero)'}`,
        };
      }
      deviceId = resolved;
    }

    try {
      switch (action) {
        case 'devices':
          return this.listDevices();
        case 'status':
          if (!deviceId) return { success: false, output: '', error: 'Se requiere device_id' };
          return this.getStatus(deviceId);
        case 'turn_on':
          if (!deviceId) return { success: false, output: '', error: 'Se requiere device_id' };
          return this.toggleDevice(deviceId, true, switchCode);
        case 'turn_off':
          if (!deviceId) return { success: false, output: '', error: 'Se requiere device_id' };
          return this.toggleDevice(deviceId, false, switchCode);
        case 'set_brightness':
          if (!deviceId) return { success: false, output: '', error: 'Se requiere device_id' };
          if (value === undefined) return { success: false, output: '', error: 'Se requiere value (0-100)' };
          return this.setBrightness(deviceId, Number(value));
        case 'set_color':
          if (!deviceId) return { success: false, output: '', error: 'Se requiere device_id' };
          if (!value) return { success: false, output: '', error: 'Se requiere value (hex color #RRGGBB)' };
          return this.setColor(deviceId, String(value));
        case 'set_temperature':
          if (!deviceId) return { success: false, output: '', error: 'Se requiere device_id' };
          if (value === undefined) return { success: false, output: '', error: 'Se requiere value (temperatura)' };
          return this.setTemperature(deviceId, Number(value));
        case 'open':
          if (!deviceId) return { success: false, output: '', error: 'Se requiere device_id' };
          return this.sendCommand(deviceId, 'control', 'open', 'abierto');
        case 'close':
          if (!deviceId) return { success: false, output: '', error: 'Se requiere device_id' };
          return this.sendCommand(deviceId, 'control', 'close', 'cerrado');
        case 'scene':
          if (!sceneId) return { success: false, output: '', error: 'Se requiere scene_id' };
          return this.triggerScene(sceneId);
        case 'sensor':
          if (!deviceId) return { success: false, output: '', error: 'Se requiere device_id' };
          return this.readSensor(deviceId);
        default:
          return { success: false, output: '', error: `Acción no reconocida: ${action}` };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Domotica tool error', { action, error: msg });
      return { success: false, output: '', error: `Error de domótica: ${msg}` };
    }
  }

  /** List all devices linked to the Tuya user */
  private async listDevices(): Promise<ToolResult> {
    // Try user-based device listing first
    const uid = config.tuyaDeviceId;
    let response: any;

    if (uid) {
      response = await this.client.request({
        path: `/v1.0/users/${uid}/devices`,
        method: 'GET',
      });
    } else {
      // Fallback: list all devices in the project
      response = await this.client.request({
        path: '/v1.0/iot-01/associated-users/devices',
        method: 'GET',
        query: { last_row_key: '', size: 100 },
      });
    }

    if (!response.success && uid) {
      // Fallback: try alternative endpoint
      logger.debug(`Tuya user endpoint failed (code=${response.code}, msg=${response.msg}), trying alternative...`);
      response = await this.client.request({
        path: '/v1.0/iot-01/associated-users/devices',
        method: 'GET',
        query: { last_row_key: '', size: 100 },
      });
    }

    if (!response.success) {
      return { success: false, output: '', error: `Tuya API error (code=${response.code}): ${response.msg}. Verificá los permisos API en iot.tuya.com → Service API → suscribite a "IoT Core" y "Smart Home Device Management"` };
    }

    const devices = Array.isArray(response.result) ? response.result : (response.result?.devices || []);
    const formatted = devices.map((d: any) => ({
      id: d.id,
      name: d.name,
      category: d.category,
      online: d.online,
      product_name: d.product_name,
    }));

    // Refresh name→ID cache
    for (const d of devices) {
      if (d.id && d.name) {
        this.nameToIdCache.set(d.name.toLowerCase().trim(), d.id);
      }
    }
    this.namesCacheLoaded = true;

    return {
      success: true,
      output: `${formatted.length} dispositivos encontrados:\n${JSON.stringify(formatted, null, 2)}`,
    };
  }

  /** Get current status of a device */
  private async getStatus(deviceId: string): Promise<ToolResult> {
    const response = await this.client.request({
      path: `/v1.0/iot-03/devices/${deviceId}/status`,
      method: 'GET',
    });

    if (!response.success) {
      return { success: false, output: '', error: `Error al obtener estado: ${response.msg}` };
    }

    const statuses = response.result || [];
    const formatted = statuses.map((s: any) => `  ${s.code}: ${s.value}`).join('\n');

    return {
      success: true,
      output: `Estado del dispositivo ${deviceId}:\n${formatted}`,
    };
  }

  /** Send a command to a device */
  private async sendCommand(
    deviceId: string,
    code: string,
    value: unknown,
    actionLabel: string
  ): Promise<ToolResult> {
    const response = await this.client.request({
      path: `/v1.0/iot-03/devices/${deviceId}/commands`,
      method: 'POST',
      body: {
        commands: [{ code, value }],
      },
    });

    if (!response.success) {
      return { success: false, output: '', error: `Error al enviar comando: ${response.msg}` };
    }

    // Emit event for pipelines
    dashboardEvents.emitDeviceStateChanged({
      deviceId,
      deviceName: deviceId,
      deviceType: 'unknown',
      property: code,
      oldValue: null,
      newValue: value,
    });

    logger.info(`Domotica: device ${deviceId} → ${code}=${value}`);

    return {
      success: true,
      output: `Dispositivo ${deviceId} ${actionLabel} correctamente`,
    };
  }

  /** Detect the correct switch code for a device by querying its status */
  private async detectSwitchCode(deviceId: string): Promise<string> {
    // Check cache first
    const cached = this.switchCodeCache.get(deviceId);
    if (cached) return cached;

    // Query device status to find which switch code it uses
    const response = await this.client.request({
      path: `/v1.0/iot-03/devices/${deviceId}/status`,
      method: 'GET',
    });

    if (response.success && Array.isArray(response.result)) {
      const codes = response.result.map((s: any) => s.code as string);

      // Find the first matching switch code from our known list
      for (const switchCode of SWITCH_CODES) {
        if (codes.includes(switchCode)) {
          this.switchCodeCache.set(deviceId, switchCode);
          logger.debug(`Domotica: detected switch code "${switchCode}" for device ${deviceId}`);
          return switchCode;
        }
      }

      // Fallback: any code starting with "switch" that has a boolean value
      for (const status of response.result) {
        if (String(status.code).startsWith('switch') && typeof status.value === 'boolean') {
          const code = status.code as string;
          this.switchCodeCache.set(deviceId, code);
          logger.debug(`Domotica: detected switch code "${code}" (fallback) for device ${deviceId}`);
          return code;
        }
      }
    }

    // Last resort: default to switch_led
    return 'switch_led';
  }

  /** Toggle a device on/off — always sends the command to Tuya */
  private async toggleDevice(deviceId: string, on: boolean, explicitCode?: string): Promise<ToolResult> {
    // Detect correct switch code
    let code = explicitCode;
    if (!code) {
      code = await this.detectSwitchCode(deviceId);
    }

    // Always send the command — never skip based on reported state
    const label = on ? 'encendido' : 'apagado';
    return this.sendCommand(deviceId, code, on, label);
  }

  /** Set brightness (0-100) → Tuya scale (10-1000) */
  private async setBrightness(deviceId: string, brightness: number): Promise<ToolResult> {
    const clamped = Math.max(0, Math.min(100, brightness));
    const tuyaValue = Math.round(clamped * 10); // Tuya uses 10-1000

    return this.sendCommand(deviceId, 'bright_value_v2', tuyaValue, `brillo ajustado a ${clamped}%`);
  }

  /** Set color from hex (#RRGGBB) → Tuya HSV format */
  private async setColor(deviceId: string, hexColor: string): Promise<ToolResult> {
    const hex = hexColor.replace('#', '');
    if (!/^[0-9A-Fa-f]{6}$/.test(hex)) {
      return { success: false, output: '', error: 'Color inválido. Usá formato #RRGGBB' };
    }

    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h = 0;
    if (delta !== 0) {
      if (max === r) h = ((g - b) / delta) % 6;
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
      h = Math.round(h * 60);
      if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : Math.round((delta / max) * 1000);
    const v = Math.round(max * 1000);

    const tuyaColor = JSON.stringify({ h, s, v });

    return this.sendCommand(deviceId, 'colour_data_v2', tuyaColor, `color cambiado a ${hexColor}`);
  }

  /** Set thermostat temperature */
  private async setTemperature(deviceId: string, temp: number): Promise<ToolResult> {
    // Most Tuya thermostats use temp_set with value * 10 (e.g., 22.5 → 225)
    const tuyaTemp = Math.round(temp * 10);
    return this.sendCommand(deviceId, 'temp_set', tuyaTemp, `temperatura ajustada a ${temp}°C`);
  }

  /** Trigger a Tuya scene */
  private async triggerScene(sceneId: string): Promise<ToolResult> {
    const response = await this.client.request({
      path: `/v1.0/iot-03/scenes/${sceneId}/trigger`,
      method: 'POST',
    });

    if (!response.success) {
      return { success: false, output: '', error: `Error al activar escena: ${response.msg}` };
    }

    logger.info(`Domotica: scene ${sceneId} triggered`);

    return {
      success: true,
      output: `Escena ${sceneId} activada correctamente`,
    };
  }

  /** Read sensor data (temperature, humidity, motion, etc.) */
  private async readSensor(deviceId: string): Promise<ToolResult> {
    const response = await this.client.request({
      path: `/v1.0/iot-03/devices/${deviceId}/status`,
      method: 'GET',
    });

    if (!response.success) {
      return { success: false, output: '', error: `Error al leer sensor: ${response.msg}` };
    }

    const statuses = response.result || [];
    const sensorData: Record<string, unknown> = {};

    for (const s of statuses) {
      const code = s.code as string;
      let value = s.value;

      // Interpret common sensor codes
      if (code === 'va_temperature' || code === 'temp_current') {
        value = `${(Number(value) / 10).toFixed(1)}°C`;
      } else if (code === 'va_humidity' || code === 'humidity_value') {
        value = `${Number(value)}%`;
      } else if (code === 'pir' || code === 'presence_state') {
        value = value ? 'Movimiento detectado' : 'Sin movimiento';
      } else if (code === 'doorcontact_state') {
        value = value ? 'Abierto' : 'Cerrado';
      } else if (code === 'battery_percentage') {
        value = `${Number(value)}% batería`;
      }

      sensorData[code] = value;
    }

    const formatted = Object.entries(sensorData)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n');

    return {
      success: true,
      output: `Sensor ${deviceId}:\n${formatted}`,
    };
  }
}
