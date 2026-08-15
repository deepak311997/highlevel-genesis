import { cva, type VariantProps } from 'class-variance-authority'

export { default as Button } from './Button.vue'

/**
 * Buttons have a light source.
 *
 * A flat fill reads as a coloured rectangle; a vertical gradient, a 1px inner
 * top highlight, a border a shade darker than the fill, and a 1px press
 * translate read as an object. That is the whole difference between "plain"
 * and "designed" here — it costs four utilities and no new colour.
 */
export const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md',
    'text-sm font-medium tracking-[-0.005em]',
    'transition-[filter,box-shadow,background-color,color] duration-150',
    'active:translate-y-px',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:opacity-45',
  ].join(' '),
  {
    variants: {
      variant: {
        default:
          'border border-primary-lo bg-gradient-to-b from-primary-hi to-primary text-primary-foreground shadow-[var(--sh-hi),var(--sh-1)] hover:brightness-[1.07] hover:shadow-[var(--sh-hi),var(--sh-2)]',
        secondary:
          'border border-border-strong bg-gradient-to-b from-raised to-card text-foreground shadow-[var(--sh-hi),var(--sh-1)] hover:bg-secondary',
        outline: 'border border-border-strong bg-transparent text-foreground hover:bg-secondary',
        ghost:
          'border border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground',
        destructive:
          'border border-destructive bg-gradient-to-b from-destructive to-destructive text-destructive-foreground shadow-[var(--sh-hi),var(--sh-1)] hover:brightness-[1.07]',
      },
      size: {
        sm: 'h-8 rounded-md px-3 text-xs',
        default: 'h-9 px-4',
        lg: 'h-10 rounded-lg px-6 text-[15px]',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

type ButtonVariants = VariantProps<typeof buttonVariants>
export type ButtonVariant = NonNullable<ButtonVariants['variant']>
export type ButtonSize = NonNullable<ButtonVariants['size']>
