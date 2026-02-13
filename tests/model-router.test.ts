// ═══════════════════════════════════════
// ATLAS — ModelRouter Tests
// ═══════════════════════════════════════

jest.mock('../src/config/config', () => ({
  config: {
    defaultModel: 'claude',
  },
}));

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../src/utils/logger', () => ({ __esModule: true, default: mockLogger }));

import { ModelRouter } from '../src/thalamus/model-router';
import { ModelProvider, ModelResponse, Message, ToolDefinition, ChatOptions } from '../src/types';

/** Create a mock provider */
function mockProvider(name: string, response?: Partial<ModelResponse>): ModelProvider {
  return {
    name,
    chat: jest.fn().mockResolvedValue({
      content: response?.content ?? `Response from ${name}`,
      toolCalls: response?.toolCalls ?? [],
      rawContent: response?.rawContent ?? [{ type: 'text', text: `Response from ${name}` }],
      model: response?.model ?? name,
      tokensUsed: response?.tokensUsed ?? { input: 100, output: 50 },
      stopReason: response?.stopReason ?? 'end_turn',
    }),
  };
}

describe('ModelRouter', () => {
  let router: ModelRouter;

  beforeEach(() => {
    router = new ModelRouter('claude');
  });

  it('should register providers', () => {
    router.register('claude', mockProvider('claude'));
    router.register('openai', mockProvider('openai'));
    expect(router.getProviderNames()).toContain('claude');
    expect(router.getProviderNames()).toContain('openai');
  });

  it('should route to default provider', async () => {
    const claude = mockProvider('claude');
    router.register('claude', claude);
    router.register('openai', mockProvider('openai'));

    const response = await router.chat('system', [{ role: 'user', content: 'hello' }]);
    expect(response.content).toBe('Response from claude');
    expect(claude.chat).toHaveBeenCalledTimes(1);
  });

  it('should detect @prefix and route accordingly', async () => {
    const claude = mockProvider('claude');
    const openai = mockProvider('openai');
    router.register('claude', claude);
    router.register('openai', openai);

    const response = await router.chat('system', [
      { role: 'user', content: '@openai tell me a joke' },
    ]);
    expect(response.content).toBe('Response from openai');
    expect(openai.chat).toHaveBeenCalledTimes(1);
    // Verify prefix was stripped
    const callArgs = (openai.chat as jest.Mock).mock.calls[0];
    const messages = callArgs[1] as Message[];
    expect(messages[0].content).toBe('tell me a joke');
  });

  it('should fallback to next provider on failure', async () => {
    const failingClaude: ModelProvider = {
      name: 'claude',
      chat: jest.fn().mockRejectedValue(new Error('500 server error')),
    };
    const openai = mockProvider('openai');
    router.register('claude', failingClaude);
    router.register('openai', openai);

    const response = await router.chat('system', [{ role: 'user', content: 'hello' }]);
    expect(response.content).toBe('Response from openai');
  });

  it('should throw when all providers fail', async () => {
    const failing: ModelProvider = {
      name: 'claude',
      chat: jest.fn().mockRejectedValue(new Error('500 error')),
    };
    router.register('claude', failing);

    await expect(
      router.chat('system', [{ role: 'user', content: 'hello' }])
    ).rejects.toThrow('Todos los providers fallaron');
  });

  it('should track token usage', async () => {
    router.register('claude', mockProvider('claude', {
      tokensUsed: { input: 500, output: 200 },
    }));

    await router.chat('system', [{ role: 'user', content: 'hello' }]);
    const usage = router.getTokenUsage();
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[0].tokensLastMinute).toBe(700);
  });

  it('should provide provider status', () => {
    router.register('claude', mockProvider('claude'));
    router.register('openai', mockProvider('openai'));

    const status = router.getProviderStatus();
    expect(status.length).toBe(2);
    expect(status.find(s => s.name === 'claude')?.isDefault).toBe(true);
  });

  it('should support sticky override via setRoute', async () => {
    const claude = mockProvider('claude');
    const openai = mockProvider('openai');
    router.register('claude', claude);
    router.register('openai', openai);

    router.setRoute('openai');
    const response = await router.chat('system', [{ role: 'user', content: 'hello' }]);
    expect(response.content).toBe('Response from openai');
  });

  it('should reset route', async () => {
    const claude = mockProvider('claude');
    const openai = mockProvider('openai');
    router.register('claude', claude);
    router.register('openai', openai);

    router.setRoute('openai');
    router.resetRoute();
    const response = await router.chat('system', [{ role: 'user', content: 'hello' }]);
    expect(response.content).toBe('Response from claude');
  });
});
