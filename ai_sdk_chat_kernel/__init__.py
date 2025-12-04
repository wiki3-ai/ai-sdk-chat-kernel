# ai-sdk-chat-kernel - AI SDK chat kernel for JupyterLite using Vercel AI SDK
# This is a JupyterLab extension with no Python code.
# The extension is distributed via shared-data in the wheel.

__version__ = "0.2.5dev2"


def _jupyter_labextension_paths():
    """Return metadata about the JupyterLab extension."""
    return [{
        "src": "ai_sdk_chat_kernel/labextension",
        "dest": "@wiki3-ai/ai-sdk-chat-kernel"
    }]
