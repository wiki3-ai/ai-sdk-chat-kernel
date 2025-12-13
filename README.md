# @wiki3-ai/ai-sdk-chat-kernel

AI SDK chat kernel for JupyterLite using Vercel AI SDK. This kernel supports multiple LLM providers including local browser-based AI and cloud providers like OpenAI, Anthropic, and Google.

## Installation

```bash
pip install ai-sdk-chat-kernel
```

Or for development:

```bash
pip install -e .
```

## Features

- **Separated Local AI Providers**: 
  - `built-in-ai/core` - Chrome/Edge Prompt API (Gemini Nano, Phi-4 Mini)
  - `built-in-ai/transformers` - Transformers.js local inference with HuggingFace models
  - `built-in-ai/webllm` - WebLLM local inference with open-source models
- **Auto-Fallback**: Automatically uses `built-in-ai/core` if available, falls back to `built-in-ai/transformers`, then `built-in-ai/webllm`
- **Dynamic Model Listing**: Fetches available WebLLM models dynamically from `prebuiltAppConfig`
- **Model Filtering**: Filter by name pattern, low-resource, or VRAM requirements
- **Download Progress**: Shows model download progress during WebLLM model loading
- **Multi-Provider Support**: Works with OpenAI, Anthropic, Google, and other Vercel AI SDK providers
- **Flexible API Key Management**: Magic command arguments or JupyterLite settings

## Usage

### Local AI Providers (Default)

By default, the kernel auto-selects a local AI provider:

1. **built-in-ai/core** (preferred): Chrome/Edge built-in AI using Gemini Nano or Phi-4 Mini
   - Requires enabling in `chrome://flags` or `edge://flags`
   - Model: `text` (only option)

2. **built-in-ai/transformers** (first fallback): Local inference with Transformers.js
   - Works in modern browsers with WASM support
   - HuggingFace models (Qwen, Llama, Phi, SmolLM, etc.)

3. **built-in-ai/webllm** (second fallback): Local inference via WebGPU
   - Works in any WebGPU-enabled browser
   - Many models available (Llama, Qwen, Phi, SmolLM, etc.)

No API key needed!

```python
# Using Chrome/Edge Built-in AI (if enabled)
%chat provider built-in-ai/core
%chat model text
Hello! How are you?

# Or use Transformers.js for local inference with HuggingFace models
%chat provider built-in-ai/transformers
%chat model HuggingFaceTB/SmolLM2-360M-Instruct

# Or use WebLLM for local inference with open-source models
%chat provider built-in-ai/webllm
%chat model SmolLM2-360M-Instruct-q4f16_1-MLC
```

### Listing and Filtering Models

```python
# List all available providers
%chat list

# List Transformers.js models
%chat list built-in-ai/transformers

# List WebLLM models
%chat list built-in-ai/webllm

# Filter models by name pattern
%chat list built-in-ai/webllm --filter llama

# Show only low-resource models (good for limited VRAM)
%chat list built-in-ai/webllm --low-resource

# Combine filters
%chat list built-in-ai/webllm --filter qwen --low-resource
```

Model listings show VRAM requirements (e.g., `[1500 MB]`) to help you choose.

### Using Cloud Providers

To use cloud providers like OpenAI, Anthropic, or Google:

**For Browser Environments (JupyterLite):**

API keys must be provided via magic commands:

```python
# Set provider with API key
%chat provider openai --key sk-proj-your-key-here

# Or set key separately
%chat provider openai
%chat key sk-proj-your-key-here

# Switch models (see available models with %chat list openai)
%chat model gpt-4o-mini
```

**For Server/Local Deployments:**

You can use environment variables:

```bash
export OPENAI_API_KEY="sk-proj-your-key-here"
export ANTHROPIC_API_KEY="sk-ant-your-key-here"
export GOOGLE_GENERATIVE_AI_API_KEY="your-key-here"
```

Or still use magic commands as shown above.

### Magic Commands

- `%chat provider <name>` - Set the provider (built-in-ai/core, built-in-ai/webllm, openai, etc.)
- `%chat model <name>` - Set the model (provider-specific)
- `%chat key <api-key>` - Set API key for current provider
- `%chat list` - List available providers
- `%chat list <provider>` - List available models for a specific provider
- `%chat list <provider> --filter <pattern>` - Filter models by name pattern
- `%chat list <provider> --low-resource` - Show only low-resource models
- `%chat status` - Show current configuration
- `%chat help` - Show help message

### Supported Providers

- **built-in-ai/core**: Chrome/Edge Prompt API (default, no API key needed)
  - Model: `text` (Gemini Nano or Phi-4 Mini depending on browser)
  - Requires flag enabled in browser settings
  
- **built-in-ai/transformers**: Transformers.js local inference (first fallback, no API key needed)
  - HuggingFace models: Qwen2.5, Llama-3.2, Phi-3.5, SmolLM2, etc.
  - Use `%chat list built-in-ai/transformers` to see available models
  - Works in modern browsers with WASM support
  
- **built-in-ai/webllm**: WebLLM local inference (second fallback, no API key needed)
  - Many models: Llama-3.2, Qwen2.5, Phi-3.5, SmolLM2, etc.
  - Use `%chat list built-in-ai/webllm` to see all available models
  - Requires WebGPU-enabled browser
  
- **openai**: OpenAI models (requires API key)
  - Default: `gpt-4o-mini` (economical, fast)
  - Available: gpt-4o, gpt-4-turbo, gpt-4, gpt-3.5-turbo
  
- **anthropic**: Anthropic models (requires API key)
  - Default: `claude-3-5-haiku-20241022` (economical, fast)
  - Available: claude-3-5-sonnet, claude-3-opus, etc.
  
- **google**: Google models (requires API key)
  - Default: `gemini-1.5-flash` (economical, fast)
  - Available: gemini-2.0-flash-exp, gemini-1.5-pro, etc.

Use `%chat list <provider>` to see all available models for each provider.

## Development

```bash
# Install npm dependencies (updates package-lock.json)
npm install

# Build the extension
npm run build

# Install in development mode
pip install -e .
```

### Version Management

The version is managed in a single location: `pyproject.toml`. To update the version:

1. Edit the version in `pyproject.toml`
2. Run `npm run sync-version` (or just `npm run build` which includes this step)

The version will automatically sync to:
- `package.json` (via `sync-version` script)
- `ai_sdk_chat_kernel/__init__.py` (dynamically reads from `pyproject.toml`)

**Note:** Do not manually edit the version in `package.json` or `__init__.py` - it will be overwritten.
