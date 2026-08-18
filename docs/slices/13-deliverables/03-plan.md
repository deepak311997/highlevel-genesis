# Slice 13 — Deliverables · Technical plan

**PRD:** `02-prd.md` (approved) · **Branch:** `slice/13-deliverables` · **Mode:** fast ·
**Read against:** `main` at `b834b61`

## Approach

Four independent bodies of work and one join. Three of them — the **environment/secret
checks**, the **seed script**, and the **two deliverable documents** — touch entirely
disjoint file sets and can be built at the same time. The fourth, the **README**, has to
come after them, because the README names `scripts/seed-sandbox.mjs` and
`release-checklist.md` and the path check (AC-4) is red until those files exist. The join is
`functions/src/hl/readme.spec.ts` (AC-9), which reads a table the README rewrite writes.

Every check is a **pure function over text**, exported from an `.mjs` module beside a
`.spec.mjs`, in the shape `scripts/check-no-firestore.mjs` already set: a named export the
spec imports, plus a `main` guarded by `import.meta.url === pathToFileURL(process.argv[1])`
so a human can also run it by hand. Filesystem and config reads are injectable parameters
with real defaults, so each spec can assert **twice** — once against a fixture that proves
the check can fail, and once against the real file that proves it passes today. That is the
PRD's own rule for these checks, and it is what makes them cheap enough to write six of.

The seed script is the same shape one level up: `readConfig`, `parseArgs`,
`plannedContacts`, `plannedAppointments` and `duplicateContactId` are pure; `seed()` takes
`fetchImpl`, `now` and `out` as injected dependencies, so every one of AC-11 … AC-15 is a
synchronous assertion over a stub's call log with no network, no clock and no Firestore.

Alternatives considered, one line each:

- *Parse `routes.ts` from an `.mjs` checker* so AC-9 could live with the other checks —
  rejected by PRD D7: a parser standing where an `import` belongs. It stays in `functions/`.
- *One `check-docs.mjs` for all six checks* — rejected: it would put the README lane and the
  deliverable-documents lane on one file and force them into a chain for no benefit.
- *A `.ts` seed script* (the name our own plan used) — rejected by D8; `scripts/` is `.mjs`
  and the root `tsconfig` excludes it, so `.ts` means either untypechecked code or a new
  runner for one file.
- *Idempotency by `POST /contacts/search`* — rejected by D10: the filter DSL is the least
  verified call in the platform, and the duplicate refusal already carries the id.
- *Write the README last, after the checks* — rejected; see **Ordering, and the one
  deviation from red-first** below.

## What the PRD says that the code does not

Recorded rather than fixed silently. None of it changes the slice's scope.

| # | PRD says | The code at `b834b61` | What this plan does |
|---|---|---|---|
| C1 | AC-3: "a README naming `npm run dev:emulator` at the root fails it" | `dev:emulator` **does** exist — in `frontend/package.json:15`. Only the root lacks it. | The resolver is **prefix-aware**: a bare `npm run X` resolves against the root `package.json` alone; `npm --prefix P run X` resolves against `P`'s. That is the only rule under which AC-3's own failing example fails. Pinned in T12. |
| C2 | Test matrix puts AC-17 and AC-18 in `scripts/check-readme.spec.mjs` | Nothing forces it, and it would put the deliverable-documents work and the README work on one spec file | They get `scripts/check-deliverables.{mjs,spec.mjs}` instead — same level (L1), same suite (`npm run test:scripts`), same assertions. **This is a deliberate deviation from the PRD's test matrix**, taken for lane disjointness and because a module should be named for what it checks. Nothing else about AC-17/AC-18 changes. |
| C3 | D9: `--assigned-user-id` comes from the first calendar's `teamMembers[0].userId` | `tests/fixtures/highlevel/calendars.json` has `"teamMembers": []` on the first calendar — the field can be absent | T6 adds the missing edge: no resolvable assignee → exit `1` naming `--assigned-user-id`, alongside the "no calendar" exit the PRD already lists. |
| C4 | AC-16: the script "never calls `POST /conversations/messages`", proven by a source scan | A scan over the file's whole text also matches the string in a *comment* | The seed script must not name `firebase`, `firestore`, `/api/hl/proxy` or `/conversations/messages` **anywhere, comments included**. Its docblock says so and points at `seed-sandbox.spec.mjs`, which is where the explanation lives. Pinned in T7. |
| C5 | AC-2 reads `deploy.yml`'s writes into `functions/.env` as `echo NAME=… > functions/.env` lines | True today (`.github/workflows/deploy.yml`, the *Write functions/.env* step) | The extractor also **fails loudly** on a heredoc redirect into `functions/.env` (`<<`), rather than silently reading nothing. A form the checker cannot read is a failure, not a pass — `check-no-firestore.mjs`'s rule for a missing `dist`. |
| C6 | The PRD's user flow lists ten beats (it counts *verify* separately); AC-17 says nine | The brief's list, quoted at `docs/IMPLEMENTATION_PLAN.md:828–830`, is nine | The nine are canonical and pinned as `LOOM_BEATS` (T8). Verification is narrated inside the `sign-up` beat. |

**API-only data access (`CLAUDE.md`, 2026-08-17):** nothing in this plan adds a Firestore
client-SDK call, a route, or a collection. The seed script imports no Firebase package at
all and is scanned for it (AC-16), and the README is scanned for any claim of client-side
Firestore access (AC-10). The rule is enforced twice and contradicted nowhere.

## File map

| File | New/Edit | What changes |
|---|---|---|
| `.env.example` | Edit | Add `HL_VERSION_ID`, `HL_AUTHORIZE_BASE`, `HL_API_BASE`, `HL_ALLOW_MESSAGE_SEND` to the functions block; add an **Operator scripts** block carrying `HL_SEED_TOKEN` and `HL_SEED_LOCATION_ID` |
| `scripts/check-secrets.mjs` | New | `.env.example` parity + `defineSecret` documentation + `deploy.yml` disjointness, with a guarded CLI |
| `scripts/check-secrets.spec.mjs` | New | AC-1, AC-2 — fixtures prove failure, the real files prove it passes |
| `scripts/check-readme.mjs` | New | Sections, bullet caps, `npm run` resolution, path existence, live-URL derivation, emulator naming, client-Firestore claims, with a guarded CLI |
| `scripts/check-readme.spec.mjs` | New | AC-3 … AC-8, AC-10 |
| `scripts/check-deliverables.mjs` | New | Loom shot list and checklist owner tags, with a guarded CLI |
| `scripts/check-deliverables.spec.mjs` | New | AC-17, AC-18 |
| `scripts/seed-sandbox.mjs` | New | The sandbox seeder — 20 contacts, 8 appointments, `--dry-run`, duplicate-tolerant |
| `scripts/seed-sandbox.spec.mjs` | New | AC-11 … AC-16 |
| `scripts/bootstrap-github.sh` | **Delete** | D17 — it bootstrapped a repository that exists |
| `tests/fixtures/highlevel/contact-create.json` | New | A successful `POST /contacts/` response |
| `tests/fixtures/highlevel/contact-duplicate.json` | New | HighLevel's 400 duplicate refusal, carrying the existing contact id |
| `tests/fixtures/highlevel/appointment-create.json` | New | A successful `POST /calendars/events/appointments` response |
| `README.md` | **Rewrite** | The whole file — status, Live URLs, local setup on emulators, HighLevel setup incl. the seed script and the 13-row allowlist, ten architecture decisions, five improvements, deployment, repository layout |
| `functions/src/hl/readme.spec.ts` | New | AC-9 — the README allowlist table against `HL_ROUTES` |
| `docs/slices/13-deliverables/loom-script.md` | New | The ≤5-minute shot list, nine beats |
| `docs/slices/13-deliverables/release-checklist.md` | New | Every human-owned item with owner, procedure and evidence slot |
| `docs/IMPLEMENTATION_PLAN.md` | Edit | §4 and §7: `seed-sandbox.ts` → `.mjs`, record `bootstrap-github.sh` deleted; §9 ledger rows F9.1/F9.2/F9.4/F7.3/NFR |
| `docs/HIGHLEVEL_PLATFORM.md` | Edit | §2 Step 3: `scripts/seed-sandbox.ts` → `scripts/seed-sandbox.mjs` |
| `docs/slices/13-deliverables/04-build-log.md` | New | The build stage's own record, incl. the fresh-clone walk |

**Untouched, and measured to be so (D14):** `frontend/src/`, `firestore.rules`,
`firestore.indexes.json`, `tests/rules/`, `functions/src/**` except the one new spec,
`.github/workflows/*`, `firebase.json`, `.firebaserc`.

## Pinned interfaces

The build stage may not vary these names or shapes — two tasks meet at each one.

### `scripts/check-secrets.mjs`

```js
/** Repo root, resolved from this file so the checks work from any cwd. */
export const ROOT            // = join(import.meta.dirname, '..')
export const PACKAGE_EXAMPLES // = ['frontend/.env.example', 'functions/.env.example']
export const ROOT_EXAMPLE     // = '.env.example'
export const DEPLOY_WORKFLOW  // = '.github/workflows/deploy.yml'

/** Every `NAME=` declared at the start of a line. Order preserved, deduped. */
export function declaredVars(text)                     // (string) => string[]

/**
 * Variables in a package example that the root example does not carry.
 * One-directional on purpose: the root file may hold MORE (the operator
 * variables live only there, because no deployed code reads them).
 */
export function missingFromRoot(rootText, packages)    // (string, {file,text}[]) => {name,file}[]

/** Every `defineSecret('NAME')` under functions/src, excluding *.spec.ts. */
export function definedSecrets(dir = join(ROOT, 'functions/src'))  // => string[] (sorted)

/**
 * Variable names the workflow writes into functions/.env.
 * Throws on a heredoc redirect into that file — a form this cannot read is a
 * failure, not a pass (C5).
 */
export function plainEnvVarsInDeploy(text)             // (string) => string[]
```

### `scripts/check-readme.mjs`

```js
export const ROOT
export const REQUIRED_SECTIONS = [
  'Live URLs', 'Local setup', 'HighLevel setup', 'Architecture decisions',
  'What I would improve', 'Deployment', 'Repository layout',
]
export const BULLET_CAPS = { 'Architecture decisions': 10, 'What I would improve': 5 }
export const FIRESTORE_CLAIMS = ['onSnapshot', 'getDoc', 'setDoc', 'subscribes to Firestore']
/** Top-level directories a repo-relative path reference may start with. */
export const PATH_ROOTS = ['scripts', 'docs', 'functions', 'frontend', 'tests', 'brand']

/** The `## ` headings, in document order. */
export function sectionsOf(text)                       // (string) => string[]
/** Everything from `## <heading>` up to the next `## `. '' if absent. */
export function sectionBody(text, heading)             // (string, string) => string
/** Lines matching /^\d+\.\s/ with no leading whitespace — top-level items only. */
export function orderedItemCount(body)                 // (string) => number

/** Every `npm [--prefix P] run X` named anywhere in the text, fences included. */
export function npmScriptsNamed(text)                  // => {script, prefix: string|null}[]
/** Scripts declared by a package.json. prefix null => the root package. */
export function scriptsOf(prefix, root = ROOT)         // => string[]
/** Those that do not resolve under the prefix-aware rule (C1). */
export function unresolvedNpmScripts(text, resolve = scriptsOf)  // => {script, prefix}[]

/** Markdown link targets + `<root>/…` tokens anywhere in the text. Deduped. */
export function pathsNamed(text)                       // => string[]
export function missingPaths(text, exists = (p) => existsSync(join(ROOT, p)))  // => string[]

/** Derived from .firebaserc and firebase.json. Throws unless exactly one region. */
export function liveUrls(firebasercText, firebaseJsonText)
  // => { project, region, hosting: `https://<project>.web.app`,
  //      functionsBase: `https://<region>-<project>.cloudfunctions.net` }

/** Which banned claims the text makes. */
export function firestoreClaims(text)                  // => string[]
```

### `scripts/check-deliverables.mjs`

```js
export const LOOM_BEATS = [
  'sign-up', 'connect-highlevel', 'create-project', 'prompt', 'stream',
  'preview', 'edit-file', 'restore-snapshot', 'architecture-decision',
]
export const LOOM_BUDGET_SECONDS = 300
export const OWNER_TAGS = ['(automated)', '(this PR)', '(human)']

/** Rows of the table under `## Shot list`. Length parsed from `m:ss`. */
export function loomShotList(text)                     // => {beat, seconds}[]
/** Human-readable problems: wrong beat, wrong order, missing, over budget. */
export function loomProblems(text)                     // => string[]

/** Every `- [ ]` / `- [x]` line, with the owner tags it carries. */
export function checkboxLines(text)                    // => {line, owners: string[]}[]
/** Lines carrying other than exactly one owner tag. */
export function ownerProblems(text)                    // => string[]
```

### `scripts/seed-sandbox.mjs`

```js
export const CONTACT_COUNT = 20
export const APPOINTMENT_COUNT = 8
export const CONTACTS_VERSION = '2021-07-28'
export const CALENDARS_VERSION = '2021-04-15'
export const DEFAULT_API_BASE = 'https://services.leadconnectorhq.com'
export const SEED_TAG = 'genesis-seed'

export class SeedConfigError extends Error {}

/** Supports both `--flag value` and `--flag=value`. */
export function parseArgs(argv)
  // => { dryRun: boolean, calendarId: string|null, assignedUserId: string|null }
/** Throws SeedConfigError naming the missing variable, before any request. */
export function readConfig(env)
  // => { token: string, locationId: string, apiBase: string }

export function headersFor(version, token)
  // => { Authorization: `Bearer ${token}`, Version: version,
  //      Accept: 'application/json', 'Content-Type': 'application/json' }

/** 20 deterministic contacts. Pure — same input, same output, every run. */
export function plannedContacts(locationId)
  // => { locationId, firstName, lastName, email, phone, tags: [SEED_TAG] }[]

/** ISO 8601 with an explicit numeric offset — never a bare `Z` (D11). */
export function isoWithOffset(date, offsetMinutes)     // => '2026-08-19T10:00:00+00:00'

/**
 * 8 appointments: two per business day (10:00 and 15:00, 30 minutes each),
 * starting the day after `now`, weekends skipped, contacts taken in order.
 */
export function plannedAppointments({ locationId, calendarId, assignedUserId, contactIds, now, offsetMinutes = 0 })
  // => { locationId, calendarId, contactId, assignedUserId, startTime, endTime, title }[]

/** HighLevel's duplicate refusal, or null. Accepts meta.contactId and contactId. */
export function duplicateContactId(status, body)       // => string | null

/** GET /calendars/?locationId= when either id is missing. Throws, naming the fix. */
export async function resolveCalendar({ fetchImpl, config, calendarId, assignedUserId })
  // => { calendarId, assignedUserId }

/** The run. Every dependency injected; no globals, no clock, no network of its own. */
export async function seed({ env, argv, fetchImpl, now, out })
  // => Summary
export function exitCodeFor(summary)                   // => 0 | 1
```

```js
/** Summary */
{
  dryRun: boolean,
  contacts:     { created: number, existing: number, failed: number },
  appointments: { created: number, failed: number },
  failures: { item: string, status: number|null, message: string }[],
  requests: number,          // every fetch the run issued, resolution included
}
```

`out` is `{ log(line), error(line) }`, defaulting to `console`; the specs pass a collector so
AC-11 can assert on the printed plan. `now` is `() => Date`, defaulting to `() => new Date()`.

### The README's allowlist table (AC-9)

Pinned here so the build renders it once, correctly. It lives under `### HighLevel API
allowlist`, inside `## HighLevel setup`. `functions/src/hl/readme.spec.ts` compares it to
`HL_ROUTES` as a **set** keyed by `METHOD + path`, on method, path, `Version`, scope, and the
disabled flag — and asserts the counts are equal, so an extra README row fails too.

| Method | Path | Version | Scope | Notes |
| --- | --- | --- | --- | --- |
| `POST` | `/contacts/search` | `2021-07-28` | `contacts.readonly` | List and search — `GET /contacts/` is deprecated upstream |
| `GET` | `/contacts/:contactId` | `2021-07-28` | `contacts.readonly` | |
| `POST` | `/contacts/` | `2021-07-28` | `contacts.write` | |
| `PUT` | `/contacts/:contactId` | `2021-07-28` | `contacts.write` | |
| `GET` | `/conversations/search` | `2021-04-15` | `conversations.readonly` | |
| `GET` | `/conversations/:conversationId` | `2021-04-15` | `conversations.readonly` | |
| `GET` | `/conversations/:conversationId/messages` | `2021-04-15` | `conversations/message.readonly` | |
| `POST` | `/conversations/messages` | `2021-04-15` | `conversations/message.write` | **Disabled by default** — sends a real SMS or email. Needs `HL_ALLOW_MESSAGE_SEND=true`, which is set in no environment |
| `GET` | `/calendars/` | `2021-04-15` | `calendars.readonly` | |
| `GET` | `/calendars/:calendarId` | `2021-04-15` | `calendars.readonly` | |
| `GET` | `/calendars/events` | `2021-04-15` | `calendars/events.readonly` | Query takes **epoch milliseconds** — ISO returns `200` with no events |
| `GET` | `/calendars/events/appointments/:eventId` | `2021-04-15` | `calendars/events.readonly` | |
| `GET` | `/calendars/:calendarId/free-slots` | `2021-04-15` | `calendars.readonly` | |

The word *disabled* may appear in **exactly one** Notes cell — the check asserts the set of
disabled rows equals the set of rows with a `flag`.

### The ten architecture decisions (D18) and the five improvements

Pinned so the caps (AC-6) and the prose agree. The build writes these as top-level numbered
items; the wording is the build's, the list is not.

1. `srcdoc` + a runtime shim over Sandpack — full control of the preview under a five-day clock
2. Files are Firestore documents, so a snapshot is a copy rather than a bucket manifest
3. The proxy is the confused-deputy fix — the generated app never holds a credential
4. Token refresh inside a transaction, against HighLevel's rotation-on-use
5. Date-pinned HighLevel API versions, with `v3` a known follow-up
6. **API-only data access**, with Firestore rules as the deny-all backstop
7. A `<genesis:file>` tag pair over fenced blocks — file boundaries emitted as they stream
8. The HighLevel cheat-sheet behind a `cache_control` breakpoint — a cache read, not a re-send
9. Two functions, not one — `generate`'s runtime profile should not be every CRUD request's
10. Vertical slices, one pull request each

Improvements (five, cap is five):

1. Iterative refinement and generation cancellation (F10.1–F10.2)
2. A real preview runtime — Sandpack or WebContainers — so generated apps can use packages
3. Per-user rate limiting and cost accounting on `generate` (F10.4)
4. Migrate the HighLevel version pin from date-based to `v3`
5. Recorded LLM fixtures for the whole golden path, so L5 can assert on generated output

Dropped from the current README's six to make the cap: breached-password screening, pushing
token refresh out of the request path, and the per-generation diff view.

### `docs/slices/13-deliverables/loom-script.md` — the shot list format

The checker parses the first markdown table under `## Shot list`. The **Beat** cell is an
inline-code slug from `LOOM_BEATS`; **Length** is `m:ss`.

| # | Beat | Length | On screen | What you say |
| --- | --- | --- | --- | --- |
| 1 | `sign-up` | 0:30 | … | … |

Budget, summing to **4:50**: sign-up 0:30 · connect-highlevel 0:35 · create-project 0:20 ·
prompt 0:25 · stream 0:45 · preview 0:45 · edit-file 0:25 · restore-snapshot 0:30 ·
architecture-decision 0:35.

### `docs/slices/13-deliverables/release-checklist.md` — the line format

Every checkbox line carries **exactly one** of `(automated)`, `(this PR)`, `(human)`:

```markdown
- [ ] **(human)** Register `https://hl-genesis-app.web.app/api/oauth/callback` on the
      marketplace app — Advanced Settings → Auth → Redirect URL. Evidence: _____
```

The owner tag must be on the `- [ ]` line itself, not on a continuation line.

## Ordering, and the one deviation from red-first

Five of the README checks (AC-3, AC-4, AC-6, AC-7, AC-10) are **red against the README on
`main` today** — it names two scripts that do not exist, carries twelve architecture bullets
and six improvements, says the live URLs are not deployed, and claims the SPA subscribes to
Firestore. The textbook order would be checks first, README second.

That order is not available here, because *every task must leave the suite green*: a check
committed before the rewrite leaves `main` red until the rewrite lands, and the rewrite is one
coherent document, not five surgical edits. So **T10 rewrites the README first, with no test
of its own** — it is prose, and the skill's rule is to say so rather than to skip the red step
quietly — and T11 … T15 then add the checks that hold it true. Each of those tasks still has a
genuine failing test first: a **fixture** carrying exactly the offending line the README used
to carry, which the PRD names as the design ("the fixtures exist to prove each check can fail;
the real files prove it passes today"). Both assertions ship in the same spec.

Two other tasks cannot be expressed as a failing test, and are marked so below: **T17**
(deleting a shell script and correcting three documents) and the `04-build-log.md` write-up.

## Task list

Ordered. Each task is one red-green-refactor cycle and one commit, and leaves the suite green.

### T1 — Root `.env.example` parity → AC-1

- **Files:** `scripts/check-secrets.mjs` (new), `scripts/check-secrets.spec.mjs` (new),
  `.env.example` (edit)
- **Red:** `check-secrets.spec.mjs` — *"every variable in a package example is in the root
  example"* over the **real** three files (fails: four variables missing), plus *"names the
  variable and the file that has it"* over a fixture pair.
- **Green:** `declaredVars` and `missingFromRoot`; add `HL_VERSION_ID`, `HL_AUTHORIZE_BASE`,
  `HL_API_BASE` and `HL_ALLOW_MESSAGE_SEND` to the root file's functions block, each with the
  one-line gloss its package file gives; add an **Operator scripts** block with `HL_SEED_TOKEN`
  and `HL_SEED_LOCATION_ID`, documented as read by `scripts/seed-sandbox.mjs` and by nothing
  deployed.
- **Refactor:** state in the file's header comment that parity is checked, and that it is
  one-directional — the root may carry more.

### T2 — Secrets are Secret Manager's, not the deploy's → AC-2

- **Files:** `scripts/check-secrets.mjs`, `scripts/check-secrets.spec.mjs`
- **Red:** *"every `defineSecret` name is documented in the root example"* (green only because
  T1 added `HL_VERSION_ID`; assert all seven by name so the list is visible), *"no
  `defineSecret` name is written into `functions/.env` by the deploy"* over the real
  `deploy.yml`, and two fixtures: a workflow line writing `ANTHROPIC_API_KEY=` into
  `functions/.env` must be reported, and a heredoc redirect into it must **throw**.
- **Green:** `definedSecrets` (scan `functions/src/**/*.ts`, skip `*.spec.ts`, regex
  `defineSecret\(\s*'([A-Z0-9_]+)'\s*\)`) and `plainEnvVarsInDeploy` (lines that redirect into
  `functions/.env`, `NAME=` extracted from the echoed text). Add the guarded CLI main printing
  every failure and exiting `1`.
- **Refactor:** one docblock naming the seven secrets and `FIRESTORE_DATABASE_ID` as the only
  plain variable the deploy writes.
- **Expected today:** seven secrets, one plain variable, empty intersection.

### T3 — The seed plan, and the config guard → AC-11, AC-14

- **Files:** `scripts/seed-sandbox.mjs` (new), `scripts/seed-sandbox.spec.mjs` (new)
- **Red:** `seed()` with `HL_SEED_TOKEN` unset rejects with `SeedConfigError` naming
  `HL_SEED_TOKEN`, and the fetch stub has **zero** calls; same for `HL_SEED_LOCATION_ID`.
  `--dry-run` prints 20 contact lines and 8 appointment lines and returns
  `{ dryRun: true, requests: 0 }`. `plannedContacts` returns 20 with unique emails, and is
  equal to itself across two calls. `isoWithOffset` renders `+00:00`, never `Z`.
- **Green:** `parseArgs`, `readConfig`, `plannedContacts`, `plannedAppointments`,
  `isoWithOffset`, and a `seed()` that returns after printing when `dryRun`. Dry-run needs no
  calendar: it prints `<resolved at run time>` for an omitted id.
- **Refactor:** the twenty names as one frozen table at the top of the file.

### T4 — Creating contacts and appointments → AC-12

- **Files:** `scripts/seed-sandbox.mjs`, `scripts/seed-sandbox.spec.mjs`,
  `tests/fixtures/highlevel/contact-create.json` (new),
  `tests/fixtures/highlevel/appointment-create.json` (new)
- **Red:** with `--calendar-id` and `--assigned-user-id` given and a stub answering the two
  fixtures, `seed()` issues exactly 28 requests — 20 `POST {apiBase}/contacts/` and 8
  `POST {apiBase}/calendars/events/appointments`; every contact request carries
  `Version: 2021-07-28`, every appointment request `Version: 2021-04-15`, all carry
  `Authorization: Bearer <token>` and `Accept: application/json`; every body carries the seed
  location id; every `startTime`/`endTime` parses and lies within 14 days of the injected
  `now`; `exitCodeFor` is `0`.
- **Green:** `headersFor` and the two request loops.
- **Refactor:** one `postJson(fetchImpl, url, version, token, body)` helper both loops use.

### T5 — A re-run is not an error → AC-13, AC-15

- **Files:** `scripts/seed-sandbox.mjs`, `scripts/seed-sandbox.spec.mjs`,
  `tests/fixtures/highlevel/contact-duplicate.json` (new)
- **Red:** a stub answering **every** contact create with the duplicate fixture (`400`, body
  carrying the existing contact id) → `contacts: { created: 0, existing: 20, failed: 0 }`, 8
  appointments still created, each `contactId` one of the ids from those responses, exit `0`.
  A stub failing the **third** contact with `500` → the other 19 are still attempted, one
  entry in `failures` naming that contact, appointments still attempted, exit `1`.
- **Green:** `duplicateContactId`, and per-item `try`/`catch` that records and continues — a
  network rejection is recorded the same way as a 5xx.
- **Refactor:** `failures` entries get a stable `item` string (`contact 3 — Dana Ruiz`) so the
  operator can find the row.

### T6 — Resolving the calendar and the assignee

- **Files:** `scripts/seed-sandbox.mjs`, `scripts/seed-sandbox.spec.mjs`
- **Red:** with neither flag given, `seed()` issues `GET {apiBase}/calendars/?locationId=…`
  with `Version: 2021-04-15` **first**, takes the first calendar's `id` and its
  `teamMembers[0].userId`. An empty `calendars` array → rejects, naming the sandbox-UI step
  (`calendars.write` is not granted). A first calendar with `teamMembers: []` and no
  `--assigned-user-id` → rejects, naming `--assigned-user-id` (C3). A `404` → rejects naming
  `--calendar-id`.
- **Green:** `resolveCalendar`, called from `seed()` before the contact loop and counted in
  `requests`.
- **Refactor:** reuse `tests/fixtures/highlevel/calendars.json` for the happy path rather
  than hand-rolling a calendar.

### T7 — The script's own boundaries → AC-16

- **Files:** `scripts/seed-sandbox.spec.mjs`, `scripts/seed-sandbox.mjs` (comments only)
- **Red:** read `scripts/seed-sandbox.mjs` as text and assert it matches none of
  `/firebase/i`, `/firestore/i`, `/api\/hl\/proxy/`, `/conversations\/messages/`.
- **Green:** scrub any such mention from the script's comments (C4) and add a docblock saying
  the forbidden surfaces are named in the spec, not here, because the scan reads the whole
  file. Add the guarded CLI main: `seed()`, print the summary, `process.exit(exitCodeFor(…))`.
- **Refactor:** the summary print is one function so the CLI and `--dry-run` share it.

### T8 — The Loom shot list → AC-17

- **Files:** `scripts/check-deliverables.mjs` (new), `scripts/check-deliverables.spec.mjs`
  (new), `docs/slices/13-deliverables/loom-script.md` (new)
- **Red:** `loomProblems` over the real `loom-script.md` is empty; over a fixture missing
  `restore-snapshot` it names it; over one with `stream` and `preview` swapped it says so;
  over one summing to `5:10` it reports the budget.
- **Green:** `loomShotList`, `loomProblems`, `LOOM_BEATS`, `LOOM_BUDGET_SECONDS`; write
  `loom-script.md` — the nine beats at the pinned timings, each with what is on screen, what
  to say, and the one architecture decision to tell (the proxy as the confused-deputy fix).
- **Refactor:** the doc opens with the preconditions (sandbox seeded, live URL open, a
  throwaway account ready) so the recording is one take.

### T9 — Every checklist line has an owner → AC-18

- **Files:** `scripts/check-deliverables.mjs`, `scripts/check-deliverables.spec.mjs`,
  `docs/slices/13-deliverables/release-checklist.md` (new)
- **Red:** `ownerProblems` over the real checklist is empty; over a fixture line with no tag
  it names the line; over one carrying both `(human)` and `(this PR)` it names the line.
- **Green:** `checkboxLines`, `ownerProblems`, `OWNER_TAGS`, and the guarded CLI main; write
  `release-checklist.md` with every item from D2 — the deploy and its smoke test
  `(automated)`; the six things this PR closes `(this PR)`; and `(human)`: register the
  deployed redirect URI, create the sandbox calendar, run `seed-sandbox.mjs` for real
  (`--dry-run` first), confirm the duplicate-refusal body shape and the appointment create
  body against the live sandbox (D10, D11), read the Cloud Run service's environment once in
  the console (D4), open the live URL, record the Loom and paste its URL into the README's
  Live URLs row and the email, plus the two hand-checks §9 owes — the **server-side SSE
  disconnect** (F6.5) and the **client-disconnect partial persistence** (F8.2), each with its
  exact procedure and an evidence slot.
- **Refactor:** the file states plainly that the epoch-millisecond finding is about the
  `GET /calendars/events` **query**, not any create body (D11).

### T10 — The README, rewritten → AC-5 (and the prose behind AC-3 … AC-10)

- **Files:** `README.md`
- **Red:** none — this is prose. See *Ordering* above. It ships green because the seven
  sections already exist; T11 … T15 are what hold every other claim true.
- **Green:** rewrite the whole file against `main` at `b834b61`:
  - Status line: twelve slices shipped, one PR each; the thirteenth is this one.
  - **Live URLs** — Hosting `https://hl-genesis-app.web.app`, Functions base
    `https://asia-south1-hl-genesis-app.cloudfunctions.net/api`, Loom *pending — see
    `docs/slices/13-deliverables/release-checklist.md`* (a visible gap, not a silent one).
  - **Local setup** — prerequisites (Node 22, a JDK for the Firestore emulator), then
    `npm run install:all` and `npm run dev`, which is `firebase emulators:exec` around the
    Vite server: **no `.env`, no Firebase project, no credentials** (verified —
    `vite.config.ts` supplies the emulator config itself, and `functions/.env.local` is
    committed). Name `firebase emulators:start` for the standalone case (`npm run emulators`).
    Then the surface table, the port-5050 note, and the test commands.
  - **Delete the "Testing the verification gate" section** (D16), replaced by two true lines:
    the Auth emulator issues the links, and the e2e suite reads them from `oobCodes`.
  - **HighLevel setup** — the marketplace app, the **deployed** redirect URI, scopes, the
    sandbox, `### HighLevel API allowlist` (the pinned 13-row table), and
    `### Seeding the sandbox` — `HL_SEED_TOKEN`, `HL_SEED_LOCATION_ID`,
    `node scripts/seed-sandbox.mjs --dry-run`, then for real.
  - **Architecture decisions** — the pinned ten, numbered, top level.
  - **What I would improve** — the pinned five.
  - **Deployment** — as today, corrected: seven `defineSecret`s, `FIRESTORE_DATABASE_ID` the
    only plain variable, and the smoke test.
  - **Repository layout** — matching what is on disk (`tests/{rules,integration,e2e,fixtures}`,
    `functions/src/{api,auth,files,hl,llm,messages,projects,snapshots,users}`, `scripts/`).
  - No `onSnapshot`, `getDoc`, `setDoc`, or "subscribes to Firestore" anywhere in the file.
- **Refactor:** `npx prettier --write README.md` — the file is prettier-clean on `main` and
  must stay so.

### T11 — Sections and bullet caps → AC-5, AC-6

- **Files:** `scripts/check-readme.mjs` (new), `scripts/check-readme.spec.mjs` (new)
- **Red:** all seven `REQUIRED_SECTIONS` present in the real README; a fixture without
  `## Deployment` names it. `orderedItemCount` is ≤ 10 and ≤ 5 in the two capped sections of
  the real README; a fixture with an eleventh decision fails, naming the section and the count.
- **Green:** `sectionsOf`, `sectionBody`, `orderedItemCount`, `REQUIRED_SECTIONS`,
  `BULLET_CAPS`.
- **Refactor:** `sectionBody` is the one place headings are sliced; every later check uses it.

### T12 — Every `npm run` resolves → AC-3

- **Files:** `scripts/check-readme.mjs`, `scripts/check-readme.spec.mjs`
- **Red:** `unresolvedNpmScripts` over the real README is empty; over a fixture naming
  `npm run dev:emulator` **without a prefix** it reports it (C1 — the root has no such
  script); over one naming `npm --prefix frontend run dev:emulator` it is empty.
- **Green:** `npmScriptsNamed` (regex `npm\s+(?:--prefix\s+(\S+)\s+)?run\s+([\w:.\-]+)`),
  `scriptsOf`, `unresolvedNpmScripts`.
- **Refactor:** the prefix rule gets a comment naming AC-3's own example as the reason.

### T13 — Every path exists → AC-4

- **Files:** `scripts/check-readme.mjs`, `scripts/check-readme.spec.mjs`
- **Depends on:** T3 … T9 (the README names `scripts/seed-sandbox.mjs` and the two docs)
- **Red:** `missingPaths` over the real README is empty; over a fixture naming
  `scripts/set-verified.mjs` it reports it; over one linking `](docs/nope.md)` it reports it;
  a fixture naming `https://example.com/a/b`, `#anchor` and `/api/health` reports nothing.
- **Green:** `pathsNamed` — markdown link targets that are not `http(s):`, `mailto:` or `#…`
  (fragment stripped), plus tokens matching `(scripts|docs|functions|frontend|tests|brand)/…`
  anywhere in the text, trailing punctuation and backticks trimmed — and `missingPaths`.
- **Refactor:** a comment recording the known limitation — a bare root filename with no slash
  is only checked when it is a markdown link target (`CLAUDE.md` is; `firestore.rules` in
  prose is not).

### T14 — Live URLs are derived, and setup names the emulator → AC-7, AC-8

- **Files:** `scripts/check-readme.mjs`, `scripts/check-readme.spec.mjs`
- **Red:** `liveUrls` over the real `.firebaserc` + `firebase.json` yields
  `hl-genesis-app` / `asia-south1`, and the **Live URLs** section of the real README contains
  both `https://hl-genesis-app.web.app` and
  `https://asia-south1-hl-genesis-app.cloudfunctions.net`; a `.firebaserc` fixture naming
  `other-project` makes it fail. `liveUrls` throws on a `firebase.json` whose rewrites name
  two regions. The **Local setup** section contains `firebase emulators:start` and
  `npm run dev`, and the root `dev` script's definition contains `emulators:exec`; a fixture
  without the emulator line fails.
- **Green:** `liveUrls` (project from `.projects.default`, region as the single distinct
  `hosting.rewrites[].function.region`) and the two section assertions.
- **Refactor:** one docblock on why the URLs are derived rather than matched literally — the
  project id is committed in exactly one place.

### T15 — No claim of client-side Firestore → AC-10

- **Files:** `scripts/check-readme.mjs`, `scripts/check-readme.spec.mjs`
- **Red:** `firestoreClaims` over the real README is empty; over a fixture containing
  `onSnapshot` it reports it; over one containing "the SPA subscribes to Firestore directly"
  (the sentence on `main` today) it reports it.
- **Green:** `FIRESTORE_CLAIMS`, `firestoreClaims`, and the guarded CLI main running every
  README check and exiting `1` on the first failure with all offenders printed.
- **Refactor:** the docblock cites `CLAUDE.md` and `scripts/check-no-firestore.mjs` — this is
  the same ban, one layer further out, over the artefact that describes the architecture.

### T16 — The README allowlist equals `HL_ROUTES` → AC-9

- **Files:** `functions/src/hl/readme.spec.ts` (new)
- **Depends on:** T10 (the table)
- **Red:** parse the first markdown table under `### HighLevel API allowlist` in
  `../../../README.md` and compare to `HL_ROUTES`: same row count; for each row the same
  `Version` and scope keyed on `METHOD path`; the set of rows whose Notes say *disabled*
  equals the set of rows with a `flag`. Assert an added `HL_ROUTES` row is reported by
  passing a local table copy plus one extra row through the same comparison function.
- **Green:** a small exported `compareAllowlist(readmeText, table)` in the spec file returning
  a list of differences, and the assertions over it. `strictTypeChecked` applies here: no
  `any`, no `as`, `noUncheckedIndexedAccess` guards on every cell read.
- **Refactor:** the docblock names the third consumer — `routes.ts` says the table has three,
  and this is the check that makes the third one real.

### T17 — Cleanup: delete a dead script, correct three documents

- **Files:** `scripts/bootstrap-github.sh` (delete), `docs/IMPLEMENTATION_PLAN.md`,
  `docs/HIGHLEVEL_PLATFORM.md`
- **Red:** none possible — a deletion and three documentation corrections. Stated rather than
  skipped.
- **Green:** delete the script (D17); in `IMPLEMENTATION_PLAN.md` replace §7's "leave it or
  delete it in Slice 13's cleanup" with the record that it was deleted, correct §4's
  `scripts/seed-sandbox.ts` to `.mjs`, and update the §9 ledger — F9.1 ✅ (deployed
  continuously; URLs in the README and derivation-tested), F9.2 ✅ (root example at parity,
  both halves tested), F9.4 ✅, F7.3 🟡 (script shipped; the live run is a checklist item),
  the emulator NFR ✅, and leave F9.3 and F9.5 ⏭ pointing at `release-checklist.md`. In
  `HIGHLEVEL_PLATFORM.md` §2 Step 3, correct the seed-script filename.
- **Refactor:** none.

## Test coverage — every AC, and where

| AC | Task | Level | Test file |
|---|---|---|---|
| AC-1 | T1 | L1 | `scripts/check-secrets.spec.mjs` |
| AC-2 | T2 | L1 | `scripts/check-secrets.spec.mjs` |
| AC-3 | T12 | L1 | `scripts/check-readme.spec.mjs` |
| AC-4 | T13 | L1 | `scripts/check-readme.spec.mjs` |
| AC-5 | T11 | L1 | `scripts/check-readme.spec.mjs` |
| AC-6 | T11 | L1 | `scripts/check-readme.spec.mjs` |
| AC-7 | T14 | L1 | `scripts/check-readme.spec.mjs` |
| AC-8 | T14 | L1 | `scripts/check-readme.spec.mjs` |
| AC-9 | T16 | L1 | `functions/src/hl/readme.spec.ts` |
| AC-10 | T15 | L1 | `scripts/check-readme.spec.mjs` |
| AC-11 | T3 | L1 | `scripts/seed-sandbox.spec.mjs` |
| AC-12 | T4 | L1 | `scripts/seed-sandbox.spec.mjs` |
| AC-13 | T5 | L1 | `scripts/seed-sandbox.spec.mjs` |
| AC-14 | T3 | L1 | `scripts/seed-sandbox.spec.mjs` |
| AC-15 | T5 | L1 | `scripts/seed-sandbox.spec.mjs` |
| AC-16 | T7 | L1 | `scripts/seed-sandbox.spec.mjs` |
| AC-17 | T8 | L1 | `scripts/check-deliverables.spec.mjs` *(C2 — the PRD's matrix says `check-readme.spec.mjs`)* |
| AC-18 | T9 | L1 | `scripts/check-deliverables.spec.mjs` *(C2)* |

**No AC is unmapped.** No AC maps to L5 — D15 settles that: the slice adds no user-facing
path, and the existing e2e suite is the regression gate.

T6, T10 and T17 close no AC on their own: T6 is the calendar-resolution edge case the PRD's
failure table requires and AC-12's flags depend on, T10 is the deliverable the checks hold
true, T17 is D17 and the ledger.

## Firestore rules changes

**None.** No collection is created, read or written. `firestore.rules`,
`firestore.indexes.json` and `tests/rules/` are untouched, and the build log records
`git diff --stat` showing it (D14). The seed script writes to HighLevel and imports no
Firebase package — proven by AC-16's source scan rather than asserted.

## Dependencies

**None.** No package is added to any of the three `package.json` files. Everything here is
Node built-ins (`node:fs`, `node:path`, `node:url`), `vitest`, and the global `fetch` Node 22
already has — which is also why `fetchImpl` is injected rather than mocked globally.

## Manual verification

Run on emulators, from a clone that is not this working tree.

**1. The fresh-clone walk (definition of done — record the output in `04-build-log.md`).**

```bash
git clone <repo-url> /tmp/genesis-fresh
cd /tmp/genesis-fresh && git checkout slice/13-deliverables
npm run install:all
npm run dev                      # emulators + Vite, no .env, no Firebase project
```

Open `http://localhost:5173`. Sign up, verify from the Auth emulator's `oobCodes`, sign in.
Following **only the README** — if a step is missing from it, the README is wrong, not the
walk.

**2. The suite from the same clone.**

```bash
npm test                         # typecheck + lint + unit + rules + integration
npm run test:e2e
npm run test:scripts             # the six new checks, on their own
```

**3. The checks as a human runs them.**

```bash
node scripts/check-secrets.mjs
node scripts/check-readme.mjs
node scripts/check-deliverables.mjs
```

Each prints what it verified and exits `0`. Break one line of the README on purpose (rename
`npm run dev` to `npm run devv`), re-run, confirm it names the line, put it back.

**4. The seed script, without spending anything.**

```bash
HL_SEED_TOKEN=x HL_SEED_LOCATION_ID=y node scripts/seed-sandbox.mjs --dry-run
```

20 contacts and 8 appointments printed, zero requests issued. The **live** run is a
`release-checklist.md` item, human-owned, and must not be run from this branch's build.

**5. The live URLs, by hand** — `https://hl-genesis-app.web.app` and
`https://hl-genesis-app.web.app/api/health`. Both answered `200` at `b834b61` (health:
`{"ok":true,…,"roundTripMs":156}`, checked 2026-08-18). This slice does not deploy (D1).

**6. D14's measurement.**

```bash
git diff --stat main -- frontend/src firestore.rules firestore.indexes.json tests/rules
```

Must print nothing. Paste it into the build log.

## Estimate

| Task | Estimate |
|---|---|
| T1 — root `.env.example` parity | 30 min |
| T2 — `defineSecret` / deploy disjointness | 40 min |
| T3 — seed plan and config guard | 50 min |
| T4 — contact and appointment creation | 40 min |
| T5 — duplicate tolerance, per-item failure | 40 min |
| T6 — calendar/assignee resolution | 30 min |
| T7 — the script's source scan | 20 min |
| T8 — Loom shot list + check | 40 min |
| T9 — release checklist + owner check | 50 min |
| T10 — **the README rewrite** | 1 h 30 min |
| T11 — sections and caps | 25 min |
| T12 — `npm run` resolution | 25 min |
| T13 — path existence | 35 min |
| T14 — live URLs and emulator naming | 35 min |
| T15 — client-Firestore claims | 20 min |
| T16 — allowlist vs `HL_ROUTES` | 40 min |
| T17 — cleanup and the ledger | 25 min |
| Manual verification (incl. the fresh-clone walk) | 45 min |
| **Total** | **≈ 9 h 20 min** |

Nothing exceeds half a day. T10 is the largest single item and is the slice's actual
deliverable; if the clock bites, the checks are what shrink, never the README.

## Lanes

Task groups by the files they own, for the build stage's fan-out. A lane may run concurrently
with any lane it shares no file with.

**Phase 1 — three lanes, fully disjoint, all three can start at once.**

| Lane | Tasks | Files it owns exclusively |
|---|---|---|
| **L-ENV** | T1 → T2 | `scripts/check-secrets.{mjs,spec.mjs}`, `.env.example` |
| **L-SEED** | T3 → T4 → T5 → T6 → T7 | `scripts/seed-sandbox.{mjs,spec.mjs}`, `tests/fixtures/highlevel/{contact-create,contact-duplicate,appointment-create}.json` |
| **L-DOCS** | T8 → T9 | `scripts/check-deliverables.{mjs,spec.mjs}`, `docs/slices/13-deliverables/{loom-script.md,release-checklist.md}` |
| **L-CLEAN** | T17 | `scripts/bootstrap-github.sh`, `docs/IMPLEMENTATION_PLAN.md`, `docs/HIGHLEVEL_PLATFORM.md` |

L-CLEAN shares no file with anything and depends on nothing; it can run in either phase.

**Barrier — T10.** The README rewrite alone. It is a barrier rather than a lane because
every remaining task reads the file it writes, and because writing it in pieces would produce
a document assembled by a checklist rather than written. It must come **after L-SEED and
L-DOCS land**, so the paths it names exist when T13 checks them.

**Phase 2 — two lanes, disjoint, both after T10.**

| Lane | Tasks | Files it owns exclusively |
|---|---|---|
| **L-README** | T11 → T12 → T13 → T14 → T15 | `scripts/check-readme.{mjs,spec.mjs}` |
| **L-ALLOWLIST** | T16 | `functions/src/hl/readme.spec.ts` |

L-README and L-ALLOWLIST touch no file in common — both only *read* `README.md` — so they
run fully in parallel.

Chains, and why each is a chain rather than a fan-out:

- **T1 → T2:** both edit `check-secrets.mjs` and its spec, and T2's "every `defineSecret` is
  documented" is green only once T1 has added `HL_VERSION_ID` to the root example.
- **T3 → T4 → T5 → T6 → T7:** one script, one spec. T4 needs T3's planners; T5 needs T4's
  request loop; T6 inserts a request ahead of it; T7 scans the finished file.
- **T8 → T9:** both grow `check-deliverables.{mjs,spec.mjs}`.
- **T11 → T12 → T13 → T14 → T15:** one checker module and one spec, each task adding an
  exported function and its CLI line. T15 closes the CLI main, so it goes last.
- **L-SEED, L-DOCS → T10:** T10 names `scripts/seed-sandbox.mjs`,
  `docs/slices/13-deliverables/release-checklist.md` and `loom-script.md`; T13 fails if any of
  them is absent.
- **T10 → T16:** T16 parses a table T10 writes.

Where a file split could keep two tasks apart, it was taken: AC-17/AC-18 moved out of
`check-readme.spec.mjs` into their own module (C2), which is what turns the deliverable
documents into a lane that runs beside the seed script instead of behind the README.
