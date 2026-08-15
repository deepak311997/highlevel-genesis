import { getDb } from '../firebase'
import type { EmailMessage, EmailTransport } from './types'

/**
 * Emulator-only transport that records mail instead of sending it.
 *
 * This is what lets the e2e suite complete a verification flow with no mailbox:
 * Playwright reads the activation link straight out of this collection. It also
 * keeps a developer running the emulators from needing SMTP2GO credentials at
 * all.
 *
 * The documents contain live action links, so the collection is denied to every
 * client in firestore.rules and it is only ever selected by ./index.ts under
 * emulator detection — never by configuration.
 */

export const DEV_MAIL_COLLECTION = '_devMail'

/**
 * A recipient this transport always refuses.
 *
 * The integration suite has to prove that a dead mail provider does not change
 * the registration response — that is the difference between "we send email"
 * and "our response leaks whether email was sent". Driving that from data
 * rather than an environment variable keeps it per-test, and keeps the seam
 * inside code that only ever runs under the emulator.
 */
export const DEV_MAIL_FAILURE_ADDRESS = 'bounce@example.test'

export class DevMailTransport implements EmailTransport {
  async send(message: EmailMessage): Promise<boolean> {
    if (message.to === DEV_MAIL_FAILURE_ADDRESS) return false

    try {
      await getDb()
        .collection(DEV_MAIL_COLLECTION)
        .add({
          to: message.to,
          subject: message.subject,
          textBody: message.textBody,
          htmlBody: message.htmlBody ?? null,
          createdAt: new Date().toISOString(),
        })
      return true
    } catch {
      // Same contract as the real transport: report failure, never reject.
      return false
    }
  }
}
