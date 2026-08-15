<script setup lang="ts">
import { computed } from 'vue'
import { Monitor, Moon, Sun } from 'lucide-vue-next'

import { useTheme } from '@/composables/useTheme'

const { preference, cycle } = useTheme()

const icon = computed(() =>
  preference.value === 'light' ? Sun : preference.value === 'dark' ? Moon : Monitor,
)

// Announce the current state, not the next one — a screen-reader user needs to
// know where they are before deciding to change it.
const label = computed(() => `Theme: ${preference.value}. Activate to change.`)
</script>

<template>
  <button
    type="button"
    :aria-label="label"
    :title="label"
    data-testid="theme-toggle"
    class="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border-strong bg-gradient-to-b from-raised to-card text-muted-foreground shadow-e1 transition-colors hover:bg-secondary hover:text-foreground"
    @click="cycle"
  >
    <component :is="icon" :size="15" :stroke-width="2" aria-hidden="true" />
  </button>
</template>
