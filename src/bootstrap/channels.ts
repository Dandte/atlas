// ═══════════════════════════════════════
// ATLAS — Bootstrap: Channel Registration
// ═══════════════════════════════════════

import { MessageProcessor } from '../types';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ModelRouter } from '../thalamus/model-router';
import { ToolRegistry } from '../motor/tool-registry';
import { ChannelManager } from '../channels/channel-manager';
import { CLIChannel } from '../channels/cli';
import { CognitiveLoop } from '../cortex/cognitive-loop';
import { Coordinator } from '../nexus/coordinator';
import { Scheduler } from '../sentinel/scheduler';
import { ProactiveEngine } from '../sentinel/proactive-engine';
import { SkillForge } from '../forge/skill-forge';
import { SessionManager } from '../cortex/session-manager';
import { BackupManager } from '../utils/backup';
import { VoiceHandler } from '../channels/voice-handler';
import { EmotionalEngine } from '../config/emotional-engine';
import { config } from '../config/config';
import logger from '../utils/logger';

/** Register and start all channels */
export async function registerChannels(
  channelManager: ChannelManager,
  processor: MessageProcessor,
  cognitiveLoop: CognitiveLoop,
  memory: MemoryManager,
  router: ModelRouter,
  registry: ToolRegistry,
  scheduler: Scheduler,
  proactiveEngine: ProactiveEngine,
  skillForge: SkillForge,
  coordinator: Coordinator | undefined,
  backupManager: BackupManager | undefined,
  sessionManager: SessionManager,
  voiceHandler: VoiceHandler | undefined,
  emotionalEngine?: EmotionalEngine | null
): Promise<boolean> {
  let hasChannels = false;

  // CLI
  if (config.cliEnabled) {
    const cli = new CLIChannel(
      processor, cognitiveLoop, memory, router, registry,
      scheduler, proactiveEngine, skillForge, coordinator, backupManager,
      sessionManager
    );
    channelManager.register(cli);
    hasChannels = true;
  }

  // Telegram
  if (config.telegramBotToken) {
    try {
      const { TelegramChannel } = require('../channels/telegram');
      const telegram = new TelegramChannel(
        config.telegramBotToken, memory, router, channelManager, voiceHandler
      );
      channelManager.register(telegram);
      channelManager.connectHandler(telegram);
      hasChannels = true;
      if (config.telegramOwnerChatId) {
        channelManager.setDefaultChatId('telegram', config.telegramOwnerChatId);
      }
      logger.info('Telegram channel registered');
    } catch (err) {
      logger.error('Failed to initialize Telegram channel', { error: err });
    }
  }

  // WhatsApp
  if (config.whatsappEnabled) {
    try {
      const { WhatsAppChannel } = require('../channels/whatsapp');
      const { WhatsAppSendTool } = require('../motor/tools/whatsapp-send');
      const { ContactsTool } = require('../motor/tools/contacts');
      const { loadInstances } = require('../config/whatsapp-instances');

      const waInstances = loadInstances();
      const waChannels: any[] = [];

      for (const inst of waInstances.filter((i: any) => i.enabled)) {
        const waCh = new WhatsAppChannel(channelManager, memory.db, inst.id, inst, voiceHandler);
        channelManager.register(waCh);
        channelManager.connectHandler(waCh);
        waChannels.push(waCh);
      }

      if (waChannels.length > 0) {
        hasChannels = true;
        const primaryWa = waChannels.find((ch: any) => ch.getInstanceConfig().isOwner) || waChannels[0];

        registry.register(new WhatsAppSendTool(
          () => primaryWa.getSocket(),
          () => primaryWa.getContactsCache(),
          memory
        ));
        registry.register(new ContactsTool(memory));

        const monitorInstance = waChannels.find((ch: any) => ch.getMonitor());
        if (monitorInstance) {
          const { WhatsAppControlTool } = require('../motor/tools/whatsapp-control');
          registry.register(new WhatsAppControlTool(
            () => monitorInstance.getMonitor(),
            () => primaryWa.getSocket(),
            () => primaryWa.getContactsCache(),
            memory
          ));
          proactiveEngine.setWhatsAppMonitor(() => monitorInstance.getMonitor());
          logger.info('WhatsApp Monitor + control tool registered');
        }

        if (config.whatsappOwnerNumber) {
          const ownerChatId = config.whatsappOwnerNumber.includes('@')
            ? config.whatsappOwnerNumber
            : `${config.whatsappOwnerNumber}@s.whatsapp.net`;
          for (const waCh of waChannels) {
            channelManager.setDefaultChatId(waCh.name, ownerChatId);
          }
        }

        logger.info(`${waChannels.length} WhatsApp instance(s) registered`);
      }
    } catch (err) {
      logger.error('Failed to initialize WhatsApp channels', { error: err });
    }
  }

  // Web
  if (config.webEnabled) {
    try {
      const { WebChannel } = require('../channels/web');
      const web = new WebChannel(channelManager, memory, emotionalEngine, voiceHandler);
      channelManager.register(web);
      hasChannels = true;
      logger.info('Web channel registered');
    } catch (err) {
      logger.error('Failed to initialize Web channel', { error: err });
    }
  }

  // Discord
  if (config.discordEnabled && config.discordBotToken) {
    try {
      const { DiscordChannel } = require('../channels/discord');
      const discord = new DiscordChannel(config.discordBotToken, memory, router, channelManager);
      channelManager.register(discord);
      channelManager.connectHandler(discord);
      hasChannels = true;
      logger.info('Discord channel registered');
    } catch (err) {
      logger.error('Failed to initialize Discord channel', { error: err });
    }
  }

  // Slack
  if (config.slackEnabled && config.slackBotToken && config.slackAppToken) {
    try {
      const { SlackChannel } = require('../channels/slack');
      const slack = new SlackChannel(channelManager, memory);
      channelManager.register(slack);
      channelManager.connectHandler(slack);
      hasChannels = true;
      logger.info('Slack channel registered');
    } catch (err) {
      logger.error('Failed to initialize Slack channel', { error: err });
    }
  }

  // DM Pairing
  if (config.dmPairingEnabled) {
    try {
      const { DMPairing } = require('../security/dm-pairing');
      const dmPairing = new DMPairing(memory.db, config.dmPairingTtlMinutes, config.dmPairingMaxPending);

      if (config.telegramOwnerChatId) dmPairing.allowSender('telegram', config.telegramOwnerChatId, config.owner, 'owner');
      if (config.whatsappOwnerNumber) {
        dmPairing.allowSender('whatsapp', config.whatsappOwnerNumber, config.owner, 'owner');
        dmPairing.allowSender('whatsapp', `${config.whatsappOwnerNumber}@s.whatsapp.net`, config.owner, 'owner');
      }
      if (config.discordOwnerId) dmPairing.allowSender('discord', config.discordOwnerId, config.owner, 'owner');
      if (config.slackOwnerId) dmPairing.allowSender('slack', config.slackOwnerId, config.owner, 'owner');

      const cliChannel = channelManager.getChannel('cli') as any;
      if (cliChannel) cliChannel._dmPairing = dmPairing;

      logger.info('DM Pairing initialized');
    } catch (err) {
      logger.error('Failed to initialize DM Pairing (non-fatal)', { error: err });
    }
  }

  return hasChannels;
}
