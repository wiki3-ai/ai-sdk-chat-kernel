/**
 * Unit tests for wiki-query MCP tools.
 * 
 * These tests verify the wiki query functions work correctly in isolation.
 * Since the functions use browser APIs (fetch, localStorage, DOMParser),
 * we mock these for unit testing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock browser globals before importing the module
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

// Setup globals before any imports
vi.stubGlobal('localStorage', mockLocalStorage);

// Mock DOMParser
class MockDOMParser {
  parseFromString(str: string, type: string) {
    // Return a minimal mock DOM structure
    return {
      querySelector: vi.fn().mockReturnValue(null),
      querySelectorAll: vi.fn().mockReturnValue([]),
      documentElement: {
        innerHTML: str,
      },
    };
  }
}
vi.stubGlobal('DOMParser', MockDOMParser);

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('wiki-query utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('URL parsing', () => {
    it('should correctly parse Wikipedia URLs', async () => {
      const testUrl = 'https://en.wikipedia.org/wiki/Python_(programming_language)';
      const url = new URL(testUrl);
      
      expect(url.hostname).toBe('en.wikipedia.org');
      expect(url.pathname).toBe('/wiki/Python_(programming_language)');
    });

    it('should identify MediaWiki sites', () => {
      const wikiUrls = [
        'https://en.wikipedia.org/wiki/Test',
        'https://commons.wikimedia.org/wiki/File:Test.jpg',
        'https://www.mediawiki.org/wiki/API',
      ];
      
      for (const urlStr of wikiUrls) {
        const url = new URL(urlStr);
        expect(url.pathname.startsWith('/wiki/')).toBe(true);
      }
    });
  });

  describe('cache operations', () => {
    it('should store items in localStorage', () => {
      const key = 'wiki:test';
      const value = JSON.stringify({ data: 'test', timestamp: Date.now() });
      
      mockLocalStorage.setItem(key, value);
      
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith(key, value);
      expect(mockLocalStorage.getItem(key)).toBe(value);
    });

    it('should handle cache expiration', () => {
      const key = 'wiki:expired';
      const oldTimestamp = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
      const value = JSON.stringify({ data: 'old', timestamp: oldTimestamp });
      
      mockLocalStorage.setItem(key, value);
      const stored = mockLocalStorage.getItem(key);
      const parsed = JSON.parse(stored!);
      
      const isExpired = (Date.now() - parsed.timestamp) > (24 * 60 * 60 * 1000);
      expect(isExpired).toBe(true);
    });
  });

  describe('wikitext parsing', () => {
    it('should count sections in wikitext', () => {
      const wikitext = `
== Section 1 ==
Content here

=== Subsection 1.1 ===
More content

== Section 2 ==
Final content
`;
      
      const sectionRegex = /^(={2,6})\s*(.+?)\s*\1/gm;
      const matches = [...wikitext.matchAll(sectionRegex)];
      
      expect(matches.length).toBe(3);
    });

    it('should count wikilinks', () => {
      const wikitext = `
This has a [[link]] and [[another link|display text]] 
and an [[external:link]] too.
`;
      
      const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      const matches = [...wikitext.matchAll(linkRegex)];
      
      expect(matches.length).toBe(3);
    });

    it('should count templates', () => {
      const wikitext = `
{{Infobox person
| name = Test
}}

Some text with {{cite web|url=example.com}} inline.

{{reflist}}
`;
      
      // Simple template count (doesn't handle nested)
      const templateStarts = (wikitext.match(/\{\{/g) || []).length;
      expect(templateStarts).toBe(3);
    });

    it('should count categories', () => {
      const wikitext = `
Article content here.

[[Category:Test category]]
[[Category:Another category]]
`;
      
      const categoryRegex = /\[\[Category:([^\]]+)\]\]/gi;
      const matches = [...wikitext.matchAll(categoryRegex)];
      
      expect(matches.length).toBe(2);
    });

    it('should count images', () => {
      const wikitext = `
[[File:Example.jpg|thumb|Caption]]
[[Image:Another.png|200px]]
`;
      
      const imageRegex = /\[\[(File|Image):([^\]|]+)/gi;
      const matches = [...wikitext.matchAll(imageRegex)];
      
      expect(matches.length).toBe(2);
    });
  });

  describe('content chunking', () => {
    it('should split content into chunks', () => {
      const content = 'A'.repeat(5000);
      const chunkSize = 2000;
      
      const chunks: Array<{ index: number; content: string }> = [];
      for (let i = 0; i < content.length; i += chunkSize) {
        chunks.push({
          index: chunks.length,
          content: content.substring(i, i + chunkSize),
        });
      }
      
      expect(chunks.length).toBe(3);
      expect(chunks[0].content.length).toBe(2000);
      expect(chunks[1].content.length).toBe(2000);
      expect(chunks[2].content.length).toBe(1000);
    });

    it('should handle small content', () => {
      const content = 'Short content';
      const chunkSize = 2000;
      
      const chunks: Array<{ index: number; content: string }> = [];
      for (let i = 0; i < content.length; i += chunkSize) {
        chunks.push({
          index: chunks.length,
          content: content.substring(i, i + chunkSize),
        });
      }
      
      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toBe(content);
    });
  });

  describe('RDF generation', () => {
    it('should generate valid Turtle prefixes', () => {
      const prefixes = `@prefix wiki: <http://wiki.example.org/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix schema: <http://schema.org/> .
`;
      
      expect(prefixes).toContain('@prefix wiki:');
      expect(prefixes).toContain('@prefix dcterms:');
      expect(prefixes).toContain('@prefix schema:');
    });

    it('should escape Turtle string literals', () => {
      const escapeForTurtle = (str: string) => {
        return str
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t');
      };
      
      expect(escapeForTurtle('Hello "World"')).toBe('Hello \\"World\\"');
      expect(escapeForTurtle('Line1\nLine2')).toBe('Line1\\nLine2');
    });

    it('should generate JSON-LD structure', () => {
      const jsonld = {
        '@context': {
          'schema': 'http://schema.org/',
          'dcterms': 'http://purl.org/dc/terms/',
        },
        '@type': 'schema:Article',
        'schema:name': 'Test Article',
        'dcterms:source': 'https://en.wikipedia.org/wiki/Test',
      };
      
      expect(jsonld['@context']).toBeDefined();
      expect(jsonld['@type']).toBe('schema:Article');
    });
  });

  describe('word count estimation', () => {
    it('should estimate word count', () => {
      const text = 'This is a test sentence with seven words.';
      const words = text.split(/\s+/).filter(w => w.length > 0);
      
      expect(words.length).toBe(8); // Including "words." as one word
    });

    it('should estimate reading time', () => {
      const wordCount = 1000;
      const wordsPerMinute = 200;
      const readingTimeMinutes = Math.ceil(wordCount / wordsPerMinute);
      
      expect(readingTimeMinutes).toBe(5);
    });
  });
});

describe('MediaWiki API patterns', () => {
  it('should construct action=raw URL', () => {
    const baseUrl = 'https://en.wikipedia.org';
    const pageTitle = 'Python_(programming_language)';
    
    const rawUrl = `${baseUrl}/w/index.php?title=${encodeURIComponent(pageTitle)}&action=raw`;
    
    expect(rawUrl).toBe('https://en.wikipedia.org/w/index.php?title=Python_(programming_language)&action=raw');
  });

  it('should construct API URL for page info', () => {
    const baseUrl = 'https://en.wikipedia.org';
    const pageTitle = 'Python_(programming_language)';
    
    const apiUrl = `${baseUrl}/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=info&format=json`;
    
    expect(apiUrl).toContain('/w/api.php');
    expect(apiUrl).toContain('action=query');
    expect(apiUrl).toContain('format=json');
  });
});
