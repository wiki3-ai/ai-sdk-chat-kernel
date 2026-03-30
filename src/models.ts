// src/models.ts
// Provider and model configuration for AI SDK
// Supports browser-ai/core (Chrome/Edge Prompt API) and browser-ai/webllm (WebLLM) as separate providers

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

// Default provider suggestions (order matters for auto-selection fallback)
export const SUGGESTED_PROVIDERS: Record<string, ProviderConfig> = {
  'browser-ai/core': {
    name: 'browser-ai/core',
    displayName: 'Browser AI (Chrome/Edge)',
    requiresApiKey: false,
    isBuiltIn: true,
    description: 'Chrome/Edge browser AI using Gemini Nano or Phi-4 Mini',
  },
  'browser-ai/webllm': {
    name: 'browser-ai/webllm',
    displayName: 'WebLLM (Local)',
    requiresApiKey: false,
    isBuiltIn: true,
    description: 'Local inference via WebGPU with open-source models',
  },
  'browser-ai/transformers': {
    name: 'browser-ai/transformers',
    displayName: 'Transformers.js (Local)',
    requiresApiKey: false,
    isBuiltIn: true,
    description: 'Local inference with HuggingFace Transformers.js models',
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

// Default provider - null means auto-select based on availability
// When user hasn't configured a provider, the kernel will try providers in order
export const DEFAULT_PROVIDER: string | null = null;
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
