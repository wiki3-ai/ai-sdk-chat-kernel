// src/models.ts
// Provider and model configuration for AI SDK
// Supports built-in-ai/core (Chrome/Edge Prompt API) and built-in-ai/webllm (WebLLM) as separate providers

export interface ProviderFactoryOptions {
  apiKey?: string;
  [key: string]: any;
}

export interface ProviderConfig {
  name: string;
  displayName: string;
  requiresApiKey: boolean;
  envVar?: string;
  factory?: (options?: ProviderFactoryOptions) => Promise<any>;
  isBuiltIn?: boolean;
  description?: string;
}

// Registry of available providers
const providerRegistry: Map<string, ProviderConfig> = new Map();

// Default provider suggestions
export const SUGGESTED_PROVIDERS: Record<string, ProviderConfig> = {
  'built-in-ai/core': {
    name: 'built-in-ai/core',
    displayName: 'Built-in AI (Chrome/Edge)',
    requiresApiKey: false,
    isBuiltIn: true,
    description: 'Chrome/Edge built-in AI using Gemini Nano or Phi-4 Mini',
  },
  'built-in-ai/webllm': {
    name: 'built-in-ai/webllm',
    displayName: 'WebLLM (Local)',
    requiresApiKey: false,
    isBuiltIn: true,
    description: 'Local inference via WebGPU with open-source models',
  },
  'openai': {
    name: 'openai',
    displayName: 'OpenAI',
    requiresApiKey: true,
    envVar: 'OPENAI_API_KEY',
    description: 'OpenAI GPT models',
  },
  'anthropic': {
    name: 'anthropic',
    displayName: 'Anthropic',
    requiresApiKey: true,
    envVar: 'ANTHROPIC_API_KEY',
    description: 'Anthropic Claude models',
  },
  'google': {
    name: 'google',
    displayName: 'Google',
    requiresApiKey: true,
    envVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
    description: 'Google Gemini models',
  },
};

// Initialize registry with suggested providers
Object.values(SUGGESTED_PROVIDERS).forEach(config => {
  providerRegistry.set(config.name, config);
});

// Default provider - will auto-select based on availability
export const DEFAULT_PROVIDER = 'built-in-ai/core';
export const DEFAULT_MODEL = 'text';

export function registerProvider(config: ProviderConfig): void {
  providerRegistry.set(config.name, config);
}

export function getProvider(name: string): ProviderConfig | undefined {
  return providerRegistry.get(name);
}

export function getAllProviders(): ProviderConfig[] {
  return Array.from(providerRegistry.values());
}

export function getProviderConfig(name: string): ProviderConfig | null {
  return providerRegistry.get(name) || null;
}
