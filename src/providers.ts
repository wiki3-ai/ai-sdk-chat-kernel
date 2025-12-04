// src/providers.ts
// Provider factory functions for AI SDK

import { type LanguageModel } from 'ai';

declare const window: any;

/**
 * Check if Chrome Built-in AI is available
 */
export async function isBuiltInAIAvailable(): Promise<boolean> {
  try {
    // Check if window.ai is available (Chrome Built-in AI API)
    if (typeof window !== 'undefined' && window.ai && window.ai.languageModel) {
      const capabilities = await window.ai.languageModel.capabilities();
      return capabilities && capabilities.available !== 'no';
    }
    return false;
  } catch (error) {
    console.log('[providers] Built-in AI check failed:', error);
    return false;
  }
}

/**
 * Create a Built-in AI provider (Chrome/Edge native AI or WebLLM fallback)
 */
export async function createBuiltInAIProvider(modelName?: string): Promise<any> {
  const hasBuiltInAI = await isBuiltInAIAvailable();
  
  if (hasBuiltInAI) {
    console.log('[providers] Using Chrome Built-in AI');
    // Dynamically import @built-in-ai/core
    const { builtInAI } = await import('@built-in-ai/core');
    // builtInAI() doesn't take a model parameter, it auto-detects
    return builtInAI();
  } else {
    console.log('[providers] Built-in AI not available, falling back to WebLLM');
    // Dynamically import and create WebLLM model
    const { CreateMLCEngine } = await import('@mlc-ai/web-llm');
    
    // Use SmolLM2 as the default lightweight model
    const defaultModel = modelName || 'SmolLM2-360M-Instruct-q4f16_1-MLC';
    
    // Create WebLLM engine
    const engine = await CreateMLCEngine(defaultModel, {
      initProgressCallback: (report: any) => {
        console.log('[WebLLM]', report.text, report.progress ? `${Math.round(report.progress * 100)}%` : '');
      }
    });
    
    // Return a wrapper that conforms to LanguageModel interface
    return {
      specificationVersion: 'v1',
      provider: 'webllm',
      modelId: defaultModel,
      doGenerate: async (options: any) => {
        // AI SDK passes messages in options.prompt
        const messages = Array.isArray(options.prompt) ? options.prompt : 
                        (options.prompt?.messages || options.prompt || []);
        
        const stream = await engine.chat.completions.create({
          messages,
          stream: true,
        });
        
        const textStream = async function* () {
          for await (const chunk of stream) {
            const content = chunk.choices?.[0]?.delta?.content || '';
            if (content) {
              yield content;
            }
          }
        };
        
        // Note: WebLLM doesn't provide token usage statistics in streaming mode
        return {
          text: textStream,
          usage: { promptTokens: 0, completionTokens: 0 },
        };
      },
    };
  }
}

/**
 * Get available models for a provider
 */
export async function getProviderModels(providerName: string): Promise<string[]> {
  try {
    switch (providerName) {
      case 'built-in-ai':
        return ['default']; // Built-in AI auto-detects
        
      case 'openai': {
        // Common OpenAI chat models (v2 API compatible)
        return [
          'gpt-4o-mini',
          'gpt-4o',
          'gpt-4-turbo',
          'gpt-4',
          'gpt-3.5-turbo',
        ];
      }
      
      case 'anthropic': {
        // Common Anthropic models
        return [
          'claude-3-5-sonnet-20241022',
          'claude-3-5-haiku-20241022',
          'claude-3-opus-20240229',
          'claude-3-sonnet-20240229',
          'claude-3-haiku-20240307',
        ];
      }
      
      case 'google': {
        // Common Google models
        return [
          'gemini-2.0-flash-exp',
          'gemini-1.5-flash',
          'gemini-1.5-flash-8b',
          'gemini-1.5-pro',
        ];
      }
      
      default:
        return []; // Unknown provider
    }
  } catch (error) {
    console.error(`[providers] Error getting models for ${providerName}:`, error);
    return [];
  }
}

/**
 * Get default model for a provider
 */
export function getDefaultModel(providerName: string): string {
  switch (providerName) {
    case 'built-in-ai':
      return 'default';
    case 'openai':
      return 'gpt-4o-mini'; // Most economical v2 model
    case 'anthropic':
      return 'claude-3-5-haiku-20241022'; // Fast and economical
    case 'google':
      return 'gemini-1.5-flash'; // Fast and economical
    default:
      return 'default';
  }
}

/**
 * Create a provider instance dynamically
 */
export async function createProvider(providerName: string, modelName: string, apiKey?: string): Promise<any> {
  switch (providerName) {
    case 'built-in-ai':
      return await createBuiltInAIProvider(modelName);
      
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      const provider = createOpenAI({ apiKey: apiKey ?? undefined });
      // Use .chat() for v2 API compatibility
      return provider.chat(modelName) as any;
    }
    
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      const provider = createAnthropic({ apiKey: apiKey ?? undefined });
      return provider(modelName) as any;
    }
    
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      const provider = createGoogleGenerativeAI({ apiKey: apiKey ?? undefined });
      return provider(modelName) as any;
    }
    
    default:
      throw new Error(`Unknown provider: ${providerName}. Supported providers: built-in-ai, openai, anthropic, google`);
  }
}
