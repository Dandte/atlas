// ═══════════════════════════════════════
// ATLAS — Web Chat Channel
// Express + Socket.IO backend
// Neural Interface support: emotional relay, operation state, voice
// ═══════════════════════════════════════

import express from 'express';
import { createServer, Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { Channel, IncomingMessage, OutgoingMessage } from '../types';
import { ChannelManager } from './channel-manager';
import { MemoryManager } from '../hippocampus/memory-manager';
import { EmotionalEngine } from '../config/emotional-engine';
import { VoiceHandler } from './voice-handler';
import { dashboardEvents } from '../dashboard/events';
import { approvalSystem } from '../security/approval';
import { approvalContext } from '../security/approval-context';
import { config } from '../config/config';
import logger from '../utils/logger';
import { v4 as uuid } from 'uuid';

export class WebChannel implements Channel {
  name = 'web';
  private app: express.Application;
  private httpServer: HttpServer;
  private io: SocketIOServer;
  private manager: ChannelManager;
  private memory: MemoryManager;
  private messageHandler?: (msg: IncomingMessage) => void;
  private running = false;
  private sockets: Map<string, any> = new Map(); // socketId → socket
  private pendingApprovals: Map<string, { resolve: (approved: boolean) => void; timeout: NodeJS.Timeout }> = new Map();

  // Neural interface state
  private emotionalEngine?: EmotionalEngine | null;
  private voiceHandler?: VoiceHandler;
  private lastEmotionalState: string = '';
  private emotionalInterval?: NodeJS.Timeout;

  constructor(
    manager: ChannelManager,
    memory: MemoryManager,
    emotionalEngine?: EmotionalEngine | null,
    voiceHandler?: VoiceHandler
  ) {
    this.manager = manager;
    this.memory = memory;
    this.emotionalEngine = emotionalEngine;
    this.voiceHandler = voiceHandler;

    this.app = express();
    this.app.use(express.json());

    this.httpServer = createServer(this.app);
    this.io = new SocketIOServer(this.httpServer, {
      cors: { origin: '*' },
      maxHttpBufferSize: 10 * 1024 * 1024, // 10MB for voice messages
    });

    this.setupRoutes();
    this.setupSocket();
    this.setupApprovalHandler();
    this.setupEventRelay();
  }

  async start(): Promise<void> {
    // Start emotional state polling
    if (this.emotionalEngine) {
      this.emotionalInterval = setInterval(() => {
        const state = this.emotionalEngine!.getState();
        if (state.current !== this.lastEmotionalState) {
          this.lastEmotionalState = state.current;
          this.io.emit('emotional_state', state);
        }
      }, 15000);
    }

    return new Promise((resolve) => {
      this.httpServer.listen(config.webPort, () => {
        this.running = true;
        logger.info(`Web chat listening on http://localhost:${config.webPort}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.emotionalInterval) {
      clearInterval(this.emotionalInterval);
      this.emotionalInterval = undefined;
    }
    this.io.close();
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    const socket = this.sockets.get(chatId);
    if (socket) {
      const payload: Record<string, unknown> = {
        text: message.text,
        parseMode: message.parseMode,
      };

      // Send attachments as base64
      if (message.attachments && message.attachments.length > 0) {
        payload.attachments = message.attachments.map(a => {
          const buffer = a.buffer || (a.path ? require('fs').readFileSync(a.path) : null);
          return {
            type: a.type,
            fileName: a.fileName,
            base64: buffer ? buffer.toString('base64') : null,
          };
        }).filter(a => a.base64);
      }

      socket.emit('response', payload);
    }
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Event Relay (operation states from dashboard events) ──

  private setupEventRelay(): void {
    dashboardEvents.on('conversation_start', () => {
      this.io.emit('operation_state', { state: 'pensando', detail: 'Procesando...' });
    });

    dashboardEvents.on('tool_execution', (data: any) => {
      this.io.emit('operation_state', {
        state: data.toolName,
        detail: `${data.toolName} (${data.durationMs}ms)`,
        success: data.success,
      });
    });

    dashboardEvents.on('conversation_end', () => {
      this.io.emit('operation_state', { state: 'idle', detail: '' });
    });
  }

  // ── Approval Handler ──

  private setupApprovalHandler(): void {
    approvalSystem.setChannelHandler('web', async (action) => {
      const ctx = approvalContext.getStore();
      const chatId = ctx?.chatId;
      if (!chatId) {
        logger.warn('Web approval: no chatId in context');
        return false;
      }

      const socket = this.sockets.get(chatId);
      if (!socket) {
        logger.warn('Web approval: socket not found for chatId');
        return false;
      }

      const approvalId = uuid();

      // Emit approval request to the client
      socket.emit('approval_request', {
        id: approvalId,
        tool: action.tool,
        description: action.description,
      });

      // Wait for response with 60s timeout
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          this.pendingApprovals.delete(approvalId);
          socket.emit('approval_timeout', { id: approvalId });
          resolve(false);
        }, 60_000);

        this.pendingApprovals.set(approvalId, { resolve, timeout });
      });
    });
  }

  // ── HTTP Routes ──

  private setupRoutes(): void {
    // Serve frontend
    const webDir = path.join(config.rootDir, 'web');
    this.app.use(express.static(webDir));

    this.app.get('/', (_req, res) => {
      res.sendFile(path.join(webDir, 'index.html'));
    });

    // Health check
    this.app.get('/api/health', (_req, res) => {
      res.json({
        status: 'ok',
        uptime: process.uptime(),
        version: '1.1.0',
      });
    });

    // Stats
    this.app.get('/api/stats', (_req, res) => {
      const stats = this.memory.getStats();
      res.json(stats);
    });

    // Emotional state endpoint (for polling fallback)
    this.app.get('/api/emotional', (_req, res) => {
      if (this.emotionalEngine) {
        res.json(this.emotionalEngine.getState());
      } else {
        res.json({ current: 'neutral', intensity: 0.5, reason: 'Engine no disponible' });
      }
    });

    // REST chat endpoint
    this.app.post('/api/chat', async (req, res) => {
      try {
        const { message, sessionId: clientSessionId } = req.body;
        if (!message || typeof message !== 'string') {
          res.status(400).json({ error: 'message is required' });
          return;
        }

        const chatId = clientSessionId || `rest_${uuid().substring(0, 8)}`;
        const msg: IncomingMessage = {
          id: uuid(),
          channel: 'web',
          chatId,
          userId: 'rest-client',
          text: message,
          timestamp: new Date(),
        };

        const result = await this.manager.processMessage(msg);

        res.json({
          response: result.response,
          sessionId: result.sessionId,
          toolsUsed: result.toolsUsed,
          model: result.model,
          tokens: result.tokensUsed,
          processingTime: result.processingTime,
        });
      } catch (err) {
        logger.error('REST /api/chat error', { error: err });
        res.status(500).json({
          error: 'Error procesando el mensaje',
        });
      }
    });
  }

  // ── WebSocket ──

  private setupSocket(): void {
    this.io.on('connection', (socket) => {
      const socketId = socket.id;
      this.sockets.set(socketId, socket);
      logger.debug(`Web socket connected: ${socketId}`);

      // Send config to client
      socket.emit('config', {
        voiceEnabled: !!(this.voiceHandler && this.voiceHandler.isAvailable()),
      });

      // Send current emotional state on connect
      if (this.emotionalEngine) {
        socket.emit('emotional_state', this.emotionalEngine.getState());
      }

      // Text message
      socket.on('message', async (data: { text: string }) => {
        if (!data.text) return;

        socket.emit('typing', true);

        const msg: IncomingMessage = {
          id: uuid(),
          channel: 'web',
          chatId: socketId,
          userId: `web_${socketId}`,
          text: data.text,
          timestamp: new Date(),
        };

        try {
          const result = await this.manager.processMessage(msg);

          socket.emit('typing', false);
          socket.emit('response', {
            text: result.response,
            toolsUsed: result.toolsUsed,
            model: result.model,
            tokens: result.tokensUsed,
            processingTime: result.processingTime,
          });
        } catch (err) {
          socket.emit('typing', false);
          socket.emit('response', {
            text: 'Hubo un error procesando tu mensaje. Intenta de nuevo.',
          });
        }
      });

      // Voice message
      socket.on('voice_message', async (data: { audio: ArrayBuffer; mimeType: string }) => {
        if (!this.voiceHandler) {
          socket.emit('response', { text: 'Voz no disponible. Se requiere OPENAI_API_KEY y voice_stt tool.' });
          return;
        }

        socket.emit('typing', true);

        try {
          const buffer = Buffer.from(data.audio);
          const sessionId = this.memory.episodic.createSession('web');
          const result = await this.voiceHandler.handleVoiceMessage(buffer, data.mimeType, sessionId, 'web');

          socket.emit('typing', false);
          socket.emit('response', {
            text: result.text,
            transcription: result.transcription,
            audioResponse: result.audioBuffer ? {
              base64: result.audioBuffer.toString('base64'),
              mimeType: 'audio/mp3',
            } : undefined,
          });
        } catch (err: any) {
          socket.emit('typing', false);
          socket.emit('response', {
            text: `Error procesando audio: ${err.message}`,
          });
          logger.error('Web voice message error', { error: err });
        }
      });

      // Approval response from client
      socket.on('approval_response', (data: { id: string; approved: boolean }) => {
        const pending = this.pendingApprovals.get(data.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingApprovals.delete(data.id);
          pending.resolve(data.approved);
        }
      });

      socket.on('disconnect', () => {
        this.sockets.delete(socketId);
        logger.debug(`Web socket disconnected: ${socketId}`);
      });
    });
  }
}
