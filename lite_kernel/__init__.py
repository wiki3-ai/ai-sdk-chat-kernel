# lite-kernel - HTTP Chat kernel for JupyterLite with WebLLM support
# This is a JupyterLab extension with no Python code.
# The extension is distributed via shared-data in the wheel.

__version__ = "1.0.0"


def _jupyter_labextension_paths():
    """Return metadata about the JupyterLab extension."""
    return [{
        "src": "lite_kernel/labextension",
        "dest": "lite-kernel"
    }]
