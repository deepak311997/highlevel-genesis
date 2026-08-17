/**
 * Dates and times, as the screens show them.
 *
 * **Locale and time zone are pinned deliberately, in both formatters.** Left to
 * the environment, a rendered value depends on whichever machine the page — or the
 * test — happens to run on: two users see different text for the same instant, and
 * an assertion becomes machine-dependent. Each formatter is built once at module
 * scope, since constructing an `Intl.DateTimeFormat` is the expensive part and
 * neither of these ever varies.
 */
const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

/** `HH:mm`, 24-hour and zero-padded — a chat bubble's timestamp (D29). */
const TIME = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
})

/**
 * `null` for anything that does not parse, so a caller renders nothing rather
 * than "Invalid Date" — a stored timestamp we cannot read is not worth a broken
 * screen.
 */
export function formatDay(iso: string): string | null {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : DAY.format(date)
}

/** The same contract as {@link formatDay}: a bubble with no time, never a broken one. */
export function formatTime(iso: string): string | null {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : TIME.format(date)
}
