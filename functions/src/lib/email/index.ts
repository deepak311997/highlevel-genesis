import { DevMailTransport } from './devMail'
import { Smtp2GoTransport } from './smtp2go'
import type { EmailTransport } from './types'

export type { EmailMessage, EmailTransport } from './types'
export { DEV_MAIL_COLLECTION } from './devMail'

/**
 * Exactly what the Firebase emulator sets, and nothing else.
 *
 * Compared strictly on purpose. The fake transport writes live verification and
 * password-reset links into Firestore, so the question "are we allowed to use
 * it?" must not be answerable by any value an operator can set — no
 * `EMAIL_TRANSPORT=dev`, no `NODE_ENV`, no debug flag. Production never sets
 * FUNCTIONS_EMULATOR, which makes it the one signal that cannot be turned on by
 * a mistake in a deploy.
 */
const EMULATOR_MARKER = 'true'

export function isEmulator(): boolean {
  return process.env['FUNCTIONS_EMULATOR'] === EMULATOR_MARKER
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(
      `Missing ${name}. Set it for local runs in functions/.env, and for deployed ` +
        `environments with \`firebase functions:secrets:set ${name}\` — see functions/.env.example.`,
    )
  }
  return value
}

/**
 * Resolve the transport for this environment.
 *
 * Reads configuration on call rather than at module scope: `firebase deploy`
 * loads and analyses the module before injecting functions/.env, so a top-level
 * throw would fail the deploy instead of the request — the same reasoning as
 * getDb() in ../firebase.
 */
export function getTransport(): EmailTransport {
  if (isEmulator()) return new DevMailTransport()

  const apiKey = required('SMTP2GO_API_KEY')
  const fromEmail = required('MAIL_FROM_EMAIL')
  const fromName = process.env['MAIL_FROM_NAME']?.trim()

  const sender =
    fromName === undefined || fromName === '' ? fromEmail : `${fromName} <${fromEmail}>`
  return new Smtp2GoTransport(apiKey, sender)
}
