<script setup lang="ts">
import { Primitive, type PrimitiveProps } from 'reka-ui'

import { cn } from '@/lib/utils'
import { buttonVariants, type ButtonSize, type ButtonVariant } from './index'

/**
 * shadcn-vue's Button, with this project's variants.
 *
 * Built on Reka UI's `Primitive` rather than a bare `<button>` so `as-child`
 * works. That matters beyond tidiness: several places need a button that is
 * really a link, and `<RouterLink><Button/></RouterLink>` produces
 * `<a><button>` — invalid HTML, because an anchor may not contain interactive
 * content, and ambiguous for screen readers and for what the click target is.
 *
 *   <Button as-child><RouterLink to="/signin">Sign in</RouterLink></Button>
 *
 * renders a single <a> carrying the button's styling.
 */
const props = withDefaults(
  defineProps<
    PrimitiveProps & {
      variant?: ButtonVariant
      size?: ButtonSize
      class?: string
    }
  >(),
  { as: 'button', variant: 'default', size: 'default', class: '' },
)
</script>

<template>
  <Primitive
    :as="props.as"
    :as-child="props.asChild"
    :class="cn(buttonVariants({ variant: props.variant, size: props.size }), props.class)"
  >
    <slot />
  </Primitive>
</template>
