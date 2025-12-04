# @wiki3-ai/ai-sdk-chat-kernel

AI SDK chat kernel for JupyterLite using Vercel AI SDK. This kernel supports multiple LLM providers including OpenAI, Anthropic, Google, and more.

## Installation

```bash
pip install ai-sdk-chat-kernel
```

Or for development:

```bash
pip install -e .
```

## Features

- **Built-in AI Support**: Automatic detection and use of Chrome/Edge Built-in AI with WebLLM fallback
- **Multi-Provider Support**: Works with OpenAI, Anthropic, Google, and other Vercel AI SDK providers
- **Flexible Configuration**: Dynamic provider and model selection without hardcoded lists
- **Flexible API Key Management**: 
  - Magic command arguments (recommended for browser environments)
  - Environment variables (for server/local deployments)
- **Model Selection**: Easy switching between any provider-specific models via magic commands

## Usage

### Built-in AI (Default)

By default, the kernel uses the `built-in-ai` provider, which automatically:
- Uses Chrome/Edge Built-in AI if available in your browser
- Falls back to WebLLM (lightweight local models) if built-in AI is not available

No configuration needed! Just start chatting:

```python
Hello! How are you?
```

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

# Switch models
%chat model gpt-4o
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

- `%chat provider <name>` - Set the provider (built-in-ai, openai, anthropic, google, etc.)
- `%chat model <name>` - Set the model (provider-specific)
- `%chat key <api-key>` - Set API key for current provider
- `%chat list` - List available providers
- `%chat status` - Show current configuration
- `%chat help` - Show help message

### Supported Providers

- **built-in-ai**: Chrome/Edge Built-in AI with WebLLM fallback (default)
- **openai**: OpenAI models (GPT-4, GPT-3.5, etc.)
- **anthropic**: Anthropic models (Claude 3.5, etc.)
- **google**: Google models (Gemini, etc.)

Any provider following the Vercel AI SDK pattern can be used by specifying its name.

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
