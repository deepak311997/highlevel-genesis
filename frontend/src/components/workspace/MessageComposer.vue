<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { MESSAGE_LIMIT } from '@/lib/messagesApi'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * The chat input.
 *
 * **The draft is the store's, not this component's** (D17, R8). At the `lg`
 * breakpoint the workspace swaps one component tree for another — resizable panels
 * above it, tabs below — so this component unmounts and a second copy of it mounts
 * on the other side. A draft held in local state is eaten by a window resize:
 * invisible in review, infuriating in use. Binding straight to the store means
 * crossing the breakpoint mid-sentence costs nothing.
 *
 * **Enter sends, Shift+Enter inserts a newline** (D21). "Build a contact dashboard
 * with search and a list of upcoming appointments" is not a single-line prompt, so
 * the multi-line case has to be reachable — and every other modifier is left alone
 * rather than treated as a send, because each one is a different intent.
 *
 * The at-limit state **says why it is disabled** (AC-32, D10): the cap is a product
 * limit stated out loud, and a dead button with no explanation is exactly what that
 * decision rules out.
 */
const workspace = useWorkspaceStore()

function submit(): void {
  // Guarded here as well as by the `disabled` attribute: a keyboard shortcut
  // reaches this function without going through the button.
  if (!workspace.canSend) return
  void workspace.send()
}
</script>

<template>
  <div class="flex flex-col gap-2 border-t border-border p-3">
    <Alert v-if="workspace.sendError" variant="destructive" data-testid="composer-error">
      <AlertDescription>{{ workspace.sendError }}</AlertDescription>
    </Alert>

    <p v-if="workspace.atLimit" data-testid="composer-limit" class="text-sm text-muted-foreground">
      This project has reached its limit of {{ MESSAGE_LIMIT }} messages.
    </p>

    <Textarea
      v-model="workspace.draft"
      data-testid="composer-input"
      class="min-h-16 resize-none"
      :disabled="workspace.atLimit || workspace.sending"
      placeholder="Describe the app you want…"
      aria-label="Message"
      @keydown.enter.exact.prevent="submit()"
    />

    <div class="flex justify-end">
      <Button
        size="sm"
        data-testid="composer-submit"
        :disabled="!workspace.canSend"
        @click="submit()"
      >
        {{ workspace.sending ? 'Sending…' : 'Send' }}
      </Button>
    </div>
  </div>
</template>
