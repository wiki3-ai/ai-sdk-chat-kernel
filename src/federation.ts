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
  getNextFallbackProvider,
  releaseWebLLMInstance,
  getWebLLMPoolStatus,
  type ModelInfo,
  type ProgressReport,
  type ProviderInstance
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
 * Get the default provider from settings.
 * Returns null if no provider configured (meaning auto-select should be used).
 */
function getDefaultProviderFromSettings(): string | null {
  // If settings has a provider configured, use it
  if (settingsDefaultProvider) {
    return settingsDefaultProvider;
  }
  // DEFAULT_PROVIDER is null, indicating auto-select
  return DEFAULT_PROVIDER;
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

        // Comm target name for progress/cancellation communication
        const PROGRESS_COMM_TARGET = 'ai-sdk-chat-kernel:progress';

        /**
         * Progress/cancellation state shared between comm manager and operations
         */
        interface ProgressState {
          isCancelled: boolean;
          abortController: AbortController;
        }

        /**
         * Manages comm-based progress reporting and cancellation
         * Handles bidirectional communication between kernel and frontend
         */
        class ProgressCommManager {
          private kernel: any; // Reference to BaseKernel for handleComm
          private commId: string | null = null;
          private state: ProgressState;
          private isOpen: boolean = false;

          constructor(kernel: any) {
            this.kernel = kernel;
            this.state = {
              isCancelled: false,
              abortController: new AbortController()
            };
          }

          /**
           * Get the current progress state (for passing to operations)
           */
          getState(): ProgressState {
            return this.state;
          }

          /**
           * Reset state for a new operation
           */
          reset(): void {
            this.state = {
              isCancelled: false,
              abortController: new AbortController()
            };
          }

          /**
           * Open a comm channel to the frontend for progress updates
           */
          open(parentHeader?: any): void {
            if (this.isOpen) {
              // Already open, just reset state
              this.reset();
              return;
            }

            this.commId = `progress-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            this.reset();

            // Send comm_open message to frontend
            this.kernel.handleComm(
              'comm_open',
              {
                comm_id: this.commId,
                target_name: PROGRESS_COMM_TARGET,
                data: { type: 'init' }
              },
              {},
              [],
              parentHeader
            );

            this.isOpen = true;
            console.debug('[ProgressComm] Opened comm channel:', this.commId);
          }

          /**
           * Send a progress update to the frontend
           * Deduplicates repeated identical messages
           */
          sendProgress(
            message: string,
            percent: number,
            status: 'loading' | 'complete' | 'error' | 'cancelled' = 'loading',
            parentHeader?: any
          ): void {
            if (!this.isOpen || !this.commId) {
              return;
            }

            this.kernel.handleComm(
              'comm_msg',
              {
                comm_id: this.commId,
                data: {
                  type: 'progress_update',
                  message,
                  percent,
                  status,
                  timestamp: Date.now()
                }
              },
              {},
              [],
              parentHeader
            );

            console.debug(`[ProgressComm] ${percent}% - ${message}`);
          }

          /**
           * Close the comm channel
           */
          close(parentHeader?: any): void {
            if (!this.isOpen || !this.commId) {
              return;
            }

            this.kernel.handleComm(
              'comm_close',
              {
                comm_id: this.commId,
                data: { type: 'close' }
              },
              {},
              [],
              parentHeader
            );

            this.isOpen = false;
            this.commId = null;
            console.debug('[ProgressComm] Closed comm channel');
          }

          /**
           * Handle incoming comm message from frontend (e.g., cancel)
           */
          handleMessage(commId: string, data: any): boolean {
            if (commId !== this.commId) {
              return false; // Not our comm
            }

            if (data?.type === 'cancel') {
              console.info('[ProgressComm] Cancel requested by user');
              this.state.isCancelled = true;
              this.state.abortController.abort();
              return true;
            }

            return false;
          }

          /**
           * Check if cancellation was requested
           */
          isCancelled(): boolean {
            return this.state.isCancelled;
          }

          /**
           * Throw if cancelled (for use in async operations)
           */
          checkCancelled(): void {
            if (this.state.isCancelled) {
              throw new DOMException('Operation cancelled by user', 'AbortError');
            }
          }
        }

        /**
         * Chat kernel using Vercel AI SDK
         * 
         * State management:
         * - Each kernel instance has its own isolated state
         * - Settings (provider, model, apiKey) are stored but session is created lazily
         * - Magic commands can configure the kernel before the first message
         * - Session is only created when actually sending a message
         * - WebLLM instances are shared globally and reference-counted
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
          
          // Track WebLLM model ID for cleanup (shared instances are reference-counted)
          private activeWebLLMModelId: string | null = null;
          
          // Progress output callback (set by parent kernel)
          private onProgress: ((text: string) => void) | null = null;

          // MCP Tools registry - maps tool pack names to their tools
          private enabledToolPacks: Set<string> = new Set();
          private toolPacksCache: Map<string, Record<string, any>> = new Map();

          constructor() {
            console.debug("[AIChatKernel] Created (session creation deferred until first message)");
          }

          /**
           * Enable an MCP tool pack by name.
           * Returns info about the enabled tools.
           */
          async enableToolPack(packName: string): Promise<{ enabled: boolean; tools: string[]; message: string }> {
            if (packName === 'wiki-query') {
              if (this.enabledToolPacks.has(packName)) {
                const tools = await this.getToolPackTools(packName);
                return {
                  enabled: true,
                  tools: Object.keys(tools),
                  message: `Tool pack '${packName}' is already enabled.`
                };
              }
              
              // Lazy load the wiki-query tools
              const wikiModule = await import('./mcp-tools/wiki-query.js');
              const tools = wikiModule.getWikiQueryTools();
              this.toolPacksCache.set(packName, tools);
              this.enabledToolPacks.add(packName);
              
              console.info(`[AIChatKernel] Enabled tool pack: ${packName}`);
              return {
                enabled: true,
                tools: Object.keys(tools),
                message: `Enabled tool pack '${packName}' with ${Object.keys(tools).length} tools: ${Object.keys(tools).join(', ')}`
              };
            }
            
            return {
              enabled: false,
              tools: [],
              message: `Unknown tool pack: ${packName}. Available packs: wiki-query`
            };
          }

          /**
           * Disable an MCP tool pack.
           */
          disableToolPack(packName: string): { disabled: boolean; message: string } {
            if (this.enabledToolPacks.has(packName)) {
              this.enabledToolPacks.delete(packName);
              this.toolPacksCache.delete(packName);
              console.info(`[AIChatKernel] Disabled tool pack: ${packName}`);
              return {
                disabled: true,
                message: `Disabled tool pack '${packName}'.`
              };
            }
            return {
              disabled: false,
              message: `Tool pack '${packName}' is not enabled.`
            };
          }

          /**
           * Get tools for a specific pack.
           */
          private async getToolPackTools(packName: string): Promise<Record<string, any>> {
            if (this.toolPacksCache.has(packName)) {
              return this.toolPacksCache.get(packName)!;
            }
            
            // Load if not cached
            if (packName === 'wiki-query') {
              const wikiModule = await import('./mcp-tools/wiki-query.js');
              const tools = wikiModule.getWikiQueryTools();
              this.toolPacksCache.set(packName, tools);
              return tools;
            }
            
            return {};
          }

          /**
           * Get all enabled tools as a combined record for use with streamText.
           */
          async getEnabledTools(): Promise<Record<string, any>> {
            const allTools: Record<string, any> = {};
            
            for (const packName of this.enabledToolPacks) {
              const packTools = await this.getToolPackTools(packName);
              Object.assign(allTools, packTools);
            }
            
            return allTools;
          }

          /**
           * List all enabled tool packs and their tools.
           */
          async listEnabledTools(): Promise<{ packs: Array<{ name: string; tools: string[] }>; total: number }> {
            const packs: Array<{ name: string; tools: string[] }> = [];
            let total = 0;
            
            for (const packName of this.enabledToolPacks) {
              const tools = await this.getToolPackTools(packName);
              const toolNames = Object.keys(tools);
              packs.push({ name: packName, tools: toolNames });
              total += toolNames.length;
            }
            
            return { packs, total };
          }

          /**
           * Get available tool packs (not necessarily enabled).
           */
          getAvailableToolPacks(): Array<{ name: string; description: string }> {
            return [
              {
                name: 'wiki-query',
                description: 'Tools for fetching and analyzing Wikipedia/MediaWiki content'
              }
            ];
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
           * Get the provider to use - pending config, settings, or auto-select
           * Returns null if no provider configured and auto-select needed
           */
          private getProviderToUse(): string | null {
            if (this.pendingProvider) {
              return this.pendingProvider;
            }
            return getDefaultProviderFromSettings(); // May return null
          }

          /**
           * Whether we're in auto-select mode (no explicit provider configured)
           */
          private isAutoSelectMode(): boolean {
            return !this.pendingProvider && !getDefaultProviderFromSettings();
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
           * Release any shared resources (e.g., WebLLM instance)
           */
          private releaseSharedResources(): void {
            if (this.activeWebLLMModelId) {
              console.debug(`[AIChatKernel] Releasing WebLLM instance: ${this.activeWebLLMModelId}`);
              releaseWebLLMInstance(this.activeWebLLMModelId);
              this.activeWebLLMModelId = null;
            }
          }

          /**
           * Try to create a session with a specific provider, returning success/failure
           */
          private async tryCreateSessionWithProvider(
            providerName: string, 
            modelName: string, 
            apiKey: string | null,
            progressCallback: (report: ProgressReport) => void,
            checkCancelled?: () => void
          ): Promise<{ success: boolean; error?: string }> {
            try {
              // Check for cancellation before starting
              if (checkCancelled) checkCancelled();
              
              console.info(`[AIChatKernel] Trying to create session: ${providerName}/${modelName}`);
              
              // Release any previous shared resources before creating new session
              this.releaseSharedResources();
              
              const result = await createProvider(providerName, modelName, apiKey ?? undefined, progressCallback);
              
              // Check for cancellation after provider creation
              if (checkCancelled) checkCancelled();
              
              this.languageModel = result.model;
              this.activeProvider = providerName;
              this.activeModel = modelName;
              this.sessionInitialized = true;
              
              // Track WebLLM model ID for cleanup
              if (result.webllmModelId) {
                this.activeWebLLMModelId = result.webllmModelId;
                console.debug(`[AIChatKernel] Tracking WebLLM instance: ${result.webllmModelId}`);
              }
              
              console.info(`[AIChatKernel] Session created successfully: ${providerName}/${modelName}`);
              return { success: true };
            } catch (error: any) {
              // Re-throw abort errors
              if (error.name === 'AbortError') {
                throw error;
              }
              console.warn(`[AIChatKernel] Failed to initialize ${providerName}:`, error.message);
              return { success: false, error: error.message };
            }
          }

          /**
           * Create the AI session with current configuration.
           * Called lazily when first message is sent.
           * If in auto-select mode, will try providers in order until one works.
           * @param progressComm Optional progress comm manager for UI updates and cancellation
           */
          private async createSession(progressComm?: ProgressCommManager): Promise<void> {
            const apiKey = this.getApiKey();
            
            // Track last message for deduplication (providers like Transformers.js spam duplicates)
            let lastProgressMessage = '';
            
            // Progress callback for model download - sends to both console and comm
            const progressCallback = (report: ProgressReport) => {
              // Deduplicate: skip if message is identical to the last one
              if (report.text === lastProgressMessage) {
                return;
              }
              lastProgressMessage = report.text;
              
              // Console output (existing behavior)
              if (this.onProgress) {
                this.onProgress(report.text + '\n');
              }
              // Comm-based progress (new)
              if (progressComm) {
                // Convert report to percentage if we have progress info
                const percent = report.progress !== undefined 
                  ? Math.round(report.progress * 100) 
                  : -1; // indeterminate
                progressComm.sendProgress(report.text, percent >= 0 ? percent : 50, 'loading');
              }
            };
            
            // Cancellation check function
            const checkCancelled = progressComm 
              ? () => progressComm.checkCancelled() 
              : undefined;

            // If user explicitly configured a provider, use it (no fallback)
            let providerName = this.getProviderToUse();
            if (providerName && !this.isAutoSelectMode()) {
              const modelName = await this.getModelToUse(providerName);
              const config = getProviderConfig(providerName);

              // Check if API key is required but not provided
              if (!apiKey && config?.requiresApiKey) {
                throw new Error(`API key required for ${providerName}.\n\nSet it in: Settings > AI SDK Chat Kernel > API Key\n\nOr use magic commands:\n  %chat provider ${providerName} --key\n  %chat key`);
              }

              const result = await this.tryCreateSessionWithProvider(providerName, modelName, apiKey, progressCallback, checkCancelled);
              if (!result.success) {
                throw new Error(`Failed to create session with ${providerName}/${modelName}: ${result.error}`);
              }
              return;
            }

            // Auto-select mode: try providers in order with fallback on failure
            console.info('[AIChatKernel] Auto-selecting provider...');
            
            // Get initial provider from auto-select
            providerName = await autoSelectLocalProvider();
            
            if (!providerName) {
              throw new Error('No local AI provider available.\n\nOptions:\n1. Enable Chrome/Edge Built-in AI in browser flags\n2. Use a browser with WebGPU support for WebLLM\n3. Configure a cloud provider with %chat provider openai --key');
            }

            // Try providers with fallback
            const errors: string[] = [];
            while (providerName) {
              // Check cancellation before trying each provider
              if (checkCancelled) checkCancelled();
              
              const modelName = await getDefaultModel(providerName);
              const result = await this.tryCreateSessionWithProvider(providerName, modelName, apiKey, progressCallback, checkCancelled);
              
              if (result.success) {
                return;
              }
              
              errors.push(`${providerName}: ${result.error}`);
              
              // Try next fallback provider
              const nextProvider = getNextFallbackProvider(providerName);
              if (nextProvider) {
                console.info(`[AIChatKernel] Falling back to ${nextProvider}...`);
                providerName = nextProvider;
              } else {
                providerName = null;
              }
            }

            // All providers failed
            throw new Error(`Failed to initialize any local AI provider:\n${errors.join('\n')}\n\nTry configuring a cloud provider with %chat provider openai --key`);
          }

          /**
           * Check if session needs to be (re)created due to config changes
           */
          private needsSessionRefresh(): boolean {
            if (!this.sessionInitialized) return true;
            
            const targetProvider = this.getProviderToUse();
            const targetModel = this.pendingModel; // Only check if explicitly set
            
            // Check model change first - this should always trigger refresh if model differs
            if (targetModel && targetModel !== this.activeModel) return true;
            
            // In auto-select mode, don't refresh if we already have a working session
            // (but model changes above still apply)
            if (!targetProvider && this.activeProvider) return false;
            
            if (targetProvider && targetProvider !== this.activeProvider) return true;
            
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
              this.releaseSharedResources();
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
            this.releaseSharedResources();
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
            this.releaseSharedResources();
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
           * Clean up resources when kernel is shutting down
           */
          shutdown(): void {
            console.debug('[AIChatKernel] Shutting down, releasing resources');
            this.releaseSharedResources();
            this.languageModel = null;
            this.sessionInitialized = false;
          }

          /**
           * Send a message and stream the response
           * @param prompt The user's message
           * @param onChunk Callback for each streamed chunk
           * @param abortSignal Optional signal to abort the request
           * @param progressComm Optional progress comm manager for UI updates
           * @param onToolCall Optional callback when a tool is called
           */
          async send(
            prompt: string, 
            onChunk?: (chunk: string) => void,
            abortSignal?: AbortSignal,
            progressComm?: ProgressCommManager,
            onToolCall?: (toolName: string, args: any, result: any) => void
          ): Promise<string> {
            // Create or refresh session if needed (with progress reporting)
            if (this.needsSessionRefresh()) {
              await this.createSession(progressComm);
            }

            if (!this.languageModel) {
              throw new Error("Language model not initialized");
            }

            // Check for abort before starting
            if (abortSignal?.aborted) {
              throw new DOMException('Aborted', 'AbortError');
            }

            // Get enabled tools
            const tools = await this.getEnabledTools();
            const hasTools = Object.keys(tools).length > 0;

            console.log(
              "[AIChatKernel] Sending prompt to provider:",
              this.activeProvider,
              "model:",
              this.activeModel,
              hasTools ? `with ${Object.keys(tools).length} tools` : "(no tools)"
            );

            // Use streamText from AI SDK with abort signal and tools
            const result = await streamText({
              model: this.languageModel,
              prompt: prompt,
              abortSignal: abortSignal,
              ...(hasTools ? { tools, maxSteps: 5 } : {}),
            });

            let fullText = "";
            
            // Process the full stream including tool calls and results
            for await (const part of result.fullStream) {
              // Check for abort between chunks
              if (abortSignal?.aborted) {
                console.debug('[AIChatKernel] Streaming aborted by user');
                throw new DOMException('Aborted', 'AbortError');
              }

              if (part.type === 'text-delta') {
                // AI SDK 4.x uses 'text' instead of 'textDelta'
                const textDelta = (part as any).textDelta ?? (part as any).text ?? '';
                fullText += textDelta;
                if (onChunk && textDelta) {
                  onChunk(textDelta);
                }
              } else if (part.type === 'tool-call') {
                // Log tool call - AI SDK 4.x uses 'input' instead of 'args'
                const args = (part as any).args ?? (part as any).input ?? {};
                console.debug(`[AIChatKernel] Tool call: ${part.toolName}`, args);
                if (onChunk) {
                  onChunk(`\n🔧 Calling tool: ${part.toolName}...\n`);
                }
              } else if (part.type === 'tool-result') {
                // Log tool result - AI SDK 4.x uses 'output' instead of 'result'
                const toolResult = (part as any).result ?? (part as any).output ?? null;
                const args = (part as any).args ?? (part as any).input ?? {};
                console.debug(`[AIChatKernel] Tool result from ${part.toolName}:`, toolResult);
                if (onToolCall) {
                  onToolCall(part.toolName, args, toolResult);
                }
                if (onChunk) {
                  // Show a brief summary of the tool result
                  const resultStr = typeof toolResult === 'string' 
                    ? toolResult.substring(0, 200) 
                    : JSON.stringify(toolResult).substring(0, 200);
                  onChunk(`✓ ${part.toolName} completed\n`);
                }
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
          private progressComm: ProgressCommManager;
          private activeCommIds: Set<string> = new Set();

          constructor(options: any) {
            super(options);
            this.chat = new AIChatKernel();
            this.progressComm = new ProgressCommManager(this);
            
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

            // %chat pool - show status of shared WebLLM instances
            if (trimmed === "%chat pool") {
              const poolStatus = getWebLLMPoolStatus();
              if (poolStatus.length === 0) {
                return "No shared WebLLM instances currently loaded.";
              }
              
              let output = "Shared WebLLM Instance Pool:\n";
              for (const instance of poolStatus) {
                output += `\n  ${instance.modelId}\n`;
                output += `    References: ${instance.refCount}\n`;
                output += `    Last used: ${instance.lastUsed.toLocaleTimeString()}\n`;
              }
              return output;
            }

            // %chat mcp - MCP tool management
            if (trimmed === "%chat mcp" || trimmed === "%chat mcp help") {
              const available = this.chat.getAvailableToolPacks();
              const { packs, total } = await this.chat.listEnabledTools();
              
              let output = `MCP Tool Management:

  %chat mcp                       - Show this help and current status
  %chat mcp list                  - List available tool packs
  %chat mcp enable <pack>         - Enable a tool pack
  %chat mcp disable <pack>        - Disable a tool pack
  %chat mcp status                - Show enabled tools

Available tool packs:
${available.map(p => `  • ${p.name} - ${p.description}`).join('\n')}

Currently enabled: ${total} tools from ${packs.length} pack(s)`;
              
              if (packs.length > 0) {
                output += '\n' + packs.map(p => `  • ${p.name}: ${p.tools.join(', ')}`).join('\n');
              }
              
              return output;
            }

            // %chat mcp list - list available tool packs
            if (trimmed === "%chat mcp list") {
              const available = this.chat.getAvailableToolPacks();
              const { packs } = await this.chat.listEnabledTools();
              const enabledNames = packs.map(p => p.name);
              
              let output = "Available MCP Tool Packs:\n\n";
              for (const pack of available) {
                const status = enabledNames.includes(pack.name) ? '✓ enabled' : '○ disabled';
                output += `  ${pack.name} (${status})\n`;
                output += `    ${pack.description}\n\n`;
              }
              output += `Use "%chat mcp enable <pack>" to enable a tool pack.`;
              return output;
            }

            // %chat mcp status - show enabled tools
            if (trimmed === "%chat mcp status") {
              const { packs, total } = await this.chat.listEnabledTools();
              
              if (packs.length === 0) {
                return "No MCP tool packs are currently enabled.\n\nUse \"%chat mcp list\" to see available packs.";
              }
              
              let output = `Enabled MCP Tools (${total} total):\n\n`;
              for (const pack of packs) {
                output += `${pack.name}:\n`;
                for (const tool of pack.tools) {
                  output += `  • ${tool}\n`;
                }
                output += '\n';
              }
              output += `The AI can now use these tools to help answer your questions.`;
              return output;
            }

            // %chat mcp enable <pack>
            const mcpEnableMatch = trimmed.match(/^%chat\s+mcp\s+enable\s+(\S+)$/);
            if (mcpEnableMatch) {
              const packName = mcpEnableMatch[1];
              const result = await this.chat.enableToolPack(packName);
              return result.message;
            }

            // %chat mcp disable <pack>
            const mcpDisableMatch = trimmed.match(/^%chat\s+mcp\s+disable\s+(\S+)$/);
            if (mcpDisableMatch) {
              const packName = mcpDisableMatch[1];
              const result = this.chat.disableToolPack(packName);
              return result.message;
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
  %chat mcp                       - MCP tool management (enable wiki-query, etc.)
  %chat mcp enable <pack>         - Enable an MCP tool pack
  %chat status                    - Show current configuration
  %chat help                      - Show this help message

Examples:
  %chat provider built-in-ai/core
  %chat provider built-in-ai/webllm
  %chat list built-in-ai/webllm --filter llama
  %chat mcp enable wiki-query     (enables Wikipedia fetching tools)
  %chat provider openai --key     (prompts securely for key)
  %chat model gpt-4o-mini

Note: 
- 'built-in-ai/core' uses Chrome/Edge Built-in AI (Gemini Nano/Phi-4 Mini)
- 'built-in-ai/webllm' uses WebLLM for local inference via WebGPU
- Use '%chat mcp enable wiki-query' to let the AI fetch Wikipedia content
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
                if (defProvider) {
                  const defModel = await getDefaultModelFromSettings(defProvider);
                  status += `\n\nDefaults from settings:\n  Provider: ${defProvider}\n  Model: ${defModel}`;
                } else {
                  status += `\n\nNo provider configured - will auto-select on first use.\nAuto-select order: built-in-ai/core → built-in-ai/webllm → built-in-ai/transformers`;
                }
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
            
            // Create a new abort controller for this request
            this.abortController = new AbortController();
            const signal = this.abortController.signal;
            
            // Open progress comm for this execution
            // @ts-ignore - parentHeader is protected but we need it
            this.progressComm.open(this.parentHeader);
            
            try {
              // Split code into lines and process magic commands
              const lines = code.split('\n');
              const magicResults: string[] = [];
              const nonMagicLines: string[] = [];
              
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('%chat')) {
                  // Process %chat magic command
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
                // Stream each chunk as it arrives, passing abort signal and progress comm
                await this.chat.send(prompt, (chunk: string) => {
                  // @ts-ignore
                  this.stream(
                    { name: "stdout", text: chunk },
                    // @ts-ignore
                    this.parentHeader
                  );
                }, signal, this.progressComm);
              } else if (magicResults.length === 0) {
                // Empty cell - do nothing
              }
              
              // Send completion status
              // @ts-ignore
              this.progressComm.sendProgress('Ready', 100, 'complete', this.parentHeader);

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
                // User interrupted - send cancelled status
                // @ts-ignore
                this.progressComm.sendProgress('Cancelled', -1, 'cancelled', this.parentHeader);
                console.info('[AISdkLiteKernel] Execution aborted by user');
                return {
                  status: "abort",
                  // @ts-ignore
                  execution_count: this.executionCount,
                };
              }
              
              const message = err?.message ?? String(err);
              // @ts-ignore
              this.progressComm.sendProgress(`Error: ${message}`, -1, 'error', this.parentHeader);
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
            } finally {
              // Clean up abort controller and close progress comm
              this.abortController = null;
              // Close comm after a short delay to allow final status to be received
              setTimeout(() => {
                // @ts-ignore
                this.progressComm.close(this.parentHeader);
              }, 1500);
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
            // Release shared resources (e.g., WebLLM instances)
            this.chat.shutdown();
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

          async commOpen(msg: any): Promise<void> {
            // Track comm IDs opened by frontend (for potential future use)
            const commId = msg?.content?.comm_id;
            if (commId) {
              this.activeCommIds.add(commId);
              console.debug('[AISdkLiteKernel] Comm opened:', commId);
            }
          }
          
          async commMsg(msg: any): Promise<void> {
            // Handle incoming messages from frontend
            const commId = msg?.content?.comm_id;
            const data = msg?.content?.data;
            
            console.debug('[AISdkLiteKernel] Comm message received:', commId, data);
            
            // Check if this is a cancel message for our progress comm
            if (this.progressComm.handleMessage(commId, data)) {
              // Cancel was handled - abort current operation
              if (this.abortController) {
                this.abortController.abort();
              }
            }
          }
          
          async commClose(msg: any): Promise<void> {
            // Track comm IDs closed by frontend
            const commId = msg?.content?.comm_id;
            if (commId) {
              this.activeCommIds.delete(commId);
              console.debug('[AISdkLiteKernel] Comm closed:', commId);
            }
          }
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

        /**
         * Subtle status bar progress indicator
         * Shows a small progress indicator in the bottom status bar area
         */
        class StatusBarProgress {
          private node: HTMLElement;
          private spinner: HTMLElement;
          private messageSpan: HTMLElement;
          private cancelBtn: HTMLElement;
          private onCancel: (() => void) | null = null;

          constructor() {
            // Create as a proper JupyterLab status bar item
            this.node = document.createElement('div');
            this.node.className = 'lm-Widget jp-StatusBar-Item ai-status-progress';
            this.node.innerHTML = `
              <div class="jp-StatusBar-GroupItem ai-status-content">
                <span class="ai-status-spinner"></span>
                <button class="ai-status-cancel" title="Cancel">×</button>
                <span class="jp-StatusBar-TextItem ai-status-message">Initializing...</span>
              </div>
            `;

            this.spinner = this.node.querySelector('.ai-status-spinner')!;
            this.messageSpan = this.node.querySelector('.ai-status-message')!;
            this.cancelBtn = this.node.querySelector('.ai-status-cancel')!;

            this.cancelBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              if (this.onCancel) {
                this.messageSpan.textContent = 'Cancelling...';
                this.cancelBtn.style.display = 'none';
                this.onCancel();
              }
            });

            this.addStyles();
            this.hide();
          }

          onCancelRequested(callback: () => void): void {
            this.onCancel = callback;
          }

          updateProgress(message: string, percent: number, status: string = 'loading'): void {
            if (status === 'complete') {
              this.messageSpan.textContent = '✓ ' + message;
              this.spinner.style.display = 'none';
              this.cancelBtn.style.display = 'none';
              this.node.classList.remove('ai-status-error');
            } else if (status === 'cancelled') {
              this.messageSpan.textContent = '⊘ Cancelled';
              this.spinner.style.display = 'none';
              this.cancelBtn.style.display = 'none';
              this.node.classList.remove('ai-status-error');
            } else if (status === 'error') {
              this.messageSpan.textContent = '✗ ' + message;
              this.spinner.style.display = 'none';
              this.cancelBtn.style.display = 'none';
              this.node.classList.add('ai-status-error');
            } else {
              // Loading
              if (percent > 0 && percent < 100) {
                this.messageSpan.textContent = `${message} (${Math.round(percent)}%)`;
              } else {
                this.messageSpan.textContent = message;
              }
              this.spinner.style.display = 'inline-block';
              this.cancelBtn.style.display = 'inline-block';
              this.node.classList.remove('ai-status-error');
            }
          }

          show(): void {
            this.node.style.display = '';
            this.node.classList.remove('lm-mod-hidden');
            this.spinner.style.display = 'inline-block';
            this.cancelBtn.style.display = 'inline-block';
            this.messageSpan.textContent = 'Streaming...';
            this.node.classList.remove('ai-status-error');
          }

          hide(): void {
            this.node.style.display = 'none';
            this.node.classList.add('lm-mod-hidden');
          }

          attachTo(): void {
            // Find the middle section of the JupyterLab status bar (right of kernel status)
            const statusBarMiddle = document.querySelector('.jp-StatusBar-Middle') ||
                                    document.querySelector('#jp-main-statusbar .lm-Panel:nth-child(2)');
            
            if (statusBarMiddle) {
              // Insert as first child of the middle status bar section
              statusBarMiddle.insertBefore(this.node, statusBarMiddle.firstChild);
              console.log('[StatusBarProgress] Attached to jp-StatusBar-Middle');
            } else {
              // Fallback: try the left section
              const statusBarLeft = document.querySelector('.jp-StatusBar-Left');
              if (statusBarLeft) {
                statusBarLeft.appendChild(this.node);
                console.log('[StatusBarProgress] Attached to jp-StatusBar-Left (fallback)');
              } else {
                // Last fallback: fixed position at bottom
                this.node.classList.add('ai-status-fixed');
                document.body.appendChild(this.node);
                console.log('[StatusBarProgress] Using fixed position fallback');
              }
            }
          }

          private addStyles(): void {
            if (document.getElementById('ai-status-progress-styles')) return;

            const style = document.createElement('style');
            style.id = 'ai-status-progress-styles';
            style.textContent = `
              .ai-status-progress.lm-Widget.jp-StatusBar-Item {
                flex: 1;
                min-width: 0;
              }
              .ai-status-progress .ai-status-content {
                display: flex;
                align-items: center;
                gap: 4px;
                width: 100%;
              }
              .ai-status-progress.lm-mod-hidden {
                display: none !important;
              }
              .ai-status-progress.ai-status-fixed {
                position: fixed;
                bottom: 0;
                left: 0;
                height: 24px;
                padding: 0 8px;
                z-index: 1000;
                background: var(--jp-layout-color2, #eeeeee);
                border-radius: 0 4px 0 0;
                border-top: 1px solid var(--jp-border-color2, #e0e0e0);
                border-right: 1px solid var(--jp-border-color2, #e0e0e0);
                display: flex;
                align-items: center;
              }
              .ai-status-spinner {
                display: inline-block;
                width: 10px;
                height: 10px;
                border: 1.5px solid var(--jp-border-color2, #e0e0e0);
                border-top-color: var(--jp-brand-color1, #2196f3);
                border-radius: 50%;
                animation: ai-spin 0.8s linear infinite;
                flex-shrink: 0;
              }
              @keyframes ai-spin {
                to { transform: rotate(360deg); }
              }
              .ai-status-message {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
              }
              .ai-status-cancel {
                background: none;
                border: none;
                color: var(--jp-ui-font-color2, #757575);
                cursor: pointer;
                font-size: 12px;
                line-height: 1;
                padding: 0 2px;
                border-radius: 2px;
                opacity: 0.6;
                flex-shrink: 0;
              }
              .ai-status-cancel:hover {
                opacity: 1;
                color: var(--jp-error-color1, #d32f2f);
              }
              .ai-status-error .ai-status-message {
                color: var(--jp-error-color1, #d32f2f);
              }
              .ai-status-error .ai-status-spinner {
                border-top-color: var(--jp-error-color1, #d32f2f);
              }
            `;
            document.head.appendChild(style);
          }
        }

        /**
         * Progress display extension plugin
         * Listens for progress comm messages from the kernel and displays in status bar
         */
        const progressExtensionPlugin = {
          id: "@wiki3-ai/ai-sdk-chat-kernel:progress-ui",
          autoStart: true,
          requires: [],
          activate: async (app: any) => {
            console.log("[ai-sdk-chat-kernel:progress-ui] Activating progress UI extension");

            // Create status bar progress indicator
            const progressWidget = new StatusBarProgress();
            
            // Delay attachment to ensure status bar is ready
            setTimeout(() => progressWidget.attachTo(), 1000);

            // Track active comms and their associated kernels
            const activeComms = new Map<string, { kernel: any; commId: string }>();

            // When user clicks cancel, send message to kernel
            progressWidget.onCancelRequested(() => {
              for (const [commId, { kernel }] of activeComms) {
                console.log('[progress-ui] Sending cancel to kernel via comm:', commId);
                if (kernel && kernel.sendCommMessage) {
                  kernel.sendCommMessage(commId, { type: 'cancel' });
                } else if (kernel && kernel.requestCommInfo) {
                  // Fallback: try to send via session
                  console.log('[progress-ui] Using session to send cancel');
                }
              }
            });

            // Listen for kernel sessions
            try {
              const sessionModule = await importShared('@jupyterlab/services');
              const { Kernel } = sessionModule;
              
              // Function to set up comm listening on a kernel
              const setupKernelCommListener = (kernel: any) => {
                if (!kernel) return;
                
                console.log('[progress-ui] Setting up comm listener for kernel:', kernel.id);
                
                // Register handler for our comm target
                kernel.registerCommTarget(PROGRESS_COMM_TARGET, (comm: any, openMsg: any) => {
                  const commId = comm.commId || openMsg?.content?.comm_id;
                  console.log('[progress-ui] Comm opened from kernel:', commId);
                  
                  // Track this comm
                  activeComms.set(commId, { kernel, commId });
                  
                  // Show progress indicator
                  progressWidget.show();
                  
                  // Handle messages
                  comm.onMsg = (msg: any) => {
                    const data = msg?.content?.data;
                    console.log('[progress-ui] Comm message:', data);
                    
                    if (data?.type === 'progress_update') {
                      progressWidget.updateProgress(
                        data.message || '',
                        data.percent ?? 0,
                        data.status || 'loading'
                      );
                      
                      // Auto-hide after complete or error (with short delay)
                      if (data.percent === 100 || data.percent === -1) {
                        setTimeout(() => {
                          progressWidget.hide();
                        }, 1500);
                      }
                    }
                  };
                  
                  // Handle close
                  comm.onClose = () => {
                    console.log('[progress-ui] Comm closed:', commId);
                    activeComms.delete(commId);
                    // Hide if no more active comms
                    if (activeComms.size === 0) {
                      progressWidget.hide();
                    }
                  };
                });
              };

              // Try to get notebook tracker to monitor kernels
              try {
                const notebookModule = await importShared('@jupyterlab/notebook');
                const { INotebookTracker } = notebookModule;
                
                // This will be called when a notebook kernel changes
                const tracker = app.serviceManager?.sessions;
                if (tracker) {
                  // Listen for session changes
                  tracker.runningChanged?.connect((_sender: any, models: any) => {
                    for (const model of models) {
                      const session = tracker.connectTo({ model });
                      if (session?.kernel) {
                        setupKernelCommListener(session.kernel);
                      }
                    }
                  });
                }
              } catch (e) {
                console.log('[progress-ui] Could not set up notebook tracking:', e);
              }

              console.log('[progress-ui] Progress UI extension activated');
            } catch (e) {
              console.warn('[progress-ui] Could not set up kernel comm listening:', e);
            }
          },
        };

        const plugins = [aiSdkChatKernelPlugin, progressExtensionPlugin];
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
