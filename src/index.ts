import { JupyterFrontEnd, JupyterFrontEndPlugin } from "@jupyterlab/application";
import { WEBLLM_MODELS, DEFAULT_WEBLLM_MODEL } from "./models.js";

import { HttpLiteKernel } from "./kernel.js";

console.log("[webllm-chat-kernel] entrypoint loaded");

declare global {
  interface Window {
    webllmModelId?: string;
    __JUPYTERLITE_SHARED_SCOPE__?: Record<string, unknown>;
    _JUPYTERLAB?: Record<string, any>;
  }
}

/**
 * JupyterLite / JupyterLab plugin that registers our WebLLM-backed kernel.
 */
const httpChatKernelPlugin: JupyterFrontEndPlugin<void> = {
  id: "webllm-chat-kernel:plugin",
  autoStart: true,
  // ❌ remove `requires: [IKernelSpecs]`,
  activate: (app: JupyterFrontEnd) => {
    console.log("[webllm-chat-kernel] Activating plugin");

    // Grab kernelspecs from the app's serviceManager
    const anyApp = app as any;
    const kernelspecs = anyApp.serviceManager?.kernelspecs;

    if (!kernelspecs || typeof kernelspecs.register !== "function") {
      console.warn(
        "[webllm-chat-kernel] kernelspecs.register is not available; kernel will not be registered.",
        kernelspecs
      );
      return;
    }

    kernelspecs.register({
      id: "webllm-chat",
      spec: {
        name: "webllm-chat",
        display_name: "WebLLM Chat",
        language: "python", // purely cosmetic; syntax highlighting
        argv: [],
        resources: {}
      },
      create: (options: any) => {
        console.log("[webllm-chat-kernel] Creating HttpLiteKernel instance", options);
        return new HttpLiteKernel(options);
      }
    });

    console.log("[webllm-chat-kernel] Kernel spec 'webllm-chat' registered");

    // --- WebLLM model selector + progress bar ---
    if (typeof document !== "undefined") {
      const bar = document.createElement("div");
      bar.style.position = "fixed";
      bar.style.top = "8px";
      bar.style.right = "8px";
      bar.style.zIndex = "9999";
      bar.style.padding = "4px 8px";
      bar.style.background = "rgba(0,0,0,0.7)";
      bar.style.color = "#fff";
      bar.style.fontSize = "12px";
      bar.style.borderRadius = "4px";
      bar.style.display = "flex";
      bar.style.gap = "4px";
      bar.style.alignItems = "center";

      const label = document.createElement("span");
      label.textContent = "WebLLM model:";
      bar.appendChild(label);

      const select = document.createElement("select");
      const saved =
        window.localStorage.getItem("webllm:modelId") ?? DEFAULT_WEBLLM_MODEL;
      WEBLLM_MODELS.forEach((id) => {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = id;
        if (id === saved) opt.selected = true;
        select.appendChild(opt);
      });
      // expose current model globally so ChatHttpKernel can read it
      window.webllmModelId = saved;
      select.onchange = () => {
        window.webllmModelId = select.value;
        window.localStorage.setItem("webllm:modelId", select.value);
      };
      bar.appendChild(select);

      const progress = document.createElement("progress");
      progress.max = 1;
      progress.value = 0;
      progress.style.width = "120px";
      progress.style.display = "none";
      bar.appendChild(progress);

      const status = document.createElement("span");
      status.textContent = "";
      bar.appendChild(status);

      window.addEventListener("webllm:model-progress", (ev: any) => {
        const { progress: p, text } = ev.detail;
        progress.style.display = p > 0 && p < 1 ? "inline-block" : "none";
        progress.value = p ?? 0;
        status.textContent = text ?? "";
      });

      document.body.appendChild(bar);
    }
  }
};

const plugins: JupyterFrontEndPlugin<any>[] = [httpChatKernelPlugin];

export default plugins;

// --- manual MF shim for static usage ---
if (typeof window !== "undefined") {
  const scope = "@wiki3-ai/webllm-chat-kernel";
  const moduleFactories: Record<string, () => any> = {
    "./index": () => ({ default: plugins }),
    "./extension": () => ({ default: plugins })
  };

  window._JUPYTERLAB = window._JUPYTERLAB || {};

  if (!window._JUPYTERLAB[scope]) {
    window._JUPYTERLAB[scope] = {
      get: (module: string) => {
        const factory = moduleFactories[module];
        if (!factory) {
          return Promise.reject(new Error(`[webllm-chat-kernel] Unknown module: ${module}`));
        }
        return Promise.resolve(factory);
      },
      init: (shareScope: Record<string, unknown> | undefined) => {
        const scopeData = shareScope ?? {};
        const globalShare = window.__JUPYTERLITE_SHARED_SCOPE__ ||= {};
        Object.assign(globalShare, scopeData);
        console.log("[webllm-chat-kernel] Module federation shim init() with shared scope keys", Object.keys(scopeData));
        return Promise.resolve();
      }
    };

      console.log(`[webllm-chat-kernel] Registered manual Module Federation shim on window._JUPYTERLAB scope='${scope}'`);
  }
}
