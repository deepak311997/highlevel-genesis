import type { VariantProps } from 'class-variance-authority'
import { cva } from 'class-variance-authority'

export { default as Alert } from './Alert.vue'
export { default as AlertDescription } from './AlertDescription.vue'
export { default as AlertTitle } from './AlertTitle.vue'

/**
 * shadcn-vue's Alert, extended.
 *
 * Upstream ships `default` and `destructive`. The auth screens need three
 * distinct meanings — a failure, a confirmation, and a neutral status — and
 * collapsing confirmation into `default` would make "we sent the link" look
 * identical to "we are still waiting".
 *
 * Colours come from this project's tokens rather than shadcn's defaults, which
 * is the point of the copy-in model: the component is ours to shape.
 */
export const alertVariants = cva(
  'relative w-full rounded-md border px-3 py-2 text-sm [&>svg]:absolute [&>svg]:left-3 [&>svg]:top-3 [&>svg~*]:pl-6',
  {
    variants: {
      variant: {
        default: 'border-border-strong bg-secondary text-muted-foreground',
        destructive: 'border-destructive/40 bg-destructive/10 text-destructive',
        success: 'border-accent/40 bg-accent/10 text-accent',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export type AlertVariants = VariantProps<typeof alertVariants>
