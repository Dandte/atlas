// ═══════════════════════════════════════
// ATLAS — WhatsApp Multi-Instance Config
// JSON-based instance management
// ═══════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { config } from './config';
import logger from '../utils/logger';

export interface WhatsAppInstanceConfig {
  id: string;
  displayName: string;
  phoneHint?: string;
  enabled: boolean;
  allowedNumbers: string[];
  monitorEnabled: boolean;
  isOwner: boolean;
}

const INSTANCES_FILE = path.join(config.dataDir, 'whatsapp-instances.json');

/** Load instances from JSON. If file doesn't exist, create default from env vars. */
export function loadInstances(): WhatsAppInstanceConfig[] {
  if (fs.existsSync(INSTANCES_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf-8'));
      return Array.isArray(data) ? data : [];
    } catch (err) {
      logger.error('Failed to parse whatsapp-instances.json', { error: err });
      return [];
    }
  }

  // No file — auto-generate default instance from env vars (backward compat)
  if (!config.whatsappEnabled) return [];

  const defaultInstance: WhatsAppInstanceConfig = {
    id: 'default',
    displayName: 'WhatsApp Principal',
    enabled: true,
    allowedNumbers: config.whatsappAllowedNumbers,
    monitorEnabled: config.whatsappMonitorEnabled,
    isOwner: true,
  };

  // Migrate old session dir if exists
  const oldSessionDir = path.join(config.dataDir, 'whatsapp-session');
  const newSessionDir = path.join(config.dataDir, 'whatsapp-session-default');
  if (fs.existsSync(oldSessionDir) && !fs.existsSync(newSessionDir)) {
    try {
      fs.renameSync(oldSessionDir, newSessionDir);
      logger.info('Migrated whatsapp-session/ → whatsapp-session-default/');
    } catch (err) {
      logger.warn('Could not migrate WhatsApp session dir', { error: err });
    }
  }

  saveInstances([defaultInstance]);
  return [defaultInstance];
}

/** Save instances to JSON file. */
export function saveInstances(instances: WhatsAppInstanceConfig[]): void {
  fs.writeFileSync(INSTANCES_FILE, JSON.stringify(instances, null, 2), 'utf-8');
}

/** Add a new instance and persist. */
export function addInstance(instance: WhatsAppInstanceConfig): WhatsAppInstanceConfig[] {
  const instances = loadInstances();
  if (instances.find(i => i.id === instance.id)) {
    throw new Error(`Instance "${instance.id}" already exists`);
  }
  instances.push(instance);
  saveInstances(instances);
  return instances;
}

/** Remove an instance by id and persist. */
export function removeInstance(id: string): WhatsAppInstanceConfig[] {
  let instances = loadInstances();
  instances = instances.filter(i => i.id !== id);
  saveInstances(instances);
  return instances;
}

/** Update an existing instance and persist. */
export function updateInstance(id: string, updates: Partial<WhatsAppInstanceConfig>): WhatsAppInstanceConfig | null {
  const instances = loadInstances();
  const idx = instances.findIndex(i => i.id === id);
  if (idx === -1) return null;
  instances[idx] = { ...instances[idx], ...updates, id }; // id is immutable
  saveInstances(instances);
  return instances[idx];
}

/** Get session directory for an instance. */
export function getSessionDir(instanceId: string): string {
  return path.join(config.dataDir, `whatsapp-session-${instanceId}`);
}
