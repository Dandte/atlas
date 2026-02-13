// ═══════════════════════════════════════
// ATLAS — Bootstrap: Model Providers
// ═══════════════════════════════════════

import { ModelRouter } from '../thalamus/model-router';
import { ClaudeProvider } from '../thalamus/claude-provider';
import { OpenAIProvider } from '../thalamus/openai-provider';
import { OllamaProvider } from '../thalamus/ollama-provider';
import { LlamaCppProvider } from '../thalamus/llamacpp-provider';
import { LMStudioProvider } from '../thalamus/lmstudio-provider';
import { GeminiProvider } from '../thalamus/gemini-provider';
import { OpenRouterProvider } from '../thalamus/openrouter-provider';
import { config } from '../config/config';
import logger from '../utils/logger';

/** Register all available model providers */
export function registerProviders(router: ModelRouter): void {
  if (config.anthropicApiKey) {
    try {
      router.register('claude', new ClaudeProvider());
      logger.info('Claude provider registered');
    } catch (err) {
      logger.error('Failed to initialize Claude provider', { error: err });
    }
  }

  if (config.openaiApiKey) {
    try {
      router.register('openai', new OpenAIProvider());
      logger.info('OpenAI provider registered');
    } catch (err) {
      logger.error('Failed to initialize OpenAI provider', { error: err });
    }
  }

  router.register('ollama', new OllamaProvider());
  logger.info('Ollama provider registered (local)');

  if (config.llamacppModel) {
    router.register('llamacpp', new LlamaCppProvider());
    logger.info(`llama.cpp provider registered (${config.llamacppBaseUrl})`);
  }

  if (config.lmstudioEnabled) {
    try {
      router.register('lmstudio', new LMStudioProvider());
      logger.info(`LM Studio provider registered (${config.lmstudioBaseUrl})`);
    } catch (err) {
      logger.error('Failed to initialize LM Studio provider', { error: err });
    }
  }

  if (config.geminiApiKey) {
    try {
      router.register('gemini', new GeminiProvider());
      logger.info('Gemini provider registered');
    } catch (err) {
      logger.error('Failed to initialize Gemini provider', { error: err });
    }
  }

  if (config.openrouterApiKey) {
    try {
      router.register('openrouter', new OpenRouterProvider());
      logger.info(`OpenRouter provider registered (model: ${config.openrouterModel})`);
    } catch (err) {
      logger.error('Failed to initialize OpenRouter provider', { error: err });
    }
  }

  if (router.getProviderNames().length === 0) {
    logger.error('No hay providers de modelo configurados. Configurá al menos ANTHROPIC_API_KEY o OPENAI_API_KEY en .env');
    process.exit(1);
  }
}
