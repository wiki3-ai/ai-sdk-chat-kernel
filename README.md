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
  - Environment variables
  - Magic command arguments
  - Interactive prompts
- **Model Selection**: Easy switching between models via magic commands

## Usage

### Setting API Keys

You can provide API keys in several ways:

1. **Environment Variables** (recommended):
```bash
export OPENAI_API_KEY="your-key-here"
export ANTHROPIC_API_KEY="your-key-here"
```

2. **Magic Command Arguments**:
```python
%chat provider openai --key your-key-here
```

3. **Interactive Prompt**: The kernel will prompt you when needed

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
