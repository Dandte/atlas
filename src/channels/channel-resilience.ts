// ═══════════════════════════════════════════════════════
// ATLAS — Channel Resilience
// Reconnection, health checks, and error recovery
// ═══════════════════════════════════════════════════════

import { Channel } from '../types';
import logger from '../utils/logger';

export type ChannelStatus = 'connected' | 'disconnected' | 'reconnecting' | 'disabled';

export interface ChannelHealthState {
  name: string;
  status: ChannelStatus;
  reconnectAttempts: number;
  lastPingAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  upSince: Date | null;
}

export interface PingableChannel extends Channel {
  ping?(): Promise<void>;
}

/**
 * Monitors registered channels and handles reconnection with exponential backoff.
 * Runs periodic health checks on channels that support ping().
 */
export class ChannelHealthMonitor {
  private states: Map<string, ChannelHealthState> = new Map();
  private channels: Map<string, PingableChannel> = new Map();
  private reconnecting: Set<string> = new Set();
  private healthInterval: ReturnType<typeof setInterval> | null = null;

  // Reconnect settings
  private maxReconnectAttempts = 10;
  private baseReconnectDelay = 5000;   // 5s
  private maxReconnectDelay = 300000;  // 5 minutes

  // Health check settings
  private healthCheckIntervalMs = 300000; // 5 minutes

  /** Register a channel for monitoring */
  register(channel: PingableChannel): void {
    this.channels.set(channel.name, channel);
    this.states.set(channel.name, {
      name: channel.name,
      status: 'disconnected',
      reconnectAttempts: 0,
      lastPingAt: null,
      lastErrorAt: null,
      lastError: null,
      upSince: null,
    });
  }

  /** Unregister a channel from monitoring */
  unregister(channelName: string): void {
    this.channels.delete(channelName);
    this.states.delete(channelName);
    this.reconnecting.delete(channelName);
  }

  /** Mark a channel as connected (call after successful start) */
  markConnected(channelName: string): void {
    const state = this.states.get(channelName);
    if (state) {
      state.status = 'connected';
      state.reconnectAttempts = 0;
      state.upSince = new Date();
      state.lastError = null;
    }
  }

  /** Mark a channel as disconnected (call on error/disconnect) */
  markDisconnected(channelName: string, error?: string): void {
    const state = this.states.get(channelName);
    if (state) {
      state.status = 'disconnected';
      state.lastErrorAt = new Date();
      state.lastError = error || null;
      state.upSince = null;
    }
  }

  /** Get status of all channels */
  getStatus(): ChannelHealthState[] {
    return Array.from(this.states.values());
  }

  /** Get status of a specific channel */
  getChannelStatus(channelName: string): ChannelHealthState | undefined {
    return this.states.get(channelName);
  }

  /** Start periodic health checks */
  startHealthChecks(): void {
    if (this.healthInterval) return;

    this.healthInterval = setInterval(async () => {
      for (const [name, channel] of this.channels) {
        const state = this.states.get(name);
        if (!state || state.status !== 'connected') continue;
        if (!channel.ping) continue;

        try {
          await channel.ping();
          state.lastPingAt = new Date();
        } catch (err: any) {
          logger.warn(`Health check failed for ${name}: ${err.message}`);
          state.status = 'disconnected';
          state.lastErrorAt = new Date();
          state.lastError = err.message;
          state.upSince = null;

          // Trigger reconnection
          this.reconnect(name);
        }
      }
    }, this.healthCheckIntervalMs);
  }

  /** Stop health checks */
  stopHealthChecks(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  /** Attempt to reconnect a channel with exponential backoff */
  async reconnect(channelName: string): Promise<boolean> {
    if (this.reconnecting.has(channelName)) return false;

    const channel = this.channels.get(channelName);
    const state = this.states.get(channelName);
    if (!channel || !state) return false;

    this.reconnecting.add(channelName);
    state.status = 'reconnecting';

    while (state.reconnectAttempts < this.maxReconnectAttempts) {
      state.reconnectAttempts++;
      const delay = Math.min(
        this.baseReconnectDelay * Math.pow(2, state.reconnectAttempts - 1),
        this.maxReconnectDelay
      );

      logger.warn(`${channelName}: reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${state.reconnectAttempts}/${this.maxReconnectAttempts})`);
      await new Promise(r => setTimeout(r, delay));

      try {
        // Stop first (ignore errors)
        try { await channel.stop(); } catch { /* ok */ }

        // Restart
        await channel.start();

        state.status = 'connected';
        state.reconnectAttempts = 0;
        state.upSince = new Date();
        state.lastError = null;
        this.reconnecting.delete(channelName);

        logger.info(`${channelName}: reconnected successfully`);
        return true;
      } catch (err: any) {
        state.lastErrorAt = new Date();
        state.lastError = err.message;
        logger.error(`${channelName}: reconnect attempt ${state.reconnectAttempts} failed: ${err.message}`);
      }
    }

    // Exhausted all attempts
    state.status = 'disconnected';
    this.reconnecting.delete(channelName);
    logger.error(`${channelName}: failed to reconnect after ${this.maxReconnectAttempts} attempts`);
    return false;
  }
}
