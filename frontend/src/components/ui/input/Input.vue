<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = withDefaults(
  defineProps<{
    modelValue?: string
    type?: string
    invalid?: boolean
    class?: string
  }>(),
  { modelValue: '', type: 'text', invalid: false, class: '' },
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <input
    :type="props.type"
    :value="props.modelValue"
    :aria-invalid="props.invalid || undefined"
    :class="
      cn(
        'flex h-9 w-full rounded-md border bg-background px-3 py-1 text-sm text-foreground',
        'shadow-[var(--sh-1)] transition-[border-color,box-shadow] duration-150',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-45',
        props.invalid ? 'border-destructive' : 'border-border-strong',
        props.class,
      )
    "
    @input="onInput"
  />
</template>
