<script setup lang="ts">
import { X } from 'lucide-vue-next'
import { nextTick, ref, watch } from 'vue'

import FileIcon from '@/components/workspace/FileIcon.vue'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * The open files, as a strip of tabs.
 *
 * **Hand-rolled rather than the vendored `Tabs`**, for two structural reasons. A
 * closable tab cannot be a single `TabsTrigger` without nesting a `<button>` in a
 * `<button>` — invalid HTML, and the inner one is unreachable by keyboard. And all
 * tabs share **one** Monaco instance, so there is no per-tab content for the root
 * to switch between. The close control is therefore a **sibling** of its tab:
 * closing a file must not also open it, which is what a nested control does by
 * bubbling.
 *
 * **The active tab is drawn as part of the editor**, taking its ground and a blue
 * rule along the top edge — the panel is narrow and the tab is the only thing that
 * names the file on screen.
 *
 * **The close control is where the dirty dot is.** One slot, not two: the dot says
 * "unsaved" while the pointer is elsewhere and becomes the ✕ on hover or focus.
 * The swap is CSS, so the button, its label and its focus order are unchanged.
 *
 * **The active tab is scrolled into view**, since `selectFile` is reachable from
 * the tree and the tab that just became active is routinely off-screen.
 */
const workspace = useWorkspaceStore()

const strip = ref<HTMLElement | null>(null)

watch(
  () => workspace.selectedPath,
  async (path) => {
    if (path === null) return
    await nextTick()
    // `block: 'nearest'` so a strip that is already showing the tab does not
    // scroll the panel underneath it.
    strip.value
      ?.querySelector('[data-testid="editor-tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  },
)
</script>

<template>
  <!-- No tab open is no strip at all, rather than an empty bordered box:
       `FileEditor` already renders the panel's own empty state underneath. -->
  <div
    v-if="workspace.openTabs.length > 0"
    ref="strip"
    role="tablist"
    aria-label="Open files"
    data-testid="editor-tabs"
    class="flex shrink-0 items-stretch overflow-x-auto border-b border-border bg-muted/50"
  >
    <div
      v-for="path in workspace.openTabs"
      :key="path"
      class="group relative flex shrink-0 items-center border-r border-border"
      :class="path === workspace.selectedPath ? 'bg-background' : 'hover:bg-background/60'"
      @auxclick.middle.prevent="workspace.closeTab(path)"
    >
      <!-- The one place the blue is spent here, marking the active tab's edge
           against the editor it belongs to. -->
      <span
        v-if="path === workspace.selectedPath"
        class="absolute inset-x-0 top-0 h-0.5 bg-primary"
        aria-hidden="true"
      />

      <button
        type="button"
        role="tab"
        data-testid="editor-tab"
        :data-path="path"
        :aria-selected="path === workspace.selectedPath"
        :data-dirty="String(workspace.dirtyPaths.includes(path))"
        :title="path"
        class="flex max-w-44 items-center gap-1.5 py-2 pr-1 pl-2.5 text-left"
        :class="path === workspace.selectedPath ? 'text-foreground' : 'text-muted-foreground'"
        @click="workspace.selectFile(path)"
      >
        <FileIcon :path="path" class="size-3.5 opacity-80" />
        <span class="truncate font-mono text-xs">{{ path }}</span>
        <!-- "You have unsaved work here" as real text, hidden from sight rather
             than from the accessibility tree. The mark itself lives in the close
             control, where it is decorative: ARIA forbids an accessible name on a
             generic element, so a labelled bullet would announce nothing. -->
        <span v-if="workspace.dirtyPaths.includes(path)" class="sr-only">Unsaved changes</span>
      </button>

      <!-- A sibling, not a child. It holds both marks, and CSS decides which one is
           showing — see the header. -->
      <button
        type="button"
        data-testid="editor-tab-close"
        :data-path="path"
        :aria-label="`Close ${path}`"
        class="mr-1.5 grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
        @click="workspace.closeTab(path)"
      >
        <span
          v-if="workspace.dirtyPaths.includes(path)"
          data-testid="editor-tab-dirty"
          class="size-1.5 rounded-full bg-primary group-hover:hidden group-focus-within:hidden"
          aria-hidden="true"
        />
        <X
          class="size-3"
          :class="
            workspace.dirtyPaths.includes(path)
              ? 'hidden group-hover:block group-focus-within:block'
              : ''
          "
          aria-hidden="true"
        />
      </button>
    </div>
  </div>
</template>
