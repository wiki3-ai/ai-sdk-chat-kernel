# AI SDK Chat Kernel Tests

This directory contains tests for the AI SDK Chat Kernel, including the MCP wiki-query feature.

## Test Types

### Unit Tests (`tests/unit/`)

Unit tests run in Node.js using [Vitest](https://vitest.dev/) and test individual functions in isolation.

**Files:**
- `wiki-query.test.ts` - Tests for wiki content parsing, caching, chunking, and RDF generation utilities
- `mcp-management.test.ts` - Tests for MCP tool pack management logic and command parsing

**Run unit tests:**
```bash
npm run test:unit

# Watch mode
npm run test:unit:watch
```

### Integration Tests (`tests/integration/`)

Integration tests run in a headless browser using [Playwright](https://playwright.dev/) against a live JupyterLite instance.

**Files:**
- `mcp-tools.spec.ts` - End-to-end tests for MCP tool enabling/disabling via `%chat` commands

**Prerequisites:**
1. Build JupyterLite with the kernel installed
2. Start a local server serving the JupyterLite site
3. Install Playwright browsers

```bash
# Install Playwright browsers (first time only)
npx playwright install chromium

# Install system dependencies (may require sudo)
npx playwright install-deps
```

**Run integration tests:**
```bash
# Start JupyterLite server first (in another terminal)
cd ../docs && python -m http.server 8000

# Run tests
npm run test:integration

# Run with browser visible
npm run test:integration:headed

# Run with Playwright UI mode
npm run test:integration:ui
```

## Test Configuration

### Vitest (`vitest.config.ts`)
- Tests in `tests/unit/**/*.test.ts`
- Node.js environment
- TypeScript type checking enabled

### Playwright (`playwright.config.ts`)
- Tests in `tests/integration/**/*.spec.ts`
- Chromium browser (headless by default)
- Base URL configurable via `JUPYTERLITE_URL` env var (default: `http://localhost:8000`)
- Screenshots and videos on failure

## Running All Tests

```bash
npm run test:all
```

## CI/CD Integration

For CI environments:

1. **Unit tests** run without any special setup
2. **Integration tests** require:
   - Playwright browsers installed (`npx playwright install`)
   - System dependencies (`npx playwright install-deps` or Docker image with deps)
   - JupyterLite site built and served

Example GitHub Actions workflow:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: npm ci
        working-directory: ai-sdk-chat-kernel
        
      - name: Run unit tests
        run: npm run test:unit
        working-directory: ai-sdk-chat-kernel
        
      - name: Install Playwright
        run: npx playwright install --with-deps chromium
        working-directory: ai-sdk-chat-kernel
        
      - name: Build JupyterLite
        run: jupyter lite build
        
      - name: Start server and run integration tests
        run: |
          python -m http.server 8000 --directory docs &
          sleep 5
          npm run test:integration
        working-directory: ai-sdk-chat-kernel
```

## Writing New Tests

### Unit Tests

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('MyFeature', () => {
  it('should do something', () => {
    expect(myFunction()).toBe(expectedValue);
  });
});
```

### Integration Tests

```typescript
import { test, expect } from '@playwright/test';

test('should work in JupyterLite', async ({ page }) => {
  await page.goto('/lab');
  await expect(page.locator('.jp-LabShell')).toBeVisible();
});
```

## Mocking Browser APIs

Since the wiki-query module uses browser-only APIs (`fetch`, `localStorage`, `DOMParser`), unit tests mock these:

```typescript
import { vi } from 'vitest';

// Mock localStorage
vi.stubGlobal('localStorage', {
  getItem: vi.fn(),
  setItem: vi.fn(),
  // ...
});

// Mock fetch
vi.stubGlobal('fetch', vi.fn());
```
