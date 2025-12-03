// src/federation.ts
// Module Federation container for JupyterLite

import { CreateMLCEngine, type MLCEngineInterface, type InitProgressReport } from "@mlc-ai/web-llm";
import { WEBLLM_MODELS, DEFAULT_WEBLLM_MODEL, isValidWebLLMModel } from "./models.js";

declare const window: any;

console.log("[webllm-chat-kernel/federation] Setting up Module Federation container");

const scope = "@wiki3-ai/webllm-chat-kernel";
let sharedScope: any = null;

// Module-level storage for the settings-based default model
let settingsDefaultModel: string | null = null;

/**
 * Get the default model from settings, falling back to the hardcoded default.
 * This is called when the kernel is first initialized.
 */
function getDefaultModel(): string {
  return settingsDefaultModel ?? DEFAULT_WEBLLM_MODEL;
}

// Helper to get a module from the shared scope
async function importShared(pkg: string): Promise<any> {
  if (!sharedScope) {
    // Fallback to global webpack share scope if available
    // @ts-ignore
    if (window.__webpack_share_scopes__ && window.__webpack_share_scopes__.default) {
      console.warn(`[webllm-chat-kernel] Using global __webpack_share_scopes__.default for ${pkg}`);
      // @ts-ignore
      sharedScope = window.__webpack_share_scopes__.default;
    } else {
      throw new Error(`[webllm-chat-kernel] Shared scope not initialized when requesting ${pkg}`);
    }
  }

  const versions = sharedScope[pkg];
  if (!versions) {
    throw new Error(`[webllm-chat-kernel] Shared module ${pkg} not found in shared scope. Available: ${Object.keys(sharedScope)}`);
  }

  const versionKeys = Object.keys(versions);
  if (versionKeys.length === 0) {
    throw new Error(`[webllm-chat-kernel] No versions available for ${pkg}`);
  }

  // Pick the first available version
  const version = versions[versionKeys[0]];
  const factory = version?.get;

  if (typeof factory !== "function") {
    throw new Error(`[webllm-chat-kernel] Module ${pkg} has no factory function`);
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

  console.log(`[webllm-chat-kernel] Loaded ${pkg}:`, result);
  return result;
}

// Module Federation container API
const container = {
  init: (scope: any) => {
    console.log("[webllm-chat-kernel/federation] init() called, storing shared scope");
    sharedScope = scope;
    return Promise.resolve();
  },

  get: async (module: string) => {
    console.log("[webllm-chat-kernel/federation] get() called for module:", module);
    console.log("[webllm-chat-kernel/federation] This means JupyterLite is requesting our plugin!");

    // JupyterLite may request either "./index" or "./extension"
    if (module === "./index" || module === "./extension") {
      // Lazy-load our plugin module, which will pull from shared scope
      return async () => {
        console.log("[webllm-chat-kernel/federation] ===== LOADING PLUGIN MODULE =====");
        console.log("[webllm-chat-kernel/federation] Loading plugins from shared scope...");

        // Import JupyterLab/JupyterLite modules from shared scope
        const { BaseKernel, IKernelSpecs } = await importShared('@jupyterlite/kernel');
        const { Widget } = await importShared('@lumino/widgets');

        const { ReactWidget, showDialog, Dialog } = await importShared('@jupyterlab/apputils');
        const React = await importShared('react');
        const { HTMLSelect } = await importShared('@jupyterlab/ui-components');


        console.log("[webllm-chat-kernel/federation] Got BaseKernel from shared scope:", BaseKernel);

        // Define WebLLM-backed Chat kernel inline (browser-only, no HTTP)
        class WebLLMChatKernel {
          private modelName: string | null = null;
          private engine: MLCEngineInterface | null = null;
          private initialized: boolean = false;
          private initializationPromise: Promise<void> | null = null;

          constructor() {
            // Model initialization is deferred until first send() call
            console.log("[WebLLMChatKernel] Created (model initialization deferred until first execution)");
          }

          /**
           * Initialize the model. Called on first send() or when explicitly setting a model.
           */
          private async initializeModel(modelName: string): Promise<void> {
            if (!isValidWebLLMModel(modelName)) {
              throw new Error(`Invalid model: ${modelName}. Use %chat list to see available models.`);
            }

            // If already initializing the same model, wait for that
            if (this.initializationPromise && this.modelName === modelName) {
              await this.initializationPromise;
              return;
            }

            // If initializing a different model, wait for current initialization to complete first
            if (this.initializationPromise) {
              await this.initializationPromise;
            }

            this.modelName = modelName;
            
            const initProgressCallback = (report: InitProgressReport) => {
              if (typeof window !== "undefined") {
                window.dispatchEvent(
                  new CustomEvent("webllm:model-progress", { detail: report })
                );
              }
            };

            this.initializationPromise = CreateMLCEngine(this.modelName, {
              initProgressCallback,
            }).then((engine: MLCEngineInterface) => {
              this.engine = engine;
              this.initialized = true;
              console.log("[WebLLMChatKernel] Initialized with model:", this.modelName);
            });

            await this.initializationPromise;
            this.initializationPromise = null;
          }

          /**
           * Set or change the model. Can be called via %chat model magic.
           * If the model is already initialized, this will reinitialize with the new model.
           */
          async setModel(modelName: string): Promise<string> {
            if (!isValidWebLLMModel(modelName)) {
              throw new Error(`Invalid model: ${modelName}`);
            }
            
            const wasInitialized = this.initialized;
            
            // Unload previous model if any
            if (this.engine) {
              await this.engine.unload();
              this.engine = null;
              this.initialized = false;
              this.initializationPromise = null;
            }

            await this.initializeModel(modelName);
            
            if (wasInitialized) {
              return `Model changed to: ${modelName}`;
            } else {
              return `Model set to: ${modelName}`;
            }
          }

          /**
           * Get the current model name, or null if not yet initialized.
           */
          getModelName(): string | null {
            return this.modelName;
          }

          /**
           * Check if the model has been initialized.
           */
          isInitialized(): boolean {
            return this.initialized;
          }

          async send(prompt: string, onChunk?: (chunk: string) => void): Promise<string> {
            // Initialize model on first send if not already done
            if (!this.initialized || !this.engine) {
              const defaultModel = getDefaultModel();
              await this.initializeModel(defaultModel);
              console.log("[WebLLMChatKernel] Auto-initialized with settings default:", defaultModel);
            }

            // After initialization, engine should be available
            if (!this.engine) {
              throw new Error("Failed to initialize WebLLM engine");
            }

            console.log(
              "[WebLLMChatKernel] Sending prompt to WebLLM:",
              prompt,
              "using model:",
              this.modelName
            );

            // Use the streaming chat completion API
            const stream = await this.engine.chat.completions.create({
              messages: [{ role: "user", content: prompt }],
              stream: true,
            });

            let reply = "";
            for await (const chunk of stream) {
              const content = chunk.choices?.[0]?.delta?.content || "";
              if (content) {
                reply += content;
                if (onChunk) {
                  onChunk(content);
                }
              }
            }

            console.log("[WebLLMChatKernel] Got reply from WebLLM:", reply);
            return reply;
          }
        }

        // Define WebLLMLiteKernel extending BaseKernel
        class WebLLMLiteKernel extends BaseKernel {
          private chat: WebLLMChatKernel;

          constructor(options: any) {
            super(options);
            this.chat = new WebLLMChatKernel();
          }

          /**
           * Handle %chat magic commands.
           * Returns the response text if a magic was handled, or null if not a magic command.
           */
          private async handleMagic(code: string): Promise<string | null> {
            const trimmed = code.trim();
            
            // %chat list [filter] - list all models, optionally filtered
            const listMatch = trimmed.match(/^%chat\s+list(?:\s+(.+))?$/);
            if (listMatch || trimmed === "%chat list") {
              const filter = listMatch?.[1]?.toLowerCase() || "";
              const filtered = filter 
                ? WEBLLM_MODELS.filter(m => m.toLowerCase().includes(filter))
                : WEBLLM_MODELS;
              
              if (filtered.length === 0) {
                return `No models found matching "${filter}".\n\nUse "%chat list" to see all ${WEBLLM_MODELS.length} available models.`;
              }
              
              const modelList = filtered.join("\n  ");
              const header = filter 
                ? `Models matching "${filter}" (${filtered.length} of ${WEBLLM_MODELS.length}):`
                : `All available models (${WEBLLM_MODELS.length}):`;
              return `${header}\n  ${modelList}\n\nUse "%chat model <name>" to switch models.`;
            }
            
            // %chat model [name] - show current model or set model
            if (trimmed === "%chat model" || trimmed === "%chat models") {
              const current = this.chat.getModelName();
              const status = this.chat.isInitialized() 
                ? `Current model: ${current}` 
                : `Model not yet initialized. Default: ${getDefaultModel()}`;
              return `${status}\n\nUse "%chat list" to see all available models.\nUse "%chat list <filter>" to filter by name (e.g., "%chat list llama").\nUse "%chat model <name>" to switch models.`;
            }
            
            const modelMatch = trimmed.match(/^%chat\s+model\s+(\S+)$/);
            if (modelMatch) {
              const modelName = modelMatch[1];
              try {
                const result = await this.chat.setModel(modelName);
                return result;
              } catch (err: any) {
                throw new Error(`${err.message}\n\nUse "%chat list" to see available models.`);
              }
            }
            
            // %chat help
            if (trimmed === "%chat" || trimmed === "%chat help") {
              return `WebLLM Chat Kernel Magic Commands:

  %chat model            - Show current model
  %chat model <name>     - Switch to a different model
  %chat list             - List all available models
  %chat list <filter>    - List models matching filter (e.g., "%chat list llama")
  %chat help             - Show this help message

The model is initialized on first cell execution using the default from Settings.
After initialization, use "%chat model <name>" to switch models.`;
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

              // Stream each chunk as it arrives using the stream() method for stdout
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
              implementation: "webllm-lite-kernel",
              implementation_version: "0.1.0",
              language_info: {
                name: "markdown",
                version: "0.0.0",
                mimetype: "text/markdown",
                file_extension: ".md",
              },
              banner: "WebLLM-backed browser chat kernel",
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

          async inputReply(_content: any): Promise<void> { }
          async commOpen(_content: any): Promise<void> { }
          async commMsg(_content: any): Promise<void> { }
          async commClose(_content: any): Promise<void> { }
        }
        // Try to get ISettingRegistry from shared scope (optional)
        let ISettingRegistry: any = null;
        try {
          const settingModule = await importShared('@jupyterlab/settingregistry');
          ISettingRegistry = settingModule.ISettingRegistry;
          console.log("[webllm-chat-kernel] Got ISettingRegistry from shared scope");
        } catch (e) {
          console.warn("[webllm-chat-kernel] ISettingRegistry not available, using defaults");
        }

        // Try to get IFormRendererRegistry from shared scope (optional)
        let IFormRendererRegistry: any = null;
        try {
          const uiModule = await importShared('@jupyterlab/ui-components');
          IFormRendererRegistry = uiModule.IFormRendererRegistry;
          console.log("[webllm-chat-kernel] Got IFormRendererRegistry from shared scope");
        } catch (e) {
          console.warn("[webllm-chat-kernel] IFormRendererRegistry not available");
        }

        // Define and return the plugin
        const webllmChatKernelPlugin = {
          id: "@wiki3-ai/webllm-chat-kernel:plugin",
          autoStart: true,
          // Match the official JupyterLite custom kernel pattern:
          // https://jupyterlite.readthedocs.io/en/latest/howto/extensions/kernel.html
          requires: [IKernelSpecs],
          optional: [ISettingRegistry, IFormRendererRegistry].filter(Boolean),
          activate: async (app: any, kernelspecs: any, settingRegistry?: any, formRendererRegistry?: any) => {
            console.log("[webllm-chat-kernel] ===== ACTIVATE FUNCTION CALLED =====");
            console.log("[webllm-chat-kernel] JupyterLab app:", app);
            console.log("[webllm-chat-kernel] kernelspecs service:", kernelspecs);
            console.log("[webllm-chat-kernel] settingRegistry:", settingRegistry);
            console.log("[webllm-chat-kernel] formRendererRegistry:", formRendererRegistry);

            // Load settings if available
            if (settingRegistry) {
              try {
                const settings = await settingRegistry.load("@wiki3-ai/webllm-chat-kernel:plugin");
                const updateSettings = () => {
                  const model = settings.get("defaultModel").composite as string;
                  if (model && isValidWebLLMModel(model)) {
                    settingsDefaultModel = model;
                    console.log("[webllm-chat-kernel] Settings loaded, default model:", model);
                  }
                };
                updateSettings();
                settings.changed.connect(updateSettings);
              } catch (e) {
                console.warn("[webllm-chat-kernel] Failed to load settings:", e);
              }
            }

            // Register custom form renderer for the model selection dropdown
            if (formRendererRegistry) {
              try {
                const PLUGIN_ID = "@wiki3-ai/webllm-chat-kernel:plugin";
                const ModelSelectorField = (props: any) => {
                  const { schema, formData, onChange } = props;
                  const [filterText, setFilterText] = React.useState('');
                  const [isOpen, setIsOpen] = React.useState(false);
                  const containerRef = React.useRef(null);
                  
                  // Filter models based on search text
                  const filteredModels = React.useMemo(() => {
                    if (!filterText) return WEBLLM_MODELS;
                    const lower = filterText.toLowerCase();
                    return WEBLLM_MODELS.filter((m: string) => m.toLowerCase().includes(lower));
                  }, [filterText]);

                  // Handle click outside to close dropdown
                  React.useEffect(() => {
                    const handleClickOutside = (event: MouseEvent) => {
                      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                        setIsOpen(false);
                      }
                    };
                    document.addEventListener('mousedown', handleClickOutside);
                    return () => document.removeEventListener('mousedown', handleClickOutside);
                  }, []);

                  const handleSelect = (model: string) => {
                    onChange(model);
                    setIsOpen(false);
                    setFilterText('');
                  };

                  return React.createElement('div', { 
                    className: 'jp-FormGroup-contentNormal',
                    style: { position: 'relative' }
                  },
                    React.createElement('h3', { 
                      className: 'jp-FormGroup-fieldLabel jp-FormGroup-contentItem' 
                    }, schema.title || 'Default Model'),
                    schema.description && React.createElement('div', { 
                      className: 'jp-FormGroup-description' 
                    }, schema.description),
                    React.createElement('div', { 
                      ref: containerRef,
                      style: { position: 'relative' } 
                    },
                      // Input field showing current value, acts as search when open
                      React.createElement('input', {
                        type: 'text',
                        className: 'jp-mod-styled',
                        style: { 
                          width: '100%', 
                          padding: '4px 8px',
                          boxSizing: 'border-box'
                        },
                        value: isOpen ? filterText : (formData || ''),
                        placeholder: isOpen ? 'Type to filter models...' : 'Click to select a model',
                        onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
                          if (isOpen) {
                            setFilterText(e.target.value);
                          }
                        },
                        onFocus: () => setIsOpen(true),
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === 'Escape') {
                            setIsOpen(false);
                            setFilterText('');
                          } else if (e.key === 'Enter' && filteredModels.length > 0) {
                            handleSelect(filteredModels[0]);
                          }
                        }
                      }),
                      // Dropdown list
                      isOpen && React.createElement('div', {
                        style: {
                          position: 'absolute',
                          top: '100%',
                          left: 0,
                          right: 0,
                          maxHeight: '300px',
                          overflowY: 'auto',
                          backgroundColor: 'var(--jp-layout-color1)',
                          border: '1px solid var(--jp-border-color1)',
                          borderRadius: '2px',
                          zIndex: 1000,
                          boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
                        }
                      },
                        filteredModels.length === 0 
                          ? React.createElement('div', {
                              style: { 
                                padding: '8px 12px', 
                                color: 'var(--jp-ui-font-color2)',
                                fontStyle: 'italic'
                              }
                            }, 'No matching models')
                          : filteredModels.map((model: string, index: number) => 
                              React.createElement('div', {
                                key: model,
                                style: {
                                  padding: '6px 12px',
                                  cursor: 'pointer',
                                  backgroundColor: model === formData 
                                    ? 'var(--jp-brand-color3)' 
                                    : 'transparent',
                                  borderBottom: index < filteredModels.length - 1 
                                    ? '1px solid var(--jp-border-color2)' 
                                    : 'none'
                                },
                                onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => {
                                  (e.target as HTMLDivElement).style.backgroundColor = 'var(--jp-layout-color2)';
                                },
                                onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => {
                                  (e.target as HTMLDivElement).style.backgroundColor = 
                                    model === formData ? 'var(--jp-brand-color3)' : 'transparent';
                                },
                                onClick: () => handleSelect(model)
                              }, model)
                            )
                      )
                    ),
                    // Show current selection below
                    formData && React.createElement('div', {
                      style: { 
                        marginTop: '4px', 
                        fontSize: '12px',
                        color: 'var(--jp-ui-font-color2)'
                      }
                    }, `Selected: ${formData}`)
                  );
                };

                formRendererRegistry.addRenderer(
                  `${PLUGIN_ID}.defaultModel`,
                  { fieldRenderer: ModelSelectorField }
                );
                console.log("[webllm-chat-kernel] Registered custom model selector renderer");
              } catch (e) {
                console.warn("[webllm-chat-kernel] Failed to register form renderer:", e);
              }
            }

            if (!kernelspecs || typeof kernelspecs.register !== "function") {
              console.error("[webllm-chat-kernel] ERROR: kernelspecs.register not available!");
              return;
            }

            try {
              kernelspecs.register({
                spec: {
                  name: "webllm-chat",
                  display_name: "WebLLM Chat",
                  language: "python",
                  argv: [],
                  resources: {},
                },
                create: async (options: any) => {
                  console.log("[webllm-chat-kernel] Creating WebLLMLiteKernel instance", options);
                  return new WebLLMLiteKernel(options);
                },
              });

              console.log("[webllm-chat-kernel] ===== KERNEL REGISTERED SUCCESSFULLY =====");
              console.log("[webllm-chat-kernel] Kernel name: webllm-chat");
              console.log("[webllm-chat-kernel] Display name: WebLLM Chat");
            } catch (error) {
              console.error("[webllm-chat-kernel] ===== REGISTRATION ERROR =====", error);
            }

            // Add command to open WebLLM settings
            const SETTINGS_COMMAND = "webllm-chat-kernel:open-settings";
            
            // Create a custom dialog widget for model selection
            class ModelSelectorDialogBody extends Widget {
              private _select: HTMLSelectElement;
              private _filter: HTMLInputElement;
              private _modelList: HTMLDivElement;
              private _selectedModel: string;
              private _allModels: string[];
              
              constructor(currentModel: string) {
                super();
                this._selectedModel = currentModel;
                this._allModels = WEBLLM_MODELS;
                
                this.node.style.cssText = 'min-width: 400px; padding: 12px;';
                
                // Create filter input
                const filterLabel = document.createElement('label');
                filterLabel.textContent = 'Filter models:';
                filterLabel.style.cssText = 'display: block; margin-bottom: 4px; font-weight: 500;';
                this.node.appendChild(filterLabel);
                
                this._filter = document.createElement('input');
                this._filter.type = 'text';
                this._filter.placeholder = 'Type to filter...';
                this._filter.className = 'jp-mod-styled';
                this._filter.style.cssText = 'width: 100%; padding: 8px; margin-bottom: 12px; box-sizing: border-box;';
                this._filter.addEventListener('input', () => this._updateList());
                this.node.appendChild(this._filter);
                
                // Create model list container
                const listLabel = document.createElement('label');
                listLabel.textContent = 'Select model:';
                listLabel.style.cssText = 'display: block; margin-bottom: 4px; font-weight: 500;';
                this.node.appendChild(listLabel);
                
                this._modelList = document.createElement('div');
                this._modelList.style.cssText = 'max-height: 300px; overflow-y: auto; border: 1px solid var(--jp-border-color1); border-radius: 4px;';
                this.node.appendChild(this._modelList);
                
                // Hidden select for form value
                this._select = document.createElement('select');
                this._select.style.display = 'none';
                this.node.appendChild(this._select);
                
                // Current selection display
                const currentLabel = document.createElement('div');
                currentLabel.style.cssText = 'margin-top: 12px; padding: 8px; background: var(--jp-layout-color2); border-radius: 4px;';
                currentLabel.innerHTML = `<strong>Current:</strong> <span id="current-model">${currentModel}</span>`;
                this.node.appendChild(currentLabel);
                
                this._updateList();
                
                // Focus filter on show
                setTimeout(() => this._filter.focus(), 100);
              }
              
              private _updateList(): void {
                const filter = this._filter.value.toLowerCase();
                const filtered = filter 
                  ? this._allModels.filter(m => m.toLowerCase().includes(filter))
                  : this._allModels;
                
                this._modelList.innerHTML = '';
                this._select.innerHTML = '';
                
                if (filtered.length === 0) {
                  const noMatch = document.createElement('div');
                  noMatch.textContent = 'No matching models';
                  noMatch.style.cssText = 'padding: 12px; color: var(--jp-ui-font-color2); font-style: italic;';
                  this._modelList.appendChild(noMatch);
                  return;
                }
                
                filtered.forEach(model => {
                  const option = document.createElement('option');
                  option.value = model;
                  option.textContent = model;
                  if (model === this._selectedModel) option.selected = true;
                  this._select.appendChild(option);
                  
                  const item = document.createElement('div');
                  item.textContent = model;
                  item.style.cssText = `
                    padding: 8px 12px; 
                    cursor: pointer; 
                    border-bottom: 1px solid var(--jp-border-color2);
                    background: ${model === this._selectedModel ? 'var(--jp-brand-color3)' : 'transparent'};
                  `;
                  item.addEventListener('mouseenter', () => {
                    if (model !== this._selectedModel) {
                      item.style.background = 'var(--jp-layout-color2)';
                    }
                  });
                  item.addEventListener('mouseleave', () => {
                    item.style.background = model === this._selectedModel ? 'var(--jp-brand-color3)' : 'transparent';
                  });
                  item.addEventListener('click', () => {
                    this._selectedModel = model;
                    this._select.value = model;
                    const currentSpan = this.node.querySelector('#current-model');
                    if (currentSpan) currentSpan.textContent = model;
                    this._updateList();
                  });
                  this._modelList.appendChild(item);
                });
              }
              
              getValue(): string {
                return this._selectedModel;
              }
            }
            
            // Helper to check if current notebook uses WebLLM kernel
            const isWebLLMKernelActive = (): boolean => {
              try {
                const current = app.shell?.currentWidget;
                if (current && (current as any).sessionContext) {
                  const kernelName = (current as any).sessionContext?.session?.kernel?.name;
                  return kernelName === 'webllm-chat';
                }
              } catch (e) {
                // Ignore errors
              }
              return false;
            };
            
            app.commands.addCommand(SETTINGS_COMMAND, {
              label: "Change WebLLM Model...",
              isVisible: () => isWebLLMKernelActive(),
              execute: async () => {
                // Show custom model selection dialog
                const currentModel = settingsDefaultModel || DEFAULT_WEBLLM_MODEL;
                const body = new ModelSelectorDialogBody(currentModel);
                
                const result = await showDialog({
                  title: 'Change Model',
                  body,
                  buttons: [
                    Dialog.cancelButton(),
                    Dialog.okButton({ label: 'Select' })
                  ]
                });
                
                if (result.button.accept) {
                  const newModel = body.getValue();
                  if (newModel && newModel !== currentModel && isValidWebLLMModel(newModel)) {
                    // Update the settings
                    if (settingRegistry) {
                      try {
                        const settings = await settingRegistry.load("@wiki3-ai/webllm-chat-kernel:plugin");
                        await settings.set("defaultModel", newModel);
                        console.log("[webllm-chat-kernel] Model setting saved:", newModel);
                      } catch (e) {
                        console.warn("[webllm-chat-kernel] Could not save to settings registry:", e);
                        // Fall back to just updating the local variable
                        settingsDefaultModel = newModel;
                      }
                    } else {
                      settingsDefaultModel = newModel;
                    }
                  }
                }
              }
            });

            // Add to Settings menu if IMainMenu is available
            try {
              const mainMenuModule = await importShared("@jupyterlab/mainmenu");
              if (mainMenuModule?.IMainMenu) {
                const IMainMenu = mainMenuModule.IMainMenu;
                // Try to get mainMenu from app
                const mainMenu = app.serviceManager?.mainMenu || 
                  (app as any)._plugins?.get?.(IMainMenu.name)?.service;
                if (mainMenu?.settingsMenu) {
                  mainMenu.settingsMenu.addGroup([{ command: SETTINGS_COMMAND }], 100);
                  console.log("[webllm-chat-kernel] Added settings command to Settings menu");
                }
              }
            } catch (e) {
              console.log("[webllm-chat-kernel] Could not add to Settings menu:", e);
            }

            // Log model download progress to console
            if (typeof window !== "undefined") {
              window.addEventListener("webllm:model-progress", (ev: any) => {
                const { progress: p, text } = ev.detail;
                const suffix =
                  typeof p === "number" && p > 0 && p < 1
                    ? ` ${Math.round(p * 100)}%`
                    : p === 1
                    ? " ready"
                    : "";
                console.log(`[webllm-chat-kernel] ${text || "Loading"}${suffix}`);
              });
            }
          },
        };

        const plugins = [webllmChatKernelPlugin];
        console.log("[webllm-chat-kernel/federation] ===== PLUGIN CREATED SUCCESSFULLY =====");
        console.log("[webllm-chat-kernel/federation] Plugin ID:", webllmChatKernelPlugin.id);
        console.log("[webllm-chat-kernel/federation] Plugin autoStart:", webllmChatKernelPlugin.autoStart);
        console.log("[webllm-chat-kernel/federation] Returning plugins array:", plugins);

        // IMPORTANT: Shape the exports like a real federated ES module
        // so JupyterLite's loader sees our plugins. It checks for
        // `__esModule` and then reads `.default`.
        const moduleExports = {
          __esModule: true,
          default: plugins
        };

        return moduleExports;
      };
    }

    throw new Error(`[webllm-chat-kernel/federation] Unknown module: ${module}`);
  }
};

// Register the container
window._JUPYTERLAB = window._JUPYTERLAB || {};
window._JUPYTERLAB[scope] = container;

console.log("[webllm-chat-kernel/federation] Registered Module Federation container for scope:", scope);
