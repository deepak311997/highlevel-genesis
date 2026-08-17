<script setup lang="ts">
import { computed } from 'vue'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { utf8Bytes } from '@/lib/files'
import { FILE_BYTES_MAX } from '@/lib/filesApi'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * One file, editable — a textarea in this slice, Monaco in Slice 7.
 *
 * That swap is why every rule lives in the store and none of it here: what
 * changes in Slice 7 is the widget, not when a save is allowed or what the
 * buffer is.
 *
 * **The buffer is the store's, not this component's**, the same reason the
 * composer's draft is (Slice 4's D17): the `lg` breakpoint swaps one component
 * tree for another, so anything held locally is eaten by a window resize.
 *
 * **Read-only while a stream is open** (D21, R4). A generation's batch and this
 * editor are two writers for one document, and the collision is silent — the user
 * types, the batch commits, the refetch replaces the buffer, and the edit is gone
 * with nothing to blame. The window is closed at its source, for the seconds it
 * exists, and the reason is on screen: a disabled control with no explanation is
 * what this project already rules out for the composer's message cap.
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

    <!-- A file that would not load has nothing to edit, so the textarea goes.
         Its own testid: a read failure and a save failure are different states,
         and one selector matching both would let a test pass on the wrong one. -->
    <div v-else-if="workspace.fileError" data-testid="file-editor-read-error" class="p-3">
      <Alert variant="destructive">
        <AlertDescription>{{ workspace.fileError }}</AlertDescription>
      </Alert>
    </div>

    <div v-else-if="workspace.fileLoading" data-testid="file-editor-loading" class="p-3">
      <div class="h-40 w-full animate-pulse rounded-md bg-secondary" />
    </div>

    <template v-else>
      <!-- D22. The server's content won; saying so is the whole decision, since
           the alternative that was rejected is silence, not a merge UI. -->
      <div v-if="workspace.fileReplaced" data-testid="file-editor-replaced" class="px-3 pt-3">
        <Alert>
          <AlertDescription>
            Replaced by the latest generation. Your unsaved changes to this file were discarded.
          </AlertDescription>
        </Alert>
      </div>

      <div class="min-h-0 flex-1 p-3">
        <Textarea
          :model-value="workspace.editorContent"
          data-testid="file-editor-input"
          class="h-full min-h-40 resize-none font-mono text-xs"
          spellcheck="false"
          :disabled="workspace.generating"
          :aria-label="workspace.selectedPath"
          @update:model-value="workspace.fileContent = String($event)"
        />
      </div>

      <div class="flex flex-col gap-2 border-t border-border p-3">
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
