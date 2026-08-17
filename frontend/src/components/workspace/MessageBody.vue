<script setup lang="ts">
import { computed } from 'vue'

import { Badge } from '@/components/ui/badge'
import { splitMessageContent } from '@/lib/messageParts'

/**
 * A message's content, as prose and file chips (AC-46, D29).
 *
 * **One component rather than a sub-template repeated twice**, because the
 * persisted bubble and the streaming placeholder render the same string (D7) and
 * two copies of this markup would be free to drift into two renderings of one
 * thing. A chip that appears only after a reload is exactly the kind of
 * inconsistency nobody notices until a demo.
 *
 * Not a markdown renderer — D6 and D29 both refuse one. The reply's prose is
 * prose, and a renderer would be a second parser over content the model controls,
 * with an injection surface, for a formatting nicety.
 */
const props = defineProps<{ content: string }>()

const parts = computed(() => splitMessageContent(props.content))
</script>

<template>
  <div class="flex flex-col items-start gap-1.5">
    <template v-for="(part, index) in parts" :key="index">
      <p v-if="part.kind === 'text'" class="whitespace-pre-wrap text-sm">{{ part.text }}</p>
      <Badge v-else variant="secondary" data-testid="file-chip" class="font-mono text-xs">
        {{ part.path }}
      </Badge>
    </template>
  </div>
</template>
