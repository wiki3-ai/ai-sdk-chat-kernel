"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const kernel_1 = require("./kernel");
const models_1 = require("./models");
const KERNEL_ID = "http-chat";
const httpChatKernelPlugin = {
    id: "http-chat-kernel:plugin",
    autoStart: true,
    activate: async (app) => {
        console.log("[http-chat-kernel] Activating plugin");
        const kernelspecs = app.serviceManager?.kernelspecs;
        if (!kernelspecs || typeof kernelspecs.register !== "function") {
            console.warn("[http-chat-kernel] kernelspecs.register is not available; kernel will not be registered.", kernelspecs);
            return;
        }
        try {
            const readiness = [];
            if (kernelspecs?.ready) {
                readiness.push(Promise.resolve(kernelspecs.ready));
            }
            if (app.restored) {
                readiness.push(app.restored);
            }
            if (readiness.length) {
                await Promise.all(readiness);
            }
        }
        catch (err) {
            console.warn("[http-chat-kernel] Failed waiting for kernelspecs readiness", err);
        }
        kernelspecs.register({
            id: KERNEL_ID,
            spec: {
                name: KERNEL_ID,
                display_name: "HTTP Chat (ACP)",
                language: "python",
                argv: [],
                resources: {},
            },
            create: (options) => {
                console.log("[http-chat-kernel] Creating HttpLiteKernel instance", options);
                return new kernel_1.HttpLiteKernel(options);
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
        const saved = window.localStorage.getItem("webllm:modelId") ?? models_1.DEFAULT_WEBLLM_MODEL;
        models_1.WEBLLM_MODELS.forEach((id) => {
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = id;
            if (id === saved) {
                opt.selected = true;
            }
            select.appendChild(opt);
        });
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
        window.addEventListener("webllm:model-progress", (ev) => {
            const { detail = {} } = ev;
            const { progress: progressValue, text } = detail;
            const showProgress = progressValue !== undefined && progressValue > 0 && progressValue < 1;
            progress.style.display = showProgress ? "inline-block" : "none";
            progress.value = progressValue ?? 0;
            status.textContent = text ?? "";
        });
        document.body.appendChild(bar);
    },
};
const plugins = [httpChatKernelPlugin];
exports.default = plugins;
