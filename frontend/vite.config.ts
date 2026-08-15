import { fileURLToPath, URL } from 'node:url'
import { loadEnv } from 'vite'
// defineConfig comes from vitest/config so the `test` block is typed.
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// Must match setGlobalOptions() in functions/src/index.ts.
const FUNCTIONS_REGION = 'asia-south1'

const HERE = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig(({ mode }) => {
  // .env sits next to this file, which is where Vite looks by default.
  const env = loadEnv(mode, HERE, '')

  // Where /api and /generate go in development.
  //
  // There is no emulator here: the app talks to real Firebase, so dev proxies
  // to the deployed functions and exercises the same path production does.
  // Derived from the project id rather than configured separately, so it
  // cannot drift; VITE_FUNCTIONS_BASE_URL overrides it if you need it to.
  //
  // Bracket access: loadEnv returns a Record, and noPropertyAccessFromIndexSignature
  // requires index-signature reads to look like index-signature reads. Blank is
  // treated as unset — `??` would accept an empty string as a real value.
  const override = env['VITE_FUNCTIONS_BASE_URL']?.trim()
  const projectId = env['VITE_FIREBASE_PROJECT_ID']?.trim()

  if (
    (override === undefined || override === '') &&
    (projectId === undefined || projectId === '')
  ) {
    throw new Error(
      'Cannot resolve the functions URL: set VITE_FIREBASE_PROJECT_ID (or ' +
        'VITE_FUNCTIONS_BASE_URL) in frontend/.env — see frontend/.env.example.',
    )
  }

  const functionsTarget =
    override !== undefined && override !== ''
      ? override
      : `https://${FUNCTIONS_REGION}-${projectId ?? ''}.cloudfunctions.net`

  return {
    plugins: [vue(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      // Mirror the production Hosting rewrites locally, so the SPA calls
      // same-origin relative paths in both environments. Without this, a
      // request to /api/health falls through to Vite's SPA handler and comes
      // back as index.html — which surfaces as "Unexpected token '<'".
      proxy: {
        '/api': { target: functionsTarget, changeOrigin: true },
        '/generate': { target: functionsTarget, changeOrigin: true },
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
  }
})
