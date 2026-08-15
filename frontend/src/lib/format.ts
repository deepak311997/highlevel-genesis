/**
 * Render a millisecond duration for humans.
 *
 * Sub-millisecond timings round to "<1 ms" rather than "0 ms", because a
 * round trip that reports zero reads as broken instrumentation.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}
