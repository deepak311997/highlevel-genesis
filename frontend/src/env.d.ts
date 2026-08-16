/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AUTH_EMULATOR_PORT: string
  readonly VITE_FIRESTORE_EMULATOR_PORT: string
  readonly VITE_FIREBASE_API_KEY?: string
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string
  readonly VITE_FIREBASE_PROJECT_ID?: string
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string
  readonly VITE_FIREBASE_APP_ID?: string
  readonly VITE_FIREBASE_DATABASE_ID?: string
  readonly VITE_FUNCTIONS_BASE_URL?: string
  /**
   * reCAPTCHA v3 **site** key for App Check. Public by design — it ships in the
   * bundle. The matching secret key must never appear in this file; anything
   * prefixed VITE_ is compiled into assets any visitor can read.
   */
  readonly VITE_GOOGLE_RECAPTCHA_V3_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
