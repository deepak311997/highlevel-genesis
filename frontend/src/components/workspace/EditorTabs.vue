<script setup lang="ts">
import { X } from 'lucide-vue-next'

import { useWorkspaceStore } from '@/stores/workspace'

/**
 * The open files, as a strip of tabs (D12, D13).
 *
 * **Hand-rolled rather than the vendored `Tabs`**, for two structural reasons
 * rather than a stylistic one. A closable tab cannot be a single `TabsTrigger`
 * without nesting a `<button>` inside a `<button>` — invalid HTML, and the inner
 * one is unreachable by keyboard. And all tabs share **one** Monaco instance, so
 * there is no per-tab `TabsContent` for reka-ui's `Tabs` to switch between; the
 * root would be managing panels that do not exist. The brief's "tabs"
 * requirement is discharged elsewhere anyway, by the shadcn `Tabs` in the narrow
 * workspace layout (Slice 4), which this does not touch.
 *
 * So the close control is a **sibling** of its tab, not a child: closing a file
 * must not also open it, which is exactly what a nested control does by
 * bubbling.
 *
 * It reflects the store and decides nothing. Which tab is active, which are
 * dirty, and what closing one does are all `stores/workspace.ts`'s, with their
 * own tests.
 */
const workspace = useWorkspaceStore()
</script>

<template>
  <!-- No tab open is no strip at all, rather than an empty bordered box:
       `FileEditor` already renders the panel's own empty state underneath. -->
  <div
    v-if="workspace.openTabs.length > 0"
    role="tablist"
    data-testid="editor-tabs"
    class="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border px-2"
  >
    <div
      v-for="path in workspace.openTabs"
      :key="path"
      class="flex shrink-0 items-center gap-1 rounded-t-md border-b-2 pr-1"
      :class="
        path === workspace.selectedPath
          ? 'border-primary bg-secondary'
          : 'border-transparent hover:bg-secondary/60'
      "
    >
      <button
        type="button"
        role="tab"
        data-testid="editor-tab"
        :data-path="path"
        :aria-selected="path === workspace.selectedPath"
        :data-dirty="String(workspace.dirtyPaths.includes(path))"
        class="max-w-40 truncate py-1.5 pl-2 text-left text-xs"
        :class="path === workspace.selectedPath ? 'font-medium' : 'text-muted-foreground'"
        @click="workspace.selectFile(path)"
      >
        {{ path }}
        <!-- The dot is the whole of "you have unsaved work here" for a tab you
             are not looking at, so it is text as well as a mark — real text,
             hidden from sight rather than from the accessibility tree. An
             `aria-label` on the bullet would have named nothing: ARIA forbids an
             accessible name on a generic element, so it is dropped and the tab
             would announce the character, or silence. -->
        <template v-if="workspace.dirtyPaths.includes(path)">
          <span class="ml-1 text-primary" aria-hidden="true">•</span>
          <span class="sr-only">Unsaved changes</span>
        </template>
      </button>

      <!-- A sibling, not a child (D13). -->
      <button
        type="button"
        data-testid="editor-tab-close"
        :data-path="path"
        :aria-label="`Close ${path}`"
        class="rounded-sm p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
        @click="workspace.closeTab(path)"
      >
        <X class="size-3" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
