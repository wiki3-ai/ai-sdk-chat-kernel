/**
 * Kernel Contract Tests
 * 
 * These tests verify that key functionality in federation.ts is present
 * by checking the compiled output. This catches regressions where features
 * (like MCP tool support or magic commands) are accidentally removed.
 * 
 * The kernel classes are defined inside a closure with JupyterLab dependencies,
 * so we test the compiled bundle for the presence of critical code patterns.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Read the compiled federation.js (the TypeScript output before bundling)
const federationSource = readFileSync(
  resolve(__dirname, '../../lib/federation.js'),
  'utf-8'
);

// Also read the TypeScript source for structure checks
const federationTs = readFileSync(
  resolve(__dirname, '../../src/federation.ts'),
  'utf-8'
);

describe('AIChatKernel class contracts', () => {
  describe('MCP tool pack support', () => {
    it('should have enabledToolPacks field', () => {
      expect(federationTs).toContain('enabledToolPacks');
    });

    it('should have toolPacksCache field', () => {
      expect(federationTs).toContain('toolPacksCache');
    });

    it('should have enableToolPack method', () => {
      expect(federationTs).toContain('enableToolPack');
      expect(federationTs).toMatch(/async enableToolPack\(packName/);
    });

    it('should have disableToolPack method', () => {
      expect(federationTs).toContain('disableToolPack');
      expect(federationTs).toMatch(/disableToolPack\(packName/);
    });

    it('should have getEnabledTools method', () => {
      expect(federationTs).toContain('getEnabledTools');
      expect(federationTs).toMatch(/async getEnabledTools\(\)/);
    });

    it('should have listEnabledTools method', () => {
      expect(federationTs).toContain('listEnabledTools');
      expect(federationTs).toMatch(/async listEnabledTools\(\)/);
    });

    it('should have getAvailableToolPacks method', () => {
      expect(federationTs).toContain('getAvailableToolPacks');
    });

    it('should import wiki-query tools when enabling', () => {
      expect(federationTs).toContain("./mcp-tools/wiki-query.js");
      expect(federationTs).toContain('getWikiQueryTools');
    });
  });

  describe('send() method with tool support', () => {
    it('should call getEnabledTools in send()', () => {
      // Verify send() gets tools before calling streamText
      const sendMethod = federationTs.match(/async send\([\s\S]*?\n        \}/m);
      expect(sendMethod).not.toBeNull();
      
      const sendBody = sendMethod![0];
      expect(sendBody).toContain('getEnabledTools');
    });

    it('should pass tools to streamText when enabled', () => {
      // The send() method should conditionally pass tools
      expect(federationTs).toContain('hasTools');
      expect(federationTs).toContain('tools, maxSteps');
    });

    it('should handle tool-call stream parts', () => {
      expect(federationTs).toContain("part.type === 'tool-call'");
    });

    it('should handle tool-result stream parts', () => {
      expect(federationTs).toContain("part.type === 'tool-result'");
    });

    it('should use fullStream (not textStream) when tools may be present', () => {
      expect(federationTs).toContain('result.fullStream');
    });

    it('should accept onToolCall callback parameter', () => {
      expect(federationTs).toMatch(/onToolCall\?.*\(.*toolName|onToolCall\?: \(/);
    });
  });

  describe('Magic command support', () => {
    it('should have processSingleMagic method', () => {
      expect(federationTs).toContain('processSingleMagic');
    });

    it('should handle %chat mcp command', () => {
      expect(federationTs).toContain('%chat mcp');
      expect(federationTs).toMatch(/%chat mcp enable/);
      expect(federationTs).toMatch(/%chat mcp disable/);
    });

    it('should have %chat mcp enable regex', () => {
      expect(federationTs).toContain('mcpEnableMatch');
      expect(federationTs).toContain('mcp\\s+enable');
    });

    it('should have %chat mcp disable regex', () => {
      expect(federationTs).toContain('mcpDisableMatch');
      expect(federationTs).toContain('mcp\\s+disable');
    });

    it('should have %chat mcp list command', () => {
      expect(federationTs).toContain('%chat mcp list');
    });

    it('should have %chat mcp status command', () => {
      expect(federationTs).toContain('%chat mcp status');
    });

    it('should handle %chat provider command', () => {
      expect(federationTs).toMatch(/%chat\s+provider/);
      expect(federationTs).toContain('providerMatch');
    });

    it('should handle %chat model command', () => {
      expect(federationTs).toMatch(/%chat\s+model/);
      expect(federationTs).toContain('modelMatch');
    });

    it('should handle %chat key command', () => {
      expect(federationTs).toContain('keyMatch');
    });

    it('should handle %chat list command', () => {
      expect(federationTs).toContain('listMatch');
    });

    it('should handle %chat status command', () => {
      expect(federationTs).toContain('%chat status');
    });

    it('should handle %chat help command', () => {
      expect(federationTs).toContain('%chat help');
    });

    it('should mention MCP in help text', () => {
      expect(federationTs).toContain('%chat mcp enable wiki-query');
    });
  });

  describe('Progress/cancellation comm support', () => {
    it('should have ProgressCommManager class', () => {
      expect(federationTs).toContain('class ProgressCommManager');
    });

    it('should define progress comm target', () => {
      expect(federationTs).toContain('ai-sdk-chat-kernel:progress');
    });

    it('should have sendProgress method', () => {
      expect(federationTs).toContain('sendProgress');
    });

    it('should have cancel handling', () => {
      expect(federationTs).toContain("data?.type === 'cancel'");
    });

    it('should have abort controller support', () => {
      expect(federationTs).toContain('AbortController');
      expect(federationTs).toContain('abortController');
    });
  });

  describe('Kernel interrupt support', () => {
    it('should have interruptRequest method', () => {
      expect(federationTs).toContain('interruptRequest');
    });

    it('should abort on interrupt', () => {
      // interruptRequest should call abort on the controller
      expect(federationTs).toMatch(/interruptRequest[\s\S]*?abort\(\)/);
    });
  });

  describe('<think> block filtering', () => {
    it('should filter out Qwen think blocks', () => {
      expect(federationTs).toContain('<think>');
      expect(federationTs).toContain('thinkRegex');
    });
  });
});

describe('Compiled bundle integrity', () => {
  it('should contain the kernel class', () => {
    expect(federationSource).toContain('AIChatKernel');
    expect(federationSource).toContain('AISdkLiteKernel');
  });

  it('should contain MCP tool methods in compiled output', () => {
    expect(federationSource).toContain('enableToolPack');
    expect(federationSource).toContain('disableToolPack');
    expect(federationSource).toContain('getEnabledTools');
  });

  it('should contain magic command handlers in compiled output', () => {
    expect(federationSource).toContain('processSingleMagic');
    expect(federationSource).toContain('mcpEnableMatch');
    expect(federationSource).toContain('mcpDisableMatch');
  });

  it('should contain tool-calling in send method', () => {
    expect(federationSource).toContain('fullStream');
    expect(federationSource).toContain('tool-call');
    expect(federationSource).toContain('tool-result');
  });

  it('should contain progress comm support', () => {
    expect(federationSource).toContain('ProgressCommManager');
    expect(federationSource).toContain('ai-sdk-chat-kernel:progress');
  });
});
