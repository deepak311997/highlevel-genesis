<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { usePreviewStore } from '@/stores/preview'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * The generated app, running — **a real screen now** (D18's debt, paid), and the
 * first time anything in this product executes a line of what the model wrote.
 *
 * **The sandbox is the whole security boundary** (D9). `allow-scripts` is the
 * point and `allow-forms` is there because a lead-capture form is one of the
 * three app shapes the system prompt names. **`allow-same-origin` is deliberately
 * absent**: with it, the frame would share our origin, read the Firebase session
 * out of IndexedDB and call the API as the user — every property the design buys
 * would be handed straight back. `allow-modals`, `allow-popups` and
 * `allow-top-navigation` are absent because nothing a small CRM dashboard does
 * needs them, and each is a way for generated code to take over the tab.
 *
 * The corollary is that the frame cannot reach HighLevel by itself — an opaque
 * origin fails the API's allowlist and cannot attest App Check — so it asks, and
 * this component's `message` listener is where the asking arrives. **No
 * credential crosses the boundary** (D2): the request is made here, on the page
 * that already holds the session, and only the response body goes back.
 *
 * **Every brokered failure renders here rather than in the app** (D17). The
 * generated app's own `try`/`catch` is the one thing that cannot be relied on —
 * it is model output — so F8.3's guarantee that a HighLevel failure is visible
 * belongs to the host, which sees every one of them regardless. A duplicated
 * message is a small price against a blank panel with no explanation.
 *
 * **Slice 12 owns the styling of the three banners and the loading state.** They
 * are hand-rolled `Alert`s here because `sonner` and `skeleton` do not exist yet;
 * that slice's audit introduces both and should fold these in rather than leave
 * two idioms in the codebase.
 */
const workspace = useWorkspaceStore()
const preview = usePreviewStore()

const frame = useTemplateRef<HTMLIFrameElement>('frame')

/**
 * Installed on `window`, because that is where a frame's `postMessage` to its
 * parent lands — there is no per-iframe event to listen to.
 *
 * Which is exactly why the identity check matters: any frame on the page, and
 * anything that opened this one, can post here. The store hands the event and
 * *this* frame's `contentWindow` to the bridge, which answers only when the two
 * are the same object and the nonce is the current build's.
 */
function onMessage(event: MessageEvent): void {
  void preview.handleMessage(event, frame.value?.contentWindow ?? null)
}

onMounted(() => {
  window.addEventListener('message', onMessage)
})

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
})

/**
 * Shared by the header's Refresh, the stale hint's, and the error state's Try
 * again — one rebuild, three doors.
 *
 * The one branch: when the *file list* is what failed, there is nothing here to
 * rebuild from. This panel holds no paths and has no business fetching them, so
 * it asks the workspace for the list and the preview store builds as soon as it
 * lands. Rebuilding regardless would re-read an empty list and settle to the
 * empty state — announcing that a project with twenty files has no app yet.
 */
function rebuild(): void {
  if (workspace.generating) return
  if (!workspace.filesLoaded) void workspace.loadFiles()
  else void preview.build()
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" data-testid="preview-panel">
    <header class="flex shrink-0 items-center gap-3 px-4 py-3">
      <h2 class="text-sm font-semibold">Preview</h2>

      <!-- Withheld during a generation (AC-30): the files are being rewritten as
           we speak, so a rebuild from them would preview a half-written app — and
           every rebuild spends the CRM account's rate-limit budget. -->
      <Button
        class="ml-auto"
        variant="outline"
        size="sm"
        data-testid="preview-refresh"
        :disabled="workspace.generating"
        @click="rebuild()"
      >
        Refresh
      </Button>
    </header>

    <!-- The banners sit under the header rather than inside the frame: the frame
         is the app, and these are things the host has to say about it. -->
    <div v-if="preview.stale" class="px-4 pb-3" data-testid="preview-stale">
      <Alert class="flex items-center justify-between gap-3">
        <AlertDescription>Files changed — Refresh to run the latest.</AlertDescription>
        <Button
          variant="outline"
          size="sm"
          data-testid="preview-stale-refresh"
          :disabled="workspace.generating"
          @click="rebuild()"
        >
          Refresh
        </Button>
      </Alert>
    </div>

    <!-- The assembler's own sentences, rendered as written and not wrapped in a
         second one: each already names the file and says what happened to it. -->
    <div v-if="preview.warnings.length > 0" class="px-4 pb-3" data-testid="preview-warning">
      <Alert>
        <AlertDescription>
          <p v-for="warning in preview.warnings" :key="warning">{{ warning }}</p>
        </AlertDescription>
      </Alert>
    </div>

    <!-- F8.3, the half that had nowhere to render before this slice. -->
    <div v-if="preview.failure" class="px-4 pb-3" data-testid="preview-failure">
      <Alert variant="destructive">
        <AlertDescription>
          {{ preview.failure.message }}
          <RouterLink
            v-if="preview.reconnectable"
            to="/dashboard"
            class="ml-1 font-medium underline"
            data-testid="preview-reconnect"
          >
            Reconnect HighLevel
          </RouterLink>
        </AlertDescription>
      </Alert>
    </div>

    <div v-if="preview.runtimeError" class="px-4 pb-3" data-testid="preview-runtime-error">
      <Alert variant="destructive">
        <AlertDescription>{{ preview.runtimeError }}</AlertDescription>
      </Alert>
    </div>

    <!-- `idle` is folded into the loading state on purpose: before the file list
         arrives there is nothing yet to call empty, and a panel that said "no app
         yet" for the moment before its own data lands would be wrong out loud. -->
    <div
      v-if="preview.state === 'idle' || preview.state === 'loading'"
      class="flex flex-1 items-center justify-center p-6"
      data-testid="preview-loading"
    >
      <div class="h-40 w-full max-w-sm animate-pulse rounded-md bg-secondary" />
    </div>

    <div
      v-else-if="preview.state === 'error'"
      class="flex flex-col gap-2 p-4"
      data-testid="preview-error"
    >
      <Alert variant="destructive">
        <AlertDescription>{{ preview.error }}</AlertDescription>
      </Alert>
      <Button
        variant="outline"
        size="sm"
        data-testid="preview-retry"
        :disabled="workspace.generating"
        @click="rebuild()"
      >
        Try again
      </Button>
    </div>

    <!-- Two causes, one state, and a different sentence for each: "you have not
         asked for an app yet" and "what you have cannot be opened" are different
         problems with different next steps. -->
    <div
      v-else-if="preview.state === 'empty'"
      class="flex flex-1 items-center justify-center p-6"
      data-testid="preview-empty"
    >
      <p class="max-w-xs text-center text-sm text-muted-foreground">
        <template v-if="preview.emptyReason === 'no_entry_point'">
          This project has no <code>index.html</code>, so there is no page to open. Ask for one in
          the chat panel.
        </template>
        <template v-else>
          Describe the app you want in the chat panel. Once it is generated, it runs here against
          your CRM data.
        </template>
      </p>
    </div>

    <!--
      `:key` on the nonce, so a rebuild **replaces** the element rather than
      renavigating it. The previous document's `WindowProxy` is then gone as well
      as out-of-nonce, which closes the stale-document race twice (D3).

      `sandbox` is a **static** attribute — nothing can compute it, which is what
      keeps `allow-same-origin` out of reach of a future refactor.
    -->
    <iframe
      v-else
      ref="frame"
      :key="preview.nonce ?? ''"
      data-testid="preview-frame"
      title="App preview"
      sandbox="allow-scripts allow-forms"
      :srcdoc="preview.document ?? ''"
      class="h-full min-h-0 w-full flex-1 border-0 bg-white"
    />
  </section>
</template>
