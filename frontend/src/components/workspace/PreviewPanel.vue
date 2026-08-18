<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { usePreviewStore } from '@/stores/preview'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * The generated app, running — the first time anything in this product executes a
 * line of what the model wrote.
 *
 * **The sandbox is the whole security boundary.** `allow-scripts` is the point and
 * `allow-forms` is there because a lead-capture form is one of the app shapes the
 * system prompt names. **`allow-same-origin` is deliberately absent**: with it the
 * frame would share our origin, read the Firebase session out of IndexedDB and call
 * the API as the user. `allow-modals`, `allow-popups` and `allow-top-navigation`
 * are absent because each is a way for generated code to take over the tab.
 *
 * The corollary is that the frame cannot reach HighLevel by itself, so it asks, and
 * this component's `message` listener is where the asking arrives. **No credential
 * crosses the boundary**: the request is made here, and only the response body goes
 * back.
 *
 * **Every brokered failure renders here rather than in the app.** The generated
 * app's own `try`/`catch` is model output and cannot be relied on, so the guarantee
 * that a HighLevel failure is visible belongs to the host.
 */
const workspace = useWorkspaceStore()
const preview = usePreviewStore()

const frame = useTemplateRef<HTMLIFrameElement>('frame')

/**
 * Installed on `window`, because that is where a frame's `postMessage` to its
 * parent lands — there is no per-iframe event to listen to. Which is exactly why
 * the identity check matters: any frame on the page can post here, and the store
 * answers only when the source and the nonce are both this build's.
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
 * Shared by the header's Refresh, the stale hint's, and the error state's Try again
 * — one rebuild, three doors.
 *
 * The one branch: when the *file list* is what failed there is nothing to rebuild
 * from, so it asks the workspace for the list instead. Rebuilding regardless would
 * re-read an empty list and announce that a project with twenty files has no app.
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
      <h2 class="label-micro">Preview</h2>

      <!-- Withheld during a generation: the files are being rewritten as we speak,
           so a rebuild would preview a half-written app — and every rebuild spends
           the CRM account's rate-limit budget. -->
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

    <!-- The assembler's own sentences, rendered as written: each already names the
         file and says what happened to it. -->
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

    <!-- `idle` is folded into the loading state: before the file list arrives there
         is nothing yet to call empty. -->
    <div
      v-if="preview.state === 'idle' || preview.state === 'loading'"
      class="flex flex-1 items-center justify-center p-6"
      data-testid="preview-loading"
    >
      <Skeleton class="h-40 w-full max-w-sm rounded-md" />
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
         problems. -->
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
      renavigating it: the previous document's `WindowProxy` is then gone as well as
      out-of-nonce. `sandbox` is a **static** attribute, which is what keeps
      `allow-same-origin` out of reach of a future refactor.
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
