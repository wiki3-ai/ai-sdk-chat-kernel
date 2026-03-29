# Progress Display with Cancellation in Chat Kernel - JupyterLite Architecture

## Your Situation - Updated

You need:
- ✅ Progress indication during federation/model loading
- ✅ **Cancel button** to stop long operations
- ✅ Workaround for kernel interrupt/stop issues
- ✅ No user notebook code
- ✅ Works in JupyterLite

**Kernel Comm approach solves all of this** by establishing bidirectional communication where frontend can signal kernel to stop.

---

## Architecture: Kernel Comm with Cancellation

### Flow Diagram

```
User clicks "Cancel" button
        ↓
Frontend extension sends via Comm
        ↓
kernel receives cancel message
        ↓
Federation loader stops gracefully
        ↓
kernel sends "Cancelled" status
        ↓
Frontend hides progress, ready for next operation
```

### Implementation Structure

```
ai-sdk-chat-kernel/
├── src/
│  ├── kernel/
│  │  ├── index.ts              # Main kernel
│  │  └── federation.ts         # Sends progress + receives cancel
│  │
│  └── extension/
│     ├── index.ts              # Comm extension entry
│     └── progress-widget.ts    # Progress UI with cancel button
│
└── package.json
```

---

## Kernel-Side Implementation (federation.ts)

### 1. Create Cancellable Federation Loader

```typescript
// src/kernel/federation.ts

import { Comm } from '@jupyterlite/kernel';

/**
 * Manages federation loading with progress reporting and cancellation support
 */
export class CancellableFederationLoader {
  private comm: Comm | null = null;
  private isCancelled = false;
  private abortController = new AbortController();
  
  /**
   * Opens bidirectional Comm channel with frontend
   */
  openProgressComm(): void {
    this.comm = new Comm({
      target_name: 'kernel-progress-comm',
      data: {}
    });
    
    // Listen for cancel messages from frontend
    this.comm.on_msg((msg: any) => {
      const { type } = msg.data;
      
      if (type === 'cancel') {
        console.log('[Kernel] User requested cancellation');
        this.isCancelled = true;
        this.abortController.abort();
        this.sendProgress('Cancelled by user', -1);
      }
    });
  }
  
  /**
   * Send progress update to frontend
   * percent: 0-100 or -1 for error/cancelled
   */
  private sendProgress(
    message: string,
    percent: number,
    status: 'loading' | 'complete' | 'error' | 'cancelled' = 'loading'
  ): void {
    if (!this.comm) return;
    
    this.comm.send({
      type: 'progress_update',
      message: message,
      percent: percent,
      status: status,
      timestamp: Date.now()
    });
    
    console.log(`[Progress ${percent}%] ${message}`);
  }
  
  /**
   * Check if cancellation was requested
   */
  private checkCancelled(): void {
    if (this.isCancelled) {
      throw new Error('Operation cancelled by user');
    }
  }
  
  /**
   * Load federation module with cancellation support
   */
  async loadFederation(): Promise<any> {
    this.sendProgress('Loading federation...', 5);
    
    try {
      this.checkCancelled();
      
      const response = await fetch('./federation.bundle.js', {
        signal: this.abortController.signal
      });
      
      if (!response.ok) {
        throw new Error(`Federation fetch failed: ${response.status}`);
      }
      
      this.sendProgress('Parsing federation...', 15);
      this.checkCancelled();
      
      const text = await response.text();
      const module = eval(text); // Or use proper module loading
      
      this.sendProgress('Federation loaded', 25, 'loading');
      return module;
      
    } catch (error: any) {
      if (error.name === 'AbortError') {
        this.sendProgress('Federation load cancelled', -1, 'cancelled');
        throw error;
      }
      this.sendProgress(`Error: ${error.message}`, -1, 'error');
      throw error;
    }
  }
  
  /**
   * Download models with progress reporting and cancellation
   */
  async downloadModels(modelList: string[]): Promise<any[]> {
    this.sendProgress('Starting model downloads...', 30);
    
    const startPercent = 30;
    const endPercent = 80;
    const percentPerModel = (endPercent - startPercent) / modelList.length;
    
    const downloadedModels = [];
    
    for (let i = 0; i < modelList.length; i++) {
      this.checkCancelled();
      
      const modelName = modelList[i];
      const percent = Math.round(startPercent + (i * percentPerModel));
      
      this.sendProgress(`Downloading ${modelName}...`, percent);
      
      try {
        const response = await fetch(`./models/${modelName}.bin`, {
          signal: this.abortController.signal
        });
        
        if (!response.ok) {
          throw new Error(`Failed to download ${modelName}: ${response.status}`);
        }
        
        // For large files, track download progress
        const contentLength = parseInt(
          response.headers.get('content-length') || '0',
          10
        );
        
        if (contentLength > 0) {
          const reader = response.body!.getReader();
          let receivedLength = 0;
          
          while (true) {
            this.checkCancelled();
            const { done, value } = await reader.read();
            
            if (done) break;
            receivedLength += value.length;
            
            // Update progress with download percentage
            const downloadPercent = (receivedLength / contentLength) * percentPerModel;
            const currentPercent = percent + downloadPercent;
            this.sendProgress(
              `Downloading ${modelName} (${Math.round((receivedLength / contentLength) * 100)}%)`,
              Math.round(currentPercent)
            );
          }
        } else {
          // Fallback if content-length not available
          const blob = await response.blob();
        }
        
        downloadedModels.push(modelName);
        this.sendProgress(`${modelName} ready`, percent + percentPerModel);
        
      } catch (error: any) {
        if (error.name === 'AbortError') {
          this.sendProgress(`Download cancelled`, -1, 'cancelled');
          throw error;
        }
        this.sendProgress(`Error downloading ${modelName}: ${error.message}`, -1, 'error');
        throw error;
      }
    }
    
    return downloadedModels;
  }
  
  /**
   * Initialize AI SDK
   */
  async initializeSDK(): Promise<void> {
    this.sendProgress('Initializing AI SDK...', 85);
    
    try {
      this.checkCancelled();
      
      // Simulated initialization (replace with actual code)
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      this.sendProgress('SDK initialized', 95);
    } catch (error: any) {
      if (error.name === 'AbortError') {
        this.sendProgress('SDK initialization cancelled', -1, 'cancelled');
        throw error;
      }
      this.sendProgress(`SDK initialization error: ${error.message}`, -1, 'error');
      throw error;
    }
  }
  
  /**
   * Main initialization flow
   */
  async initialize(modelList: string[]): Promise<boolean> {
    try {
      this.openProgressComm();
      this.sendProgress('Starting kernel initialization', 0, 'loading');
      
      // Stage 1: Federation
      await this.loadFederation();
      
      // Stage 2: Models
      await this.downloadModels(modelList);
      
      // Stage 3: SDK
      await this.initializeSDK();
      
      // Complete
      this.sendProgress('Kernel ready!', 100, 'complete');
      
      // Close comm after delay
      setTimeout(() => {
        this.comm?.close();
      }, 1500);
      
      return true;
      
    } catch (error: any) {
      if (this.isCancelled) {
        // Already sent cancelled message
        return false;
      }
      
      console.error('[Kernel] Initialization failed:', error);
      return false;
    }
  }
  
  /**
   * Reset state for next initialization attempt
   */
  reset(): void {
    this.isCancelled = false;
    this.abortController = new AbortController();
    this.comm = null;
  }
}

// Usage in kernel startup
export const federationLoader = new CancellableFederationLoader();

// Call during kernel init:
// await federationLoader.initialize(['llm-model', 'embedding-model']);
```

---

## Frontend Extension Implementation

### 1. Progress Display Widget with Cancel Button

```typescript
// src/extension/progress-widget.ts

/**
 * UI widget for progress with cancel button
 */
export class ProgressDisplay {
  private node: HTMLElement;
  private progressBar: HTMLProgressElement;
  private messageDiv: HTMLElement;
  private percentDiv: HTMLElement;
  private cancelButton: HTMLButtonElement;
  private onCancel: (() => void) | null = null;
  
  constructor() {
    this.node = document.createElement('div');
    this.node.className = 'kernel-progress-modal';
    
    this.node.innerHTML = `
      <div class="kernel-progress-overlay"></div>
      <div class="kernel-progress-container">
        <div class="kernel-progress-header">
          <h3>Initializing Kernel</h3>
          <button class="kernel-progress-close" aria-label="Cancel">×</button>
        </div>
        <div class="kernel-progress-body">
          <div class="kernel-progress-message"></div>
          <progress class="kernel-progress-bar" max="100" value="0"></progress>
          <div class="kernel-progress-percent">0%</div>
        </div>
        <div class="kernel-progress-footer">
          <button class="kernel-progress-cancel-btn">Cancel Operation</button>
        </div>
      </div>
    `;
    
    // Cache element references
    this.progressBar = this.node.querySelector('.kernel-progress-bar')!;
    this.messageDiv = this.node.querySelector('.kernel-progress-message')!;
    this.percentDiv = this.node.querySelector('.kernel-progress-percent')!;
    this.cancelButton = this.node.querySelector('.kernel-progress-cancel-btn')!;
    
    const closeButton = this.node.querySelector('.kernel-progress-close')!;
    
    // Wire up button handlers
    this.cancelButton.addEventListener('click', () => {
      this.handleCancel();
    });
    
    closeButton.addEventListener('click', () => {
      this.handleCancel();
    });
    
    // Add styles
    this.addStyles();
    
    // Hidden by default
    this.hide();
  }
  
  /**
   * Register callback for when user clicks cancel
   */
  onCancelRequested(callback: () => void): void {
    this.onCancel = callback;
  }
  
  /**
   * Handle cancel button click
   */
  private handleCancel(): void {
    this.cancelButton.disabled = true;
    this.cancelButton.textContent = 'Cancelling...';
    
    if (this.onCancel) {
      this.onCancel();
    }
  }
  
  /**
   * Update progress display
   */
  updateProgress(message: string, percent: number, status: string = 'loading'): void {
    this.messageDiv.textContent = message;
    
    // Handle special values
    if (percent === -1) {
      // Error or cancelled
      this.progressBar.value = 0;
      this.percentDiv.textContent = status === 'cancelled' ? 'Cancelled' : 'Error';
      this.node.classList.add('kernel-progress-error');
      this.cancelButton.disabled = true;
    } else if (percent === 100) {
      // Complete
      this.progressBar.value = 100;
      this.percentDiv.textContent = '100%';
      this.cancelButton.disabled = true;
      this.node.classList.remove('kernel-progress-error');
    } else {
      // In progress
      this.progressBar.value = percent;
      this.percentDiv.textContent = `${Math.round(percent)}%`;
      this.node.classList.remove('kernel-progress-error');
    }
  }
  
  /**
   * Show progress modal
   */
  show(): void {
    this.node.style.display = 'flex';
    this.cancelButton.disabled = false;
    this.cancelButton.textContent = 'Cancel Operation';
  }
  
  /**
   * Hide progress modal
   */
  hide(): void {
    this.node.style.display = 'none';
  }
  
  /**
   * Append to document
   */
  attachTo(parent: HTMLElement = document.body): void {
    parent.appendChild(this.node);
  }
  
  /**
   * Add CSS styles
   */
  private addStyles(): void {
    if (document.getElementById('kernel-progress-styles')) {
      return; // Already added
    }
    
    const style = document.createElement('style');
    style.id = 'kernel-progress-styles';
    style.textContent = `
      .kernel-progress-modal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 10000;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      
      .kernel-progress-overlay {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.3);
        z-index: 1;
      }
      
      .kernel-progress-container {
        position: relative;
        z-index: 2;
        background: white;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        width: 100%;
        max-width: 500px;
        overflow: hidden;
      }
      
      .kernel-progress-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid #e0e0e0;
      }
      
      .kernel-progress-header h3 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
        color: #333;
      }
      
      .kernel-progress-close {
        background: none;
        border: none;
        font-size: 24px;
        cursor: pointer;
        color: #666;
        padding: 0;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        transition: background 0.2s;
      }
      
      .kernel-progress-close:hover {
        background: #f0f0f0;
      }
      
      .kernel-progress-body {
        padding: 20px;
      }
      
      .kernel-progress-message {
        font-size: 14px;
        color: #555;
        margin-bottom: 12px;
        min-height: 20px;
        word-wrap: break-word;
      }
      
      .kernel-progress-bar {
        width: 100%;
        height: 8px;
        border: none;
        border-radius: 4px;
        background: #e0e0e0;
        overflow: hidden;
      }
      
      .kernel-progress-bar::-webkit-progress-bar {
        background: #e0e0e0;
        border-radius: 4px;
      }
      
      .kernel-progress-bar::-webkit-progress-value {
        background: #2196f3;
        border-radius: 4px;
        transition: width 0.3s ease;
      }
      
      .kernel-progress-bar::-moz-progress-bar {
        background: #2196f3;
        border-radius: 4px;
        transition: width 0.3s ease;
      }
      
      .kernel-progress-percent {
        font-size: 12px;
        color: #999;
        margin-top: 8px;
        text-align: right;
      }
      
      .kernel-progress-footer {
        padding: 16px 20px;
        border-top: 1px solid #e0e0e0;
        text-align: right;
      }
      
      .kernel-progress-cancel-btn {
        background: #f44336;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        transition: background 0.2s;
      }
      
      .kernel-progress-cancel-btn:hover:not(:disabled) {
        background: #d32f2f;
      }
      
      .kernel-progress-cancel-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      
      .kernel-progress-error .kernel-progress-bar {
        background: #f44336;
      }
      
      .kernel-progress-error .kernel-progress-bar::-webkit-progress-value {
        background: #d32f2f;
      }
      
      .kernel-progress-error .kernel-progress-bar::-moz-progress-bar {
        background: #d32f2f;
      }
      
      .kernel-progress-error .kernel-progress-message {
        color: #d32f2f;
      }
    `;
    
    document.head.appendChild(style);
  }
}
```

### 2. Comm Extension Plugin

```typescript
// src/extension/index.ts

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import {
  INotebookTracker
} from '@jupyterlab/notebook';

import { ProgressDisplay } from './progress-widget';

/**
 * Progress communication extension
 * Handles bidirectional communication with kernel for progress updates and cancellation
 */
const commExtension: JupyterFrontEndPlugin<void> = {
  id: '@wiki3/kernel-progress-comm',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (
    app: JupyterFrontEnd,
    notebookTracker: INotebookTracker
  ) => {
    // Create progress display widget
    const progressDisplay = new ProgressDisplay();
    progressDisplay.attachTo(document.body);
    
    // When user clicks cancel, send message to kernel
    progressDisplay.onCancelRequested(() => {
      if (currentComm) {
        console.log('[Extension] Sending cancel to kernel');
        currentComm.send({
          type: 'cancel'
        });
      }
    });
    
    let currentComm: any = null;
    
    /**
     * Handle incoming Comm from kernel
     */
    const handleNewComm = (comm: any, msg: any) => {
      currentComm = comm;
      console.log('[Extension] Comm opened by kernel');
      
      // Show progress display
      progressDisplay.show();
      
      /**
       * Handle messages from kernel
       */
      const onMessage = (msg: any) => {
        const { data } = msg.content;
        
        if (data?.type === 'progress_update') {
          const { message, percent, status } = data;
          
          console.log(`[Extension] Progress: ${percent}% - ${message}`);
          
          // Update UI
          progressDisplay.updateProgress(message, percent, status);
          
          // Auto-hide when complete or error
          if (percent === 100 || percent === -1) {
            setTimeout(() => {
              progressDisplay.hide();
              if (percent === 100) {
                currentComm = null;
              }
            }, 2000);
          }
        }
      };
      
      comm.on_msg(onMessage);
    };
    
    /**
     * Register handler for kernel opening progress comm
     */
    const setupCommHandler = (sender: any, panel: any) => {
      const { sessionContext } = panel;
      
      if (!sessionContext || !sessionContext.session) {
        console.log('[Extension] No session context yet');
        return;
      }
      
      const kernel = sessionContext.session.kernel;
      
      if (!kernel) {
        console.log('[Extension] No kernel yet');
        sessionContext.kernelChanged?.connect(() => {
          setupCommHandler(sender, panel);
        });
        return;
      }
      
      // Register comm target for incoming comms from kernel
      kernel.registerCommTarget(
        'kernel-progress-comm',
        (comm: any, msg: any) => {
          handleNewComm(comm, msg);
        }
      );
      
      console.log('[Extension] Comm target registered');
    };
    
    // Set up for newly added notebooks
    notebookTracker.widgetAdded.connect(setupCommHandler);
    
    // Set up for existing notebooks
    notebookTracker.forEach((panel) => {
      setupCommHandler(notebookTracker, panel);
    });
  }
};

export default commExtension;
```

---

## Integration with Kernel Startup

### In your kernel initialization code:

```typescript
// In kernel boot sequence (e.g., src/kernel/index.ts)

import { federationLoader } from './federation';

// During kernel initialization:
async function initializeKernel() {
  // ... kernel setup ...
  
  // Start federation loading with progress + cancellation
  const success = await federationLoader.initialize([
    'gpt2-model',
    'embedding-model',
    'tokenizer-model'
  ]);
  
  if (!success) {
    console.log('Kernel initialization was cancelled by user');
    // Handle cancelled state - may retry
    return;
  }
  
  console.log('Kernel ready!');
  // ... rest of kernel setup ...
}
```

---

## Message Protocol

### Kernel → Frontend (IOPub)

```json
{
  "type": "progress_update",
  "message": "Downloading model-1...",
  "percent": 45,
  "status": "loading",
  "timestamp": 1702599999000
}
```

Percent values:
- `0-100`: Progress percentage
- `-1`: Error or cancelled

Status values:
- `"loading"`: In progress
- `"complete"`: Finished successfully
- `"error"`: Failed
- `"cancelled"`: User cancelled

### Frontend → Kernel (Comm)

```json
{
  "type": "cancel"
}
```

---

## Why This Solves Your Problems

### ✅ Progress Indication
- Modal overlay shows clear progress bar
- Real-time percentage and message updates
- Visual feedback for each stage

### ✅ Cancellation Support
- User clicks "Cancel Operation" button
- Frontend sends message to kernel via Comm
- Kernel stops gracefully using `AbortController`
- `checkCancelled()` throws at safe points
- Frontend hides modal after cancellation

### ✅ Workaround for Interrupt Issues
Instead of relying on kernel interrupt/stop (which you said isn't working):
- Cancellation happens **from user action → frontend → kernel**
- Kernel can handle it properly (no shell protocol issues)
- Clean shutdown without forcing interrupts
- Can retry/reinitialize if needed

### ✅ No User Code Required
- All Python/TypeScript in kernel extension
- Frontend extension auto-activates
- Users just see progress modal

### ✅ Graceful Error Handling
```typescript
// In federation.ts
try {
  await loadFederation();
} catch (error) {
  if (error.name === 'AbortError') {
    // User cancelled
    this.sendProgress('Cancelled', -1, 'cancelled');
  } else {
    // Real error
    this.sendProgress(`Error: ${error.message}`, -1, 'error');
  }
}
```

---

## Testing the Implementation

### Test Cancellation

1. Start kernel initialization
2. Wait for progress to appear
3. Click "Cancel Operation" button
4. Observe:
   - Button becomes disabled
   - Message changes to "Cancelled"
   - Progress bar goes red
   - Modal closes after 2 seconds

### Test Progress Updates

In your `federation.ts`, add debug logging:
```typescript
this.sendProgress('Stage 1', 25);
await delay(1000);
this.sendProgress('Stage 2', 50);
await delay(1000);
this.sendProgress('Stage 3', 75);
```

### Browser Console

```javascript
// Watch Comm messages
const old = console.log;
console.log = function(...args) {
  if (args[0]?.includes?.('Progress')) {
    console.warn('[PROGRESS]', ...args);
  }
  old.apply(console, args);
};
```

---

## Advanced Features (Optional)

### Retry Logic After Cancellation

```typescript
async function initializeWithRetry(maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    federationLoader.reset(); // Reset state for retry
    
    const success = await federationLoader.initialize(models);
    if (success) {
      return true;
    }
    
    // User cancelled - allow them to retry
    console.log(`Initialization cancelled. Retry available.`);
    // Don't keep retrying automatically after cancel
    break;
  }
  
  return false;
}
```

### Per-Model Download Progress

The code already handles this with `getReader()` for chunked downloads. For each model, users see:
```
Downloading model-1 (0%)
Downloading model-1 (25%)
Downloading model-1 (50%)
Downloading model-1 (75%)
Downloading model-1 (100%)
Downloading model-2 (0%)
...
```

### Persistent State Across Attempts

If user cancels and wants to retry with partial downloads:
```typescript
private downloadedModels = new Set<string>();

async downloadModels(modelList: string[]) {
  for (const model of modelList) {
    if (this.downloadedModels.has(model)) {
      continue; // Skip already downloaded
    }
    // Download logic
    this.downloadedModels.add(model);
  }
}
```

---

## Reference

- [Jupyter Comms Protocol](https://jupyter-client.readthedocs.io/en/stable/messaging.html#comm-messages)
- [AbortController MDN](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
- [Fetch API with Signal](https://developer.mozilla.org/en-US/docs/Web/API/fetch#signal)
- [JupyterLab Extension Development](https://jupyterlab.readthedocs.io/en/latest/extension/extension_dev.html)

---

## Next Steps

1. **Integrate federation.ts code** - Add `CancellableFederationLoader` class
2. **Add extension code** - Implement Comm listener + progress UI
3. **Test cancellation** - Verify AbortController stops downloads
4. **Handle retries** - Add retry logic if needed
5. **Production polish** - Add error recovery, logging, analytics

This approach gives you **full control** over the initialization flow and fixes the interrupt/stop issues by using **explicit cancellation signals** rather than relying on kernel interrupt mechanisms.
