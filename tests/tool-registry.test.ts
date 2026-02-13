// ═══════════════════════════════════════
// ATLAS — ToolRegistry Tests
// ═══════════════════════════════════════

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../src/utils/logger', () => ({ __esModule: true, default: mockLogger }));

import { ToolRegistry } from '../src/motor/tool-registry';
import { Tool, ToolDefinition, ToolResult } from '../src/types';

function createMockTool(name: string, description: string = 'test tool'): Tool {
  return {
    definition: {
      name,
      description,
      input_schema: { type: 'object', properties: {} },
    },
    execute: jest.fn().mockResolvedValue({ success: true, output: `${name} executed` }),
  };
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('should register tools', () => {
    registry.register(createMockTool('tool_a'));
    expect(registry.getNames()).toContain('tool_a');
  });

  it('should get tool by name', () => {
    const tool = createMockTool('my_tool');
    registry.register(tool);
    expect(registry.get('my_tool')).toBe(tool);
  });

  it('should return undefined for non-existent tool', () => {
    expect(registry.get('nope')).toBeUndefined();
  });

  it('should list all definitions', () => {
    registry.register(createMockTool('a'));
    registry.register(createMockTool('b'));
    const defs = registry.getDefinitions();
    expect(defs.length).toBe(2);
    expect(defs.map(d => d.name)).toEqual(['a', 'b']);
  });

  it('should return all names', () => {
    registry.register(createMockTool('x'));
    registry.register(createMockTool('y'));
    expect(registry.getNames()).toEqual(['x', 'y']);
  });

  it('should overwrite on re-register', () => {
    registry.register(createMockTool('t', 'v1'));
    registry.register(createMockTool('t', 'v2'));
    const defs = registry.getDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].description).toBe('v2');
  });
});
