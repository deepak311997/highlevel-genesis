import { fileURLToPath, URL } from 'node:url'
import { loadEnv } from 'vite'
// defineConfig comes from vitest/config so the `test` block is typed.
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// Must match setGlobalOptions() in functions/src/index.ts.
const FUNCTIONS_REGION = 'asia-south1'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/**
 * Config for `--mode emulator`, supplied here rather than in a .env file.
 *
 * None of it is secret — it identifies a throwaway demo project — but `.env.*`
 * is deliberately gitignored with a broad glob, so a committed `.env.emulator`
 * is not available. Baking the values in keeps the e2e suite runnable from a
 * fresh clone with no setup, which is the whole point of the emulator path.
 */
const EMULATOR_ENV: Record<string, string> = {
  VITE_FIREBASE_API_KEY: 'fake-api-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'demo-genesis.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'demo-genesis',
  VITE_FIREBASE_DATABASE_ID: 'hl-genesis',
  // Blank: requests stay same-origin and go through the proxy below, exactly
  // as the Hosting rewrite does in production.
  VITE_FUNCTIONS_BASE_URL: '',
  // The suites move the emulators to a second port set so they do not have to
  // stop a development session; the SPA has to follow them there.
  VITE_AUTH_EMULATOR_PORT: process.env['AUTH_EMULATOR_PORT'] ?? '9099',
  VITE_FIRESTORE_EMULATOR_PORT: process.env['FIRESTORE_EMULATOR_PORT_CLIENT'] ?? '8080',
}

/**
 * Where the emulated `api` function lives.
 *
 * The port is configurable because the test suites run the emulators on a
 * second set, so they do not have to stop a development session first.
 */
const EMULATOR_FUNCTIONS_PORT = process.env['FUNCTIONS_EMULATOR_PORT'] ?? '5001'
const EMULATOR_FUNCTIONS_TARGET = `http://127.0.0.1:${EMULATOR_FUNCTIONS_PORT}/demo-genesis/asia-south1`

export default defineConfig(({ mode }) => {
  // .env sits next to this file, which is where Vite looks by default.
  const env = mode === 'emulator' ? EMULATOR_ENV : loadEnv(mode, HERE, '')

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
    mode === 'emulator'
      ? EMULATOR_FUNCTIONS_TARGET
      : override !== undefined && override !== ''
        ? override
        : `https://${FUNCTIONS_REGION}-${projectId ?? ''}.cloudfunctions.net`

  // In emulator mode the values above have to reach the *app*, not just this
  // config. Vite only injects import.meta.env from .env files it loads itself,
  // and .env.* is gitignored, so they are substituted statically instead.
  const define =
    mode === 'emulator'
      ? Object.fromEntries(
          Object.entries(EMULATOR_ENV).map(([key, value]) => [
            `import.meta.env.${key}`,
            JSON.stringify(value),
          ]),
        )
      : {}

  return {
    plugins: [vue(), tailwindcss()],
    define,
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      // Also configurable, so a Playwright run and `npm run dev` can coexist.
      port: Number(process.env['E2E_PORT'] ?? '5173'),
      /*
       * Tunnel hostnames, for checking the integration against live HighLevel.
       *
       * HighLevel requires an HTTPS redirect URI, so the only way to run the
       * real OAuth flow against a local build is through a tunnel — and Vite
       * rejects requests whose Host header it does not recognise, answering
       * "Blocked request" before the app is even reached. Listing the common
       * tunnel suffixes here means that failure never happens; the tunnel is
       * still opt-in, selected in functions/.env.local.
       */
      allowedHosts: [
        '.ngrok-free.dev',
        '.ngrok-free.app',
        '.ngrok.io',
        '.trycloudflare.com',
        '.loca.lt',
      ],
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
