<script setup lang="ts">
import { X } from 'lucide-vue-next'
import { nextTick, ref, watch } from 'vue'

import FileIcon from '@/components/workspace/FileIcon.vue'
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
 * Three things the strip does that a plain row of buttons does not:
 *
 * **The active tab is drawn as part of the editor, not as a chip above it** — it
 * takes the editor's own ground, loses the bottom hairline the strip carries,
 * and gets a blue rule along its top edge. The panel is narrow and the tab is
 * the only thing that names the file on screen, so "which file am I editing" has
 * to survive a glance.
 *
 * **The close control is where the dirty dot is** (VS Code's arrangement, and
 * for its reason). One slot, not two: the dot says "unsaved" while the pointer
 * is elsewhere, and becomes the ✕ the moment the tab is hovered or focused. Two
 * permanent controls per tab is what made the old strip unreadable at four open
 * files. The swap is CSS — the button, its label and its focus order are
 * unchanged, so nothing here is hover-only for a keyboard.
 *
 * **The active tab is scrolled into view.** Twenty files may be open and
 * `selectFile` is reachable from the tree, so the tab that just became active is
 * routinely off-screen.
 *
 * It reflects the store and decides nothing else. Which tab is active, which are
 * dirty, and what closing one does are all `stores/workspace.ts`'s, with their
 * own tests.
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
      <!-- The one place the blue is spent here: it marks the active tab's edge
           against the editor it belongs to. A hairline rather than a fill, which
           is the language's device. -->
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
        <!-- The dot is the whole of "you have unsaved work here" for a tab you
             are not looking at, so it is text as well as a mark — real text,
             hidden from sight rather than from the accessibility tree. The mark
             itself lives in the close control beside this, where it is decorative
             and cannot be given a name: ARIA forbids an accessible name on a
             generic element, so the tab would have announced the character, or
             silence. -->
        <span v-if="workspace.dirtyPaths.includes(path)" class="sr-only">Unsaved changes</span>
      </button>

      <!-- A sibling, not a child (D13). It holds both marks, and CSS decides
           which one is showing — see the header. -->
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
