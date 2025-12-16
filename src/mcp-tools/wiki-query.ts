/**
 * Wiki Query Tools for AI SDK Chat Kernel
 * 
 * Browser-only MCP tools for comprehensive wiki operations:
 * - Discover and fetch raw wiki source content
 * - Analyze content statistics (size, sections, links, etc.)
 * - Retrieve chunked source content for token optimization
 * - Convert wiki content to RDF with schema/KG context
 * 
 * Uses fetch API, localStorage caching, and DOMParser
 * Designed specifically for JupyterLite environment
 */

import { z } from 'zod';
import { tool } from 'ai';

// ============================================================================
// Types
// ============================================================================

export interface WikiSourceUrl {
  sourceUrl: string | null;
  canonicalUrl: string;
  wikiType: "mediawiki" | "unknown";
  method: "html_metadata" | "api_discovery" | "fallback";
  pageTitle: string;
  error?: string;
}

export interface WikiContent {
  pageTitle: string;
  canonicalUrl: string;
  sourceUrl: string;
  wikitext: string;
  fetchedAt: string;
  contentHash: string;
  fromCache: boolean;
}

export interface ContentStats {
  pageTitle: string;
  totalCharacters: number;
  totalWords: number;
  totalSections: number;
  totalLinks: number;
  totalTemplates: number;
  totalImages: number;
  totalCategories: number;
  estimatedReadingTime: number;
  sections: Array<{
    title: string;
    level: number;
    characterCount: number;
    wordCount: number;
  }>;
}

export interface ChunkedContent {
  pageTitle: string;
  totalChunks: number;
  chunkSize: number;
  chunks: Array<{
    index: number;
    startChar: number;
    endChar: number;
    content: string;
  }>;
}

export interface RDFConversionOptions {
  format: "turtle" | "jsonld" | "ntriples";
  includeMetadata?: boolean;
  schemaUri?: string;
  kgSchemas?: Record<string, any>;
  customContext?: Record<string, any>;
  prompt?: string;
}

export interface RDFOutput {
  format: string;
  rdf: string;
  metadata: {
    triples: number;
    subjects: number;
    properties: number;
    timestamp: string;
  };
}

// ============================================================================
// localStorage-based Cache Manager (Browser-only)
// ============================================================================

class LocalStorageCache {
  private storageName: string = 'wiki-query-cache';
  private maxEntries: number = 50;

  set(key: string, value: any, ttl: number = 3600): void {
    const entry = {
      value,
      timestamp: Date.now(),
      ttl,
    };

    try {
      const serialized = JSON.stringify(entry);
      
      // Check size before storing (localStorage has ~5MB limit)
      if (serialized.length > 4.5 * 1024 * 1024) {
        console.warn(`[wiki-query] Cache entry for ${key} too large (${serialized.length} bytes), skipping cache`);
        return;
      }

      localStorage.setItem(`${this.storageName}:${key}`, serialized);
      this.pruneIfNeeded();
    } catch (e) {
      if (e instanceof Error && e.name === 'QuotaExceededError') {
        console.warn('[wiki-query] localStorage quota exceeded, clearing old entries');
        this.pruneExpired();
        try {
          localStorage.setItem(`${this.storageName}:${key}`, JSON.stringify(entry));
        } catch {
          console.warn('[wiki-query] Still unable to store after pruning');
        }
      }
    }
  }

  get(key: string): any | null {
    try {
      const item = localStorage.getItem(`${this.storageName}:${key}`);
      if (!item) return null;

      const entry = JSON.parse(item);
      const age = (Date.now() - entry.timestamp) / 1000;

      if (age > entry.ttl) {
        localStorage.removeItem(`${this.storageName}:${key}`);
        return null;
      }

      return entry.value;
    } catch {
      return null;
    }
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  clear(pattern?: string): number {
    let count = 0;
    try {
      const keys = Object.keys(localStorage);
      const prefix = `${this.storageName}:`;

      for (const key of keys) {
        if (!key.startsWith(prefix)) continue;

        const localKey = key.substring(prefix.length);

        if (!pattern || new RegExp(pattern).test(localKey)) {
          localStorage.removeItem(key);
          count++;
        }
      }
    } catch (e) {
      console.error('[wiki-query] Error clearing cache:', e);
    }

    return count;
  }

  getStats(): { entries: number; totalSize: number } {
    let entries = 0;
    let totalSize = 0;
    
    try {
      const keys = Object.keys(localStorage);
      const prefix = `${this.storageName}:`;

      for (const key of keys) {
        if (!key.startsWith(prefix)) continue;
        entries++;
        const item = localStorage.getItem(key);
        if (item) totalSize += item.length;
      }
    } catch (e) {
      console.error('[wiki-query] Error getting cache stats:', e);
    }

    return { entries, totalSize };
  }

  private pruneExpired(): void {
    try {
      const keys = Object.keys(localStorage);
      const prefix = `${this.storageName}:`;

      for (const key of keys) {
        if (!key.startsWith(prefix)) continue;

        try {
          const item = localStorage.getItem(key);
          if (!item) continue;

          const entry = JSON.parse(item);
          const age = (Date.now() - entry.timestamp) / 1000;

          if (age > entry.ttl) {
            localStorage.removeItem(key);
          }
        } catch {
          localStorage.removeItem(key);
        }
      }
    } catch (e) {
      console.error('[wiki-query] Error pruning cache:', e);
    }
  }

  private pruneIfNeeded(): void {
    try {
      const keys = Object.keys(localStorage);
      const prefix = `${this.storageName}:`;
      const ourKeys = keys.filter(k => k.startsWith(prefix));

      if (ourKeys.length > this.maxEntries) {
        // Remove oldest entries
        const entries: Array<[string, any]> = ourKeys.map(k => [
          k,
          JSON.parse(localStorage.getItem(k) || '{}')
        ]);

        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

        const toRemove = entries.slice(0, Math.ceil(ourKeys.length * 0.2));
        for (const [key] of toRemove) {
          localStorage.removeItem(key);
        }
      }
    } catch (e) {
      console.error('[wiki-query] Error in pruneIfNeeded:', e);
    }
  }

  generateKey(prefix: string, url: string, params?: Record<string, any>): string {
    const paramStr = params ? JSON.stringify(params) : '';
    const combined = url + paramStr;
    let hash = 0;

    for (let i = 0; i < combined.length; i++) {
      const char = combined.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }

    return `${prefix}:${Math.abs(hash).toString(16)}`;
  }
}

// Singleton cache instance
const cache = new LocalStorageCache();

// ============================================================================
// Helper Functions
// ============================================================================

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

function escapeString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

// ============================================================================
// Wiki Source Discovery
// ============================================================================

function discoverViaHtmlMetadata(doc: Document, pageUrl: string): Partial<WikiSourceUrl> & { sourceUrl?: string } {
  try {
    const linkTags = doc.querySelectorAll('link[rel]');
    
    for (const link of linkTags) {
      const rel = link.getAttribute('rel');
      const href = link.getAttribute('href');
      const type = link.getAttribute('type');

      if (!href) continue;

      const absoluteUrl = new URL(href, pageUrl).href;

      if ((rel === 'alternate' && type === 'application/x-wiki') || rel === 'edit') {
        const rawUrl = convertEditToRawUrl(absoluteUrl);
        if (rawUrl) {
          const title = extractPageTitle(doc, pageUrl);
          return {
            sourceUrl: rawUrl,
            canonicalUrl: pageUrl,
            wikiType: "mediawiki",
            method: "html_metadata",
            pageTitle: title,
          };
        }
      }
    }

    return {};
  } catch {
    return {};
  }
}

function convertEditToRawUrl(editUrl: string): string | null {
  try {
    const url = new URL(editUrl);
    if (url.searchParams.has('action')) {
      url.searchParams.set('action', 'raw');
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function extractPageTitle(doc: Document, pageUrl: string): string {
  const titleTag = doc.querySelector('meta[property="og:title"]');
  if (titleTag?.getAttribute('content')) {
    return titleTag.getAttribute('content')!;
  }

  const docTitle = doc.querySelector('title')?.textContent;
  if (docTitle) {
    // Clean up common Wikipedia title suffixes
    return docTitle.replace(/ - Wikipedia.*$/, '').replace(/ — Wikipédia.*$/, '').trim();
  }

  try {
    const url = new URL(pageUrl);
    const pathMatch = url.pathname.match(/\/wiki\/(.+)/);
    if (pathMatch) {
      return decodeURIComponent(pathMatch[1].replace(/_/g, ' '));
    }
  } catch {}

  return '';
}

function extractTitleFromUrl(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);

    const titleParam = url.searchParams.get('title');
    if (titleParam) return titleParam;

    const pathMatch = url.pathname.match(/\/wiki\/(.+)/);
    if (pathMatch) return decodeURIComponent(pathMatch[1]);

    return null;
  } catch {
    return null;
  }
}

async function discoverViaApi(pageUrl: string): Promise<WikiSourceUrl | null> {
  try {
    const url = new URL(pageUrl);
    const baseUrl = `${url.protocol}//${url.hostname}`;

    const apiEndpoints = ['/w/api.php', '/api.php', '/wiki/api.php'];

    for (const apiPath of apiEndpoints) {
      try {
        const apiUrl = new URL(apiPath, baseUrl);
        apiUrl.searchParams.set('action', 'query');
        apiUrl.searchParams.set('meta', 'siteinfo');
        apiUrl.searchParams.set('siprop', 'general');
        apiUrl.searchParams.set('format', 'json');
        apiUrl.searchParams.set('origin', '*'); // CORS support

        const response = await fetch(apiUrl.href, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WikiQueryJupyterLite/1.0)' },
        });

        if (!response.ok) continue;

        const data = (await response.json()) as Record<string, any>;

        if (!data.query?.general) continue;

        const general = data.query.general;
        const title = extractTitleFromUrl(pageUrl);

        if (title) {
          const scriptPath = general.scriptpath || '/w';
          const rawUrl = new URL(scriptPath + '/index.php', baseUrl);
          rawUrl.searchParams.set('title', title);
          rawUrl.searchParams.set('action', 'raw');

          return {
            sourceUrl: rawUrl.toString(),
            canonicalUrl: pageUrl,
            wikiType: "mediawiki",
            method: "api_discovery",
            pageTitle: title.replace(/_/g, ' '),
          };
        }
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function constructFromUrlPattern(pageUrl: string): WikiSourceUrl {
  try {
    const url = new URL(pageUrl);
    const title = extractTitleFromUrl(pageUrl);

    if (title) {
      const sourceUrl = new URL('/w/index.php', `${url.protocol}//${url.hostname}`);
      sourceUrl.searchParams.set('title', title);
      sourceUrl.searchParams.set('action', 'raw');

      return {
        sourceUrl: sourceUrl.toString(),
        canonicalUrl: pageUrl,
        wikiType: "mediawiki",
        method: "fallback",
        pageTitle: title.replace(/_/g, ' '),
      };
    }

    return {
      sourceUrl: null,
      canonicalUrl: pageUrl,
      wikiType: "unknown",
      method: "fallback",
      pageTitle: "",
    };
  } catch {
    return {
      sourceUrl: null,
      canonicalUrl: pageUrl,
      wikiType: "unknown",
      method: "fallback",
      pageTitle: "",
    };
  }
}

/**
 * Discover the raw wiki source URL for a given wiki page URL.
 * Tries multiple discovery methods in order:
 * 1. HTML metadata (<link rel="edit">)
 * 2. MediaWiki API discovery
 * 3. URL pattern fallback
 */
export async function discoverWikiSourceUrl(
  pageUrl: string,
  followRedirects: boolean = true
): Promise<WikiSourceUrl> {
  try {
    console.log(`[wiki-query] Discovering source URL for: ${pageUrl}`);
    
    const response = await fetch(pageUrl, {
      redirect: followRedirects ? 'follow' : 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WikiQueryJupyterLite/1.0)',
      },
    });

    if (!response.ok) {
      return {
        sourceUrl: null,
        canonicalUrl: pageUrl,
        wikiType: "unknown",
        method: "fallback",
        pageTitle: "",
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const finalUrl = response.url || pageUrl;
    const htmlText = await response.text();

    // Parse HTML using DOMParser (browser API)
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');

    // Try HTML metadata first
    const htmlResult = discoverViaHtmlMetadata(doc, finalUrl);
    if (htmlResult.sourceUrl) {
      console.log(`[wiki-query] Found via HTML metadata: ${htmlResult.sourceUrl}`);
      return htmlResult as WikiSourceUrl;
    }

    // Try API discovery
    const apiResult = await discoverViaApi(finalUrl);
    if (apiResult) {
      console.log(`[wiki-query] Found via API: ${apiResult.sourceUrl}`);
      return apiResult;
    }

    // Fallback to URL pattern
    const fallbackResult = constructFromUrlPattern(finalUrl);
    console.log(`[wiki-query] Using fallback: ${fallbackResult.sourceUrl}`);
    return fallbackResult;
  } catch (error) {
    console.error('[wiki-query] Discovery error:', error);
    return {
      sourceUrl: null,
      canonicalUrl: pageUrl,
      wikiType: "unknown",
      method: "fallback",
      pageTitle: "",
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// Wiki Content Fetching
// ============================================================================

/**
 * Fetch the raw wikitext content from a wiki page.
 * Caches results in localStorage for improved performance.
 */
export async function getWikiContent(
  pageUrl: string,
  followRedirects: boolean = true,
  useCache: boolean = true,
  cacheTTL: number = 3600
): Promise<WikiContent> {
  const cacheKey = cache.generateKey('wiki_content', pageUrl);

  if (useCache && cache.has(cacheKey)) {
    console.log(`[wiki-query] Returning cached content for: ${pageUrl}`);
    return { ...cache.get(cacheKey), fromCache: true };
  }

  console.log(`[wiki-query] Fetching content for: ${pageUrl}`);
  const sourceUrlData = await discoverWikiSourceUrl(pageUrl, followRedirects);

  if (!sourceUrlData.sourceUrl) {
    throw new Error(`Could not discover wiki source URL for: ${pageUrl}${sourceUrlData.error ? ` (${sourceUrlData.error})` : ''}`);
  }

  const response = await fetch(sourceUrlData.sourceUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WikiQueryJupyterLite/1.0)' },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch wiki content: HTTP ${response.status}`);
  }

  const wikitext = await response.text();

  const content: WikiContent = {
    pageTitle: sourceUrlData.pageTitle,
    canonicalUrl: sourceUrlData.canonicalUrl,
    sourceUrl: sourceUrlData.sourceUrl,
    wikitext,
    fetchedAt: new Date().toISOString(),
    contentHash: hashString(wikitext),
    fromCache: false,
  };

  if (useCache) {
    cache.set(cacheKey, content, cacheTTL);
  }

  console.log(`[wiki-query] Fetched ${wikitext.length} characters for: ${sourceUrlData.pageTitle}`);
  return content;
}

// ============================================================================
// Content Statistics Analysis
// ============================================================================

function analyzeContentStats(wikitext: string, pageTitle: string): ContentStats {
  const totalCharacters = wikitext.length;
  const totalWords = wikitext.split(/\s+/).filter(w => w.length > 0).length;

  const sectionMatches = wikitext.match(/^=+\s*[^=]+\s*=+/gm) || [];
  const totalSections = sectionMatches.length;

  const linkMatches = wikitext.match(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g) || [];
  const totalLinks = linkMatches.length;

  const templateMatches = wikitext.match(/\{\{([^}]+)\}\}/g) || [];
  const totalTemplates = templateMatches.length;

  const imageMatches = wikitext.match(/\[\[(File|Image):([^\]|]+)/gi) || [];
  const totalImages = imageMatches.length;

  const categoryMatches = wikitext.match(/\[\[Category:([^\]|]+)/gi) || [];
  const totalCategories = categoryMatches.length;

  const estimatedReadingTime = Math.ceil(totalWords / 200);

  // Parse sections with metadata
  const sections = sectionMatches.map((line, idx) => {
    const match = line.match(/^(=+)\s*([^=]+)\s*=+/);
    if (!match) return null;

    const level = match[1].length - 1;
    const title = match[2].trim();

    // Estimate section size
    const sectionStart = wikitext.indexOf(line) + line.length;
    const nextSectionIdx = idx + 1 < sectionMatches.length
      ? wikitext.indexOf(sectionMatches[idx + 1])
      : wikitext.length;

    const sectionContent = wikitext.substring(sectionStart, nextSectionIdx);
    const characterCount = sectionContent.length;
    const wordCount = sectionContent.split(/\s+/).filter(w => w.length > 0).length;

    return {
      title,
      level,
      characterCount,
      wordCount,
    };
  }).filter((s): s is NonNullable<typeof s> => s !== null);

  return {
    pageTitle,
    totalCharacters,
    totalWords,
    totalSections,
    totalLinks,
    totalTemplates,
    totalImages,
    totalCategories,
    estimatedReadingTime,
    sections,
  };
}

/**
 * Get statistics about a wiki page's content.
 * Includes section breakdown, link counts, reading time estimate, etc.
 */
export async function getContentStats(
  pageUrl: string,
  useCache: boolean = true
): Promise<ContentStats> {
  const cacheKey = cache.generateKey('content_stats', pageUrl);

  if (useCache && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const content = await getWikiContent(pageUrl, true, useCache, 3600);
  const stats = analyzeContentStats(content.wikitext, content.pageTitle);

  if (useCache) {
    cache.set(cacheKey, stats, 3600);
  }

  return stats;
}

// ============================================================================
// Chunked Content Retrieval
// ============================================================================

function chunkContent(
  wikitext: string,
  chunkSize: number = 2000
): ChunkedContent['chunks'] {
  const chunks: ChunkedContent['chunks'] = [];
  let index = 0;

  for (let i = 0; i < wikitext.length; i += chunkSize) {
    const startChar = i;
    const endChar = Math.min(i + chunkSize, wikitext.length);
    const content = wikitext.substring(startChar, endChar);

    chunks.push({
      index,
      startChar,
      endChar,
      content,
    });

    index++;
  }

  return chunks;
}

/**
 * Get wiki content split into chunks for token-efficient processing.
 * Useful for large articles that exceed LLM context windows.
 */
export async function getChunkedContent(
  pageUrl: string,
  chunkSize: number = 2000,
  useCache: boolean = true
): Promise<ChunkedContent> {
  const cacheKey = cache.generateKey('chunked_content', pageUrl, { chunkSize });

  if (useCache && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const content = await getWikiContent(pageUrl, true, useCache, 3600);
  const chunks = chunkContent(content.wikitext, chunkSize);

  const result: ChunkedContent = {
    pageTitle: content.pageTitle,
    totalChunks: chunks.length,
    chunkSize,
    chunks,
  };

  if (useCache) {
    cache.set(cacheKey, result, 3600);
  }

  return result;
}

// ============================================================================
// RDF Conversion
// ============================================================================

function parseWikitextToSections(wikitext: string): Array<{
  title: string;
  level: number;
  content: string;
}> {
  const sections = [];
  const sectionMatches = [...wikitext.matchAll(/^(=+)\s*([^=]+)\s*=+/gm)];

  for (let i = 0; i < sectionMatches.length; i++) {
    const match = sectionMatches[i];
    const level = match[1].length - 1;
    const title = match[2].trim();

    const contentStart = match.index! + match[0].length;
    const contentEnd = i + 1 < sectionMatches.length
      ? sectionMatches[i + 1].index!
      : wikitext.length;

    const content = wikitext.substring(contentStart, contentEnd).trim();

    sections.push({ title, level, content });
  }

  return sections;
}

function extractLinksFromWikitext(wikitext: string): Array<{
  target: string;
  label?: string;
}> {
  const links = [];
  const linkMatches = wikitext.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g);

  for (const match of linkMatches) {
    const target = match[1].trim();
    const label = match[2]?.trim();

    if (!target.startsWith("File:") && !target.startsWith("Image:") && !target.startsWith("Category:")) {
      links.push({ target, label });
    }
  }

  return links;
}

function convertToTurtle(
  baseUri: string,
  schemaUri: string,
  sections: Array<{ title: string; level: number; content: string }>,
  links: Array<{ target: string; label?: string }>,
  metadata: { title: string; url: string; fetchedAt: string; characterCount: number; wordCount: number },
  options: RDFConversionOptions
): string {
  let turtle = `@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix schema: <${schemaUri}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${baseUri}> a schema:WebPage ;
    rdfs:label "${escapeString(metadata.title)}" ;
    schema:url <${escapeString(metadata.url)}> ;
    schema:datePublished "${metadata.fetchedAt}"^^xsd:dateTime ;
    schema:wordCount ${metadata.wordCount} ;
    schema:characterCount ${metadata.characterCount} .
`;

  for (const section of sections) {
    const sectionUri = `${baseUri}/section/${encodeURIComponent(section.title)}`;
    turtle += `
<${sectionUri}> a schema:Article ;
    rdfs:label "${escapeString(section.title)}" ;
    schema:isPartOf <${baseUri}> ;
    rdfs:comment "${escapeString(section.content.substring(0, 200))}" .
`;
  }

  for (const link of links) {
    const linkUri = `http://wiki.example.org/page/${encodeURIComponent(link.target)}`;
    turtle += `
<${baseUri}> schema:mentions <${linkUri}> .
`;
  }

  if (options.customContext) {
    for (const [key, value] of Object.entries(options.customContext)) {
      turtle += `
<${baseUri}> schema:${key} "${escapeString(JSON.stringify(value))}" .
`;
    }
  }

  return turtle;
}

function convertToJsonLD(
  baseUri: string,
  schemaUri: string,
  sections: Array<{ title: string; level: number; content: string }>,
  links: Array<{ target: string; label?: string }>,
  metadata: { title: string; url: string; fetchedAt: string; characterCount: number; wordCount: number },
  options: RDFConversionOptions
): string {
  const jsonld: any = {
    "@context": {
      "@vocab": schemaUri,
      "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
      ...options.customContext,
    },
    "@id": baseUri,
    "@type": "WebPage",
    "label": metadata.title,
    "url": metadata.url,
    "datePublished": metadata.fetchedAt,
    "wordCount": metadata.wordCount,
    "characterCount": metadata.characterCount,
    "sections": sections.map((section) => ({
      "@type": "Article",
      "label": section.title,
      "isPartOf": { "@id": baseUri },
      "comment": section.content.substring(0, 200),
    })),
    "mentions": links.map((link) => ({
      "@id": `http://wiki.example.org/page/${encodeURIComponent(link.target)}`,
    })),
  };

  return JSON.stringify(jsonld, null, 2);
}

function convertToNTriples(
  baseUri: string,
  schemaUri: string,
  sections: Array<{ title: string; level: number; content: string }>,
  links: Array<{ target: string; label?: string }>,
  metadata: { title: string; url: string; fetchedAt: string; characterCount: number; wordCount: number },
  _options: RDFConversionOptions
): string {
  let ntriples = "";

  ntriples += `<${baseUri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${schemaUri}WebPage> .
<${baseUri}> <http://www.w3.org/2000/01/rdf-schema#label> "${escapeString(metadata.title)}" .
<${baseUri}> <${schemaUri}url> <${escapeString(metadata.url)}> .
<${baseUri}> <${schemaUri}datePublished> "${metadata.fetchedAt}"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
<${baseUri}> <${schemaUri}wordCount> "${metadata.wordCount}"^^<http://www.w3.org/2001/XMLSchema#integer> .
`;

  for (const section of sections) {
    const sectionUri = `${baseUri}/section/${encodeURIComponent(section.title)}`;
    ntriples += `<${sectionUri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${schemaUri}Article> .
<${sectionUri}> <http://www.w3.org/2000/01/rdf-schema#label> "${escapeString(section.title)}" .
<${sectionUri}> <${schemaUri}isPartOf> <${baseUri}> .
`;
  }

  for (const link of links) {
    const linkUri = `http://wiki.example.org/page/${encodeURIComponent(link.target)}`;
    ntriples += `<${baseUri}> <${schemaUri}mentions> <${linkUri}> .
`;
  }

  return ntriples;
}

function countTriples(rdf: string, format: string): number {
  if (format === "turtle" || format === "ntriples") {
    const lines = rdf.split("\n").filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith("@") && !trimmed.startsWith("#") && trimmed.endsWith(".");
    });
    return lines.length;
  } else if (format === "jsonld") {
    try {
      const obj = JSON.parse(rdf);
      // Count properties at the top level
      return Object.keys(obj).filter(k => !k.startsWith("@")).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

function convertToRDF(
  wikitext: string,
  pageTitle: string,
  sourceUrl: string,
  options: RDFConversionOptions
): RDFOutput {
  const baseUri = `http://wiki.example.org/page/${encodeURIComponent(pageTitle)}`;
  const schemaUri = options.schemaUri || "http://schema.org/";

  const sections = parseWikitextToSections(wikitext);
  const links = extractLinksFromWikitext(wikitext);
  const metadata = {
    title: pageTitle,
    url: sourceUrl,
    fetchedAt: new Date().toISOString(),
    characterCount: wikitext.length,
    wordCount: wikitext.split(/\s+/).filter(w => w.length > 0).length,
  };

  let rdf = "";

  if (options.format === "turtle") {
    rdf = convertToTurtle(baseUri, schemaUri, sections, links, metadata, options);
  } else if (options.format === "jsonld") {
    rdf = convertToJsonLD(baseUri, schemaUri, sections, links, metadata, options);
  } else if (options.format === "ntriples") {
    rdf = convertToNTriples(baseUri, schemaUri, sections, links, metadata, options);
  }

  const triples = countTriples(rdf, options.format);
  const subjects = new Set<string>();
  const properties = new Set<string>();

  if (options.format === "turtle" || options.format === "ntriples") {
    const lines = rdf.split("\n");
    for (const line of lines) {
      const parts = line.split(/[\s<>]+/).filter((p) => p.length > 0);
      if (parts.length >= 3) {
        subjects.add(parts[0]);
        properties.add(parts[1]);
      }
    }
  }

  return {
    format: options.format,
    rdf,
    metadata: {
      triples,
      subjects: subjects.size,
      properties: properties.size,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Convert wiki content to RDF format (Turtle, JSON-LD, or N-Triples).
 * Includes page metadata, sections, and internal links.
 */
export async function convertWikiToRDF(
  pageUrl: string,
  options: RDFConversionOptions
): Promise<RDFOutput> {
  const content = await getWikiContent(pageUrl, true, true, 3600);
  return convertToRDF(content.wikitext, content.pageTitle, content.sourceUrl, options);
}

// ============================================================================
// Cache Management
// ============================================================================

/**
 * Clear the wiki query cache.
 * @param pattern Optional regex pattern to match cache keys
 * @returns Number of entries cleared
 */
export function clearCache(pattern?: string): { cleared: number; message: string } {
  const cleared = cache.clear(pattern);
  return {
    cleared,
    message: pattern 
      ? `Cleared ${cleared} cache entries matching "${pattern}"`
      : `Cleared all ${cleared} wiki cache entries`
  };
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): { entries: number; totalSize: number; message: string } {
  const stats = cache.getStats();
  const sizeKB = (stats.totalSize / 1024).toFixed(1);
  return {
    ...stats,
    message: `Wiki cache: ${stats.entries} entries, ${sizeKB} KB`
  };
}

// ============================================================================
// AI SDK Tool Definitions
// ============================================================================

/**
 * Wiki query tools for AI SDK 5.x.
 * These tools enable the AI to fetch and analyze Wikipedia/MediaWiki content.
 * 
 * Note: AI SDK 5.x uses 'inputSchema' instead of 'parameters'
 */

// Define input schemas separately for type inference
const discoverWikiSourceInputSchema = z.object({
  url: z.string().describe('The URL of the wiki page (e.g., https://en.wikipedia.org/wiki/Python_(programming_language))'),
});

const getWikiContentInputSchema = z.object({
  url: z.string().describe('The URL of the wiki page'),
});

const getContentStatsInputSchema = z.object({
  url: z.string().describe('The URL of the wiki page'),
});

const getChunkedContentInputSchema = z.object({
  url: z.string().describe('The URL of the wiki page'),
  chunkSize: z.number().optional().default(2000).describe('Size of each chunk in characters (default: 2000)'),
  chunkIndex: z.number().optional().describe('Specific chunk index to return (0-based). If not provided, returns metadata about all chunks.'),
});

const convertToRdfInputSchema = z.object({
  url: z.string().describe('The URL of the wiki page'),
  format: z.enum(['turtle', 'jsonld', 'ntriples']).optional().default('turtle').describe('RDF output format'),
});

const clearWikiCacheInputSchema = z.object({
  pattern: z.string().optional().describe('Optional regex pattern to match cache keys'),
});

export const wikiQueryTools = {
  discover_wiki_source: tool({
    description: 'Discover the raw wiki source URL for a Wikipedia or MediaWiki page. Returns the URL where the raw wikitext can be fetched.',
    inputSchema: discoverWikiSourceInputSchema,
    execute: async ({ url }: z.infer<typeof discoverWikiSourceInputSchema>) => {
      const result = await discoverWikiSourceUrl(url);
      return result;
    },
  }),

  get_wiki_content: tool({
    description: 'Fetch the raw wikitext content from a Wikipedia or MediaWiki page. Returns the full wiki markup. Use this to get the actual content of a wiki article.',
    inputSchema: getWikiContentInputSchema,
    execute: async ({ url }: z.infer<typeof getWikiContentInputSchema>) => {
      const result = await getWikiContent(url);
      // Return a summary if content is very large
      if (result.wikitext.length > 10000) {
        return {
          ...result,
          wikitext: result.wikitext.substring(0, 10000) + `\n\n... [truncated, total ${result.wikitext.length} characters]`,
          truncated: true,
        };
      }
      return result;
    },
  }),

  get_content_stats: tool({
    description: 'Analyze a wiki page and return statistics: character count, word count, sections, links, templates, images, categories, and estimated reading time. Use this to understand the structure of an article before fetching full content.',
    inputSchema: getContentStatsInputSchema,
    execute: async ({ url }: z.infer<typeof getContentStatsInputSchema>) => {
      return await getContentStats(url);
    },
  }),

  get_chunked_content: tool({
    description: 'Get wiki content split into chunks for processing large articles. Useful when the full content exceeds token limits. Returns chunk metadata, or a specific chunk if chunkIndex is provided.',
    inputSchema: getChunkedContentInputSchema,
    execute: async ({ url, chunkSize, chunkIndex }: z.infer<typeof getChunkedContentInputSchema>) => {
      const result = await getChunkedContent(url, chunkSize || 2000);
      
      if (chunkIndex !== undefined && chunkIndex >= 0 && chunkIndex < result.chunks.length) {
        return {
          pageTitle: result.pageTitle,
          totalChunks: result.totalChunks,
          chunkSize: result.chunkSize,
          requestedChunk: result.chunks[chunkIndex],
        };
      }
      
      // Return just metadata without all chunk contents (too large)
      return {
        pageTitle: result.pageTitle,
        totalChunks: result.totalChunks,
        chunkSize: result.chunkSize,
        chunks: result.chunks.map(c => ({
          index: c.index,
          startChar: c.startChar,
          endChar: c.endChar,
          // Show just first 100 chars as preview
          preview: c.content.substring(0, 100) + '...',
        })),
      };
    },
  }),

  convert_to_rdf: tool({
    description: 'Convert wiki content to RDF format (Turtle, JSON-LD, or N-Triples). Extracts page structure, sections, and links into semantic web format for knowledge graph applications.',
    inputSchema: convertToRdfInputSchema,
    execute: async ({ url, format }: z.infer<typeof convertToRdfInputSchema>) => {
      const result = await convertWikiToRDF(url, {
        format: format || 'turtle',
        includeMetadata: true,
      });
      
      // Truncate if very large
      if (result.rdf.length > 20000) {
        return {
          ...result,
          rdf: result.rdf.substring(0, 20000) + `\n\n# ... [truncated, ${result.metadata.triples} total triples]`,
          truncated: true,
        };
      }
      return result;
    },
  }),

  clear_wiki_cache: tool({
    description: 'Clear the wiki query cache to force fresh fetches. Use this if you need the latest version of a wiki page.',
    inputSchema: clearWikiCacheInputSchema,
    execute: async ({ pattern }: z.infer<typeof clearWikiCacheInputSchema>) => {
      return clearCache(pattern);
    },
  }),
};

/**
 * Get all wiki tools as a record for use with AI SDK streamText.
 */
export function getWikiQueryTools() {
  return wikiQueryTools;
}

/**
 * Tool names available in wiki-query
 */
export const WIKI_TOOL_NAMES = Object.keys(wikiQueryTools) as (keyof typeof wikiQueryTools)[];

