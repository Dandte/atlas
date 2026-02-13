// ═══════════════════════════════════════
// ATLAS — Built-in Skills Registration
// ═══════════════════════════════════════

import { ToolRegistry } from '../../tool-registry';
import { ChannelManager } from '../../../channels/channel-manager';
import type Database from 'better-sqlite3';
import logger from '../../../utils/logger';

// Skills — Original
import { TrmColombiaTool } from './trm-colombia';
import { WeatherTool } from './weather';
import { LoanCalculatorTool } from './loan-calculator';
import { ReminderTool } from './reminder';
import { NotesTool } from './notes';
import { ConverterTool } from './converter';
import { SummarizeUrlTool } from './summarize-url';
import { PasswordGenTool } from './password-gen';

// Skills — New
import { CalculatorTool } from './calculator';
import { TranslateTool } from './translate';
import { CountdownTool } from './countdown';
import { CryptoPricesTool } from './crypto-prices';
import { DnsLookupTool } from './dns-lookup';
import { RandomTool } from './random';

// Skills — OpenClaw-inspired
import { BrowserTool } from './browser';
import { ClipboardTool } from './clipboard';
// ScreenshotTool removed — replaced by motor/tools/screenshot.ts (with channel send support)
import { EmailTool } from './email';
import { OpenAppTool } from './open-app';

// Skills — OpenClaw Phase 2
import { PDFGeneratorTool } from './pdf-generator';
import { GoogleCalendarTool } from './google-calendar';
import { ImageGenTool } from './image-gen';

// Skills — OpenClaw Phase 3
import { SpotifyTool } from './spotify';
import { QRCodeTool } from './qr-code';
import { YouTubeDlTool } from './youtube-dl';
import { VoiceSTTTool } from './voice-stt';
import { OCRTool } from './ocr';
import { TTSTool } from './tts';
import { UrlShortenerTool } from './url-shortener';
import { WorkflowTool } from './workflow';

/** Module-level list of registered builtin skill info (populated by registerBuiltinSkills) */
export const builtinSkillsList: Array<{ name: string; description: string }> = [];

/**
 * Register all built-in skills.
 * Call after ChannelManager is available.
 */
export function registerBuiltinSkills(
  registry: ToolRegistry,
  db: Database.Database,
  channelManager: ChannelManager
): number {
  const skills = [
    new TrmColombiaTool(),
    new WeatherTool(),
    new LoanCalculatorTool(),
    new ReminderTool(channelManager),
    new NotesTool(db),
    new ConverterTool(),
    new SummarizeUrlTool(),
    new PasswordGenTool(),
    new CalculatorTool(),
    new TranslateTool(),
    new CountdownTool(),
    new CryptoPricesTool(),
    new DnsLookupTool(),
    new RandomTool(),
    new BrowserTool(),
    new ClipboardTool(),
    // ScreenshotTool now registered in index.ts (with channel send)
    new EmailTool(),
    new OpenAppTool(),
    new PDFGeneratorTool(),
    new GoogleCalendarTool(),
    new ImageGenTool(),
    new SpotifyTool(),
    new QRCodeTool(),
    new YouTubeDlTool(),
    new VoiceSTTTool(),
    new OCRTool(),
    new TTSTool(),
    new UrlShortenerTool(),
    new WorkflowTool(db),
  ];

  for (const skill of skills) {
    registry.register(skill);
    builtinSkillsList.push({
      name: skill.definition.name,
      description: skill.definition.description,
    });
  }

  logger.info(`${skills.length} built-in skills registered`);
  return skills.length;
}
