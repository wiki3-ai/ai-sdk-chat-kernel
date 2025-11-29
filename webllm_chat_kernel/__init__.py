# webllm-chat-kernel - WebLLM chat kernel for JupyterLite using @built-in-ai/web-llm
# This is a JupyterLab extension with no Python code.
# The extension is distributed via shared-data in the wheel.

__version__ = "0.1.2"


def _jupyter_labextension_paths():
    """Return metadata about the JupyterLab extension."""
    return [{
        "src": "webllm_chat_kernel/labextension",
        "dest": "@wiki3-ai/webllm-chat-kernel"
    }]
