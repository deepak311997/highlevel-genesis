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
 * Three things here cannot be inferred from the code:
 *
 * **1. The instance lives in a `shallowRef`**, and everything else Monaco hands us
 * lives in plain closure variables. `ref()` over an editor makes Vue walk a very
 * large third-party object graph on every property access, and a deep reactive
 * proxy is not `===` the value that was emitted.
 *
 * **2. Streamed chunks are `applyEdits`, never `setValue`.** The decision is
 * `lib/editorContent.ts`'s; what happens here is turning its answer into a range.
 * `setValue` would snap the viewport to line 1 on every chunk, reset the undo
 * stack, and re-tokenize the whole document — and would pass every test below L5.
 * A full-range replace is the same mistake one step smaller, which is why a
 * mid-file change arrives here as a splice over the range that actually moved.
 *
 * **3. `applying` is load-bearing, not defensive.** The wrapper emits
 * `update:value` on *every* content change including ours, and its own comparison
 * is never equal because `props.value` is deliberately unbound. Without the guard
 * every streamed byte would be written back into the store and every generated
 * file would arrive dirty.
 *
 * A fourth, in `onBeforeUnmount`: the wrapper's `onUnmounted` disposes the model,
 * and the `lg` breakpoint unmounts this component on a window resize — so the
 * registry detaches the editor first, or it would hand out a disposed model.
 *
 * The wrapper's `path`, `value` and `language` props are all left unbound. Bound,
 * its watcher owns the models — keyed in monaco's *global* registry, so two
 * projects share one `index.html` — and drives the document with `setValue` per
 * change, which is hazard 2 by construction.
 */

const workspace = useWorkspaceStore()

/**
 * The dynamic import's three states. Monaco is roughly a megabyte gzipped and the
 * sign-in page has no use for it, so `monacoSetup` is behind `import()` — which is
 * also what earns this screen an honest loading and error state.
 */
const status = ref<'loading' | 'failed' | 'ready'>('loading')

/** `shallowRef`, for the same reason the editor is one: this is all of monaco. */
const monaco = shallowRef<MonacoModelApi | null>(null)

/** Never `ref`, never `reactive` — see the header. */
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
    // The message is ours rather than the browser's: "Failed to fetch dynamically
    // imported module" is not a sentence for a user.
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
 * A fresh object every time, because the wrapper's `options` watcher is `deep` and
 * calls `updateOptions` with whatever it is given. `readOnlyMessage` is set always:
 * a message on an editable editor is inert, and a conditional `undefined` is an
 * error under `exactOptionalPropertyTypes`.
 */
const options = computed<monacoEditor.IStandaloneEditorConstructionOptions>(() => ({
  // Load-bearing: the editor sits inside a `ResizablePanelGroup`, and without this
  // Monaco never re-measures when the splitter moves — the text stays clipped at
  // the old width, with no error attached.
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  tabSize: 2,
  wordWrap: 'on',
  fontFamily: 'var(--font-mono)',
  // A generation's batch and this editor are two writers for one document, and the
  // collision is silent.
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
 * Bring the active model in line with what the store says the file is. The `null`
 * edit is the common case and costs nothing: our own writes land back here through
 * the store, and the comparison terminates the round trip by itself.
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
      // The view follows the tail — the whole of "tokens appear live".
      instance.revealLine(model.getLineCount())
    } else {
      /*
       * The minimal changed range, not the whole document: a located change
       * touches its own lines, so the ones above it keep their screen position and
       * only what changed is re-tokenized.
       */
      const start = model.getPositionAt(edit.offset)
      const end = model.getPositionAt(edit.offset + edit.length)
      model.applyEdits([
        {
          range: {
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: end.column,
          },
          text: edit.text,
        },
      ])
      // The view follows the change rather than the tail, and only if it is off
      // screen — a reveal on every chunk would fight a user who scrolled away.
      instance.revealLineInCenterIfOutsideViewport(start.lineNumber)
    }
  } finally {
    applying = false
  }
}

function onMount(instance: monacoEditor.IStandaloneCodeEditor): void {
  editor.value = instance

  // The anonymous model the wrapper creates because `path` is unbound. Captured
  // before we swap ours in, and disposed after — left alive it leaks one model per
  // mount, and the breakpoint remounts this component on a window resize.
  const anonymous = instance.getModel()

  rebuildRegistry()
  anonymous?.dispose()
}

/** A registry belongs to one project; leaving disposes every model it made. */
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
 * One watcher over both, rather than two: separately, the content watcher could
 * fire before the path watcher in a flush and apply the *new* file's text to the
 * *old* model.
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
       and leaves Monaco measuring a container with no height. `relative` is for
       the two overlays. -->
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
