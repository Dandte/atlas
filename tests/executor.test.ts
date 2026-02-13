// ═══════════════════════════════════════
// ATLAS — ToolExecutor Tests
// ═══════════════════════════════════════

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../src/utils/logger', () => ({ __esModule: true, default: mockLogger }));

// Mock approval system to always approve
jest.mock('../src/security/approval', () => ({
  approvalSystem: {
    requestApproval: jest.fn().mockResolvedValue(true),
  },
}));

import { ToolRegistry } from '../src/motor/tool-registry';
import { ToolExecutor } from '../src/motor/executor';
import { Tool, ToolResult } from '../src/types';

function createMockTool(name: string, opts?: { dangerous?: boolean; result?: ToolResult }): Tool {
  return {
    definition: {
      name,
      description: `Mock ${name}`,
      input_schema: { type: 'object', properties: {} },
      dangerous: opts?.dangerous,
    },
    execute: jest.fn().mockResolvedValue(opts?.result ?? { success: true, output: `${name} done` }),
  };
}

function createMockAuditLog() {
  return {
    logToolExecution: jest.fn(),
  } as any;
}

describe('ToolExecutor', () => {
  let registry: ToolRegistry;
  let executor: ToolExecutor;
  let auditLog: ReturnType<typeof createMockAuditLog>;

  beforeEach(() => {
    registry = new ToolRegistry();
    auditLog = createMockAuditLog();
    executor = new ToolExecutor(registry, auditLog);
  });

  it('should execute a registered tool', async () => {
    const tool = createMockTool('test_tool');
    registry.register(tool);

    const result = await executor.execute({
      id: 'call-1',
      name: 'test_tool',
      input: { key: 'value' },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('test_tool done');
    expect(tool.execute).toHaveBeenCalledWith({ key: 'value' });
  });

  it('should return error for non-existent tool', async () => {
    const result = await executor.execute({
      id: 'call-2',
      name: 'nonexistent',
      input: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should log tool execution to audit log', async () => {
    registry.register(createMockTool('audited_tool'));

    await executor.execute({
      id: 'call-3',
      name: 'audited_tool',
      input: { action: 'test' },
    });

    expect(auditLog.logToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'audited_tool',
        success: true,
      })
    );
  });

  it('should handle tool execution errors', async () => {
    const failingTool: Tool = {
      definition: { name: 'fail_tool', description: 'Fails', input_schema: { type: 'object', properties: {} } },
      execute: jest.fn().mockRejectedValue(new Error('Execution crashed')),
    };
    registry.register(failingTool);

    const result = await executor.execute({
      id: 'call-4',
      name: 'fail_tool',
      input: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Execution crashed');
    expect(auditLog.logToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'fail_tool',
        success: false,
      })
    );
  });

  it('should request approval for dangerous tools', async () => {
    const { approvalSystem } = require('../src/security/approval');
    registry.register(createMockTool('dangerous_tool', { dangerous: true }));

    await executor.execute({
      id: 'call-5',
      name: 'dangerous_tool',
      input: { command: 'rm -rf /' },
    });

    expect(approvalSystem.requestApproval).toHaveBeenCalledWith(
      'dangerous_tool',
      expect.any(Object),
      expect.any(String)
    );
  });

  it('should deny execution when approval is rejected', async () => {
    const { approvalSystem } = require('../src/security/approval');
    approvalSystem.requestApproval.mockResolvedValueOnce(false);

    registry.register(createMockTool('dangerous_tool', { dangerous: true }));

    const result = await executor.execute({
      id: 'call-6',
      name: 'dangerous_tool',
      input: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('denied');
  });

  it('should treat git commit/push as dangerous', async () => {
    const { approvalSystem } = require('../src/security/approval');
    const gitTool = createMockTool('git');
    registry.register(gitTool);

    await executor.execute({
      id: 'call-7',
      name: 'git',
      input: { operation: 'push' },
    });

    expect(approvalSystem.requestApproval).toHaveBeenCalled();
  });

  it('should pass model info to audit log', async () => {
    registry.register(createMockTool('model_tool'));

    await executor.execute(
      { id: 'call-8', name: 'model_tool', input: {} },
      'claude-sonnet-4-20250514'
    );

    expect(auditLog.logToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-20250514',
      })
    );
  });
});
