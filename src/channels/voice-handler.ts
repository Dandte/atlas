// ═══════════════════════════════════════
// ATLAS — Voice Handler
// v0.9 Feature 6: STT→Process→TTS pipeline
// ═══════════════════════════════════════

import { ToolRegistry } from '../motor/tool-registry';
import { MessageProcessor } from '../types';
import { config } from '../config/config';
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface VoiceResult {
  text: string;
  transcription: string;
  audioBuffer?: Buffer;
}

export class VoiceHandler {
  private registry: ToolRegistry;
  private processor: MessageProcessor;

  constructor(registry: ToolRegistry, processor: MessageProcessor) {
    this.registry = registry;
    this.processor = processor;
  }

  /**
   * Handle a voice message: transcribe → process → optionally generate TTS
   */
  async handleVoiceMessage(
    audioBuffer: Buffer,
    mimeType: string,
    sessionId: string,
    channel: string
  ): Promise<VoiceResult> {
    // Step 1: Transcribe via voice_stt tool
    const sttTool = this.registry.get('voice_stt');
    if (!sttTool) {
      throw new Error('voice_stt tool not available');
    }

    logger.info(`Voice: transcribing ${audioBuffer.length} bytes (${mimeType})`);

    // VoiceSTTTool expects a file path — save buffer to temp file
    const ext = mimeType.includes('ogg') ? '.ogg'
      : mimeType.includes('mp4') ? '.m4a'
      : mimeType.includes('mpeg') ? '.mp3'
      : mimeType.includes('webm') ? '.webm'
      : '.wav';
    const tmpFile = path.join(os.tmpdir(), `atlas-voice-${Date.now()}${ext}`);
    fs.writeFileSync(tmpFile, audioBuffer);

    let sttResult;
    try {
      sttResult = await sttTool.execute({
        file: tmpFile,
        language: config.voiceTtsLanguage,
      });
    } finally {
      // Cleanup temp file
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    if (!sttResult.success || !sttResult.output) {
      throw new Error(`Transcription failed: ${sttResult.error || 'Empty result'}`);
    }

    // Extract just the transcription text (output may include metadata lines)
    const lines = sttResult.output.split('\n');
    const transcriptionIdx = lines.findIndex(l => l.startsWith('Transcripción:'));
    const transcription = transcriptionIdx >= 0
      ? lines.slice(transcriptionIdx + 1).join('\n').trim()
      : sttResult.output.trim();

    logger.info(`Voice: transcribed "${transcription.substring(0, 100)}..."`);

    // Step 2: Process the transcribed text through CognitiveLoop
    const result = await this.processor.process(transcription, sessionId, channel);

    // Step 3: Generate TTS response if enabled
    let audioResponse: Buffer | undefined;
    if (config.voiceAutoRespondAudio) {
      audioResponse = await this.generateTTS(result.response);
    }

    return {
      text: result.response,
      transcription,
      audioBuffer: audioResponse,
    };
  }

  /**
   * Generate TTS audio from text
   */
  async generateTTS(text: string): Promise<Buffer | undefined> {
    const ttsTool = this.registry.get('tts');
    if (!ttsTool) {
      logger.warn('Voice: tts tool not available for audio response');
      return undefined;
    }

    try {
      const ttsText = text.length > 1000 ? text.substring(0, 1000) + '...' : text;

      const ttsParams: Record<string, unknown> = { text: ttsText };
      if (config.ttsDefaultVoice) ttsParams.voice = config.ttsDefaultVoice;
      if (config.ttsProvider) ttsParams.provider = config.ttsProvider;
      const ttsResult = await ttsTool.execute(ttsParams);

      if (ttsResult.success && ttsResult.output) {
        // TTSTool output: "Audio generado: /path/to/file.mp3\nVoz: ..."
        const match = ttsResult.output.match(/Audio generado: (.+\.mp3)/);
        if (match && fs.existsSync(match[1])) {
          return fs.readFileSync(match[1]);
        }
      }
    } catch (err) {
      logger.error('Voice: TTS generation failed', { error: err });
    }

    return undefined;
  }

  /**
   * Check if voice handling is available
   */
  isAvailable(): boolean {
    return this.registry.has('voice_stt');
  }

  /**
   * Check if TTS response is available
   */
  isTTSAvailable(): boolean {
    return this.registry.has('tts');
  }
}
