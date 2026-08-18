<script setup lang="ts">
import { computed } from 'vue'

import CodeEditor from '@/components/workspace/CodeEditor.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { utf8Bytes } from '@/lib/files'
import { FILE_BYTES_MAX } from '@/lib/filesApi'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * One file, editable.
 *
 * Every rule lives in the store — the byte count, the cap, the disabled states,
 * the read-only guard — so this holds four states and a footer. **The buffer is
 * the store's**, per tab, for the composer draft's reason: the `lg` breakpoint
 * swaps one component tree for another, so anything held locally is eaten by a
 * window resize.
 *
 * **The editor's region is a flex column, and the editor fills it as a flex item**
 * — never by `height: 100%`. Measured: a percentage height against a parent sized
 * by `flex-grow` does not resolve, and Monaco then renders a 5 px editor with no
 * error and no failing test below L5.
 *
 * **Read-only while a stream is open.** A generation's batch and this editor are
 * two writers for one document, and the collision is silent. The lock is Monaco's
 * own option; what stays here is withholding **Save** and putting the reason on
 * screen, because a disabled control with no explanation is what this project
 * rules out elsewhere.
 */
const workspace = useWorkspaceStore()

/**
 * Bytes, because the cap is bytes. A character count would tell someone with a
 * multi-byte file that they were well inside a limit they had already passed, and
 * the server would then refuse a save the button had offered.
 */
const bytes = computed(() => utf8Bytes(workspace.editorContent))
const overCap = computed(() => bytes.value > FILE_BYTES_MAX)

/*
 * Three reasons to withhold Save, and the two that need explaining have it on
 * screen beside them. `fileDirty` is the third: an unchanged file has nothing to
 * store.
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

    <!-- A file that would not load has nothing to edit, so the editor goes. Its own
         testid, because a read failure and a save failure are different states. The
         tab stays open, which is what gives the retry somewhere to live —
         `reloadFile()`, since selecting an already-buffered path issues nothing. -->
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
      <!-- The server's content won, and saying so is the whole decision — the
           rejected alternative is silence, not a merge UI. Origin-neutral, because
           a restore replaces buffers through the same re-read and the same flag. -->
      <div v-if="workspace.fileReplaced" data-testid="file-editor-replaced" class="px-3 pt-3">
        <Alert>
          <AlertDescription>
            Replaced by a newer version of this file. Your unsaved changes were discarded.
          </AlertDescription>
        </Alert>
      </div>

      <!-- A flex column, not a plain block — see the header. No padding: the
           editor's own gutter is its margin. `relative` is for the read's
           skeleton, which goes *over* the editor. -->
      <div class="relative flex min-h-0 flex-1 flex-col">
        <CodeEditor />

        <!-- A read in flight covers the editor rather than replacing it: a
             `v-else-if` would unmount `CodeEditor` and take the Monaco instance and
             the whole model registry with it — every *other* tab's undo history and
             scroll position, disposed for a fetch unrelated to them. -->
        <div
          v-if="workspace.fileLoading"
          data-testid="file-editor-loading"
          class="absolute inset-0 bg-background p-3"
        >
          <Skeleton class="h-40 w-full rounded-md" />
        </div>
      </div>

      <!-- Withheld while the read is in flight: a footer reading "0 bytes" over a
           file that is still arriving is wrong rather than absent. -->
      <div v-if="!workspace.fileLoading" class="flex flex-col gap-2 border-t border-border p-3">
        <Alert v-if="workspace.saveError" variant="destructive" data-testid="file-editor-error">
          <AlertDescription>{{ workspace.saveError }}</AlertDescription>
        </Alert>

        <!-- The reason the panel is frozen, for the seconds it is. -->
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
