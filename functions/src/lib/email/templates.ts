import type { EmailMessage } from './types'

/**
 * The three messages the auth endpoints can send.
 *
 * Every template takes a link and nothing else. That is deliberate: no display
 * name, no echoed address, no user-controlled string reaches a body. An email
 * built from attacker-supplied text is an HTML-injection surface aimed at a
 * mail client, and it is worth giving that up rather than defending it.
 *
 * Which template is sent is the *only* thing that differs between the register
 * branches. The HTTP response does not vary, so the branch is visible solely to
 * whoever controls the mailbox.
 */

export type EmailContent = Omit<EmailMessage, 'to'>

const PRODUCT = 'Genesis'

/**
 * Text nodes need `&`, `<` and `>` handled and nothing else.
 *
 * Separate from {@link escapeAttr} so prose survives readable — escaping quotes
 * here would render "didn't" as "didn&#39;t" in a mail client that shows the
 * plain part, for no security gain, since a quote cannot end a text node.
 *
 * `&` is replaced first in both, or the later replacements double-escape.
 */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Attribute values additionally need both quote characters neutralised. */
function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function layout(heading: string, paragraphs: readonly string[], link: string, cta: string): string {
  const href = escapeAttr(link)
  const body = paragraphs.map((p) => `<p>${escapeText(p)}</p>`).join('\n    ')

  return `<!doctype html>
<html>
  <body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1a1a1a;">
    <h1 style="font-size: 20px;">${escapeText(heading)}</h1>
    ${body}
    <p><a href="${href}" style="display:inline-block;padding:10px 16px;background:#3b5bdb;color:#fff;border-radius:6px;text-decoration:none;">${escapeText(cta)}</a></p>
    <p style="font-size: 12px; color: #666;">If the button does not work, paste this into your browser:<br>${escapeText(link)}</p>
  </body>
</html>`
}

function plain(paragraphs: readonly string[], link: string): string {
  return `${paragraphs.join('\n\n')}\n\n${link}\n\n— ${PRODUCT}\n`
}

/**
 * Sent when the address had no account.
 *
 * The "didn't create this account" line is load-bearing, not boilerplate:
 * anyone can trigger this email at anyone else's address, so the reader has to
 * know that clicking completes a registration they may not have started.
 */
export function activationEmail(link: string): EmailContent {
  const paragraphs = [
    `Confirm your address to finish setting up your ${PRODUCT} account.`,
    "If you didn't create this account, ignore this email — nothing happens until the link below is opened, and the address stays unused.",
  ]

  return {
    subject: `Verify your email for ${PRODUCT}`,
    textBody: plain(paragraphs, link),
    htmlBody: layout('Verify your email', paragraphs, link, 'Verify email'),
  }
}

/**
 * Sent when the address already has a verified account.
 *
 * Carries a reset link and no activation link. Sending an activation link here
 * would let whoever submitted the form verify an account they do not control.
 */
export function alreadyRegisteredEmail(link: string): EmailContent {
  const paragraphs = [
    `Someone tried to create a ${PRODUCT} account with this address, but you already have an account.`,
    "If that was you, sign in instead. If you've forgotten your password, use the link below to set a new one.",
    "If it wasn't you, no action is needed — your account is unchanged.",
  ]

  return {
    subject: `You already have a ${PRODUCT} account`,
    textBody: plain(paragraphs, link),
    htmlBody: layout('You already have an account', paragraphs, link, 'Reset your password'),
  }
}

export function passwordResetEmail(link: string): EmailContent {
  const paragraphs = [
    `Use the link below to set a new ${PRODUCT} password. It expires shortly.`,
    "If you didn't ask to reset your password, ignore this email — your current password still works.",
  ]

  return {
    subject: `Reset your ${PRODUCT} password`,
    textBody: plain(paragraphs, link),
    htmlBody: layout('Reset your password', paragraphs, link, 'Set a new password'),
  }
}
