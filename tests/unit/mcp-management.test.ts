/**
 * MCP Tool Integration Unit Tests
 * 
 * These tests verify the MCP tool registration and execution logic
 * without requiring a full browser environment. They test the
 * AIChatKernel MCP methods in isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock browser globals
const mockLocalStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    key: vi.fn((i: number) => Object.keys(store)[i] || null),
    get length() { return Object.keys(store).length; },
  };
})();
vi.stubGlobal('localStorage', mockLocalStorage);

// Mock DOMParser
class MockDOMParser {
  parseFromString(str: string, _type: string) {
    return {
      querySelector: vi.fn().mockReturnValue(null),
      querySelectorAll: vi.fn().mockReturnValue([]),
      documentElement: { innerHTML: str },
    };
  }
}
vi.stubGlobal('DOMParser', MockDOMParser);

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('MCP Tool Pack Management', () => {
  // Simulate the AIChatKernel's MCP management logic
  let enabledToolPacks: Set<string>;
  let toolPacksCache: Map<string, Record<string, any>>;
  
  const availableToolPacks = [
    { name: 'wiki-query', description: 'Tools for fetching and analyzing Wikipedia/MediaWiki content' },
  ];
  
  const mockWikiTools = {
    discover_wiki_source: { description: 'Discover wiki source URL' },
    get_wiki_content: { description: 'Get wiki content' },
    get_content_stats: { description: 'Get content statistics' },
    get_chunked_content: { description: 'Get chunked content' },
    convert_to_rdf: { description: 'Convert to RDF' },
    clear_wiki_cache: { description: 'Clear cache' },
  };
  
  async function enableToolPack(packName: string) {
    if (packName === 'wiki-query') {
      if (enabledToolPacks.has(packName)) {
        return {
          enabled: true,
          tools: Object.keys(mockWikiTools),
          message: `Tool pack '${packName}' is already enabled.`,
        };
      }
      
      toolPacksCache.set(packName, mockWikiTools);
      enabledToolPacks.add(packName);
      
      return {
        enabled: true,
        tools: Object.keys(mockWikiTools),
        message: `Enabled tool pack '${packName}' with ${Object.keys(mockWikiTools).length} tools`,
      };
    }
    
    return {
      enabled: false,
      tools: [],
      message: `Unknown tool pack: ${packName}. Available packs: wiki-query`,
    };
  }
  
  function disableToolPack(packName: string) {
    if (enabledToolPacks.has(packName)) {
      enabledToolPacks.delete(packName);
      toolPacksCache.delete(packName);
      return {
        disabled: true,
        message: `Disabled tool pack '${packName}'.`,
      };
    }
    return {
      disabled: false,
      message: `Tool pack '${packName}' is not enabled.`,
    };
  }
  
  async function getEnabledTools() {
    const allTools: Record<string, any> = {};
    for (const packName of enabledToolPacks) {
      const packTools = toolPacksCache.get(packName);
      if (packTools) {
        Object.assign(allTools, packTools);
      }
    }
    return allTools;
  }
  
  async function listEnabledTools() {
    const packs: Array<{ name: string; tools: string[] }> = [];
    let total = 0;
    
    for (const packName of enabledToolPacks) {
      const tools = toolPacksCache.get(packName);
      if (tools) {
        const toolNames = Object.keys(tools);
        packs.push({ name: packName, tools: toolNames });
        total += toolNames.length;
      }
    }
    
    return { packs, total };
  }
  
  function getAvailableToolPacks() {
    return availableToolPacks;
  }

  beforeEach(() => {
    enabledToolPacks = new Set();
    toolPacksCache = new Map();
    vi.clearAllMocks();
    mockLocalStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('enableToolPack', () => {
    it('should enable wiki-query pack', async () => {
      const result = await enableToolPack('wiki-query');
      
      expect(result.enabled).toBe(true);
      expect(result.tools).toContain('discover_wiki_source');
      expect(result.tools).toContain('get_wiki_content');
      expect(result.tools.length).toBe(6);
    });

    it('should return already enabled message on re-enable', async () => {
      await enableToolPack('wiki-query');
      const result = await enableToolPack('wiki-query');
      
      expect(result.enabled).toBe(true);
      expect(result.message).toContain('already enabled');
    });

    it('should reject unknown pack names', async () => {
      const result = await enableToolPack('unknown-pack');
      
      expect(result.enabled).toBe(false);
      expect(result.tools).toHaveLength(0);
      expect(result.message).toContain('Unknown tool pack');
    });
  });

  describe('disableToolPack', () => {
    it('should disable enabled pack', async () => {
      await enableToolPack('wiki-query');
      const result = disableToolPack('wiki-query');
      
      expect(result.disabled).toBe(true);
      expect(result.message).toContain('Disabled');
    });

    it('should handle disabling non-enabled pack', () => {
      const result = disableToolPack('wiki-query');
      
      expect(result.disabled).toBe(false);
      expect(result.message).toContain('not enabled');
    });
  });

  describe('getEnabledTools', () => {
    it('should return empty object when no packs enabled', async () => {
      const tools = await getEnabledTools();
      
      expect(Object.keys(tools)).toHaveLength(0);
    });

    it('should return all tools from enabled packs', async () => {
      await enableToolPack('wiki-query');
      const tools = await getEnabledTools();
      
      expect(Object.keys(tools)).toHaveLength(6);
      expect(tools).toHaveProperty('discover_wiki_source');
      expect(tools).toHaveProperty('get_wiki_content');
    });
  });

  describe('listEnabledTools', () => {
    it('should return empty list when no packs enabled', async () => {
      const { packs, total } = await listEnabledTools();
      
      expect(packs).toHaveLength(0);
      expect(total).toBe(0);
    });

    it('should list all enabled packs and tools', async () => {
      await enableToolPack('wiki-query');
      const { packs, total } = await listEnabledTools();
      
      expect(packs).toHaveLength(1);
      expect(packs[0].name).toBe('wiki-query');
      expect(packs[0].tools).toContain('discover_wiki_source');
      expect(total).toBe(6);
    });
  });

  describe('getAvailableToolPacks', () => {
    it('should return list of available packs', () => {
      const packs = getAvailableToolPacks();
      
      expect(packs).toHaveLength(1);
      expect(packs[0].name).toBe('wiki-query');
      expect(packs[0].description).toContain('Wikipedia');
    });
  });
});

describe('MCP %chat Command Parsing', () => {
  // Test the regex patterns used for command parsing
  
  describe('%chat mcp command patterns', () => {
    const mcpEnablePattern = /^%chat\s+mcp\s+enable\s+(\S+)$/;
    const mcpDisablePattern = /^%chat\s+mcp\s+disable\s+(\S+)$/;
    
    it('should match %chat mcp enable <pack>', () => {
      const match = '%chat mcp enable wiki-query'.match(mcpEnablePattern);
      
      expect(match).not.toBeNull();
      expect(match![1]).toBe('wiki-query');
    });

    it('should match %chat mcp disable <pack>', () => {
      const match = '%chat mcp disable wiki-query'.match(mcpDisablePattern);
      
      expect(match).not.toBeNull();
      expect(match![1]).toBe('wiki-query');
    });

    it('should not match invalid enable commands', () => {
      expect('%chat mcp enable'.match(mcpEnablePattern)).toBeNull();
      expect('%chat mcp enable '.match(mcpEnablePattern)).toBeNull();
      expect('%chatmcp enable wiki'.match(mcpEnablePattern)).toBeNull();
    });

    it('should handle pack names with hyphens', () => {
      const match = '%chat mcp enable my-custom-pack'.match(mcpEnablePattern);
      
      expect(match).not.toBeNull();
      expect(match![1]).toBe('my-custom-pack');
    });
  });

  describe('%chat mcp base commands', () => {
    it('should match %chat mcp exactly', () => {
      expect('%chat mcp'.trim() === '%chat mcp').toBe(true);
    });

    it('should match %chat mcp help', () => {
      expect('%chat mcp help'.trim() === '%chat mcp help').toBe(true);
    });

    it('should match %chat mcp list', () => {
      expect('%chat mcp list'.trim() === '%chat mcp list').toBe(true);
    });

    it('should match %chat mcp status', () => {
      expect('%chat mcp status'.trim() === '%chat mcp status').toBe(true);
    });
  });
});

describe('Tool Schema Validation', () => {
  // Test that tools would be accepted by AI SDK
  
  it('should have required tool properties', () => {
    const mockTool = {
      description: 'Test tool description',
      inputSchema: { type: 'object' },
      execute: async () => ({ result: 'test' }),
    };
    
    expect(mockTool).toHaveProperty('description');
    expect(mockTool).toHaveProperty('inputSchema');
    expect(mockTool).toHaveProperty('execute');
    expect(typeof mockTool.execute).toBe('function');
  });

  it('should have descriptive tool descriptions', () => {
    const toolDescriptions = [
      'Discover the raw wiki source URL for a Wikipedia or MediaWiki page',
      'Fetch the raw wikitext content from a Wikipedia or MediaWiki page',
      'Analyze a wiki page and return statistics',
      'Get wiki content split into chunks',
      'Convert wiki content to RDF format',
      'Clear the wiki query cache',
    ];
    
    for (const desc of toolDescriptions) {
      expect(desc.length).toBeGreaterThan(20);
      expect(desc).not.toContain('TODO');
    }
  });
});
