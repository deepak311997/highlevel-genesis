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

/** One file a turn touched, and whether it was changed rather than written. */
interface FileRef {
  path: string
  changed: boolean
}

type Section =
  | { kind: 'markdown'; blocks: Block[] }
  | { kind: 'files'; refs: FileRef[] }
  | { kind: 'error'; text: string }

const sections = computed<Section[]>(() => {
  const out: Section[] = []

  for (const part of splitMessageContent(props.content)) {
    if (part.kind === 'file' || part.kind === 'edit') {
      const ref = { path: part.path, changed: part.kind === 'edit' }
      const last = out[out.length - 1]
      if (last?.kind === 'files') last.refs.push(ref)
      else out.push({ kind: 'files', refs: [ref] })
      continue
    }
    if (part.kind === 'error') {
      out.push({ kind: 'error', text: part.text })
      continue
    }
    const blocks = parseMarkdown(part.text)
    if (blocks.length > 0) out.push({ kind: 'markdown', blocks })
  }

  return out
})

/**
 * What the group heading says. Written and changed are counted apart, because
 * "3 files written" over a turn that changed one line of one of them is the
 * sentence this slice exists to stop the product saying.
 */
function summaryOf(refs: readonly FileRef[]): string {
  const changed = refs.filter((ref) => ref.changed).length
  const written = refs.length - changed
  const parts: string[] = []
  if (written > 0) parts.push(`${String(written)} ${written === 1 ? 'file' : 'files'} written`)
  if (changed > 0) parts.push(`${String(changed)} changed`)
  return parts.join(' · ')
}

/**
 * The icon for a path, by extension. Four buckets rather than one per extension:
 * the icon is a scanning aid.
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

      <!-- The refusal, in the bubble rather than beside it: a banner is cleared by
           a reload and a transcript is not. -->
      <p
        v-else-if="section.kind === 'error'"
        data-testid="message-error"
        class="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
      >
        {{ section.text }}
      </p>

      <div
        v-else
        data-testid="file-group"
        class="overflow-hidden rounded-md border border-border-strong bg-secondary/60"
      >
        <p
          class="border-b border-border-strong px-2.5 py-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground"
        >
          {{ summaryOf(section.refs) }}
        </p>
        <button
          v-for="ref in section.refs"
          :key="ref.path"
          type="button"
          data-testid="file-chip"
          :data-changed="String(ref.changed)"
          class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :title="`Open ${ref.path}`"
          @click="workspace.selectFile(ref.path)"
        >
          <component :is="iconFor(ref.path)" class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate font-mono text-xs">{{ ref.path }}</span>
          <span v-if="ref.changed" class="label-micro ml-auto shrink-0 text-muted-foreground">
            changed
          </span>
        </button>
      </div>
    </template>
  </div>
</template>
