// src/federation.ts
// Module Federation container for JupyterLite with AI SDK support

import { streamText, type LanguageModel } from 'ai';
import { DEFAULT_PROVIDER, DEFAULT_MODEL, getProviderConfig, getAllProviders, type ProviderConfig } from "./models.js";
import { createProvider, getProviderModels, getDefaultModel } from "./providers.js";

declare const window: any;

console.log("[ai-sdk-chat-kernel/federation] Setting up Module Federation container");

const scope = "@wiki3-ai/ai-sdk-chat-kernel";
let sharedScope: any = null;

// Module-level storage for settings
let settingsDefaultProvider: string | null = null;
let settingsDefaultModel: string | null = null;

/**
 * Get the default provider from settings, falling back to the hardcoded default.
 */
function getDefaultProviderFromSettings(): string {
  return settingsDefaultProvider ?? DEFAULT_PROVIDER;
}

/**
 * Get the default model from settings, or provider-specific default
 */
async function getDefaultModelFromSettings(providerName: string): Promise<string> {
  // If settings specify a model, use it
  if (settingsDefaultModel) {
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
        const { ReactWidget, showDialog, Dialog } = await importShared('@jupyterlab/apputils');
        const React = await importShared('react');

        console.log("[ai-sdk-chat-kernel/federation] Got BaseKernel from shared scope:", BaseKernel);

        /**
         * Chat kernel using Vercel AI SDK
         */
        class AIChatKernel {
          private provider: string | null = null;
          private modelName: string | null = null;
          private apiKey: string | null = null;
          private initialized: boolean = false;
          private languageModel: any | null = null;

          constructor() {
            console.log("[AIChatKernel] Created (initialization deferred until first execution)");
          }

          /**
           * Get API key from stored key only (browser environment doesn't have access to env vars)
           * Environment variables would need to be injected at build time, which is not recommended
           * for security reasons in browser contexts.
           */
          private getApiKey(providerName: string): string | null {
            // Check if we have a stored key for the current provider
            if (this.apiKey && this.provider === providerName) {
              return this.apiKey;
            }

            // In browser environments, we don't have access to process.env at runtime
            // Users must provide API keys via magic commands:
            // - %chat provider <name> --key <api-key>
            // - %chat key <api-key>
            return null;
          }

          /**
           * Initialize or reinitialize with a provider and model
           */
          async initialize(providerName: string, modelName: string, apiKey?: string): Promise<void> {
            // Store the configuration
            this.provider = providerName;
            this.modelName = modelName;
            if (apiKey) {
              this.apiKey = apiKey;
            }

            // Get API key
            let key = this.getApiKey(providerName);
            const config = getProviderConfig(providerName);

            // Check if API key is required but not provided
            if (!key && config?.requiresApiKey) {
              throw new Error(`API key required for ${providerName}. Provide it using:\n  %chat provider ${providerName} --key <your-api-key>\nOr set it separately:\n  %chat key <your-api-key>`);
            }

            // Create language model using dynamic provider system
            try {
              this.languageModel = await createProvider(providerName, modelName, key ?? undefined);
              this.initialized = true;
              console.log(`[AIChatKernel] Initialized with provider: ${providerName}, model: ${modelName}`);
            } catch (error: any) {
              throw new Error(`Failed to initialize provider ${providerName}: ${error.message}`);
            }
          }

          /**
           * Set API key for current provider
           */
          setApiKey(key: string): void {
            // Validate API key format (no whitespace)
            if (!key || /\s/.test(key)) {
              throw new Error("Invalid API key format. API keys should not contain whitespace.");
            }
            this.apiKey = key;
            console.log(`[AIChatKernel] API key updated`);
          }

          /**
           * Set provider (and optionally model and API key)
           */
          async setProvider(providerName: string, modelName?: string, apiKey?: string): Promise<string> {
            const config = getProviderConfig(providerName);
            
            // Use provided model or get default for this provider
            const model = modelName || await getDefaultModel(providerName);

            await this.initialize(providerName, model, apiKey);
            
            const displayName = config?.displayName || providerName;
            return `Provider set to: ${displayName} (${model})`;
          }

          /**
           * Set model for current provider
           */
          async setModel(modelName: string): Promise<string> {
            if (!this.provider) {
              throw new Error("No provider set. Use %chat provider <name> first.");
            }

            await this.initialize(this.provider, modelName, this.apiKey || undefined);
            return `Model changed to: ${modelName}`;
          }

          /**
           * Get current configuration
           */
          getConfig(): { provider: string | null; model: string | null } {
            return {
              provider: this.provider,
              model: this.modelName,
            };
          }

          /**
           * Send a message and stream the response
           */
          async send(prompt: string, onChunk?: (chunk: string) => void): Promise<string> {
            // Initialize if not done yet
            if (!this.initialized) {
              const defaultProvider = getDefaultProviderFromSettings();
              const defaultModel = await getDefaultModelFromSettings(defaultProvider);
              await this.initialize(defaultProvider, defaultModel);
              console.log(`[AIChatKernel] Auto-initialized with provider: ${defaultProvider}, model: ${defaultModel}`);
            }

            if (!this.languageModel) {
              throw new Error("Language model not initialized");
            }

            console.log(
              "[AIChatKernel] Sending prompt:",
              prompt,
              "using provider:",
              this.provider,
              "model:",
              this.modelName
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

            console.log("[AIChatKernel] Got reply:", fullText);
            return fullText;
          }
        }

        // Define AISdkLiteKernel extending BaseKernel
        class AISdkLiteKernel extends BaseKernel {
          private chat: AIChatKernel;

          constructor(options: any) {
            super(options);
            this.chat = new AIChatKernel();
          }

          /**
           * Prompt the user for input using a password dialog.
           * This prevents API keys from being visible in notebook cells.
           */
          private async promptForPassword(promptText: string): Promise<string> {
            // Use Dialog.getPassword for secure input
            const result = await (Dialog as any).getPassword({
              title: 'API Key Required',
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
           * Handle %chat magic commands.
           */
          private async handleMagic(code: string): Promise<string | null> {
            const trimmed = code.trim();

            // %chat help
            if (trimmed === "%chat" || trimmed === "%chat help") {
              const providers = getAllProviders();
              const providerList = providers.map(p => p.name).join(', ');
              
              return `AI SDK Chat Kernel Magic Commands:

  %chat provider <name>           - Set provider (${providerList})
  %chat provider <name> --key     - Set provider, prompt securely for API key
  %chat provider <name> --key <k> - Set provider with API key (visible in cell)
  %chat model <name>              - Set model (provider-specific)
  %chat key                       - Prompt securely for API key (recommended)
  %chat key <api-key>             - Set API key (visible in cell - not recommended)
  %chat list                      - List available providers
  %chat status                    - Show current configuration
  %chat help                      - Show this help message

Examples:
  %chat provider built-in-ai
  %chat provider openai --key     (prompts securely for key)
  %chat key                       (prompts securely for key)
  %chat model gpt-4o

Note: 
- The 'built-in-ai' provider uses Chrome Built-in AI if available, or WebLLM as fallback.
- Use '%chat key' or '--key' without a value to enter keys securely (hidden input).
- Avoid putting API keys directly in notebook cells as they will be saved in the file.`;
            }

            // %chat list [provider]
            const listMatch = trimmed.match(/^%chat\s+list(?:\s+(\S+))?$/);
            if (listMatch || trimmed === "%chat list") {
              const specificProvider = listMatch?.[1];
              
              if (specificProvider) {
                // List models for a specific provider
                const models = await getProviderModels(specificProvider);
                const config = getProviderConfig(specificProvider);
                
                if (!config) {
                  return `Unknown provider: ${specificProvider}\n\nUse "%chat list" to see available providers.`;
                }
                
                let output = `${config.displayName} (${config.name}) Models:\n\n`;
                
                if (models.length > 0) {
                  const defaultModel = await getDefaultModel(specificProvider);
                  models.forEach((model: string) => {
                    const isDefault = model === defaultModel;
                    output += `  ${isDefault ? '• ' : '  '}${model}${isDefault ? ' (default)' : ''}\n`;
                  });
                  
                  // Add helpful note for built-in-ai provider
                  if (specificProvider === 'built-in-ai') {
                    output += '\nNote: "prompt-api" uses Chrome Built-in AI, others use WebLLM for local inference.\n';
                  }
                } else {
                  output += "  Accepts any model name\n";
                }
                
                if (config.requiresApiKey) {
                  output += `\nRequires API key: ${config.envVar || 'Set via %chat key'}\n`;
                }
                
                output += `\nUsage:\n  %chat provider ${specificProvider}${config.requiresApiKey ? ' --key <api-key>' : ''}\n`;
                output += `  %chat model <model-name>\n`;
                
                return output;
              } else {
                // List all providers
                const providers = getAllProviders();
                let output = "Available Providers:\n\n";
                
                for (const config of providers) {
                  const defaultModel = await getDefaultModel(config.name);
                  output += `• ${config.displayName} (${config.name})\n`;
                  output += `  Default model: ${defaultModel}\n`;
                  
                  if (config.isBuiltIn) {
                    output += `  Type: Browser built-in (prompt-api) or local (WebLLM)\n`;
                  } else if (config.requiresApiKey) {
                    output += `  Requires API key${config.envVar ? `: ${config.envVar}` : ''}\n`;
                  }
                  output += "\n";
                }
                
                output += "Use '%chat list <provider>' to see models for a specific provider.\n";
                output += "\nExamples:\n";
                output += "  %chat list built-in-ai\n";
                output += "  %chat provider built-in-ai\n";
                output += "  %chat model prompt-api\n";
                output += "  %chat provider openai --key sk-...\n";
                
                return output;
              }
            }

            // %chat status
            if (trimmed === "%chat status") {
              const { provider, model } = this.chat.getConfig();
              if (!provider) {
                const defProvider = getDefaultProviderFromSettings();
                const defModel = await getDefaultModelFromSettings(defProvider);
                return `Not yet initialized. Will use default: ${defProvider} with model ${defModel}`;
              }
              return `Current provider: ${provider}\nCurrent model: ${model}`;
            }

            // %chat key [api-key] - if no key provided, prompt securely
            const keyMatch = trimmed.match(/^%chat\s+key(?:\s+(\S+))?$/);
            if (keyMatch) {
              let key = keyMatch[1];
              if (!key) {
                // Prompt for key using password field (hidden input)
                key = await this.promptForPassword('Enter API key: ');
                if (!key || key.trim() === '') {
                  return "API key entry cancelled (empty input).";
                }
              }
              this.chat.setApiKey(key);
              return "API key set successfully.";
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
                const result = await this.chat.setProvider(providerName, undefined, apiKey);
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
                const result = await this.chat.setModel(modelName);
                return result;
              } catch (err: any) {
                throw new Error(`${err.message}\n\nUse "%chat list" to see available models.`);
              }
            }

            return null; // Not a magic command
          }

          async executeRequest(content: any): Promise<any> {
            const code = String(content.code ?? "");
            try {
              // Check for magic commands first
              const magicResult = await this.handleMagic(code);
              if (magicResult !== null) {
                // @ts-ignore
                this.stream(
                  { name: "stdout", text: magicResult + "\n" },
                  // @ts-ignore
                  this.parentHeader
                );
                return {
                  status: "ok",
                  // @ts-ignore
                  execution_count: this.executionCount,
                  payload: [],
                  user_expressions: {},
                };
              }

              // Stream each chunk as it arrives
              await this.chat.send(code, (chunk: string) => {
                // @ts-ignore
                this.stream(
                  { name: "stdout", text: chunk },
                  // @ts-ignore
                  this.parentHeader
                );
              });

              return {
                status: "ok",
                // @ts-ignore
                execution_count: this.executionCount,
                payload: [],
                user_expressions: {},
              };
            } catch (err: any) {
              const message = err?.message ?? String(err);
              // @ts-ignore
              this.publishExecuteError(
                {
                  ename: "Error",
                  evalue: message,
                  traceback: [],
                },
                // @ts-ignore
                this.parentHeader
              );
              return {
                status: "error",
                // @ts-ignore
                execution_count: this.executionCount,
                ename: "Error",
                evalue: message,
                traceback: [],
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
            return { status: "ok", restart: false };
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
                  
                  if (provider) {
                    settingsDefaultProvider = provider;
                    console.log("[ai-sdk-chat-kernel] Default provider from settings:", provider);
                  }
                  
                  if (model) {
                    settingsDefaultModel = model;
                    console.log("[ai-sdk-chat-kernel] Default model from settings:", model);
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
