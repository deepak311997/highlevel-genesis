/**
 * The seam between "we decided to send a message" and "a third party delivered
 * it".
 *
 * Two implementations sit behind this: the real SMTP2GO client, and a fake that
 * records into Firestore so the e2e suite can read a verification link without
 * a mailbox. Selecting between them is the whole reason the interface exists —
 * see ./index.ts, which keys that choice on emulator detection rather than on
 * configuration, so the fake cannot be switched on in production.
 */

export interface EmailMessage {
  to: string
  subject: string
  textBody: string
  htmlBody?: string
}

export interface EmailTransport {
  /**
   * Resolves `true` only when the provider confirms delivery was accepted.
   *
   * Never rejects. Registration has to return a byte-identical response whether
   * or not mail went out — an exception here would change the response and
   * reintroduce the account-existence oracle the endpoint exists to close.
   */
  send(message: EmailMessage): Promise<boolean>
}
