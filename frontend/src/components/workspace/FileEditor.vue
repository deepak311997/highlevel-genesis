<script setup lang="ts">
import { computed } from 'vue'

import CodeEditor from '@/components/workspace/CodeEditor.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { utf8Bytes } from '@/lib/files'
import { FILE_BYTES_MAX } from '@/lib/filesApi'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * One file, editable — **Monaco since Slice 7, and the widget was the whole of
 * the change.**
 *
 * Slice 6's header said the swap "touches `FileEditor.vue` and nothing here",
 * and this file is where that claim was cashed. Every rule lives in the store —
 * the byte count, the cap, the disabled states, the read-only guard — so the
 * diff was `<Textarea>` out, `<CodeEditor>` in, plus the **Try again** the tab
 * model made possible. Its spec is the record: all but two cases are byte-for-
 * byte Slice 6's, and they pass over a completely different editor.
 *
 * **The buffer is the store's, not this component's**, the same reason the
 * composer's draft is (Slice 4's D17): the `lg` breakpoint swaps one component
 * tree for another, so anything held locally is eaten by a window resize. It is
 * now a buffer *per tab* (D14), and the fields this reads are the active one's.
 *
 * **The editor's region is a flex column, and the editor fills it as a flex
 * item** — never by `height: 100%` (D19, R4). Measured in a browser: a
 * percentage height against a parent whose own height comes from `flex-grow`
 * does not resolve, and Monaco, which measures its container and has no
 * intrinsic height of its own, then renders a **5 px** editor with no error and
 * no failing test at any level below L5. The textarea this replaced hid the same
 * broken chain behind its own `min-h-40`.
 *
 * **Read-only while a stream is open** (D9, R4). A generation's batch and this
 * editor are two writers for one document, and the collision is silent — the user
 * types, the batch commits, the refetch replaces the buffer, and the edit is gone
 * with nothing to blame. The lock itself is Monaco's `readOnly` option now, set
 * by `CodeEditor`; what stays here is withholding **Save** and putting the reason
 * on screen, because a disabled control with no explanation is what this project
 * already rules out for the composer's message cap.
 */
const workspace = useWorkspaceStore()

/**
 * Bytes, because the cap is bytes.
 *
 * A character count would tell someone with a multi-byte file that they were
 * well inside a limit they had already passed, and then the server would refuse
 * a save the button had offered.
 */
const bytes = computed(() => utf8Bytes(workspace.editorContent))
const overCap = computed(() => bytes.value > FILE_BYTES_MAX)

/*
 * Three reasons to withhold Save, and the two that need explaining have it on
 * screen beside them. `fileDirty` is the third: an unchanged file has nothing to
 * store, and offering the request anyway would advance `updatedAt` for a
 * document nobody edited.
 */
const canSave = computed(
  () => workspace.fileDirty && !overCap.value && !workspace.saving && !workspace.generating,
)

function save(): void {
  // Guarded here as well as by `disabled`: a keyboard shortcut reaches this
  // function without going through the button.
  if (!canSave.value) return
  void workspace.saveFile()
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="file-editor">
    <!-- Nothing selected: the panel's own empty state, distinct from "no files". -->
    <div
      v-if="workspace.selectedPath === null"
      data-testid="file-editor-empty"
      class="flex flex-1 items-center justify-center p-6"
    >
      <p class="max-w-xs text-center text-sm text-muted-foreground">
        Select a file to read or edit it.
      </p>
    </div>

    <!-- A file that would not load has nothing to edit, so the editor goes.
         Its own testid: a read failure and a save failure are different states,
         and one selector matching both would let a test pass on the wrong one.

         The tab stays open (D12), which is what gives the retry somewhere to
         live — `reloadFile()` rather than `selectFile()`, because the tab is
         already open and selecting an already-buffered path issues nothing. -->
    <div
      v-else-if="workspace.fileError"
      data-testid="file-editor-read-error"
      class="flex flex-col gap-2 p-3"
    >
      <Alert variant="destructive">
        <AlertDescription>{{ workspace.fileError }}</AlertDescription>
      </Alert>
      <Button
        variant="outline"
        size="sm"
        data-testid="file-editor-retry"
        @click="workspace.reloadFile()"
      >
        Try again
      </Button>
    </div>

    <template v-else>
      <!-- D22. The server's content won; saying so is the whole decision, since
           the alternative that was rejected is silence, not a merge UI.

           Slice 11's D22 keeps that argument and takes the origin out of the
           copy: a **restore** now replaces buffers as well, through the same
           re-read and the same flag, so a notice that named the generation
           would be plainly wrong half the time it appeared. The wording states
           what the user can act on — a newer version is on screen, the unsaved
           edits are gone — and leaves *which* writer produced it to the history
           sheet, which is the surface that actually knows (P8). -->
      <div v-if="workspace.fileReplaced" data-testid="file-editor-replaced" class="px-3 pt-3">
        <Alert>
          <AlertDescription>
            Replaced by a newer version of this file. Your unsaved changes were discarded.
          </AlertDescription>
        </Alert>
      </div>

      <!-- A **flex column**, not a plain block, and the editor fills it as a flex
           item rather than by `height: 100%` — see the header (D19, R4). No
           padding: the editor's own gutter is its margin. `relative` is for the
           read's skeleton, which goes *over* the editor. -->
      <div class="relative flex min-h-0 flex-1 flex-col">
        <CodeEditor />

        <!-- A read in flight covers the editor rather than replacing it. A
             `v-else-if` here would unmount `CodeEditor` on every open of a file
             this session has not read — and on the re-read every generation ends
             with — taking the Monaco instance and the whole model registry with
             it: every *other* tab's undo history and scroll position, disposed
             for a fetch that has nothing to do with them. -->
        <div
          v-if="workspace.fileLoading"
          data-testid="file-editor-loading"
          class="absolute inset-0 bg-background p-3"
        >
          <div class="h-40 w-full animate-pulse rounded-md bg-secondary" />
        </div>
      </div>

      <!-- Withheld while the read is in flight: there is nothing to count yet,
           and a footer reading "0 bytes" over a file that is still arriving is a
           number that is wrong rather than absent. -->
      <div v-if="!workspace.fileLoading" class="flex flex-col gap-2 border-t border-border p-3">
        <Alert v-if="workspace.saveError" variant="destructive" data-testid="file-editor-error">
          <AlertDescription>{{ workspace.saveError }}</AlertDescription>
        </Alert>

        <!-- The reason the panel is frozen, for the seconds it is (D21). -->
        <p
          v-if="workspace.generating"
          data-testid="file-editor-readonly"
          class="text-xs text-muted-foreground"
        >
          Read-only while a reply is generating.
        </p>

        <div class="flex items-center justify-between gap-3">
          <p
            data-testid="file-editor-bytes"
            class="text-xs"
            :class="overCap ? 'text-destructive' : 'text-muted-foreground'"
          >
            {{ bytes.toLocaleString('en-US') }} bytes
            <template v-if="overCap">
              — too large to save, the limit is
              {{ FILE_BYTES_MAX.toLocaleString('en-US') }}
            </template>
          </p>

          <Button size="sm" data-testid="file-editor-save" :disabled="!canSave" @click="save()">
            {{ workspace.saving ? 'Saving…' : 'Save' }}
          </Button>
        </div>
      </div>
    </template>
  </div>
</template>
