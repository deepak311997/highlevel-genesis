<script setup lang="ts">
import { FileCode2, FileJson, FileText, FileType2 } from 'lucide-vue-next'
import { computed } from 'vue'

import MarkdownBody from '@/components/workspace/MarkdownBody.vue'
import { parseMarkdown, type Block } from '@/lib/markdown'
import { splitMessageContent } from '@/lib/messageParts'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * A message's content: prose, and the files the turn wrote (AC-46, D29).
 *
 * **One component rather than a sub-template repeated twice**, because the
 * persisted bubble and the streaming placeholder render the same string (D7) and
 * two copies of this markup would be free to drift into two renderings of one
 * thing. A chip that appears only after a reload is exactly the kind of
 * inconsistency nobody notices until a demo.
 *
 * ## Two changes from the original, both about what the reader does next
 *
 * The prose is now parsed (`markdown.ts`) instead of printed raw. The bubble was
 * showing `**bold**` and `- ` as literal characters, which reads as a defect in
 * the product rather than as emphasis — and the reply is mostly a list of
 * behaviours, which is exactly the shape markdown exists for. The safety
 * objection the old comment raised is answered structurally rather than waived:
 * the parser emits data, this template prints it, and `no-v-html.spec.ts` keeps
 * it that way.
 *
 * The file markers are now a **group of controls**, not a run of pills. A run of
 * `Badge`s said which files were written and then made the reader go and find
 * them in the tree; the files a turn just produced are the most likely thing they
 * want to open, so each row opens it. Consecutive markers collapse into one group
 * because the server emits them as a run, and three separate cards for one turn's
 * output is three times the chrome for one fact.
 */
const props = defineProps<{
  content: string
  /** Passed through to the caret; set only by the streaming placeholder. */
  streaming?: boolean
}>()

const workspace = useWorkspaceStore()

/** A run of file markers, collapsed; prose, parsed. */
type Section = { kind: 'markdown'; blocks: Block[] } | { kind: 'files'; paths: string[] }

const sections = computed<Section[]>(() => {
  const out: Section[] = []

  for (const part of splitMessageContent(props.content)) {
    if (part.kind === 'file') {
      const last = out[out.length - 1]
      if (last?.kind === 'files') last.paths.push(part.path)
      else out.push({ kind: 'files', paths: [part.path] })
      continue
    }
    const blocks = parseMarkdown(part.text)
    if (blocks.length > 0) out.push({ kind: 'markdown', blocks })
  }

  return out
})

/**
 * The icon for a path, by extension.
 *
 * Four buckets rather than a lookup of every extension the model might invent:
 * the icon is a scanning aid, and a reader who cannot tell a `.mjs` from a `.js`
 * at a glance is not helped by a fifth glyph.
 */
function iconFor(path: string) {
  if (/\.(?:html?|vue)$/i.test(path)) return FileCode2
  if (/\.(?:css|scss)$/i.test(path)) return FileType2
  if (/\.(?:js|ts|mjs|cjs|json)$/i.test(path)) return FileJson
  return FileText
}
</script>

<template>
  <div class="flex flex-col items-stretch gap-2.5">
    <template v-for="(section, index) in sections" :key="index">
      <MarkdownBody
        v-if="section.kind === 'markdown'"
        :blocks="section.blocks"
        :caret="streaming === true && index === sections.length - 1"
      />

      <div
        v-else
        data-testid="file-group"
        class="overflow-hidden rounded-md border border-border-strong bg-secondary/60"
      >
        <p
          class="border-b border-border-strong px-2.5 py-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground"
        >
          {{ section.paths.length }} {{ section.paths.length === 1 ? 'file' : 'files' }} written
        </p>
        <button
          v-for="path in section.paths"
          :key="path"
          type="button"
          data-testid="file-chip"
          class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :title="`Open ${path}`"
          @click="workspace.selectFile(path)"
        >
          <component :is="iconFor(path)" class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate font-mono text-xs">{{ path }}</span>
        </button>
      </div>
    </template>
  </div>
</template>
