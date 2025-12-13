// src/federation.ts
// Module Federation container for JupyterLite with AI SDK support

import { streamText, type LanguageModel } from 'ai';
import { DEFAULT_PROVIDER, DEFAULT_MODEL, getProviderConfig, getAllProviders, type ProviderConfig } from "./models.js";
import { 
  createProvider, 
  getProviderModels, 
  getDefaultModel, 
  autoSelectLocalProvider,
  checkProviderSupport,
  formatModelInfo,
  getAllProviderNames,
  type ModelInfo,
  type ProgressReport
} from "./providers.js";

declare const window: any;

console.log("[ai-sdk-chat-kernel/federation] Setting up Module Federation container");

const scope = "@wiki3-ai/ai-sdk-chat-kernel";
let sharedScope: any = null;

// Module-level storage for settings (captured from frontend when model loads)
let settingsDefaultProvider: string | null = null;
let settingsDefaultModel: string | null = null;
let settingsApiKey: string | null = null;

/**
 * Get the default provider from settings, falling back to the hardcoded default.
 */
function getDefaultProviderFromSettings(): string {
  return settingsDefaultProvider ?? DEFAULT_PROVIDER;
}

/**
 * Get the API key from settings
 */
function getApiKeyFromSettings(): string | null {
  return settingsApiKey;
}

/**
 * Get the default model from settings, or provider-specific default
 */
async function getDefaultModelFromSettings(providerName: string): Promise<string> {
  // Only use settings model if we're using the settings provider
  // This ensures that when users switch providers, they get the correct default model
  const settingsProvider = getDefaultProviderFromSettings();
  if (settingsDefaultModel && providerName === settingsProvider) {
    return settingsDefaultModel;
  }
  // Otherwise use provider-specific default from providers.ts
  return await getDefaultModel(providerName);
}

// Helper to get a module from the shared scope
async function importShared(pkg: string): Promise<any> {
  if (!sharedScope) {
    // Fallback to global webpack share scope if available
    // @ts-ignore
    if (window.__webpack_share_scopes__ && window.__webpack_share_scopes__.default) {
      console.warn(`[ai-sdk-chat-kernel] Using global __webpack_share_scopes__.default for ${pkg}`);
      // @ts-ignore
      sharedScope = window.__webpack_share_scopes__.default;
    } else {
      throw new Error(`[ai-sdk-chat-kernel] Shared scope not initialized when requesting ${pkg}`);
    }
  }

  const versions = sharedScope[pkg];
  if (!versions) {
    throw new Error(`[ai-sdk-chat-kernel] Shared module ${pkg} not found in shared scope. Available: ${Object.keys(sharedScope)}`);
  }

  const versionKeys = Object.keys(versions);
  if (versionKeys.length === 0) {
    throw new Error(`[ai-sdk-chat-kernel] No versions available for ${pkg}`);
  }

  // Pick the first available version
  const version = versions[versionKeys[0]];
  const factory = version?.get;

  if (typeof factory !== "function") {
    throw new Error(`[ai-sdk-chat-kernel] Module ${pkg} has no factory function`);
  }

  // Factory might return a Promise or the module directly
  let result = factory();

  // If it's a promise, await it
  if (result && typeof result.then === 'function') {
    result = await result;
  }

  // If result is a function (Webpack module wrapper), call it to get the actual exports
  if (typeof result === 'function') {
    result = result();
  }

  console.log(`[ai-sdk-chat-kernel] Loaded ${pkg}:`, result);
  return result;
}

// Module Federation container API
const container = {
  init: (scope: any) => {
    console.log("[ai-sdk-chat-kernel/federation] init() called, storing shared scope");
    sharedScope = scope;
    return Promise.resolve();
  },

  get: async (module: string) => {
    console.log("[ai-sdk-chat-kernel/federation] get() called for module:", module);
    console.log("[ai-sdk-chat-kernel/federation] This means JupyterLite is requesting our plugin!");

    // JupyterLite may request either "./index" or "./extension"
    if (module === "./index" || module === "./extension") {
      // Lazy-load our plugin module, which will pull from shared scope
      return async () => {
        console.log("[ai-sdk-chat-kernel/federation] ===== LOADING PLUGIN MODULE =====");
        console.log("[ai-sdk-chat-kernel/federation] Loading plugins from shared scope...");

        // Import JupyterLab/JupyterLite modules from shared scope
        const { BaseKernel, IKernelSpecs } = await importShared('@jupyterlite/kernel');
        const { Widget } = await importShared('@lumino/widgets');
        const { InputDialog } = await importShared('@jupyterlab/apputils');
        const React = await importShared('react');

        console.log("[ai-sdk-chat-kernel/federation] Got BaseKernel from shared scope:", BaseKernel);

        /**
         * Chat kernel using Vercel AI SDK
         * 
         * State management:
         * - Each kernel instance has its own isolated state
         * - Settings (provider, model, apiKey) are stored but session is created lazily
         * - Magic commands can configure the kernel before the first message
         * - Session is only created when actually sending a message
         */
        class AIChatKernel {
          // Pending configuration (can be modified by magic commands before session creation)
          private pendingProvider: string | null = null;
          private pendingModel: string | null = null;
          private pendingApiKey: string | null = null;
          
          // Active session state
          private activeProvider: string | null = null;
          private activeModel: string | null = null;
          private languageModel: any | null = null;
          private sessionInitialized: boolean = false;
          
          // Progress output callback (set by parent kernel)
          private onProgress: ((text: string) => void) | null = null;

          constructor() {
            console.debug("[AIChatKernel] Created (session creation deferred until first message)");
          }
          
          /**
           * Set progress callback for outputting download progress
           */
          setProgressCallback(callback: (text: string) => void): void {
            this.onProgress = callback;
          }

          /**
           * Get API key - checks pending config first, then settings
           */
          private getApiKey(): string | null {
            // Priority: 1) Pending key set via magic, 2) Settings key
            if (this.pendingApiKey) {
              return this.pendingApiKey;
            }
            return getApiKeyFromSettings();
          }

          /**
           * Get the provider to use - pending config or settings default
           */
          private getProviderToUse(): string {
            return this.pendingProvider ?? getDefaultProviderFromSettings();
          }

          /**
           * Get the model to use - pending config or settings/provider default
           */
          private async getModelToUse(providerName: string): Promise<string> {
            if (this.pendingModel) {
              console.debug(`[AIChatKernel] Using explicit model: ${this.pendingModel}`);
              return this.pendingModel;
            }
            // If user explicitly switched providers, use provider-specific default
            if (this.pendingProvider) {
              const defaultModel = await getDefaultModel(providerName);
              console.debug(`[AIChatKernel] Provider switched, using provider default: ${defaultModel}`);
              return defaultModel;
            }
            // Otherwise use settings default or provider default
            const model = await getDefaultModelFromSettings(providerName);
            console.debug(`[AIChatKernel] Using settings/provider default: ${model}`);
            return model;
          }

          /**
           * Create the AI session with current configuration.
           * Called lazily when first message is sent.
           */
          private async createSession(): Promise<void> {
            const providerName = this.getProviderToUse();
            const modelName = await this.getModelToUse(providerName);
            const apiKey = this.getApiKey();
            const config = getProviderConfig(providerName);

            // Check if API key is required but not provided
            if (!apiKey && config?.requiresApiKey) {
              throw new Error(`API key required for ${providerName}.\n\nSet it in: Settings > AI SDK Chat Kernel > API Key\n\nOr use magic commands:\n  %chat provider ${providerName} --key\n  %chat key`);
            }

            // Create language model using dynamic provider system with progress reporting
            try {
              console.info(`[AIChatKernel] Creating session: ${providerName}/${modelName}`);
              
              // Progress callback for model download
              const progressCallback = (report: ProgressReport) => {
                // Don't log here - let the onProgress callback handle it to avoid duplication
                if (this.onProgress) {
                  this.onProgress(report.text + '\n');
                }
              };
              
              this.languageModel = await createProvider(providerName, modelName, apiKey ?? undefined, progressCallback);
              this.activeProvider = providerName;
              this.activeModel = modelName;
              this.sessionInitialized = true;
              console.info(`[AIChatKernel] Session created: ${providerName}/${modelName}`);
            } catch (error: any) {
              console.error(`[AIChatKernel] Session creation failed:`, error);
              throw new Error(`Failed to create session with ${providerName}/${modelName}: ${error.message}`);
            }
          }

          /**
           * Check if session needs to be (re)created due to config changes
           */
          private needsSessionRefresh(): boolean {
            if (!this.sessionInitialized) return true;
            
            const targetProvider = this.getProviderToUse();
            const targetModel = this.pendingModel; // Only check if explicitly set
            
            if (targetProvider !== this.activeProvider) return true;
            if (targetModel && targetModel !== this.activeModel) return true;
            
            return false;
          }

          /**
           * Set API key (stored for use when session is created)
           */
          setApiKey(key: string): void {
            if (!key || /\s/.test(key)) {
              throw new Error("Invalid API key format. API keys should not contain whitespace.");
            }
            this.pendingApiKey = key;
            // Mark session for refresh if it exists
            if (this.sessionInitialized) {
              this.sessionInitialized = false;
              this.languageModel = null;
            }
            console.log(`[AIChatKernel] API key configured`);
          }

          /**
           * Set provider (stored for use when session is created)
           */
          setProvider(providerName: string, modelName?: string, apiKey?: string): string {
            const config = getProviderConfig(providerName);
            if (!config) {
              // Allow unknown providers - they might be custom
              console.warn(`[AIChatKernel] Unknown provider: ${providerName}, proceeding anyway`);
            }
            
            this.pendingProvider = providerName;
            // Clear pendingModel when switching providers so the new provider's default is used
            // Unless a specific model was provided
            if (modelName) {
              this.pendingModel = modelName;
            } else {
              this.pendingModel = null;
            }
            if (apiKey) {
              this.pendingApiKey = apiKey;
            }
            
            // Mark session for refresh on next send
            this.sessionInitialized = false;
            this.languageModel = null;
            
            const displayName = config?.displayName || providerName;
            return `Provider: ${displayName}`;
          }

          /**
           * Set model (stored for use when session is created)
           */
          setModel(modelName: string): string {
            this.pendingModel = modelName;
            
            // Mark session for refresh on next send
            this.sessionInitialized = false;
            this.languageModel = null;
            
            return `Model: ${modelName}`;
          }

          /**
           * Get current configuration (both pending and active)
           */
          getConfig(): { 
            provider: string | null; 
            model: string | null;
            sessionActive: boolean;
            pendingProvider: string | null;
            pendingModel: string | null;
          } {
            return {
              provider: this.activeProvider,
              model: this.activeModel,
              sessionActive: this.sessionInitialized,
              pendingProvider: this.pendingProvider,
              pendingModel: this.pendingModel,
            };
          }

          /**
           * Send a message and stream the response
           */
          async send(prompt: string, onChunk?: (chunk: string) => void): Promise<string> {
            // Create or refresh session if needed
            if (this.needsSessionRefresh()) {
              await this.createSession();
            }

            if (!this.languageModel) {
              throw new Error("Language model not initialized");
            }

            console.log(
              "[AIChatKernel] Sending prompt to provider:",
              this.activeProvider,
              "model:",
              this.activeModel
            );

            // Use streamText from AI SDK
            const result = await streamText({
              model: this.languageModel,
              prompt: prompt,
            });

            let fullText = "";
            for await (const textPart of result.textStream) {
              fullText += textPart;
              if (onChunk) {
                onChunk(textPart);
              }
            }

            console.debug("[AIChatKernel] Got reply:", fullText.substring(0, 100) + (fullText.length > 100 ? '...' : ''));
            return fullText;
          }
        }

        // Define AISdkLiteKernel extending BaseKernel
        class AISdkLiteKernel extends BaseKernel {
          private chat: AIChatKernel;
          private abortController: AbortController | null = null;
          private lastProgressMessage: string = '';

          constructor(options: any) {
            super(options);
            this.chat = new AIChatKernel();
            
            // Set up progress callback to log to console (keeps notebook output clean)
            this.chat.setProgressCallback((text: string) => {
              // Log to console instead of notebook output
              // Progress messages are for model downloads which can be verbose
              const trimmed = text.trim();
              
              // Deduplicate download progress messages to avoid hundreds of identical logs
              if (trimmed.toLowerCase().includes('download')) {
                if (trimmed === this.lastProgressMessage) {
                  return; // Skip duplicate
                }
                this.lastProgressMessage = trimmed;
              }
              
              console.info(`[ai-sdk-chat-kernel] ${trimmed}`);
            });
          }

          /**
           * Prompt the user for input using a password dialog.
           * This prevents API keys from being visible in notebook cells.
           */
          private async promptForPassword(promptText: string): Promise<string> {
            // Use InputDialog.getPassword for secure input
            const result = await InputDialog.getPassword({
              title: 'API Key',
              label: promptText,
              okLabel: 'Set Key',
              cancelLabel: 'Cancel'
            });
            
            if (result.button.accept && result.value) {
              return result.value;
            }
            return '';
          }

          /**
           * Handle input reply from user (not used for password dialog approach)
           */
          inputReply(_content: any): void {
            // No-op: we use Dialog.getPassword instead of stdin for API keys
          }

          /**
           * Process a single %chat magic command line.
           * Returns the result message, or null if not a magic command.
           */
          private async processSingleMagic(line: string): Promise<string | null> {
            const trimmed = line.trim();
            
            // Skip empty lines
            if (!trimmed) {
              return null;
            }
            
            // Only process lines starting with %chat
            if (!trimmed.startsWith('%chat')) {
              return null;
            }

            // %chat help
            if (trimmed === "%chat" || trimmed === "%chat help") {
              const providerNames = getAllProviderNames();
              const providerList = providerNames.join(', ');
              
              return `AI SDK Chat Kernel Magic Commands:

  %chat provider <name>           - Set provider (${providerList})
  %chat provider <name> --key     - Set provider, prompt securely for API key
  %chat provider <name> --key <k> - Set provider with API key (visible in cell)
  %chat model <name>              - Set model (provider-specific)
  %chat key                       - Prompt securely for API key (recommended)
  %chat key <api-key>             - Set API key (visible in cell - not recommended)
  %chat list                      - List available providers with support status
  %chat list <provider>           - List models for a provider
  %chat list <provider> --filter <pattern>  - Filter models by name pattern
  %chat list <provider> --low-resource      - Show only low-resource models
  %chat status                    - Show current configuration
  %chat help                      - Show this help message

Examples:
  %chat provider built-in-ai/core
  %chat provider built-in-ai/webllm
  %chat list built-in-ai/webllm --filter llama
  %chat list built-in-ai/webllm --low-resource
  %chat provider openai --key     (prompts securely for key)
  %chat model gpt-4o-mini

Note: 
- 'built-in-ai/core' uses Chrome/Edge Built-in AI (Gemini Nano/Phi-4 Mini)
- 'built-in-ai/webllm' uses WebLLM for local inference via WebGPU
- API keys can be set in Settings > AI SDK Chat Kernel
- Use '%chat key' or '--key' to enter keys via secure dialog`;
            }

            // %chat list [provider] [--filter <pattern>] [--low-resource]
            const listMatch = trimmed.match(/^%chat\s+list(?:\s+(\S+))?(?:\s+--filter\s+(\S+))?(\s+--low-resource)?$/);
            if (listMatch || trimmed === "%chat list") {
              const specificProvider = listMatch?.[1];
              const filterPattern = listMatch?.[2];
              const lowResourceOnly = !!listMatch?.[3];
              
              if (specificProvider) {
                // Check provider support first
                const support = await checkProviderSupport(specificProvider);
                
                // List models for a specific provider
                const models = await getProviderModels(specificProvider, {
                  namePattern: filterPattern,
                  lowResourceOnly: lowResourceOnly
                });
                const config = getProviderConfig(specificProvider);
                
                if (!config) {
                  return `Unknown provider: ${specificProvider}\n\nUse "%chat list" to see available providers.`;
                }
                
                let output = `${config.displayName} (${config.name})\n`;
                output += `Support: ${support.supported ? '✓ Available' : `✗ ${support.reason}`}\n\n`;
                
                if (models.length > 0) {
                  const defaultModel = await getDefaultModel(specificProvider);
                  output += `Models${filterPattern ? ` (filtered: "${filterPattern}")` : ''}${lowResourceOnly ? ' (low-resource only)' : ''}:\n\n`;
                  
                  for (const model of models) {
                    const isDefault = model.id === defaultModel;
                    let line = `  ${isDefault ? '• ' : '  '}${model.id}`;
                    
                    // Add metadata
                    const meta: string[] = [];
                    if (model.vramMB) meta.push(`${Math.round(model.vramMB)}MB`);
                    if (model.lowResource) meta.push('low-resource');
                    if (isDefault) meta.push('default');
                    
                    if (meta.length > 0) {
                      line += ` (${meta.join(', ')})`;
                    }
                    output += line + '\n';
                  }
                  
                  // Add helpful notes
                  if (specificProvider === 'built-in-ai/webllm') {
                    output += '\nTip: Use --low-resource to show models for mobile/low-end devices\n';
                    output += 'Tip: Use --filter <name> to search (e.g., --filter llama)\n';
                  }
                } else {
                  if (filterPattern || lowResourceOnly) {
                    output += "No models match the filter criteria.\n";
                  } else {
                    output += "Accepts any model name\n";
                  }
                }
                
                if (config.requiresApiKey) {
                  output += `\nRequires API key: ${config.envVar || 'Set via %chat key'}\n`;
                }
                
                output += `\nUsage:\n  %chat provider ${specificProvider}${config.requiresApiKey ? ' --key' : ''}\n`;
                output += `  %chat model <model-name>\n`;
                
                return output;
              } else {
                // List all providers with support status
                const providers = getAllProviders();
                let output = "Available Providers:\n\n";
                
                for (const config of providers) {
                  const support = await checkProviderSupport(config.name);
                  const defaultModel = await getDefaultModel(config.name);
                  
                  const statusIcon = support.supported ? '✓' : '✗';
                  output += `${statusIcon} ${config.displayName} (${config.name})\n`;
                  
                  if (config.description) {
                    output += `  ${config.description}\n`;
                  }
                  
                  if (!support.supported) {
                    output += `  Status: ${support.reason}\n`;
                  } else {
                    output += `  Default model: ${defaultModel}\n`;
                  }
                  
                  if (config.requiresApiKey) {
                    output += `  Requires API key: ${config.envVar || 'yes'}\n`;
                  }
                  output += "\n";
                }
                
                output += "Use '%chat list <provider>' to see models for a specific provider.\n";
                output += "\nExamples:\n";
                output += "  %chat list built-in-ai/webllm\n";
                output += "  %chat list built-in-ai/webllm --low-resource\n";
                output += "  %chat provider openai --key\n";
                
                return output;
              }
            }

            // %chat status
            if (trimmed === "%chat status") {
              const config = this.chat.getConfig();
              let status = "";
              
              if (config.sessionActive) {
                status = `Active session:\n  Provider: ${config.provider}\n  Model: ${config.model}`;
              } else {
                status = "No active session yet.";
              }
              
              if (config.pendingProvider || config.pendingModel) {
                status += "\n\nPending configuration:";
                if (config.pendingProvider) {
                  status += `\n  Provider: ${config.pendingProvider}`;
                  // Show what model will be used
                  if (!config.pendingModel) {
                    const defaultModel = await getDefaultModel(config.pendingProvider);
                    status += `\n  Model: ${defaultModel} (provider default)`;
                  }
                }
                if (config.pendingModel) {
                  status += `\n  Model: ${config.pendingModel}`;
                }
              }
              
              if (!config.sessionActive && !config.pendingProvider) {
                const defProvider = getDefaultProviderFromSettings();
                const defModel = await getDefaultModelFromSettings(defProvider);
                status += `\n\nDefaults from settings:\n  Provider: ${defProvider}\n  Model: ${defModel}`;
              }
              
              return status;
            }

            // %chat key [api-key] - if no key provided, prompt securely
            const keyMatch = trimmed.match(/^%chat\s+key(?:\s+(\S+))?$/);
            if (keyMatch) {
              let key = keyMatch[1];
              if (!key) {
                // Prompt for key using password field (hidden input)
                key = await this.promptForPassword('Enter API key: ');
                if (!key || key.trim() === '') {
                  return "API key entry cancelled.";
                }
              }
              this.chat.setApiKey(key);
              return "API key set.";
            }

            // %chat provider <name> [--key [api-key]]
            // If --key is provided without a value, prompt securely for the key
            const providerMatch = trimmed.match(/^%chat\s+provider\s+(\S+)(?:\s+--key(?:\s+(\S+))?)?$/);
            if (providerMatch) {
              const providerName = providerMatch[1];
              let apiKey = providerMatch[2];
              const hasKeyFlag = trimmed.includes('--key');
              
              // If --key flag is present but no value, prompt for it
              if (hasKeyFlag && !apiKey) {
                apiKey = await this.promptForPassword(`Enter API key for ${providerName}: `);
                if (!apiKey || apiKey.trim() === '') {
                  return "Provider setup cancelled (empty API key).";
                }
              }
              
              try {
                const result = this.chat.setProvider(providerName, undefined, apiKey);
                return result;
              } catch (err: any) {
                throw new Error(`${err.message}\n\nUse "%chat list" to see available providers.`);
              }
            }

            // %chat model <name>
            const modelMatch = trimmed.match(/^%chat\s+model\s+(.+)$/);
            if (modelMatch) {
              const modelName = modelMatch[1].trim();
              try {
                const result = this.chat.setModel(modelName);
                return result;
              } catch (err: any) {
                throw new Error(`${err.message}\n\nUse "%chat list" to see available models.`);
              }
            }

            // Unrecognized %chat command
            return `Unknown command: ${trimmed}\nUse "%chat help" for available commands.`;
          }

          async executeRequest(content: any): Promise<any> {
            const code = String(content.code ?? "");
            try {
              // Split code into lines and process magic commands
              const lines = code.split('\n');
              const magicResults: string[] = [];
              const nonMagicLines: string[] = [];
              
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('%chat')) {
                  // Process magic command
                  const result = await this.processSingleMagic(line);
                  if (result !== null) {
                    magicResults.push(result);
                  }
                } else if (trimmed) {
                  // Non-empty, non-magic line
                  nonMagicLines.push(line);
                }
              }
              
              // Output magic command results
              if (magicResults.length > 0) {
                // @ts-ignore
                this.stream(
                  { name: "stdout", text: magicResults.join('\n') + "\n" },
                  // @ts-ignore
                  this.parentHeader
                );
              }
              
              // If there's non-magic content, send it as a prompt
              const prompt = nonMagicLines.join('\n').trim();
              if (prompt) {
                // Stream each chunk as it arrives
                await this.chat.send(prompt, (chunk: string) => {
                  // @ts-ignore
                  this.stream(
                    { name: "stdout", text: chunk },
                    // @ts-ignore
                    this.parentHeader
                  );
                });
              } else if (magicResults.length === 0) {
                // Empty cell - do nothing
              }

              return {
                status: "ok",
                // @ts-ignore
                execution_count: this.executionCount,
                payload: [],
                user_expressions: {},
              };
            } catch (err: any) {
              // Handle different error types gracefully
              const isAbortError = err?.name === 'AbortError' || err?.message?.includes('aborted');
              
              if (isAbortError) {
                // User interrupted - don't show as error
                console.info('[AISdkLiteKernel] Execution aborted by user');
                return {
                  status: "abort",
                  // @ts-ignore
                  execution_count: this.executionCount,
                };
              }
              
              const message = err?.message ?? String(err);
              console.error('[AISdkLiteKernel] Execution error:', message);
              
              // @ts-ignore
              this.publishExecuteError(
                {
                  ename: err?.name || "Error",
                  evalue: message,
                  traceback: err?.stack ? [err.stack] : [],
                },
                // @ts-ignore
                this.parentHeader
              );
              return {
                status: "error",
                // @ts-ignore
                execution_count: this.executionCount,
                ename: err?.name || "Error",
                evalue: message,
                traceback: err?.stack ? [err.stack] : [],
              };
            }
          }

          async kernelInfoRequest(): Promise<any> {
            return {
              status: "ok",
              protocol_version: "5.3",
              implementation: "ai-sdk-lite-kernel",
              implementation_version: "0.1.0",
              language_info: {
                name: "markdown",
                version: "0.0.0",
                mimetype: "text/markdown",
                file_extension: ".md",
              },
              banner: "AI SDK-backed browser chat kernel",
              help_links: [],
            };
          }

          async completeRequest(content: any): Promise<any> {
            return {
              status: "ok",
              matches: [],
              cursor_start: content.cursor_pos ?? 0,
              cursor_end: content.cursor_pos ?? 0,
              metadata: {},
            };
          }

          async inspectRequest(_content: any): Promise<any> {
            return { status: "ok", found: false, data: {}, metadata: {} };
          }

          async isCompleteRequest(_content: any): Promise<any> {
            return { status: "complete", indent: "" };
          }

          async commInfoRequest(_content: any): Promise<any> {
            return { status: "ok", comms: {} };
          }

          async historyRequest(_content: any): Promise<any> {
            return { status: "ok", history: [] };
          }

          async shutdownRequest(_content: any): Promise<any> {
            console.info('[AISdkLiteKernel] Shutting down');
            // Abort any in-progress operations
            if (this.abortController) {
              this.abortController.abort();
              this.abortController = null;
            }
            return { status: "ok", restart: false };
          }
          
          async interruptRequest(): Promise<void> {
            console.info('[AISdkLiteKernel] Interrupt requested');
            // Abort any in-progress operations
            if (this.abortController) {
              this.abortController.abort();
              this.abortController = null;
            }
          }

          async commOpen(_content: any): Promise<void> { }
          async commMsg(_content: any): Promise<void> { }
          async commClose(_content: any): Promise<void> { }
        }

        // Try to get ISettingRegistry from shared scope (optional)
        let ISettingRegistry: any = null;
        try {
          const settingModule = await importShared('@jupyterlab/settingregistry');
          ISettingRegistry = settingModule.ISettingRegistry;
          console.log("[ai-sdk-chat-kernel] Got ISettingRegistry from shared scope");
        } catch (e) {
          console.warn("[ai-sdk-chat-kernel] ISettingRegistry not available, using defaults");
        }

        // Define and return the plugin
        const aiSdkChatKernelPlugin = {
          id: "@wiki3-ai/ai-sdk-chat-kernel:plugin",
          autoStart: true,
          requires: [IKernelSpecs],
          optional: [ISettingRegistry].filter(Boolean),
          activate: async (app: any, kernelspecs: any, settingRegistry?: any) => {
            console.log("[ai-sdk-chat-kernel] ===== ACTIVATE FUNCTION CALLED =====");
            console.log("[ai-sdk-chat-kernel] JupyterLab app:", app);
            console.log("[ai-sdk-chat-kernel] kernelspecs service:", kernelspecs);
            console.log("[ai-sdk-chat-kernel] settingRegistry:", settingRegistry);

            // Load settings if available
            if (settingRegistry) {
              try {
                const settings = await settingRegistry.load("@wiki3-ai/ai-sdk-chat-kernel:plugin");
                const updateSettings = () => {
                  const provider = settings.get("defaultProvider").composite as string;
                  const model = settings.get("defaultModel").composite as string;
                  const apiKey = settings.get("apiKey").composite as string;
                  
                  if (provider) {
                    settingsDefaultProvider = provider;
                    console.log("[ai-sdk-chat-kernel] Default provider from settings:", provider);
                  }
                  
                  if (model) {
                    settingsDefaultModel = model;
                    console.log("[ai-sdk-chat-kernel] Default model from settings:", model);
                  }
                  
                  if (apiKey) {
                    settingsApiKey = apiKey;
                    // Don't log the actual key for security
                    console.log("[ai-sdk-chat-kernel] API key loaded from settings");
                  } else {
                    settingsApiKey = null;
                  }
                };
                updateSettings();
                settings.changed.connect(updateSettings);
              } catch (e) {
                console.warn("[ai-sdk-chat-kernel] Failed to load settings:", e);
              }
            }

            if (!kernelspecs || typeof kernelspecs.register !== "function") {
              console.error("[ai-sdk-chat-kernel] ERROR: kernelspecs.register not available!");
              return;
            }

            try {
              kernelspecs.register({
                spec: {
                  name: "ai-sdk-chat",
                  display_name: "AI SDK Chat",
                  language: "python",
                  argv: [],
                  resources: {},
                },
                create: async (options: any) => {
                  console.log("[ai-sdk-chat-kernel] Creating AISdkLiteKernel instance", options);
                  return new AISdkLiteKernel(options);
                },
              });

              console.log("[ai-sdk-chat-kernel] ===== KERNEL REGISTERED SUCCESSFULLY =====");
              console.log("[ai-sdk-chat-kernel] Kernel name: ai-sdk-chat");
              console.log("[ai-sdk-chat-kernel] Display name: AI SDK Chat");
            } catch (error) {
              console.error("[ai-sdk-chat-kernel] ===== REGISTRATION ERROR =====", error);
            }

            // Add command to open settings
            const SETTINGS_COMMAND = "ai-sdk-chat-kernel:open-settings";
            
            const isAISdkKernelActive = (): boolean => {
              try {
                const current = app.shell?.currentWidget;
                if (current && (current as any).sessionContext) {
                  const kernelName = (current as any).sessionContext?.session?.kernel?.name;
                  return kernelName === 'ai-sdk-chat';
                }
              } catch (e) {
                // Ignore errors
              }
              return false;
            };
            
            app.commands.addCommand(SETTINGS_COMMAND, {
              label: "Open AI SDK Settings...",
              isVisible: () => isAISdkKernelActive(),
              execute: async () => {
                if (settingRegistry) {
                  try {
                    await app.commands.execute('settingeditor:open', {
                      query: '@wiki3-ai/ai-sdk-chat-kernel'
                    });
                  } catch (e) {
                    console.warn("[ai-sdk-chat-kernel] Could not open settings editor:", e);
                  }
                }
              }
            });

            // Add to Settings menu if IMainMenu is available
            try {
              const mainMenuModule = await importShared("@jupyterlab/mainmenu");
              if (mainMenuModule?.IMainMenu) {
                const IMainMenu = mainMenuModule.IMainMenu;
                const mainMenu = app.serviceManager?.mainMenu || 
                  (app as any)._plugins?.get?.(IMainMenu.name)?.service;
                if (mainMenu?.settingsMenu) {
                  mainMenu.settingsMenu.addGroup([{ command: SETTINGS_COMMAND }], 100);
                  console.log("[ai-sdk-chat-kernel] Added settings command to Settings menu");
                }
              }
            } catch (e) {
              console.log("[ai-sdk-chat-kernel] Could not add to Settings menu:", e);
            }
          },
        };

        const plugins = [aiSdkChatKernelPlugin];
        console.log("[ai-sdk-chat-kernel/federation] ===== PLUGIN CREATED SUCCESSFULLY =====");
        console.log("[ai-sdk-chat-kernel/federation] Plugin ID:", aiSdkChatKernelPlugin.id);
        console.log("[ai-sdk-chat-kernel/federation] Plugin autoStart:", aiSdkChatKernelPlugin.autoStart);
        console.log("[ai-sdk-chat-kernel/federation] Returning plugins array:", plugins);

        // Shape the exports like a real federated ES module
        const moduleExports = {
          __esModule: true,
          default: plugins
        };

        return moduleExports;
      };
    }

    throw new Error(`[ai-sdk-chat-kernel/federation] Unknown module: ${module}`);
  }
};

// Register the container
window._JUPYTERLAB = window._JUPYTERLAB || {};
window._JUPYTERLAB[scope] = container;

console.log("[ai-sdk-chat-kernel/federation] Registered Module Federation container for scope:", scope);
