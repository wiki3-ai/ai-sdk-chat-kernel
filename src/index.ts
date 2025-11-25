import { JupyterFrontEnd, JupyterFrontEndPlugin } from "@jupyterlab/application";
import type { IKernel } from "@jupyterlite/kernel";
import { IKernelSpecs } from "@jupyterlite/kernel";

import { createHttpLiteKernel } from "./kernel";
import { DEFAULT_WEBLLM_MODEL, WEBLLM_MODELS } from "./models";

declare global {
  interface Window {
    webllmModelId?: string;
  }
}

const KERNEL_ID = "http-chat";

const httpChatKernelPlugin: JupyterFrontEndPlugin<void> = {
  id: "http-chat-kernel:plugin",
  autoStart: true,
  requires: [IKernelSpecs],
  activate: async (app: JupyterFrontEnd, kernelspecs: IKernelSpecs) => {
    console.log("[http-chat-kernel] Activating plugin");

    if (!kernelspecs || typeof kernelspecs.register !== "function") {
      console.warn(
        "[http-chat-kernel] kernelspecs.register is not available; kernel will not be registered.",
        kernelspecs
      );
      return;
    }

    try {
      const readiness: Promise<unknown>[] = [];
      const serviceReady = (app.serviceManager as any)?.ready;
      if (serviceReady) {
        readiness.push(Promise.resolve(serviceReady));
      }
      if (app.restored) {
        readiness.push(app.restored);
      }
      if (readiness.length) {
        await Promise.all(readiness);
      }
    } catch (err) {
      console.warn("[http-chat-kernel] Failed waiting for kernelspecs readiness", err);
    }

    kernelspecs.register({
      spec: {
        name: KERNEL_ID,
        display_name: "HTTP Chat (ACP)",
        language: "python",
        argv: [],
        resources: {},
      },
      create: async (options: IKernel.IOptions) => {
        console.log("[http-chat-kernel] Creating HttpLiteKernel instance", options);
        return Promise.resolve(createHttpLiteKernel(options as any));
      },
    });

    console.log(`[http-chat-kernel] Kernel spec '${KERNEL_ID}' registered`);

    if (typeof document === "undefined") {
      return;
    }

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
      if (id === saved) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });

    (window as any).webllmModelId = saved;
    select.onchange = () => {
      (window as any).webllmModelId = select.value;
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

    window.addEventListener("webllm:model-progress", (ev: Event) => {
      const { detail = {} } = ev as CustomEvent<{ progress?: number; text?: string }>;
      const { progress: progressValue, text } = detail;

      const showProgress = progressValue !== undefined && progressValue > 0 && progressValue < 1;
      progress.style.display = showProgress ? "inline-block" : "none";
      progress.value = progressValue ?? 0;
      status.textContent = text ?? "";
    });

    document.body.appendChild(bar);
  },
};

const plugins: JupyterFrontEndPlugin<any>[] = [httpChatKernelPlugin];

export default plugins;
