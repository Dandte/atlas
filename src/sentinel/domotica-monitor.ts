// ═══════════════════════════════════════
// ATLAS — Domótica Monitor
// Polling de estado de dispositivos Tuya
// Detecta cambios y emite eventos para Pipelines
// ═══════════════════════════════════════

import Database from 'better-sqlite3';
import { dashboardEvents } from '../dashboard/events';
import { config } from '../config/config';
import logger from '../utils/logger';

let TuyaContext: any;
try {
  TuyaContext = require('@tuya/tuya-connector-nodejs').TuyaContext;
} catch {
  // Will fail at runtime if not installed
}

export class DomoticaMonitor {
  private db: Database.Database;
  private client: any;
  private pollInterval: NodeJS.Timeout | null = null;
  private deviceStates: Map<string, Record<string, unknown>> = new Map();
  private trackedDevices: string[] = [];

  constructor(db: Database.Database) {
    this.db = db;
    this.initTables();

    if (TuyaContext) {
      this.client = new TuyaContext({
        baseUrl: config.tuyaApiUrl,
        accessKey: config.tuyaAccessKey,
        secretKey: config.tuyaSecretKey,
      });
    }
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS domotica_devices (
        id TEXT PRIMARY KEY,
        tuya_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        category TEXT,
        room TEXT,
        online INTEGER DEFAULT 0,
        last_state TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS domotica_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        device_name TEXT,
        event_type TEXT NOT NULL,
        property TEXT,
        old_value TEXT,
        new_value TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_domotica_events_device ON domotica_events(device_id);
      CREATE INDEX IF NOT EXISTS idx_domotica_events_time ON domotica_events(timestamp);
    `);
  }

  /** Start polling device states */
  start(intervalSec: number): void {
    if (!this.client) {
      logger.warn('DomoticaMonitor: Tuya SDK not available, skipping');
      return;
    }

    // Initial poll
    this.poll().catch(err => logger.error('DomoticaMonitor initial poll failed', { error: err }));

    // Periodic polling
    this.pollInterval = setInterval(() => {
      this.poll().catch(err => logger.error('DomoticaMonitor poll error', { error: err }));
    }, intervalSec * 1000);

    logger.info(`DomoticaMonitor started (poll every ${intervalSec}s)`);
  }

  /** Stop polling */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    logger.info('DomoticaMonitor stopped');
  }

  /** Poll all tracked devices for state changes (public for on-demand refresh) */
  async poll(): Promise<void> {
    // If no tracked devices yet, discover them
    if (this.trackedDevices.length === 0) {
      await this.discoverDevices();
    }

    for (const deviceId of this.trackedDevices) {
      try {
        const response = await this.client.request({
          path: `/v1.0/iot-03/devices/${deviceId}/status`,
          method: 'GET',
        });

        if (!response.success) continue;

        const statuses = response.result || [];
        const newState: Record<string, unknown> = {};
        for (const s of statuses) {
          newState[s.code] = s.value;
        }

        const oldState = this.deviceStates.get(deviceId) || {};
        const deviceInfo = this.getDeviceInfo(deviceId);

        // Detect changes
        for (const [key, newVal] of Object.entries(newState)) {
          const oldVal = oldState[key];
          if (oldVal !== undefined && oldVal !== newVal) {
            // State changed!
            const deviceName = deviceInfo?.name || deviceId;
            const category = deviceInfo?.category || 'unknown';

            dashboardEvents.emitDeviceStateChanged({
              deviceId,
              deviceName,
              deviceType: category,
              property: key,
              oldValue: oldVal,
              newValue: newVal,
            });

            // Log event to SQLite
            this.db.prepare(`
              INSERT INTO domotica_events (device_id, device_name, event_type, property, old_value, new_value)
              VALUES (?, ?, 'state_changed', ?, ?, ?)
            `).run(deviceId, deviceName, key, String(oldVal), String(newVal));

            logger.debug(`Domotica: ${deviceName} ${key}: ${oldVal} → ${newVal}`);
          }
        }

        // Update stored state
        this.deviceStates.set(deviceId, newState);

        // Update DB
        this.db.prepare(`
          UPDATE domotica_devices SET last_state = ?, last_updated = datetime('now')
          WHERE tuya_id = ?
        `).run(JSON.stringify(newState), deviceId);

      } catch (err) {
        logger.debug(`DomoticaMonitor: failed to poll device ${deviceId}`, { error: err });
      }
    }
  }

  /** Discover devices from Tuya and save to DB */
  private async discoverDevices(): Promise<void> {
    try {
      const uid = config.tuyaDeviceId;
      let response: any;

      if (uid) {
        response = await this.client.request({
          path: `/v1.0/users/${uid}/devices`,
          method: 'GET',
        });
      } else {
        response = await this.client.request({
          path: '/v1.0/iot-01/associated-users/devices',
          method: 'GET',
          query: { last_row_key: '', size: 100 },
        });
      }

      if (!response.success) {
        logger.warn(`DomoticaMonitor: device discovery failed (code=${response.code}, msg=${response.msg})`);

        // Fallback: try alternative endpoint if UID-based one fails
        if (uid) {
          logger.info('DomoticaMonitor: trying alternative endpoint...');
          response = await this.client.request({
            path: '/v1.0/iot-01/associated-users/devices',
            method: 'GET',
            query: { last_row_key: '', size: 100 },
          });

          if (!response.success) {
            logger.warn(`DomoticaMonitor: alternative endpoint also failed (code=${response.code}, msg=${response.msg}). Verificá los permisos API en iot.tuya.com → Cloud → tu proyecto → Service API → suscribite a "IoT Core" y "Smart Home Device Management"`);
            return;
          }
        } else {
          return;
        }
      }

      const devices = Array.isArray(response.result) ? response.result : (response.result?.devices || []);

      const upsert = this.db.prepare(`
        INSERT INTO domotica_devices (id, tuya_id, name, category, online)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tuya_id) DO UPDATE SET name = excluded.name, category = excluded.category, online = excluded.online
      `);

      for (const d of devices) {
        upsert.run(d.id, d.id, d.name, d.category, d.online ? 1 : 0);
        this.trackedDevices.push(d.id);
      }

      logger.info(`DomoticaMonitor: discovered ${devices.length} devices`);
    } catch (err) {
      logger.error('DomoticaMonitor: device discovery error', { error: err });
    }
  }

  /** Get device info from SQLite */
  private getDeviceInfo(tuyaId: string): { name: string; category: string } | null {
    const row = this.db.prepare('SELECT name, category FROM domotica_devices WHERE tuya_id = ?').get(tuyaId) as any;
    return row || null;
  }

  // ── Query methods (for dashboard API) ──

  /** Get all known devices with their last state */
  getDevices(): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM domotica_devices ORDER BY name').all() as any[];
  }

  /** Get device detail including last state */
  getDevice(deviceId: string): Record<string, unknown> | null {
    return this.db.prepare('SELECT * FROM domotica_devices WHERE tuya_id = ?').get(deviceId) as any || null;
  }

  /** Get recent events */
  getEvents(limit: number = 50): Array<Record<string, unknown>> {
    return this.db.prepare(
      'SELECT * FROM domotica_events ORDER BY timestamp DESC LIMIT ?'
    ).all(limit) as any[];
  }

  /** Get events for a specific device */
  getDeviceEvents(deviceId: string, limit: number = 50): Array<Record<string, unknown>> {
    return this.db.prepare(
      'SELECT * FROM domotica_events WHERE device_id = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(deviceId, limit) as any[];
  }
}
