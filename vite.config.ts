import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// https://vite.dev/config/
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Single source of truth for the version the app reports (and that the MCP
  // `get_app_state` tool hands to agents).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // Tauri drives the dev server; fail loudly rather than silently picking
  // another port, which would leave the shell pointing at nothing.
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/tests/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
