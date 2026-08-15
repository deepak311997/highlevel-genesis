import { logAuthEvent } from '../log'
import type { EmailMessage, EmailTransport } from './types'

/**
 * SMTP2GO REST transport.
 *
 * Ported from the working implementation in VoiceSquad's `email_service.py`.
 * That version also carries an SMTP fallback; this one does not, because a
 * second code path that only runs when the first is misconfigured is a path
 * nothing tests.
 *
 * The endpoint is a constant, not configuration — only the secret varies.
 */

export const SMTP2GO_API_URL = 'https://api.smtp2go.com/v3/email/send'

/**
 * A hung provider must not hold a Cloud Functions instance open. The `api`
 * function has a 60s timeout; mail is one of several things a request does.
 */
export const SMTP2GO_TIMEOUT_MS = 15_000

interface Smtp2GoResponse {
  data?: { succeeded?: number }
}

export class Smtp2GoTransport implements EmailTransport {
  constructor(
    private readonly apiKey: string,
    private readonly sender: string,
  ) {}

  async send(message: EmailMessage): Promise<boolean> {
    const payload: Record<string, unknown> = {
      sender: this.sender,
      to: [message.to],
      subject: message.subject,
      text_body: message.textBody,
    }
    if (message.htmlBody !== undefined) {
      payload['html_body'] = message.htmlBody
    }

    try {
      const res = await fetch(SMTP2GO_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Header, never a query parameter — a key in a URL lands in access
          // logs, proxy history and browser referrers.
          'X-Smtp2go-Api-Key': this.apiKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SMTP2GO_TIMEOUT_MS),
      })

      if (!res.ok) {
        logAuthEvent('email.send_failed', { outcome: 'transport_failed', status: res.status })
        return false
      }

      const body = (await res.json()) as Smtp2GoResponse
      if ((body.data?.succeeded ?? 0) < 1) {
        // A 200 that delivered nothing. Silently treating this as success is
        // how "the email never arrived" becomes unexplainable.
        logAuthEvent('email.send_failed', { outcome: 'transport_failed', status: res.status })
        return false
      }

      return true
    } catch (err) {
      // Deliberately not `describeError(err)`. This call carries our API key in
      // scope, and provider error strings have been known to echo the request;
      // the error's class name is enough to tell a timeout from a DNS failure.
      logAuthEvent('email.send_failed', {
        outcome: 'transport_failed',
        detail: err instanceof Error ? err.name : 'unknown',
      })
      return false
    }
  }
}
