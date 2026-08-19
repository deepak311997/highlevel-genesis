# Slice 13 — Release checklist

Every deliverable this slice owes, with the **one** party that closes it. Three owners, per
PRD D2: the pipeline, this pull request, and a pair of human hands. The third group is the
reason the file exists — those items cannot be closed by an unattended session, and a
checklist that pretends otherwise is a checklist that lies.

**Format.** Every checkbox line carries exactly one of `(automated)`, `(this PR)` or
`(human)`, on the `- [ ]` line itself. `scripts/check-deliverables.mjs` fails the scripts
suite otherwise, so an item cannot be added without saying who closes it (AC-18). Every
human item states its **exact procedure** and ends in an `Evidence:` slot — paste the
command output, the response body, or the screenshot filename into it as you go. An item is
closed when the box is ticked _and_ the slot is filled.

**How to run the check:**

```bash
node scripts/check-deliverables.mjs   # or: npm run test:scripts
```

---

## Owned by the pipeline (automated)

Nothing to do. Listed because the brief's deliverables name them, and a reviewer should be
able to see that they are covered rather than missing.

- [ ] **(automated)** Deploy Hosting and Cloud Functions on merge to `main`.
      [`.github/workflows/deploy.yml`](../../../.github/workflows/deploy.yml) is triggered by
      CI's completion (`workflow_run`) rather than by the push, so it deploys the exact SHA
      that went green; a red CI means no deploy. Nothing here runs `firebase deploy` by hand
      (D1) — a second, untested path to production is worse than a slower one.
- [ ] **(automated)** Smoke-test the deployment. The same workflow's _Smoke test the deployed
      API_ step calls the deployed `/api/health`, which writes a Firestore document, reads it
      back and deletes it, and fails the run unless it answers `ok: true`. That proves four
      things a successful upload proves nothing about: the Hosting rewrite reaches the
      function, the function booted, its configuration arrived, and the Admin SDK can reach
      the named database.

---

## Closed by this pull request (this PR)

Each is done and held true by a test; the test is what stops it drifting back.

- [ ] **(this PR)** Root `.env.example` at full parity with `frontend/.env.example` and
      `functions/.env.example`, plus the operator variables `HL_SEED_TOKEN` and
      `HL_SEED_LOCATION_ID`. Held by `scripts/check-secrets.spec.mjs` (AC-1, AC-2).
- [ ] **(this PR)** The README, rewritten against the code as it actually stands: Live URLs,
      local setup on emulators from a fresh clone, HighLevel setup, the thirteen-row API
      allowlist, ten architecture decisions, five improvements, deployment, repository
      layout. Held by `scripts/check-readme.spec.mjs` and `functions/src/hl/readme.spec.ts`
      (AC-3 … AC-10).
- [ ] **(this PR)** [`scripts/seed-sandbox.mjs`](../../../scripts/seed-sandbox.mjs) — 20
      contacts and 8 appointments, `--dry-run` first, duplicate-tolerant, no Firebase import
      and no proxy call. Held by `scripts/seed-sandbox.spec.mjs` (AC-11 … AC-16). Running it
      against the real sandbox is a human item below.
- [ ] **(this PR)** [`loom-script.md`](loom-script.md) — the nine-beat shot list at 4:50,
      with preconditions, what is on screen and what to say. Held by
      `scripts/check-deliverables.spec.mjs` (AC-17). Recording it is a human item below.
- [ ] **(this PR)** This checklist, with every remaining item, its owner, its procedure and
      its evidence slot (D12). Held by `scripts/check-deliverables.spec.mjs` (AC-18).
- [ ] **(this PR)** The tests that keep all of the above true — seven `.spec.mjs` files under
      `scripts/`, run by `npm run test:scripts`, plus `functions/src/hl/readme.spec.ts`, which
      runs under `npm --prefix functions run test`. `npm test` covers both.

---

## Owned by a human

### HighLevel marketplace and sandbox

- [ ] **(human)** Register the deployed redirect URI on the marketplace app.
      marketplace.gohighlevel.com → My Apps → the Genesis app → **Advanced Settings → Auth →
      Redirect URL** → add **`https://hl-genesis-app.web.app/api/oauth/callback`** and save.
      It must match the URL the OAuth request sends **byte for byte**, including the absence
      of a trailing slash; the value the server sends is `HL_REDIRECT_URI` in Secret Manager,
      so read that first and paste it rather than retyping it. Then verify end to end: open
      the live app, sign in, press **Connect HighLevel**, approve, and confirm the dashboard
      reads _Connected to_ the sandbox location. A mismatch shows up as HighLevel's own
      redirect-uri error before the consent screen, not as a Genesis error.
      Evidence: _____ (screenshot of the saved Redirect URL field, and of _Connected to …_)
- [ ] **(human)** Create the sandbox calendar in the HighLevel UI. In the sandbox sub-account:
      Calendars → **Create Calendar** → a simple _Service Booking_ calendar with your user as
      a team member, availability inside business hours, 30-minute slots. **No script can do
      this** — `calendars.write` is a deliberately skipped scope (D9), so nothing Genesis
      holds a token for is allowed to create one. Note the calendar id and the team member's
      user id from the URL / calendar settings; the seed script resolves both from
      `GET /calendars/` if you skip this, but only if the calendar exists.
      Evidence: _____ (calendar id, and the `teamMembers[0].userId` it resolves to)
- [ ] **(human)** Dry-run the seeder. Get a Private Integration Token for the sandbox
      sub-account (Settings → Private Integrations, or use an OAuth access token — the API is
      identical), then:
      `HL_SEED_TOKEN=… HL_SEED_LOCATION_ID=… node scripts/seed-sandbox.mjs --dry-run`.
      It must print 20 contacts and 8 appointments and issue **zero** requests. Read the names
      and the appointment times before spending anything.
      Evidence: _____ (the printed plan, or its last ten lines)
- [ ] **(human)** Run the seeder for real, dropping `--dry-run` and adding
      `--calendar-id` / `--assigned-user-id` if resolution failed. Expect
      `contacts:     20 created, 0 existing, 0 failed` and
      `appointments: 8 created, 0 failed`, exit `0`. Then re-run it once, unchanged: the
      second run must report `0 created, 20 existing` and still exit `0` — that is the
      idempotency claim (D10), and a re-run is the only thing that tests it. Confirm the
      contacts and appointments in the HighLevel UI afterwards.
      Evidence: _____ (both summaries, first run and re-run)
- [ ] **(human)** Check the seeded appointment times read sensibly in the sandbox's timezone.
      The seeder places them at **10:00 and 15:00 UTC** — `plannedAppointments` takes an
      `offsetMinutes`, but nothing passes one, so a sandbox in US Pacific shows 03:00 and
      08:00 local. If they read wrong on camera, move the sandbox's timezone, or add the
      `--utc-offset` flag the review named as the follow-up (`scripts/seed-sandbox.mjs`
      already has the plumbing and its tests; only a flag and a call site are missing).
      Evidence: _____ (the times as HighLevel displays them, and the sandbox timezone)

### Two HighLevel body shapes only a live call can settle

Both are stubbed from fixtures in the automated suite, and both are the least-verified
shapes in `docs/HIGHLEVEL_PLATFORM.md`. Record the **real** responses so the fixtures can be
corrected if they are wrong.

- [ ] **(human)** Confirm the **duplicate-refusal body shape** (D10). After a successful seed
      run, create one contact that already exists and capture the whole refusal:
      `curl -sS -i -X POST https://services.leadconnectorhq.com/contacts/ -H "Authorization: Bearer $HL_SEED_TOKEN" -H "Version: 2021-07-28" -H "Accept: application/json" -H "Content-Type: application/json" -d '{"locationId":"'"$HL_SEED_LOCATION_ID"'","firstName":"Amara","lastName":"Osei","email":"amara.osei@genesis-seed.example.com"}'`
      That is seed row 1, verbatim — a name and address the seeder has already created, which
      is what makes the call a duplicate. Any other contact returns `201` and settles nothing.
      The script's `duplicateContactId` reads the existing id from `meta.contactId` and falls
      back to `contactId`. If the live body puts it somewhere else, or does not carry it at
      all, the re-run path is wrong — fix `tests/fixtures/highlevel/contact-duplicate.json`
      and the reader together, and say so in the PR.
      Evidence: _____ (status line and full JSON body, verbatim)
- [ ] **(human)** Confirm the **appointment create body's time format** (D11). Create one
      appointment by hand with an explicit numeric offset, exactly as the script sends it:
      `curl -sS -i -X POST https://services.leadconnectorhq.com/calendars/events/appointments -H "Authorization: Bearer $HL_SEED_TOKEN" -H "Version: 2021-04-15" -H "Accept: application/json" -H "Content-Type: application/json" -d '{"locationId":"…","calendarId":"…","contactId":"…","assignedUserId":"…","startTime":"2026-08-20T10:00:00+00:00","endTime":"2026-08-20T10:30:00+00:00","title":"Genesis seed check"}'`
      Then read it back with `GET /calendars/events/appointments/<eventId>` and confirm the
      stored times are the ones you sent, in the timezone you meant. **The epoch-millisecond
      finding does not apply here** — see the note at the foot of this file.
      Evidence: _____ (the create response, and the read-back times)

### The deployment, by hand, once

- [ ] **(human)** Read the deployed service's environment once in the console and confirm no
      secret is a plain environment variable (F9.2, D4). Cloud Run → the `api` and `generate`
      services → Revisions → the current revision → **Variables & Secrets**. Expect
      `FIRESTORE_DATABASE_ID` as the only plain variable, and the seven `defineSecret` values
      (`ANTHROPIC_API_KEY`, `OAUTH_STATE_SECRET`, `HL_CLIENT_ID`, `HL_CLIENT_SECRET`,
      `HL_VERSION_ID`, `HL_REDIRECT_URI`, `ALLOWED_ORIGINS`) attached as Secret Manager
      references, not as values. This is a **one-time confirmation, not the mechanism** — the
      mechanism is `scripts/check-secrets.mjs`, which asserts every commit that no
      `defineSecret` name is written into `functions/.env` by the deploy. A console reading
      verifies today and nothing tomorrow.
      Evidence: _____ (screenshot of Variables & Secrets for each of the two services)
- [ ] **(human)** Open the live URL and sign in. `https://hl-genesis-app.web.app` — sign up
      with a fresh address, verify from the email, sign in, and land on the dashboard with the
      HighLevel connection live and **Check data access** returning real counts for Contacts,
      Conversations and Calendars. The deploy's smoke test proves `/api/health`; it proves
      nothing about the SPA, Auth, or the OAuth loop against the real marketplace app. Do this
      **before** recording, not during.
      Evidence: _____ (the three data-access counts, and the date you checked)
- [x] **(human)** Record the Loom and link it. Follow
      [`loom-script.md`](loom-script.md) — its preconditions first, then the nine beats at the
      pinned timings; **≤ 5 minutes**, one take. Then set the video to _anyone with the link
      can view_ and check that in a private window, paste the URL into the README's **Live
      URLs** table (the _Loom walkthrough_ row, which currently reads _pending_ and points
      here), and paste the same URL into the submission email. Two places, both required by
      the brief.
      Evidence: https://www.loom.com/share/f77abdb006c847cb8c761defe092f562 — in the README's **Live URLs** table.

### The two hand-checks §9 owes this slice

Both concern what happens when an SSE generation is cut off, and **neither is reachable from
an emulator**: the functions emulator terminates the client connection at its own proxy and
never signals the function runtime, which was measured in Slice 5 and is why AC-17/AC-18 were
driven at L1 there rather than left as L4 tests passing for the wrong reason. What is owed is
the platform half — that **Cloud Run** delivers the signal at all. Do both in **one**
generation against the deployed app; they are two readings of the same take.

The setup, once, for both: open the live app, open a project with a HighLevel connection,
and send a prompt long enough to stream for a while ("Build me a contacts dashboard with
search, a detail panel, and an appointments list" is about right). Let it stream for ten
seconds, then **close the tab**.

- [ ] **(human)** F6.5 — the **server-side SSE disconnect**. Confirm the function saw the
      client leave. Cloud Logging, or:
      `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="generate" AND jsonPayload.event="generation.complete"' --limit 5 --freshness=10m --project hl-genesis-app`
      The `generation.complete` line must appear **within a second or two of the tab closing**
      — not at the point the model would have finished — and carry `truncated: true`. That is
      `res.on('close')` in [`functions/src/generate.ts`](../../../functions/src/generate.ts)
      firing: the listener is on `res` rather than `req` precisely because `express.json()`
      has already drained the request. If the line only appears at natural completion, Cloud
      Run is not delivering the disconnect and the stream runs on with nobody listening —
      record that, because it is a real finding and the fallback (pointing the SPA at the
      function URL directly with `VITE_FUNCTIONS_BASE_URL`, bypassing the Hosting rewrite) is
      worth trying as a second reading.
      Evidence: _____ (the log line with its timestamp, beside the time you closed the tab)
- [ ] **(human)** F8.2 — **client-disconnect partial persistence**. Confirm the partial reply
      survived. Reopen the app, sign in, open the same project: the assistant message must be
      in the transcript, ending where the stream was cut, marked **· Interrupted** with a
      **Retry** beside it, and it must contain the prose that had streamed by the moment you
      closed the tab and no more. Press **Retry** and confirm it re-opens the stream for the
      same transcript without adding a second user message. If files had already been written
      by the cut point, the project's file tree must be either the complete set from that turn
      or the previous set — never half a turn's files.
      Evidence: _____ (screenshot of the reopened transcript showing the marker and Retry)

---

## One note worth keeping straight

**The epoch-millisecond finding is about a query, not a create body.** `docs/HIGHLEVEL_PLATFORM.md`
§6.3 records that `GET /calendars/events` takes its `startTime` and `endTime` **as epoch
milliseconds** — pass ISO 8601 there and HighLevel answers `200` with an empty list, which is
the worst possible failure because it looks like "no appointments" rather than like an error.
That finding applies to **that query's parameters and nothing else**. The appointment
_create_ body sends **ISO 8601 with an explicit numeric offset** (`2026-08-20T10:00:00+00:00`,
never a bare `Z`), which is what `scripts/seed-sandbox.mjs` does and what the hand-check above
confirms against the live sandbox. Over-generalising the finding into "HighLevel uses epoch
milliseconds everywhere" is the mistake this paragraph exists to prevent; it cost a day once
already.
