// src/models.ts
// Provider and model configuration for AI SDK

export interface ProviderConfig {
  name: string;
  displayName: string;
  models: string[];
  requiresApiKey: boolean;
  envVar: string;
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  openai: {
    name: 'openai',
    displayName: 'OpenAI',
    models: [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-4',
      'gpt-3.5-turbo',
      'o1-preview',
      'o1-mini',
    ],
    requiresApiKey: true,
    envVar: 'OPENAI_API_KEY',
  },
  anthropic: {
    name: 'anthropic',
    displayName: 'Anthropic',
    models: [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307',
    ],
    requiresApiKey: true,
    envVar: 'ANTHROPIC_API_KEY',
  },
  google: {
    name: 'google',
    displayName: 'Google',
    models: [
      'gemini-2.0-flash-exp',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b',
      'gemini-1.5-pro',
    ],
    requiresApiKey: true,
    envVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
  },
};

export const DEFAULT_PROVIDER = 'openai';
export const DEFAULT_MODEL = 'gpt-4o-mini';

export function isValidProvider(name: string): boolean {
  return name in PROVIDERS;
}

export function isValidModel(provider: string, model: string): boolean {
  const providerConfig = PROVIDERS[provider];
  if (!providerConfig) return false;
  return providerConfig.models.includes(model);
}

export function getProviderConfig(name: string): ProviderConfig | null {
  return PROVIDERS[name] || null;
}
