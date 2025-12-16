/**
 * Integration tests for AI SDK Chat Kernel MCP features.
 * 
 * These tests run against a live JupyterLite instance in a headless browser.
 * They verify the full MCP tool workflow including:
 * - Kernel initialization
 * - MCP tool enabling/disabling via %chat commands
 * - Tool execution by AI models
 */

import { test, expect, Page } from '@playwright/test';

// Increase timeout for notebook operations
test.setTimeout(120000);

/**
 * Helper to wait for JupyterLite to fully load
 */
async function waitForJupyterLite(page: Page) {
  // Wait for the JupyterLab shell to be ready
  await page.waitForSelector('.jp-LabShell', { timeout: 60000 });
  
  // Wait for any loading indicators to disappear
  await page.waitForFunction(() => {
    const spinners = document.querySelectorAll('.jp-Spinner');
    return spinners.length === 0;
  }, { timeout: 30000 });
}

/**
 * Helper to create a new notebook with AI SDK kernel
 */
async function createNotebookWithAIKernel(page: Page) {
  // Click File menu
  await page.click('text=File');
  
  // Click New > Notebook
  await page.click('text=New');
  await page.click('text=Notebook');
  
  // Wait for kernel selection dialog
  await page.waitForSelector('.jp-Dialog', { timeout: 10000 });
  
  // Select AI SDK Chat kernel
  const kernelOption = page.locator('text=AI SDK Chat');
  if (await kernelOption.isVisible()) {
    await kernelOption.click();
    await page.click('button:has-text("Select")');
  } else {
    // Close dialog and try via launcher
    await page.click('button:has-text("Cancel")');
    throw new Error('AI SDK Chat kernel not found in kernel selection');
  }
  
  // Wait for notebook to be ready
  await page.waitForSelector('.jp-Notebook', { timeout: 10000 });
}

/**
 * Helper to execute a cell and wait for output
 */
async function executeCell(page: Page, code: string) {
  // Find the active cell or first cell
  const cell = page.locator('.jp-Cell.jp-mod-active .jp-InputArea-editor');
  await cell.click();
  
  // Clear and type code
  await page.keyboard.press('Control+a');
  await page.keyboard.type(code);
  
  // Execute cell
  await page.keyboard.press('Shift+Enter');
  
  // Wait for cell to finish executing (kernel idle)
  await page.waitForSelector('.jp-Notebook-ExecutionIndicator:not(.jp-mod-busy)', { 
    timeout: 60000 
  }).catch(() => {
    // Alternative: wait for output area
  });
  
  // Small delay to ensure output is rendered
  await page.waitForTimeout(1000);
}

/**
 * Helper to get cell output text
 */
async function getCellOutput(page: Page, cellIndex: number = 0): Promise<string> {
  const outputs = page.locator('.jp-OutputArea-output');
  const output = outputs.nth(cellIndex);
  
  if (await output.isVisible()) {
    return await output.innerText();
  }
  return '';
}

test.describe('AI SDK Chat Kernel MCP Integration', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to JupyterLite
    await page.goto('/lab');
    await waitForJupyterLite(page);
  });

  test('should load JupyterLite successfully', async ({ page }) => {
    // Verify main JupyterLab UI is present
    await expect(page.locator('.jp-LabShell')).toBeVisible();
    await expect(page.locator('#jp-main-dock-panel')).toBeVisible();
  });

  test('should have AI SDK Chat kernel available', async ({ page }) => {
    // Open launcher
    await page.click('[data-command="launcher:create"]');
    
    // Wait for launcher
    await page.waitForSelector('.jp-Launcher', { timeout: 10000 });
    
    // Look for AI SDK kernel card
    const kernelCard = page.locator('.jp-LauncherCard:has-text("AI SDK")');
    await expect(kernelCard).toBeVisible({ timeout: 10000 });
  });

  test.describe('MCP Commands', () => {
    test.beforeEach(async ({ page }) => {
      await createNotebookWithAIKernel(page);
    });

    test('should show help with %chat help', async ({ page }) => {
      await executeCell(page, '%chat help');
      
      const output = await getCellOutput(page);
      expect(output).toContain('AI SDK Chat Kernel');
      expect(output).toContain('%chat mcp');
    });

    test('should list MCP tools with %chat mcp', async ({ page }) => {
      await executeCell(page, '%chat mcp');
      
      const output = await getCellOutput(page);
      expect(output).toContain('MCP Tool Management');
      expect(output).toContain('wiki-query');
    });

    test('should enable wiki-query tools', async ({ page }) => {
      await executeCell(page, '%chat mcp enable wiki-query');
      
      const output = await getCellOutput(page);
      expect(output).toContain('Enabled');
      expect(output).toContain('wiki-query');
    });

    test('should show enabled status after enabling', async ({ page }) => {
      // Enable first
      await executeCell(page, '%chat mcp enable wiki-query');
      
      // Add new cell
      await page.keyboard.press('b'); // Insert cell below
      
      // Check status
      await executeCell(page, '%chat mcp status');
      
      const output = await getCellOutput(page, 1);
      expect(output).toContain('wiki-query');
      expect(output).toContain('discover_wiki_source');
      expect(output).toContain('get_wiki_content');
    });

    test('should disable wiki-query tools', async ({ page }) => {
      // Enable first
      await executeCell(page, '%chat mcp enable wiki-query');
      
      // Add new cell
      await page.keyboard.press('b');
      
      // Disable
      await executeCell(page, '%chat mcp disable wiki-query');
      
      const output = await getCellOutput(page, 1);
      expect(output).toContain('Disabled');
    });

    test('should list available tool packs', async ({ page }) => {
      await executeCell(page, '%chat mcp list');
      
      const output = await getCellOutput(page);
      expect(output).toContain('wiki-query');
      expect(output).toContain('Wikipedia');
    });
  });
});

test.describe('Wiki Query Tool Execution', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate and create notebook
    await page.goto('/lab');
    await waitForJupyterLite(page);
    await createNotebookWithAIKernel(page);
    
    // Enable wiki-query tools
    await executeCell(page, '%chat mcp enable wiki-query');
  });

  // Note: These tests require a working AI provider
  // They may be skipped in CI without provider credentials
  test.skip('should use wiki tools when asking about Wikipedia content', async ({ page }) => {
    // This test requires an AI provider to be configured
    // Skip if no provider is available
    
    // Configure provider (would need API key)
    // await executeCell(page, '%chat provider openai --key');
    
    // Ask about Wikipedia content
    await page.keyboard.press('b');
    await executeCell(page, 'What is the first paragraph of the Wikipedia article about Python programming language?');
    
    // Check that tool was called
    const output = await getCellOutput(page, 1);
    expect(output).toContain('Python');
  });
});

test.describe('Error Handling', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/lab');
    await waitForJupyterLite(page);
    await createNotebookWithAIKernel(page);
  });

  test('should handle unknown MCP pack gracefully', async ({ page }) => {
    await executeCell(page, '%chat mcp enable unknown-pack');
    
    const output = await getCellOutput(page);
    expect(output).toContain('Unknown');
  });

  test('should handle disabling non-enabled pack', async ({ page }) => {
    await executeCell(page, '%chat mcp disable wiki-query');
    
    const output = await getCellOutput(page);
    expect(output).toContain('not enabled');
  });
});
