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

- **Multi-Provider Support**: Works with OpenAI, Anthropic, Google, and other Vercel AI SDK providers
- **Flexible API Key Management**: 
  - Magic command arguments (recommended for browser environments)
  - Environment variables (for server/local deployments)
- **Model Selection**: Easy switching between models via magic commands

## Usage

### Setting API Keys

**For Browser Environments (JupyterLite):**

API keys must be provided via magic commands:

```python
# Set provider with API key
%chat provider openai --key sk-proj-your-key-here

# Or set key separately
%chat key sk-proj-your-key-here
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

- `%chat provider <name>` - Set the provider (openai, anthropic, google)
- `%chat model <name>` - Set the model
- `%chat key <api-key>` - Set API key
- `%chat list` - List available providers and models
- `%chat help` - Show help message

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
