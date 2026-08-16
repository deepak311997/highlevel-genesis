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
        // `good`, not `accent`. style.css reserves the ember accent for the one
        // element per view that is *live* — a streaming token, a running
        // generation — and says so explicitly: "never success, never a
        // decorative highlight". Five auth screens render a success alert, so
        // using the accent here would spend the loudest colour in the palette
        // on the calmest state and leave nothing to mark the live one with when
        // Slice 5 starts streaming.
        success: 'border-good/40 bg-good/10 text-good',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export type AlertVariants = VariantProps<typeof alertVariants>
