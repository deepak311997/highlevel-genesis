<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { DEFAULT_REDIRECT } from '@/lib/redirect'
import { useHlStore } from '@/stores/hl'

/**
 * Where the OAuth callback lands the browser.
 *
 * The Cloud Function does the work — it exchanges the code and stores the
 * connection — and then 302s here with the outcome. This route exists so that
 * the dashboard never has to know about OAuth: it takes the outcome off the
 * URL, puts it in the store, refreshes the connection, and leaves.
 *
 * **`replace`, not `push`.** The callback URL carries a spent authorization
 * code; leaving it in history means the back button returns to something that
 * can only fail. Replacing drops it.
 *
 * There is no Continue button. A terminal screen would add a click to the happy
 * path and tell the user nothing they did not already know.
 */
const route = useRoute()
const router = useRouter()
const hl = useHlStore()

onMounted(async () => {
  const code = route.query['code']
  if (route.query['status'] === 'error') {
    hl.noteCallbackError(typeof code === 'string' && code !== '' ? code : 'exchange_failed')
  }

  // Refresh before navigating, so the dashboard renders the settled state
  // rather than flashing "Not connected" and correcting itself.
  await hl.refresh()
  await router.replace(DEFAULT_REDIRECT)
})
</script>

<template>
  <div class="flex min-h-[40vh] flex-col items-center justify-center gap-3">
    <div
      class="h-6 w-6 animate-spin rounded-full border-2 border-border-strong border-t-foreground"
      aria-hidden="true"
    />
    <p data-testid="hl-callback-status" class="text-sm text-muted-foreground">
      Finishing connection…
    </p>
  </div>
</template>
