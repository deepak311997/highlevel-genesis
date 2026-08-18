import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { registerSessionExpiredHook } from './lib/apiClient'
import { createSessionExpiredHook } from './lib/sessionExpiry'
import { useAuthStore } from './stores/auth'
import './style.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)

/**
 * The one place that knows about both the router and the auth store (D10).
 *
 * That is why `apiClient` takes a callback instead of importing them itself: it
 * sits below both, so reaching up would be a cycle — and would make every typed
 * client's unit test need a Pinia instance to exercise a fetch. Here, at
 * assembly, all three are already to hand.
 *
 * `useAuthStore()` is called lazily inside each closure. Pinia is installed by
 * the line above, so there is an active instance, but resolving the store
 * eagerly would build it before the app has finished booting.
 */
registerSessionExpiredHook(
  createSessionExpiredHook({
    isSignedIn: () => useAuthStore().isSignedIn,
    currentPath: () => router.currentRoute.value.fullPath,
    signOut: () => useAuthStore().signOutNow(),
    replace: async (path) => {
      await router.replace(path)
    },
  }),
)

app.mount('#app')
