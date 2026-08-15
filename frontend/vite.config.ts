import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Mirror the production Hosting rewrites locally, so the SPA calls
    // same-origin relative paths in both environments. Without this, a request
    // to /api/health falls through to Vite's SPA handler and comes back as
    // index.html — which surfaces as "Unexpected token '<'".
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5001/demo-genesis/us-central1',
        changeOrigin: true,
      },
      '/generate': {
        target: 'http://127.0.0.1:5001/demo-genesis/us-central1',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,vue}'],
    },
  },
})
