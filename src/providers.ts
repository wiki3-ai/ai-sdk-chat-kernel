// src/providers.ts
// Provider factory functions for AI SDK

import { type LanguageModel } from 'ai';

/**
 * Check if Chrome Built-in AI Prompt API is available
 * Uses the built-in-ai/core package's detection which works in WebWorker context
 */
export async function isPromptAPIAvailable(): Promise<boolean> {
  try {
    // Use the built-in-ai/core package's built-in detection
    // This works in WebWorker context where window may not be available
    const { doesBrowserSupportBuiltInAI } = await import('@built-in-ai/core');
    return doesBrowserSupportBuiltInAI();
  } catch (error) {
    console.log('[providers] Prompt API check failed:', error);
    return false;
  }
}

/**
 * Create a Built-in AI provider instance based on model name
 * - "prompt-api": Use Chrome/Edge Built-in AI Prompt API
 * - WebLLM model names: Use WebLLM for local inference
 */
export async function createBuiltInAIProvider(modelName: string): Promise<any> {
  // Determine which implementation to use based on model name
  if (modelName === 'prompt-api') {
    console.log('[providers] Using Chrome Built-in AI Prompt API');
    // Check if Prompt API is available
    const hasPromptAPI = await isPromptAPIAvailable();
    if (!hasPromptAPI) {
      throw new Error('Chrome Built-in AI Prompt API is not available. Enable it in chrome://flags or use a WebLLM model.');
    }
    
    // Dynamically import @built-in-ai/core
    const { builtInAI } = await import('@built-in-ai/core');
    return builtInAI();
  } else {
    // Use WebLLM for the specified model
    console.log(`[providers] Using WebLLM with model: ${modelName}`);
    // Dynamically import and create WebLLM model
    const { CreateMLCEngine } = await import('@mlc-ai/web-llm');
    
    // Create WebLLM engine with specified model
    const engine = await CreateMLCEngine(modelName, {
      initProgressCallback: (report: any) => {
        console.log('[WebLLM]', report.text, report.progress ? `${Math.round(report.progress * 100)}%` : '');
      }
    });
    
    // Return a wrapper that conforms to LanguageModel interface
    return {
      specificationVersion: 'v1',
      provider: 'webllm',
      modelId: modelName,
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
      case 'built-in-ai': {
        // Check if Prompt API is available
        const hasPromptAPI = await isPromptAPIAvailable();
        const models = [];
        
        if (hasPromptAPI) {
          models.push('prompt-api');
        }
        
        // Always include common WebLLM models
        models.push(
          'SmolLM2-360M-Instruct-q4f16_1-MLC',
          'SmolLM2-1.7B-Instruct-q4f16_1-MLC',
          'Llama-3.2-1B-Instruct-q4f16_1-MLC',
          'Llama-3.2-3B-Instruct-q4f16_1-MLC',
          'Phi-3.5-mini-instruct-q4f16_1-MLC',
          'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
          'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
        );
        
        return models;
      }
        
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
export async function getDefaultModel(providerName: string): Promise<string> {
  switch (providerName) {
    case 'built-in-ai': {
      // Check if Prompt API is available, otherwise use smallest WebLLM model
      const hasPromptAPI = await isPromptAPIAvailable();
      return hasPromptAPI ? 'prompt-api' : 'SmolLM2-360M-Instruct-q4f16_1-MLC';
    }
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
