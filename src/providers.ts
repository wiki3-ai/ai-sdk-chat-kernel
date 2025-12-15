// src/providers.ts
// Provider factory functions for AI SDK
// Supports built-in-ai/core (Chrome/Edge Prompt API) and built-in-ai/webllm (WebLLM) as separate providers

import { type LanguageModel } from 'ai';

// ============================================================================
// Types
// ============================================================================

export interface ModelInfo {
  id: string;
  displayName: string;
  vramMB?: number;
  lowResource?: boolean;
  provider: string;
}

export interface ModelAvailability {
  status: 'unavailable' | 'downloadable' | 'downloading' | 'available';
  reason?: string;
}

export interface ProviderSupport {
  supported: boolean;
  reason?: string;
}

export interface ProgressReport {
  progress: number; // 0-1
  text: string;
}

// ============================================================================
// Session-level caches (populated once per session)
// ============================================================================

let webllmModelsCache: ModelInfo[] | null = null;
let providerSupportCache: Map<string, ProviderSupport> = new Map();

/**
 * Clear all session caches (for testing or reset)
 */
export function clearProviderCaches(): void {
  webllmModelsCache = null;
  providerSupportCache.clear();
  console.debug('[providers] Cleared all caches');
}

// ============================================================================
// Provider Support Detection
// ============================================================================

/**
 * Check if Chrome/Edge Built-in AI Prompt API is available
 */
export async function isBuiltInAICoreSupported(): Promise<ProviderSupport> {
  const cached = providerSupportCache.get('built-in-ai/core');
  if (cached) return cached;

  try {
    const { doesBrowserSupportBuiltInAI } = await import('@built-in-ai/core');
    const supported = doesBrowserSupportBuiltInAI();
    const result: ProviderSupport = {
      supported,
      reason: supported ? undefined : 'Chrome/Edge Built-in AI not available. Enable in chrome://flags or edge://flags'
    };
    providerSupportCache.set('built-in-ai/core', result);
    console.debug('[providers] built-in-ai/core support:', result);
    return result;
  } catch (error) {
    const result: ProviderSupport = {
      supported: false,
      reason: `Failed to check built-in AI support: ${error}`
    };
    providerSupportCache.set('built-in-ai/core', result);
    console.warn('[providers] built-in-ai/core check failed:', error);
    return result;
  }
}

/**
 * Check if Transformers.js is available
 */
export async function isTransformersSupported(): Promise<ProviderSupport> {
  const cached = providerSupportCache.get('built-in-ai/transformers');
  if (cached) return cached;

  try {
    const { doesBrowserSupportTransformersJS } = await import('@built-in-ai/transformers-js');
    const supported = doesBrowserSupportTransformersJS();
    const result: ProviderSupport = {
      supported,
      reason: supported ? undefined : 'Transformers.js not available in this browser'
    };
    providerSupportCache.set('built-in-ai/transformers', result);
    console.debug('[providers] built-in-ai/transformers support:', result);
    return result;
  } catch (error) {
    const result: ProviderSupport = {
      supported: false,
      reason: `Failed to check Transformers support: ${error}`
    };
    providerSupportCache.set('built-in-ai/transformers', result);
    console.warn('[providers] built-in-ai/transformers check failed:', error);
    return result;
  }
}

/**
 * Check if WebLLM (WebGPU) is available
 */
export async function isWebLLMSupported(): Promise<ProviderSupport> {
  const cached = providerSupportCache.get('built-in-ai/webllm');
  if (cached) return cached;

  try {
    const { doesBrowserSupportWebLLM } = await import('@built-in-ai/web-llm');
    const supported = doesBrowserSupportWebLLM();
    const result: ProviderSupport = {
      supported,
      reason: supported ? undefined : 'WebGPU not available in this browser'
    };
    providerSupportCache.set('built-in-ai/webllm', result);
    console.debug('[providers] built-in-ai/webllm support:', result);
    return result;
  } catch (error) {
    const result: ProviderSupport = {
      supported: false,
      reason: `Failed to check WebLLM support: ${error}`
    };
    providerSupportCache.set('built-in-ai/webllm', result);
    console.warn('[providers] built-in-ai/webllm check failed:', error);
    return result;
  }
}

/**
 * Check if a provider is supported
 */
export async function checkProviderSupport(providerName: string): Promise<ProviderSupport> {
  switch (providerName) {
    case 'built-in-ai/core':
      return await isBuiltInAICoreSupported();
    case 'built-in-ai/transformers':
      return await isTransformersSupported();
    case 'built-in-ai/webllm':
      return await isWebLLMSupported();
    case 'openai':
    case 'anthropic':
    case 'google':
      // Cloud providers are always "supported" - they just need API keys
      return { supported: true };
    default:
      return { supported: false, reason: `Unknown provider: ${providerName}` };
  }
}

/**
 * Auto-select the best available local provider
 * Returns 'built-in-ai/core' if available, else 'built-in-ai/webllm' if WebGPU available, else 'built-in-ai/transformers', else null
 * Note: This only checks if the browser APIs are present, not if initialization will succeed.
 * Actual initialization may still fail and require fallback.
 */
export async function autoSelectLocalProvider(): Promise<string | null> {
  const coreSupport = await isBuiltInAICoreSupported();
  if (coreSupport.supported) {
    console.info('[providers] Auto-selected built-in-ai/core');
    return 'built-in-ai/core';
  }

  const webllmSupport = await isWebLLMSupported();
  if (webllmSupport.supported) {
    console.info('[providers] Auto-selected built-in-ai/webllm (fallback from core)');
    return 'built-in-ai/webllm';
  }

  const transformersSupport = await isTransformersSupported();
  if (transformersSupport.supported) {
    console.info('[providers] Auto-selected built-in-ai/transformers (fallback from webllm)');
    return 'built-in-ai/transformers';
  }

  console.warn('[providers] No local provider available');
  return null;
}

/**
 * Get the next fallback provider after a failed provider
 * Used when initialization fails even though browser support check passed
 */
export function getNextFallbackProvider(failedProvider: string): string | null {
  const fallbackOrder = ['built-in-ai/core', 'built-in-ai/webllm', 'built-in-ai/transformers'];
  const currentIndex = fallbackOrder.indexOf(failedProvider);
  if (currentIndex >= 0 && currentIndex < fallbackOrder.length - 1) {
    return fallbackOrder[currentIndex + 1];
  }
  return null;
}

// ============================================================================
// Model Listing
// ============================================================================

/**
 * Get all WebLLM models from prebuiltAppConfig (cached per session)
 */
export async function getWebLLMModels(): Promise<ModelInfo[]> {
  if (webllmModelsCache) {
    return webllmModelsCache;
  }

  try {
    // Import prebuiltAppConfig from @mlc-ai/web-llm (the underlying package)
    const { prebuiltAppConfig } = await import('@mlc-ai/web-llm');
    
    const models: ModelInfo[] = prebuiltAppConfig.model_list
      .filter((m: any) => m.model_type !== 'embedding') // Filter out embedding models
      .map((m: any) => ({
        id: m.model_id,
        displayName: m.model_id,
        vramMB: m.vram_required_MB,
        lowResource: m.low_resource_required ?? false,
        provider: 'built-in-ai/webllm'
      }));

    webllmModelsCache = models;
    console.info(`[providers] Loaded ${models.length} WebLLM models from prebuiltAppConfig`);
    return models;
  } catch (error) {
    console.error('[providers] Failed to load WebLLM models:', error);
    // Return minimal fallback list
    const fallback: ModelInfo[] = [
      { id: 'SmolLM2-360M-Instruct-q4f16_1-MLC', displayName: 'SmolLM2-360M-Instruct', vramMB: 500, lowResource: true, provider: 'built-in-ai/webllm' },
      { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', displayName: 'Llama-3.2-1B-Instruct', vramMB: 1000, lowResource: true, provider: 'built-in-ai/webllm' },
      { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', displayName: 'Qwen2.5-0.5B-Instruct', vramMB: 600, lowResource: true, provider: 'built-in-ai/webllm' },
    ];
    webllmModelsCache = fallback;
    return fallback;
  }
}

/**
 * Filter models by criteria
 */
export function filterModels(
  models: ModelInfo[],
  options: {
    namePattern?: string;
    lowResourceOnly?: boolean;
    maxVramMB?: number;
  } = {}
): ModelInfo[] {
  let filtered = models;

  if (options.namePattern) {
    const pattern = options.namePattern.toLowerCase();
    filtered = filtered.filter(m => 
      m.id.toLowerCase().includes(pattern) || 
      m.displayName.toLowerCase().includes(pattern)
    );
  }

  if (options.lowResourceOnly) {
    filtered = filtered.filter(m => m.lowResource === true);
  }

  if (options.maxVramMB !== undefined) {
    filtered = filtered.filter(m => !m.vramMB || m.vramMB <= options.maxVramMB!);
  }

  return filtered;
}

/**
 * Get available models for a provider
 */
export async function getProviderModels(
  providerName: string,
  filterOptions?: { namePattern?: string; lowResourceOnly?: boolean; maxVramMB?: number }
): Promise<ModelInfo[]> {
  try {
    let models: ModelInfo[];

    switch (providerName) {
      case 'built-in-ai/core': {
        // Chrome/Edge built-in AI has a single model
        models = [{
          id: 'text',
          displayName: 'Built-in AI (Gemini Nano / Phi-4 Mini)',
          provider: 'built-in-ai/core'
        }];
        break;
      }

      case 'built-in-ai/transformers': {
        // Transformers.js supports many models from HuggingFace
        // List some common small models suitable for browser inference
        models = [
          { id: 'onnx-community/Qwen2.5-0.5B-Instruct', displayName: 'Qwen2.5 0.5B Instruct', provider: 'built-in-ai/transformers' },
          { id: 'onnx-community/Llama-3.2-1B-Instruct', displayName: 'Llama 3.2 1B Instruct', provider: 'built-in-ai/transformers' },
          { id: 'onnx-community/Phi-3.5-mini-instruct', displayName: 'Phi-3.5 Mini Instruct', provider: 'built-in-ai/transformers' },
          { id: 'HuggingFaceTB/SmolLM2-360M-Instruct', displayName: 'SmolLM2 360M Instruct', provider: 'built-in-ai/transformers' },
        ];
        break;
      }

      case 'built-in-ai/webllm': {
        models = await getWebLLMModels();
        break;
      }

      case 'openai': {
        // OpenAI doesn't expose a model listing API, use curated list
        models = [
          { id: 'gpt-4o-mini', displayName: 'GPT-4o Mini', provider: 'openai' },
          { id: 'gpt-4o', displayName: 'GPT-4o', provider: 'openai' },
          { id: 'gpt-4-turbo', displayName: 'GPT-4 Turbo', provider: 'openai' },
          { id: 'gpt-4', displayName: 'GPT-4', provider: 'openai' },
          { id: 'gpt-3.5-turbo', displayName: 'GPT-3.5 Turbo', provider: 'openai' },
        ];
        break;
      }

      case 'anthropic': {
        models = [
          { id: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet 4', provider: 'anthropic' },
          { id: 'claude-3-5-sonnet-20241022', displayName: 'Claude 3.5 Sonnet', provider: 'anthropic' },
          { id: 'claude-3-5-haiku-20241022', displayName: 'Claude 3.5 Haiku', provider: 'anthropic' },
          { id: 'claude-3-opus-20240229', displayName: 'Claude 3 Opus', provider: 'anthropic' },
          { id: 'claude-3-haiku-20240307', displayName: 'Claude 3 Haiku', provider: 'anthropic' },
        ];
        break;
      }

      case 'google': {
        models = [
          { id: 'gemini-2.0-flash-exp', displayName: 'Gemini 2.0 Flash', provider: 'google' },
          { id: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash', provider: 'google' },
          { id: 'gemini-1.5-flash-8b', displayName: 'Gemini 1.5 Flash 8B', provider: 'google' },
          { id: 'gemini-1.5-pro', displayName: 'Gemini 1.5 Pro', provider: 'google' },
        ];
        break;
      }

      default:
        console.warn(`[providers] Unknown provider: ${providerName}`);
        return [];
    }

    // Apply filters if provided
    if (filterOptions) {
      models = filterModels(models, filterOptions);
    }

    return models;
  } catch (error) {
    console.error(`[providers] Error getting models for ${providerName}:`, error);
    return [];
  }
}

/**
 * Get default model for a provider
 */
export async function getDefaultModel(providerName: string): Promise<string> {
  switch (providerName) {
    case 'built-in-ai/core':
      return 'text'; // Single model for built-in AI
    case 'built-in-ai/transformers':
      return 'HuggingFaceTB/SmolLM2-360M-Instruct'; // Smallest efficient model
    case 'built-in-ai/webllm': {
      // Return smallest low-resource model
      const models = await getWebLLMModels();
      const lowResource = models.filter(m => m.lowResource).sort((a, b) => (a.vramMB || 0) - (b.vramMB || 0));
      return lowResource[0]?.id || 'SmolLM2-360M-Instruct-q4f16_1-MLC';
    }
    case 'openai':
      return 'gpt-4o-mini';
    case 'anthropic':
      return 'claude-3-5-haiku-20241022';
    case 'google':
      return 'gemini-1.5-flash';
    default:
      return 'default';
  }
}

// ============================================================================
// Model Availability
// ============================================================================

/**
 * Check the availability status of a specific model
 */
export async function getModelAvailability(
  providerName: string,
  modelId: string
): Promise<ModelAvailability> {
  try {
    switch (providerName) {
      case 'built-in-ai/core': {
        const { builtInAI } = await import('@built-in-ai/core');
        const model = builtInAI();
        const status = await model.availability();
        return { status: status as ModelAvailability['status'] };
      }

      case 'built-in-ai/transformers': {
        const { transformersJS } = await import('@built-in-ai/transformers-js');
        const model = transformersJS(modelId);
        const status = await model.availability();
        return { status: status as ModelAvailability['status'] };
      }

      case 'built-in-ai/webllm': {
        const { webLLM } = await import('@built-in-ai/web-llm');
        const model = webLLM(modelId);
        const status = await model.availability();
        return { status: status as ModelAvailability['status'] };
      }

      case 'openai':
      case 'anthropic':
      case 'google':
        // Cloud providers are always "available" if you have an API key
        return { status: 'available' };

      default:
        return { status: 'unavailable', reason: `Unknown provider: ${providerName}` };
    }
  } catch (error) {
    console.error(`[providers] Error checking availability for ${providerName}/${modelId}:`, error);
    return { status: 'unavailable', reason: String(error) };
  }
}

// ============================================================================
// Provider/Model Creation
// ============================================================================

/**
 * Create a built-in-ai/core provider instance
 */
export async function createBuiltInAICoreProvider(
  onProgress?: (report: ProgressReport) => void
): Promise<LanguageModel> {
  console.info('[providers] Creating built-in-ai/core provider');
  
  const support = await isBuiltInAICoreSupported();
  if (!support.supported) {
    throw new Error(`built-in-ai/core not available: ${support.reason}`);
  }

  const { builtInAI } = await import('@built-in-ai/core');
  const model = builtInAI();

  // Check availability and potentially download
  const availability = await model.availability();
  console.debug('[providers] built-in-ai/core availability:', availability);

  if (availability === 'unavailable') {
    throw new Error('Built-in AI model is unavailable in this browser');
  }

  if (availability === 'downloadable' || availability === 'downloading') {
    console.info('[providers] Downloading built-in AI model...');
    if (onProgress) {
      onProgress({ progress: 0, text: 'Downloading built-in AI model...' });
    }
    
    await model.createSessionWithProgress((progress: number) => {
      if (onProgress) {
        onProgress({ progress, text: `Downloading: ${Math.round(progress * 100)}%` });
      }
    });
    
    if (onProgress) {
      onProgress({ progress: 1, text: 'Model ready' });
    }
  }

  return model as LanguageModel;
}

/**
 * Create a built-in-ai/transformers provider instance
 */
export async function createTransformersProvider(
  modelId: string,
  onProgress?: (report: ProgressReport) => void
): Promise<LanguageModel> {
  console.info(`[providers] Creating built-in-ai/transformers provider with model: ${modelId}`);
  
  const support = await isTransformersSupported();
  if (!support.supported) {
    throw new Error(`built-in-ai/transformers not available: ${support.reason}`);
  }

  const { transformersJS } = await import('@built-in-ai/transformers-js');
  const model = transformersJS(modelId);

  // Check availability and potentially download
  const availability = await model.availability();
  console.debug(`[providers] ${modelId} availability:`, availability);

  if (availability === 'unavailable') {
    throw new Error(`Model ${modelId} is unavailable`);
  }

  if (availability === 'downloadable') {
    console.info(`[providers] Downloading model ${modelId}...`);
    if (onProgress) {
      onProgress({ progress: 0, text: `Downloading ${modelId}...` });
    }
    
    await model.createSessionWithProgress((report: any) => {
      const progress = typeof report === 'number' ? report : (report?.progress ?? 0);
      const text = typeof report === 'number' 
        ? `Downloading: ${Math.round(report * 100)}%`
        : (report?.text ?? `Downloading: ${Math.round(progress * 100)}%`);
      
      if (onProgress) {
        onProgress({ progress, text });
      }
    });
    
    if (onProgress) {
      onProgress({ progress: 1, text: 'Model ready' });
    }
  }

  return model as LanguageModel;
}

/**
 * Create a built-in-ai/webllm provider instance
 */
export async function createWebLLMProvider(
  modelId: string,
  onProgress?: (report: ProgressReport) => void
): Promise<LanguageModel> {
  console.info(`[providers] Creating built-in-ai/webllm provider with model: ${modelId}`);
  
  const support = await isWebLLMSupported();
  if (!support.supported) {
    throw new Error(`built-in-ai/webllm not available: ${support.reason}`);
  }

  const { webLLM } = await import('@built-in-ai/web-llm');
  const model = webLLM(modelId);

  // Check availability and potentially download
  const availability = await model.availability();
  console.debug(`[providers] ${modelId} availability:`, availability);

  if (availability === 'unavailable') {
    throw new Error(`Model ${modelId} is unavailable - WebGPU may not be supported`);
  }

  if (availability === 'downloadable' || availability === 'downloading') {
    console.info(`[providers] Downloading model ${modelId}...`);
    if (onProgress) {
      onProgress({ progress: 0, text: `Downloading ${modelId}...` });
    }
    
    await model.createSessionWithProgress((report: any) => {
      const progress = typeof report === 'number' ? report : (report?.progress ?? 0);
      const text = typeof report === 'number' 
        ? `Downloading: ${Math.round(report * 100)}%`
        : (report?.text ?? `Downloading: ${Math.round(progress * 100)}%`);
      
      if (onProgress) {
        onProgress({ progress, text });
      }
    });
    
    if (onProgress) {
      onProgress({ progress: 1, text: 'Model ready' });
    }
  }

  return model as LanguageModel;
}

/**
 * Create a provider instance dynamically
 */
export async function createProvider(
  providerName: string,
  modelName: string,
  apiKey?: string,
  onProgress?: (report: ProgressReport) => void
): Promise<LanguageModel> {
  console.info(`[providers] Creating provider: ${providerName}, model: ${modelName}`);
  
  try {
    switch (providerName) {
      case 'built-in-ai/core':
        return await createBuiltInAICoreProvider(onProgress);

      case 'built-in-ai/transformers':
        return await createTransformersProvider(modelName, onProgress);

      case 'built-in-ai/webllm':
        return await createWebLLMProvider(modelName, onProgress);

      case 'openai': {
        const { createOpenAI } = await import('@ai-sdk/openai');
        const provider = createOpenAI({ apiKey: apiKey ?? undefined });
        return provider.chat(modelName) as LanguageModel;
      }

      case 'anthropic': {
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        const provider = createAnthropic({ apiKey: apiKey ?? undefined });
        return provider(modelName) as LanguageModel;
      }

      case 'google': {
        const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
        const provider = createGoogleGenerativeAI({ apiKey: apiKey ?? undefined });
        return provider(modelName) as LanguageModel;
      }

      default:
        throw new Error(`Unknown provider: ${providerName}. Supported: built-in-ai/core, built-in-ai/transformers, built-in-ai/webllm, openai, anthropic, google`);
    }
  } catch (error: any) {
    console.error(`[providers] Failed to create provider ${providerName}:`, error);
    throw error;
  }
}

// ============================================================================
// Utility functions
// ============================================================================

/**
 * Format model info for display
 */
export function formatModelInfo(model: ModelInfo): string {
  let info = model.id;
  const parts: string[] = [];
  
  if (model.vramMB) {
    parts.push(`${Math.round(model.vramMB)}MB VRAM`);
  }
  if (model.lowResource) {
    parts.push('low-resource');
  }
  
  if (parts.length > 0) {
    info += ` (${parts.join(', ')})`;
  }
  
  return info;
}

/**
 * Get all supported provider names
 */
export function getAllProviderNames(): string[] {
  return ['built-in-ai/core', 'built-in-ai/transformers', 'built-in-ai/webllm', 'openai', 'anthropic', 'google'];
}
