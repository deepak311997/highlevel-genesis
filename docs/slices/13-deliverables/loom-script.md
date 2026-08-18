# Loom script — the golden path in five minutes

**Owner:** human (see `release-checklist.md`) · **Budget:** 5:00 hard cap, 4:50 planned ·
**Beats:** the nine the brief names, in the brief's order

The recording is **one take**. Everything below is arranged so it can be: the account is
made live on camera, but nothing else is discovered on camera — the sandbox already has
data, the prompt is already chosen, and the two waits (the verification email, the
generation stream) are the beats rather than gaps inside them.

`scripts/check-deliverables.mjs` reads the table under **Shot list** and fails the scripts
suite if a beat is dropped, reordered, or if the timings run past five minutes. Change a
timing and re-run `npm run test:scripts` before recording.

---

## Before you record

Twenty minutes of setup buys the single take. Do all of it first.

- **Seed the sandbox**, twice — `node scripts/seed-sandbox.mjs --dry-run` first, then without
  the flag, with `HL_SEED_TOKEN` and `HL_SEED_LOCATION_ID` set. Twenty contacts and eight
  appointments; the preview beat is a blank panel without them. This is a
  `release-checklist.md` item and it must already be closed.
- **Have a throwaway account ready to make.** A fresh address you can open in the same
  browser — a `+tag` alias on an inbox you already have signed in works, and keeps the
  verification click to one tab switch. Do **not** pre-create it: sign-up is beat one.
- **Open the two tabs you will need, in this order:** the live app
  (`https://hl-genesis-app.web.app`) and the inbox. Nothing else. Close every other tab, and
  bookmark neither.
- **Sign out everywhere.** The app must be at the sign-in screen when you press record, or
  beat one has nothing to show.
- **Window and zoom.** 1440 × 900 or wider, browser zoom at 100%. Below 1024px the workspace
  collapses from three resizable panels to tabs, and the three-panel shot is the product.
- **Light or dark, then leave it.** The theme toggle is in the dashboard header; pick one
  before you record. Switching mid-take reads as a fidget.
- **Have the prompt in your clipboard**, exactly as written in beat four. Typing it live
  costs fifteen seconds and one typo.
- **Mute notifications.** macOS Focus, or the equivalent.
- **Say the numbers out loud once** before recording. The tight beats are `create-project`
  (0:20) and `edit-file` (0:25); both are easy to overrun by talking through a click.

If a beat goes wrong, stop and restart from the top. The whole point of the setup above is
that a restart costs five minutes, not an afternoon.

---

## Shot list

| #   | Beat                    | Length | On screen                                                                                                                                                                                                                                                                                                                                              | What you say                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `sign-up`               | 0:30   | The live URL, signed out. **Sign up** — the fresh address, a password; the strength meter fills as you type. Submit lands on **Check your email**, which says _Waiting for you to open it — this page continues on its own._ Switch to the inbox, click the link, switch back: the page has already moved to the dashboard.                            | "This is Genesis, live on Firebase Hosting. I'll make an account from scratch. Email and password — sign-up runs through a Cloud Function rather than the client SDK, so the response is byte-identical whether or not the address is already registered; it can't be used to enumerate users. Now it's waiting on verification, and it's genuinely blocking — an unverified account can't reach any data, because the API checks `email_verified` on every route, and the rules deny every browser outright behind that as the backstop. I'll click the link… and the page moved itself."                                            |
| 2   | `connect-highlevel`     | 0:35   | Dashboard, **HighLevel** card. Click **Connect HighLevel** → HighLevel's consent screen with the scope list → approve → back on the dashboard reading **Connected to** the sandbox location. Click **Check data access**: three rows — Contacts, Conversations, Calendars — resolve to real counts.                                                    | "Now I connect a HighLevel account. This is the real OAuth flow — the authorize URL carries an encrypted CSRF state, and HighLevel comes back to a Cloud Function callback that exchanges the code for tokens server-side. The browser never sees a HighLevel token; it's written straight to Firestore under my user and read only by the Admin SDK. Back on the dashboard — connected to my sandbox sub-account. And this is a live probe of all three surfaces: contacts, conversations, calendars. Those counts are coming from the CRM right now."                                                                               |
| 3   | `create-project`        | 0:20   | **Projects** card → **New project**. Name: `Contact dashboard`. Description: `Who's in the CRM and who's booked`. Submit; the workspace opens at `/projects/<id>` with three empty panels — chat, code, preview — and _No files yet. Describe the app you want._                                                                                       | "A project is the unit of work. Name it, and here's the workspace: chat on the left, the editor in the middle, the running app on the right. Nothing in it yet."                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4   | `prompt`                | 0:25   | Paste into the composer: **"Show me a dashboard of my contacts with their email and phone, and a list of the next appointments on my calendar."** Hover **Send** for a beat before clicking, so the prompt is readable.                                                                                                                                | "I'll describe what I want in plain English. Note what I'm not doing: no endpoint, no API version, no auth. The model already knows how to call this CRM — the HighLevel cheat-sheet is pinned at the front of the system prompt behind a prompt-cache breakpoint, so it's a cache read on every generation after the first rather than something we pay to re-send."                                                                                                                                                                                                                                                                 |
| 5   | `stream`                | 0:45   | Click **Send**. The chat shows **Generating…**; prose streams into the reply; the file tree fills in file by file as `index.html` and `app.js` appear; Monaco shows tokens landing at the tail, greyed with _Read-only while a reply is generating._ Let it run to completion — do not talk over the last ten seconds.                                 | "That's Claude, streaming over server-sent events — token by token, not a request and a response. Watch the file tree: files appear as their boundaries arrive in the stream, because the model marks each file's start and end with its own tag pair rather than a fenced block, so we know where a file begins before it's finished. The editor is read-only while this runs — you're watching it write, and there's no way to fight it for the buffer. Nothing is written to the project until the whole set validates."                                                                                                           |
| 6   | `preview`               | 0:45   | The preview panel refreshes on completion. Scroll it: the generated dashboard listing **real contacts by name, email and phone**, and the next appointments with real dates. Point at one contact, then switch to the HighLevel tab for two seconds to show the same person in the CRM, and switch back.                                               | "And there it is running — those are real contacts out of the real CRM account, not fixtures. Here's the same person in HighLevel. The generated app runs in a sandboxed iframe with no same-origin access, so it can't read my session; when it wants CRM data it asks the host page, and the host calls our proxy. Appointments too — that's the calendar."                                                                                                                                                                                                                                                                         |
| 7   | `edit-file`             | 0:25   | Click `index.html` in the file tree; it opens in a tab beside the one already open. Change the heading text to something obviously yours. **Unsaved changes** appears; click **Save**; click **Refresh** on the preview and the heading changes.                                                                                                       | "It's a real editor, not a viewer — Monaco, tabbed, one buffer per file, so an unsaved edit survives a tab switch. I'll change this heading, save, refresh the preview. My edit, running."                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 8   | `restore-snapshot`      | 0:30   | **History** in the code panel header opens the **Version history** sheet: rows newest-first with version number, origin (_Generation_ / _Before restore_), file count and time. Click **Restore** on the generation row; confirm inline with **Restore this version**; the toast reads _Restored…_; the heading is back and the editor tab reconciles. | "Every generation snapshots the whole file set, so versions are versions of the project, not diffs. Here's the one from before my edit — restore it. And restoring is itself undoable: it snapshots what was there first, which is why there's a 'Before restore' entry above it now."                                                                                                                                                                                                                                                                                                                                                |
| 9   | `architecture-decision` | 0:35   | Split or full screen on `functions/src/hl/routes.ts` — the thirteen allowlisted rows with their methods, paths and pinned `Version` headers. Scroll once, slowly. End on the running preview.                                                                                                                                                          | "One decision, if I have to pick one: the proxy. The obvious build hands the generated app a HighLevel token — and that app is model output running in an iframe, so the token would be readable in page source. Instead the generated app calls our own endpoint with no credential at all, and the token is attached server-side, refreshed server-side, scoped to the caller's account. It's the confused-deputy problem, and the fix is that the deputy never holds the credential. Thirteen routes, allowlisted by method and path with the API version pinned — anything else is refused. That's Genesis. Thanks for watching." |

**Total: 4:50.** Ten seconds of headroom against the five-minute cap, which is the margin
for one sentence running long — not for a tenth beat.

---

## After the take

1. Watch it once, end to end, with the transcript on. If a beat overran, the fix is usually
   one sentence cut, not a re-record.
2. Set the Loom to **anyone with the link can view** — a video the grader cannot open is a
   video that does not exist. Check it in a private window.
3. Paste the URL into the README's **Live URLs** table, the _Loom walkthrough_ row, and into
   the submission email.
4. Tick the `record the Loom` line in `release-checklist.md` and paste the URL into its
   evidence slot.
