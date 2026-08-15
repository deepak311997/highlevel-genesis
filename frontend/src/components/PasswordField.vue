<script setup lang="ts">
import { computed, ref } from 'vue'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { passwordChecks } from '@/lib/password'

/**
 * A password input that shows its own rules.
 *
 * The policy requires four character classes, and a field that only reports
 * failure after submit makes satisfying them a guessing game. The checklist
 * appears once typing starts, so it guides rather than nags an empty form.
 *
 * The reveal toggle matters more than usual here for the same reason: a
 * compliant password is fiddly, and typing one blind invites the retry loop
 * this is meant to avoid.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    id: string
    label: string
    autocomplete: string
    invalid?: boolean
    showRules?: boolean
    autofocus?: boolean
  }>(),
  { invalid: false, showRules: false, autofocus: false },
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const revealed = ref(false)

const checks = computed(() => passwordChecks(props.modelValue))
const showChecklist = computed(() => props.showRules && props.modelValue.length > 0)
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div class="flex items-baseline justify-between gap-2">
      <Label :for="props.id">{{ props.label }}</Label>
      <button
        type="button"
        class="text-xs text-muted-foreground underline hover:text-foreground"
        :aria-pressed="revealed"
        data-testid="password-reveal"
        @click="revealed = !revealed"
      >
        {{ revealed ? 'Hide' : 'Show' }}
      </button>
    </div>

    <Input
      :id="props.id"
      :model-value="props.modelValue"
      :type="revealed ? 'text' : 'password'"
      :autocomplete="props.autocomplete"
      :autofocus="props.autofocus"
      :invalid="props.invalid"
      @update:model-value="emit('update:modelValue', $event)"
    />

    <ul v-if="showChecklist" data-testid="password-rules" class="mt-0.5 flex flex-col gap-0.5">
      <li
        v-for="check in checks"
        :key="check.id"
        class="flex items-center gap-1.5 text-xs"
        :class="check.met ? 'text-accent' : 'text-muted-foreground'"
        :data-met="check.met"
      >
        <span aria-hidden="true" class="font-mono">{{ check.met ? '✓' : '·' }}</span>
        <span>{{ check.label }}</span>
        <span class="sr-only">{{ check.met ? '(met)' : '(not yet met)' }}</span>
      </li>
    </ul>
  </div>
</template>
