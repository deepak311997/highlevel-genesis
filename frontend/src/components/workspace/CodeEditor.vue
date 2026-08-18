<script setup lang="ts">
import { VueMonacoEditor } from '@guolao/vue-monaco-editor'
import type { editor as monacoEditor } from 'monaco-editor'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useDarkClass } from '@/composables/useDarkClass'
import { editorEdit } from '@/lib/editorContent'
import { editorLanguage } from '@/lib/editorLanguage'
import {
  createModelRegistry,
  type EditorHost,
  type ModelRegistry,
  type MonacoModelApi,
} from '@/lib/editorModels'
// Names only — this module holds no monaco import, so referencing it here does
// not drag the editor chunk back in front of the dynamic import.
import { THEME_DARK, THEME_LIGHT } from '@/lib/editorTheme'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * Monaco — **the only place in the app that touches an editor instance**.
 *
 * Three things here cannot be inferred from the code, and each has cost someone
 * a day somewhere:
 *
 * **1. The instance lives in a `shallowRef`, and everything else Monaco hands us
 * lives in plain closure variables** (D6). `ref()` over an editor makes Vue walk
 * a very large third-party object graph on every property access. AC-28 asserts
 * the stored value is `===` the emitted one, which a deep reactive proxy is not —
 * so this is a test rather than a comment.
 *
 * **2. Streamed chunks are `applyEdits`, never `setValue`** (D8, P4, R1). The
 * whole decision is `lib/editorContent.ts`, with its own tests; what happens here
 * is turning its answer into a range. `setValue` would snap the viewport to line
 * 1 on every chunk, reset the undo stack, and re-tokenize the whole document each
 * time — and it would pass every test below L5.
 *
 * **3. `applying` is load-bearing, not defensive.** The wrapper emits
 * `update:value` on *every* content change including ours: its handler compares
 * the new text against `props.value`, which is `undefined` here because the prop
 * is deliberately unbound, so the comparison is never equal. Without the guard,
 * every streamed byte would be written back into the store and every generated
 * file would arrive dirty.
 *
 * A fourth, in `onBeforeUnmount`: the wrapper's own `onUnmounted` disposes
 * `editorRef.value.getModel()`, and the `lg` breakpoint unmounts this component
 * on a window resize — so the registry detaches the editor *before* the wrapper
 * gets there, or it would hand out a disposed model afterwards.
 *
 * The wrapper's `path`, `value` and `language` props are all left unbound (D7).
 * Bound, its watcher owns the models — keyed in monaco's *global* registry, so
 * two projects share one `index.html` — and drives the document with `setValue`
 * per change, which is hazard 2 by construction. What it still owns is what we
 * actually want from it: the loader, editor construction, the container, the
 * sizing and the theme.
 */

const workspace = useWorkspaceStore()

/**
 * The dynamic import's three states (D20).
 *
 * Monaco is roughly a megabyte gzipped and the sign-in page has no use for it, so
 * `lib/monacoSetup` is behind `import()` and lands in its own chunk. That is also
 * what earns this screen an honest loading state and an honest error state.
 */
const status = ref<'loading' | 'failed' | 'ready'>('loading')

/** `shallowRef`, for the same reason the editor is one: this is all of monaco. */
const monaco = shallowRef<MonacoModelApi | null>(null)

/** D6. Never `ref`, never `reactive` — AC-28 is the assertion. */
const editor = shallowRef<monacoEditor.IStandaloneCodeEditor | null>(null)

/** Not reactive either: nothing renders it, and it holds text models. */
let registry: ModelRegistry | null = null

/** See the header, hazard 3. A plain boolean, because the round trip is one tick. */
let applying = false

const dark = useDarkClass()

async function load(): Promise<void> {
  status.value = 'loading'
  try {
    const setup = await import('@/lib/monacoSetup')
    monaco.value = setup.monaco
    status.value = 'ready'
  } catch {
    // The message is ours rather than the browser's: "Failed to fetch
    // dynamically imported module" is not a sentence for a user.
    status.value = 'failed'
  }
}

onMounted(() => {
  void load()
})

/**
 * The skeleton covers both halves of the wait — the chunk arriving, and the
 * editor reporting itself — but not the failure, which is its own state.
 */
const showSkeleton = computed(
  () => status.value === 'loading' || (status.value === 'ready' && editor.value === null),
)

/**
 * A fresh object every time, because the wrapper's `options` watcher is
 * `deep: true` and calls `updateOptions` with whatever it is given.
 *
 * `readOnlyMessage` is set **always**, not only while generating: a message on an
 * editable editor is inert, and `exactOptionalPropertyTypes` makes a conditional
 * `undefined` an error rather than a shrug.
 */
const options = computed<monacoEditor.IStandaloneEditorConstructionOptions>(() => ({
  // D18's load-bearing one: the editor sits inside a `ResizablePanelGroup`, and
  // without this Monaco never re-measures when the splitter moves — the text
  // stays clipped at the old width, with no error attached.
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  tabSize: 2,
  wordWrap: 'on',
  fontFamily: 'var(--font-mono)',
  // D9, restated in the widget: a generation's batch and this editor are two
  // writers for one document, and the collision is silent.
  readOnly: workspace.generating,
  readOnlyMessage: { value: 'Read-only while a reply is generating.' },
}))

/** `IStandaloneCodeEditor` satisfies `EditorHost` structurally. */
function hostOf(instance: monacoEditor.IStandaloneCodeEditor): EditorHost {
  return instance
}

/** Put the active tab's model on the editor, or none if no tab is open. */
function activate(): void {
  const instance = editor.value
  if (instance === null || registry === null) return

  const path = workspace.selectedPath
  if (path === null) {
    instance.setModel(null)
    return
  }

  registry.activate(hostOf(instance), path, workspace.editorContent, editorLanguage(path))
}

/**
 * Bring the active model in line with what the store says the file is.
 *
 * The `null` edit is the common case and costs nothing: our own writes land back
 * here through the store, and the comparison terminates the round trip by itself.
 */
function syncModel(): void {
  const instance = editor.value
  const model = instance?.getModel() ?? null
  if (instance === null || model === null) return

  const edit = editorEdit(model.getValue(), workspace.editorContent)
  if (edit === null) return

  applying = true
  try {
    if (edit.kind === 'append') {
      // A zero-width range at the very end of the document, which is what makes
      // this O(delta) and leaves the cursor and scroll where they are.
      const line = model.getLineCount()
      const column = model.getLineMaxColumn(line)
      model.applyEdits([
        {
          range: {
            startLineNumber: line,
            startColumn: column,
            endLineNumber: line,
            endColumn: column,
          },
          text: edit.text,
        },
      ])
      // The view follows the tail — the whole of "tokens appear live" (D8).
      instance.revealLine(model.getLineCount())
    } else {
      model.applyEdits([{ range: model.getFullModelRange(), text: edit.text }])
    }
  } finally {
    applying = false
  }
}

function onMount(instance: monacoEditor.IStandaloneCodeEditor): void {
  editor.value = instance

  // The anonymous model the wrapper creates because `path` is unbound. Captured
  // before we swap ours in, and disposed after — left alive it leaks one model
  // per mount, and the breakpoint remounts this component on a window resize.
  const anonymous = instance.getModel()

  rebuildRegistry()
  anonymous?.dispose()
}

/** A registry belongs to one project; leaving disposes every model it made (D7). */
function rebuildRegistry(): void {
  const instance = editor.value
  registry?.disposeAll(instance)
  registry = null

  const resolved = monaco.value
  const id = workspace.projectId
  if (instance === null || resolved === null || id === null) return

  registry = createModelRegistry(resolved, id)
  activate()
  syncModel()
}

watch(() => workspace.projectId, rebuildRegistry)

/**
 * One watcher over both, rather than two.
 *
 * Separately, the content watcher could fire before the path watcher in a flush
 * and apply the *new* file's text to the *old* model — one file's bytes written
 * into another's document. Watching the pair makes that ordering a statement
 * rather than a coincidence.
 */
watch(
  () => [workspace.selectedPath, workspace.editorContent] as const,
  ([path], [previousPath]) => {
    if (path !== previousPath) activate()
    syncModel()
  },
)

function onUpdateValue(value: string): void {
  // See the header, hazard 3. Our own append comes back through here.
  if (applying) return
  workspace.editContent(value)
}

onBeforeUnmount(() => {
  // `disposeAll` sets the editor's model to `null` first, which is what keeps the
  // wrapper's own `onUnmounted` from disposing a model we still hold.
  registry?.disposeAll(editor.value)
  registry = null
})
</script>

<template>
  <!-- `flex-1` inside its parent's flex column, and a flex row itself, so no link
       in this chain is a percentage of a flex-sized box — which does not resolve,
       and leaves Monaco measuring a container with no height (D19, R4). The
       wrapper's own `height: 100%` below is then belt-and-braces: as a flex item
       it stretches to this box either way. `relative` is for the two overlays. -->
  <div data-testid="code-editor" class="relative flex min-h-0 w-full flex-1">
    <VueMonacoEditor
      v-if="status === 'ready'"
      width="100%"
      height="100%"
      :theme="dark ? THEME_DARK : THEME_LIGHT"
      :options="options"
      @mount="onMount"
      @update:value="onUpdateValue"
    />

    <!-- Absolutely positioned over the editor area rather than instead of it, so
         the wrapper can construct underneath and fire `mount`. -->
    <div
      v-if="showSkeleton"
      data-testid="code-editor-loading"
      class="absolute inset-0 flex flex-col gap-2 bg-background p-3"
    >
      <Skeleton class="h-4 w-2/3 rounded" />
      <Skeleton class="h-4 w-1/2 rounded" />
      <Skeleton class="h-4 w-3/4 rounded" />
    </div>

    <div
      v-else-if="status === 'failed'"
      data-testid="code-editor-failed"
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6"
    >
      <p class="max-w-xs text-center text-sm text-muted-foreground">
        The editor could not be loaded. The rest of the workspace still works.
      </p>
      <Button variant="outline" size="sm" data-testid="code-editor-retry" @click="load()">
        Try again
      </Button>
    </div>
  </div>
</template>
