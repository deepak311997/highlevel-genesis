/**
 * Dates, as the cards show them.
 *
 * **Locale and time zone are pinned deliberately.** Left to the environment, a
 * rendered date depends on whichever machine the page — or the test — happens to
 * run on: two users see different text for the same day, and an assertion
 * becomes machine-dependent. The formatter is built once at module scope, since
 * constructing an `Intl.DateTimeFormat` is the expensive part and this one never
 * varies.
 */
const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
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
