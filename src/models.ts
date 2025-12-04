// src/models.ts
// Provider and model configuration for AI SDK

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
}

// Registry of available providers
const providerRegistry: Map<string, ProviderConfig> = new Map();

// Default provider suggestions (non-exhaustive)
export const SUGGESTED_PROVIDERS: Record<string, ProviderConfig> = {
  'built-in-ai': {
    name: 'built-in-ai',
    displayName: 'Built-in AI (Chrome/Edge)',
    requiresApiKey: false,
    isBuiltIn: true,
  },
  'openai': {
    name: 'openai',
    displayName: 'OpenAI',
    requiresApiKey: true,
    envVar: 'OPENAI_API_KEY',
  },
  'anthropic': {
    name: 'anthropic',
    displayName: 'Anthropic',
    requiresApiKey: true,
    envVar: 'ANTHROPIC_API_KEY',
  },
  'google': {
    name: 'google',
    displayName: 'Google',
    requiresApiKey: true,
    envVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
  },
};

// Initialize registry with suggested providers
Object.values(SUGGESTED_PROVIDERS).forEach(config => {
  providerRegistry.set(config.name, config);
});

export const DEFAULT_PROVIDER = 'built-in-ai';
export const DEFAULT_MODEL = 'default';

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
