# HighLevel Platform Reference — for Genesis

**Purpose:** everything you need to create a HighLevel marketplace app, install it, get OAuth tokens, and call the Contacts / Conversations / Calendars APIs. Scoped to what the Genesis take-home actually needs — **we are not publishing to the public marketplace.**

**Researched:** 2026-08-14, against `marketplace.gohighlevel.com/docs` (the current portal; the old `highlevel.stoplight.io` docs are being deprecated).

**Confidence markers used below:**
- ✅ **Verified** — read directly from HighLevel's official docs.
- ⚠️ **Verify on day 0** — the docs portal renders parameter tables client-side and I could not extract them; the shape below is from community sources + the official SDK's types. Confirm with a real token before hardcoding into the LLM system prompt.

---

## 0. TL;DR — the decisions for this build

| Question | Answer | Why |
|---|---|---|
| App type | **Private** ✅ | No marketplace review, no approval wait. Not a day-0 blocker. |
| Target User | **Sub-account** ✅ | You get a **Location token directly** — skips the agency→location token exchange entirely. |
| Who can install | **Both Agency & Sub-account** ✅ | Costs nothing, keeps the demo flexible. |
| Test environment | **Sandbox / App Test Account** ✅ | Free, provisioned instantly from the dev portal, Enterprise features on. This is your demo data source. |
| API version | Pin **`2021-07-28`** (contacts, locations) and **`2021-04-15`** (calendars, conversations) ⚠️ | `v3` shipped 2026-06-11 and is the docs default, but date-based versions are stable, still supported, and vastly better covered by community examples. Don't spend interview days on a version migration. |
| Auth model | Marketplace OAuth (mandated by the brief) ✅ | A Private Integration Token would be simpler but the assignment explicitly requires OAuth 2.0. |
| Base API URL | `https://services.leadconnectorhq.com` ✅ | |

**The big unblock:** the assignment does *not* require marketplace approval. A Private app + a Sandbox account gets you a working OAuth install in well under an hour. My earlier "this could be a multi-day blocker" concern is resolved — **do this first thing on day 1 anyway**, because everything downstream depends on it.

---

## 1. Concepts you must get right

HighLevel's whole model hangs on two levels. Getting this wrong is the #1 source of 401s and empty responses.

```
Agency  (a.k.a. "Company")           companyId
  ├── Sub-account (a.k.a. "Location")   locationId   ← CRM data lives HERE
  ├── Sub-account
  └── Sub-account
```

- **Contacts, Conversations, Calendars all live at the Location level.** Every meaningful call needs a `locationId` and a **Location-scoped token**.
- An **Agency/Company token** (`userType: "Company"`) can create sub-accounts and manage agency settings, but **cannot** directly read contacts. To use one you must first exchange it for a Location token.
- A **Location token** (`userType: "Location"`, carries `locationId`) is what you actually want.

**→ For Genesis: set Target User = Sub-account.** The install then returns a Location token directly and you never touch `/oauth/locationToken`. This also cleanly justifies the spec's "one HL location per user" (F1.3) as a deliberate design decision rather than a limitation.

### Marketplace OAuth app vs. Private Integration Token (PIT)

| | Marketplace OAuth App | Private Integration Token |
|---|---|---|
| Token | Issued via OAuth code flow, **expires in ~24h**, refreshable ✅ | Static, **never expires** ✅ |
| Created by | Developer, in the Marketplace portal | End user, in Settings → Other Settings → Private Integrations ✅ |
| Multi-tenant | Yes — one app, many installs | No — one token per account |
| Genesis uses | **This one** (assignment mandates OAuth 2.0) | Useful only as a debugging fallback |

Keep a PIT in your back pocket: if OAuth breaks at 2am on day 4, a PIT lets you verify the *API layer* independently of the *auth layer*.

---

## 2. Setup, step by step

### Step 1 — Developer account ✅
1. Go to **https://marketplace.gohighlevel.com/**
2. Click **Sign Up**, fill the form.
3. Verify **phone number**, click **Get Started**.
4. Verify **email** from your inbox.

The first registrant is the sole account owner; add teammates as users rather than sharing the login. Docs do not state a paid HighLevel subscription is required for a *developer* account — and the Sandbox account (Step 3) covers you regardless.

### Step 2 — Create the app ✅
Marketplace → **My Apps** → **Create App**.

Fields, with the values for Genesis:

| Field | Set to | Notes |
|---|---|---|
| **App Name** | `Genesis` | Visible to users on public apps only |
| **App Type** | **Private** | Not listed in the marketplace, no approval required |
| **Target User** | **Sub-account** | → Location token directly |
| **Who Can Install** | **Both Agency & Sub-account** | |
| **Listing Type** | White-label (irrelevant for private) | |

Then in **Advanced Settings**:

- **Auth → OAuth Scopes** — see §4. ⚠️ **Choose these carefully on day 0** (see gotcha below).
- **Auth → Redirect URL** — must be **HTTPS** ✅ and match the OAuth request **exactly**.
- **Secrets → Client Keys → Add** → generates **Client ID + Client Secret**.
  - ⚠️ **The Client Secret is shown once.** Copy it immediately into `.env` / Firebase Secret Manager.
- **Secrets → Shared Secret Key** — used for validating signed token-based user context (custom pages). Not needed for Genesis.
- **Events → Webhook URL** — optional; see §7.

> **Gotcha — scope changes force re-authorization.** Adding a scope after the fact means every existing install must go through the OAuth flow again. Since you control all installs here it's survivable, but pick the full scope list now rather than discovering `calendars/events.readonly` is missing on day 4.

**Redirect URL to register:** use your Firebase Hosting domain, not the raw Cloud Run function URL:

```
https://<your-project>.web.app/api/oauth/callback
```

Rationale: it's stable across function redeploys, it's the same origin as the SPA (no CORS on the callback), and it's what you'll want in the README. Register the emulator URL as a *second* redirect entry if HighLevel allows multiple; otherwise develop against the deployed callback and tunnel locally.

✅ **This route already exists.** `firebase.json` rewrites `/api/**` to the `api` function in **`asia-south1`**, so the callback lands at `/api/oauth/callback` with no new plumbing — Slice 2 adds a handler to the existing Express router. The same string must appear byte-for-byte in three places: the marketplace app's Redirect URL field, `HL_REDIRECT_URI` in `functions/.env`, and the `redirect_uri` on both the authorize URL and the token exchange. A trailing slash in one of the three is the classic day-one hour.

### Step 3 — Sandbox / App Test account ✅

This is your demo environment and it solves the "reviewer connects an empty location" problem.

1. Marketplace Developer Portal → **Testing** (top nav) → **+ Create App Test Account**
2. Provide an account name and password. **Provisioned immediately.**
3. It behaves as a standalone HighLevel account, with **trial access to Enterprise features enabled**.

Constraints:
- Active for **up to 6 months** from creation.
- Webhooks/automations testable **at low volume** only.
- Subject to Sandbox Fair Use guidelines.

**Action item:** once created, manually seed it — ~20 contacts with real-looking names/emails/phones/tags, a calendar, and 5–10 appointments spread over the next two weeks. Your Loom demo lives or dies on this. Write it as a seed script (`scripts/seed-sandbox.ts`) using the API so you can re-run it; that's also a nice thing to point at in the README.

### Step 4 — Install the app

The install URL — this is the "authorize URL" your **Connect HighLevel** button points at:

```
https://marketplace.gohighlevel.com/oauth/chooselocation
  ?response_type=code
  &redirect_uri=https://<your-project>.web.app/api/oauth/callback
  &client_id=<CLIENT_ID>
  &scope=<space-separated scopes, URL-encoded>
```
✅ Verified format.

Notes:
- White-label variant: `https://marketplace.leadconnectorhq.com/oauth/chooselocation` (same params).
- Scopes are **space-separated** in the `scope` param (so `%20` once encoded).
- Append **`&loginWindowOpenMode=self`** to log in in the same tab; default is a new tab. ✅ Useful — the default popup behaviour is confusing in a demo.
- Add your own `state` param (CSRF token + Firebase UID) — HighLevel passes it through, and you need it to attach the callback to a Firebase user. **This is required, not optional:** the callback is an unauthenticated endpoint and `state` is your only link back to the signed-in user.

Flow: admin visits the URL → picks a location → redirected to `redirect_uri?code=...&state=...`.

**Private app install limit** ✅: apps created after **2025-11-18** are capped at **5 agency installs** (unlimited sub-accounts within them). One agency = 1 count regardless of sub-account count. Irrelevant for a take-home; worth knowing.

---

## 3. OAuth 2.0 mechanics ✅

Only the **Authorization Code** grant is supported.

### Token exchange

```
POST https://services.leadconnectorhq.com/oauth/token
Content-Type: application/x-www-form-urlencoded
Accept: application/json
```

| Param | Value |
|---|---|
| `client_id` | your client id |
| `client_secret` | your client secret |
| `grant_type` | `authorization_code` |
| `code` | from the callback |
| `user_type` | **`Location`** (for Genesis) |
| `redirect_uri` | must match **exactly** |

> **Gotcha:** the body must be **form-urlencoded**, not JSON. Sending JSON here is the single most common failure and produces an unhelpful error.

> **Gotcha:** no `Version` header on the token endpoint — it's the one exception ✅.

### Response ✅

```jsonc
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_in": 86399,          // ~24 hours
  "token_type": "Bearer",
  "scope": "contacts.readonly calendars.readonly ...",
  "userType": "Location",
  "companyId": "...",
  "locationId": "...",          // ← present for Location tokens
  "userId": "...",
  "refreshTokenId": "...",
  "isBulkInstallation": false
}
```

### Refresh

Same endpoint, `grant_type=refresh_token`, plus `refresh_token`, `client_id`, `client_secret`, `user_type`, `redirect_uri`.

### ⚠️⚠️ Token lifecycle — the trap

✅ **Verified:** access token ≈ **24 hours** (`expires_in: 86399`). Refresh token valid **1 year _or until used_** — **every refresh issues a new refresh token and invalidates the old one.**

This is rotation-on-use, and it means:

> **Two concurrent requests that both see an expired access token will both attempt a refresh. One wins; the other presents an already-consumed refresh token and gets rejected. If you then persist that failure, the connection is permanently bricked and the user must reinstall the app.**

For Genesis this is a live risk, not a theoretical one: the preview iframe will fire several proxy calls in parallel on first render, and they'll all hit an expired token at the same moment.

**Mitigation — implement this from the start, not after it bites:**

```ts
// functions/src/hl/token.ts  — sketch
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const SKEW_MS = 5 * 60_000; // refresh 5 min early

export async function getAccessToken(uid: string): Promise<string> {
  const db = getFirestore();
  const ref = db.doc(`hlConnections/${uid}`);

  // Fast path: valid token, no transaction needed.
  const snap = await ref.get();
  const conn = snap.data();
  if (!conn) throw new HlNotConnectedError();
  if (conn.expiresAt.toMillis() - SKEW_MS > Date.now()) return conn.accessToken;

  // Slow path: serialize the refresh so only one caller rotates the token.
  return db.runTransaction(async (tx) => {
    const fresh = (await tx.get(ref)).data()!;
    // Someone else refreshed while we waited — use theirs.
    if (fresh.expiresAt.toMillis() - SKEW_MS > Date.now()) return fresh.accessToken;

    const next = await exchangeRefreshToken(fresh.refreshToken);
    tx.update(ref, {
      accessToken:  next.access_token,
      refreshToken: next.refresh_token,          // ← MUST persist the new one
      expiresAt:    new Date(Date.now() + next.expires_in * 1000),
      updatedAt:    FieldValue.serverTimestamp(),
    });
    return next.access_token;
  });
}
```

Two further rules:
1. **Never** persist a refresh failure by clearing the stored refresh token — you'd destroy a token that may still be valid. Mark a `needsReconnect` flag only after a *definitive* `invalid_grant`.
2. Refresh **proactively on a 5-minute skew**, not reactively on 401. Reactive-only refresh maximizes the number of simultaneous refresh attempts.

### Agency → Location token exchange ✅ (you shouldn't need this)

```
POST https://services.leadconnectorhq.com/oauth/locationToken
Authorization: Bearer <agency token>
body: { companyId, locationId }
```

Only relevant if Target User = Agency, or on a bulk install (`isBulkInstallation: true`, `userType: "Company"`), where you must list installed sub-accounts and exchange per location. **Avoid by choosing Sub-account target user.**

---

## 4. Scopes ✅

All verified from the official scopes reference. All Sub-Account level unless noted.

**Required for Genesis:**

| Scope | Grants |
|---|---|
| `locations.readonly` | Location details (**needed for the "connected to <name>" UI**, F1.3) |
| `contacts.readonly` | Read contacts + their tasks, notes, appointments |
| `contacts.write` | Create/update/delete contacts, tags, notes, tasks |
| `conversations.readonly` | Retrieve + search conversations |
| `conversations.write` | Create/update/delete conversations |
| `conversations/message.readonly` | Read messages, recordings, transcriptions |
| `conversations/message.write` | **Send messages**, upload files, update message status |
| `calendars.readonly` | Calendars + **free-slot availability** |
| `calendars/events.readonly` | **Appointments** and blocked slots |
| `calendars/events.write` | Create/update/delete appointments |

**Worth adding cheaply (avoids a re-auth later):**

| Scope | Why |
|---|---|
| `users.readonly` | Calendar events reference `userId`; you'll want names not UUIDs |
| `opportunities.readonly` | Pipelines/deals — a very natural "build me a dashboard" prompt |
| `locations/customFields.readonly` | Generated apps that display custom contact fields |
| `locations/tags.readonly` | Tag filters in generated contact lists |

**Skip:** `calendars.write` (creating *calendars* is not a demo prompt), `locations.write` (agency-only), anything payments/products.

---

## 5. Calling the API

### Required headers ✅

```
Authorization: Bearer <location access token>
Version: 2021-07-28          ← REQUIRED on every request except /oauth/token
Accept: application/json
Content-Type: application/json   (on writes)
```

Omitting `Version` returns a "version header was not found" style error. ✅

### Versioning ✅

- Date-based: `2021-04-15`, `2021-07-28`, `2023-02-21` — legacy but supported.
- Named: **`v3`** (released **2026-06-11**), `v4` planned. Same `Version` header, named value.
- The docs portal has a **version switcher**; it now defaults to **v3**, which is why doc pages show `Version: v3`.
- Versions eventually go maintenance-only, then retired (requests with that header rejected).

**Recommendation: pin date-based versions for this build.** v3 is 2 months old, community examples are all date-based, and the assignment is judged on the app, not on API currency. Note the choice in your README architecture bullets — "pinned to stable date-based API versions; v3 migration is a known follow-up" is a *good* answer, not a weak one.

### Rate limits ✅

- **Burst: 100 requests / 10 seconds**, per app per resource (per Location).
- **Daily: 200,000 requests**, per app per resource.
- Response headers: `X-RateLimit-Limit-Daily`, `X-RateLimit-Daily-Remaining`, `X-RateLimit-Interval-Milliseconds`, `X-RateLimit-Max`, `X-RateLimit-Remaining`.

Generous. But the burst limit is reachable if generated code renders a contact list and then fires one `GET /contacts/{id}` per row — a very plausible LLM output. Two defenses: (a) tell the model in the system prompt to use list endpoints and never N+1; (b) surface `X-RateLimit-Remaining` through the proxy so you can show a real error instead of a mystery failure.

---

## 6. The three API surfaces

Base: `https://services.leadconnectorhq.com`

### 6.1 Contacts — `Version: 2021-07-28`

| Method | Path | Scope | Notes |
|---|---|---|---|
| POST | `/contacts/search` | `contacts.readonly` | ✅ **Use this for listing/searching.** Body: `locationId`, `page`, `pageLimit`, `filters`, `sort`, `searchAfter` ✅ |
| GET | `/contacts/{contactId}` | `contacts.readonly` | |
| GET | `/contacts/lookup?email=&phone=` | `contacts.readonly` | Exact match; ≤20 results, cursor paginated ✅ |
| POST | `/contacts/` | `contacts.write` | Body includes `locationId` |
| PUT | `/contacts/{contactId}` | `contacts.write` | |
| POST | `/contacts/upsert` | `contacts.write` | Respects the location's "Allow Duplicate Contact" setting ✅ |
| DELETE | `/contacts/{contactId}` | `contacts.write` | |
| ~~GET~~ | ~~`/contacts/?locationId=`~~ | — | ⛔ **Deprecated** ✅ — docs explicitly redirect to `/contacts/search` |

⚠️ The exact `filters` / `sort` grammar for `/contacts/search` needs verification against a live token — it's a structured filter DSL, not flat query params, and it's the single most important thing to get right for the LLM system prompt.

### 6.2 Conversations — `Version: 2021-04-15`

| Method | Path | Scope |
|---|---|---|
| GET | `/conversations/search` ✅ | `conversations.readonly` |
| GET | `/conversations/{conversationId}` | `conversations.readonly` |
| POST | `/conversations/` | `conversations.write` |
| GET | `/conversations/{conversationId}/messages` ✅ | `conversations/message.readonly` |
| POST | `/conversations/messages` | `conversations/message.write` |

⚠️ Query params for `/conversations/search` (expected: `locationId`, `query`, `limit`, `status`, `assignedTo`, `sort`, `sortBy`) need day-0 verification.

> ⚠️ **Demo warning:** `POST /conversations/messages` **sends a real SMS or email.** In a sandbox this may fail for lack of a provisioned phone number / LC Email, and if it *succeeds* it costs money and messages a real endpoint. Recommend: expose the send endpoint through the proxy but **allowlist it behind an explicit flag**, and keep it out of the Loom demo. Read-only conversations is the safe demo surface.

### 6.3 Calendars — `Version: 2021-04-15`

| Method | Path | Scope |
|---|---|---|
| GET | `/calendars/` ✅ | `calendars.readonly` |
| GET | `/calendars/{calendarId}` | `calendars.readonly` |
| GET | `/calendars/events` ✅ | `calendars/events.readonly` |
| GET | `/calendars/{calendarId}/free-slots` | `calendars.readonly` |
| GET | `/calendars/events/appointments/{eventId}` | `calendars/events.readonly` |
| POST | `/calendars/events/appointments` | `calendars/events.write` |

⚠️ `/calendars/events` params (expected: `locationId` + `startTime`/`endTime`, plus one of `calendarId` / `userId` / `groupId`) need verification — in particular **whether times are epoch-milliseconds or ISO 8601**. Community reports point at epoch ms. Get this wrong and you get an empty array with a 200, which is the worst kind of bug to debug live. **Verify this specific thing first.**

### 6.4 Locations — `Version: 2021-07-28`

| Method | Path | Scope | Why |
|---|---|---|---|
| GET | `/locations/{locationId}` | `locations.readonly` | The location **name** for the connection-status UI (F1.3) |

### Official SDK ✅

`npm install @gohighlevel/api-client` — Node ≥18, written in TypeScript with full type definitions, auto-refreshes on 401, `ghl.setApiVersion('2021-07-28')`.

**Recommendation: install it as a `devDependency`, and never call it at runtime.** Its `.d.ts` files are the most reliable parameter reference available — better than the docs portal for exactly the ⚠️ items above. Your proxy should be a thin `fetch` wrapper you fully control (you need pass-through of arbitrary paths, custom error mapping, and your own token transaction from §3). Using the SDK's auto-refresh would reintroduce the rotation race. Recorded in `PRODUCT_SPEC.md` §7.3 so nobody later mistakes it for a shipped dependency.

---

## 7. Webhooks (optional for Genesis) ✅

Configure in the app's Advanced Settings → Events → paste a webhook URL against the events you want. Editable any time, even live.

**Signature verification:**

| Header | Algorithm | Status |
|---|---|---|
| `X-GHL-Signature` | **Ed25519** | Current, preferred |
| `X-WH-Signature` | RSA-SHA256 | Legacy — **deprecated 2026-09-01** |

If both arrive, Ed25519 wins. Ed25519 public key ✅:

```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----
```

Events cover contacts, opportunities, tasks, appointments, invoices, products, associations, locations, users, plus app **INSTALL / UNINSTALL**.

**Verdict for the 5-day build:** F10.6 (webhooks) is the *lowest* impressiveness-per-effort bonus — it needs a public endpoint, signature verification, and an event you can actually trigger on camera. **Skip it.** The one exception worth 20 minutes: subscribe to **UNINSTALL** so you can mark the connection dead instead of serving 401s forever. That's a genuinely good detail to mention in the README.

---

## 8. Mapping to the Genesis spec

| Spec feature | What HighLevel requires |
|---|---|
| **F1.2** Connect HighLevel OAuth | `chooselocation` URL + `state` carrying the Firebase UID; callback exchanges code with `user_type=Location` |
| **F1.3** Token lifecycle, one location per user | Direct consequence of Target User = Sub-account. Transactional refresh per §3. |
| **F1.3** Connection status shows location name | `GET /locations/{locationId}` + `locations.readonly` |
| **F3.2** HL knowledge in system prompt | §5 headers + §6 endpoint tables, rewritten as a proxy-relative cheat sheet (see below) |
| **F7.1** Three API surfaces | §6.1–6.3 |
| **F7.2** Authenticated proxy | Attaches `Authorization` + `Version`, resolves token per §3 |
| **F7.3** Sandbox HL account | §2 Step 3 — App Test Account + seed script |
| **F8.3** Failed HL calls surfaced | Map `401 invalid_grant` → "reconnect required"; `429` → rate-limit message using `X-RateLimit-*` |
| **F10.5** Pagination bonus | `/contacts/search` `searchAfter` cursor |

### The proxy contract to teach the LLM

Do **not** put raw HighLevel URLs in the system prompt — generated code cannot reach them (CORS, and it has no token). Give the model one calling convention:

```js
// The ONLY way generated apps talk to HighLevel.
// locationId and auth are injected server-side. Never include them.
const res = await hl('POST', '/contacts/search', { pageLimit: 20 });
const res = await hl('GET',  '/calendars/events', { startTime, endTime, calendarId });
```

Your proxy then:
1. Authenticates the caller (§9 note).
2. **Allowlists** `(method, path-pattern)` — this is the confused-deputy fix. A generated "contact cleanup tool" must not be able to `DELETE /contacts/{id}` in a loop.
3. Injects `locationId`, `Authorization`, `Version`.
4. Normalizes errors into a stable shape the model is told to expect.

The allowlist doubles as the spec for §6 — one table, three consumers (proxy, system prompt, README).

---

## 9. Day-0 verification checklist

Do all of this **before writing any Genesis code.** Every item is something that silently breaks later.

```bash
# 0. Set these once
export CID='...' CSEC='...' REDIRECT='https://<project>.web.app/api/oauth/callback'

# 1. Build the install URL, open it, install into the SANDBOX location.
#    (scopes space-separated, URL-encoded)
echo "https://marketplace.gohighlevel.com/oauth/chooselocation?response_type=code&redirect_uri=${REDIRECT}&client_id=${CID}&scope=locations.readonly%20contacts.readonly%20contacts.write%20conversations.readonly%20conversations%2Fmessage.readonly%20calendars.readonly%20calendars%2Fevents.readonly&loginWindowOpenMode=self"

# 2. Exchange the code  → NOTE: form-urlencoded, no Version header
curl -sS -X POST https://services.leadconnectorhq.com/oauth/token \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "client_id=${CID}" \
  --data-urlencode "client_secret=${CSEC}" \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode "code=PASTE_CODE" \
  --data-urlencode 'user_type=Location' \
  --data-urlencode "redirect_uri=${REDIRECT}" | tee /tmp/tok.json

export TOK=$(jq -r .access_token /tmp/tok.json)
export LOC=$(jq -r .locationId  /tmp/tok.json)
# ✓ Confirm locationId is present and userType == "Location"

# 3. Location name (connection-status UI)
curl -sS "https://services.leadconnectorhq.com/locations/${LOC}" \
  -H "Authorization: Bearer ${TOK}" -H 'Version: 2021-07-28' -H 'Accept: application/json'

# 4. Contacts search — capture the EXACT filters/sort grammar
curl -sS -X POST https://services.leadconnectorhq.com/contacts/search \
  -H "Authorization: Bearer ${TOK}" -H 'Version: 2021-07-28' \
  -H 'Content-Type: application/json' \
  -d "{\"locationId\":\"${LOC}\",\"pageLimit\":20}"

# 5. Calendars
curl -sS "https://services.leadconnectorhq.com/calendars/?locationId=${LOC}" \
  -H "Authorization: Bearer ${TOK}" -H 'Version: 2021-04-15'

# 6. ⚠️ THE BIG ONE: epoch-ms vs ISO. Try both; whichever returns data wins.
NOW=$(($(date +%s)*1000)); WEEK=$((NOW + 604800000))
curl -sS "https://services.leadconnectorhq.com/calendars/events?locationId=${LOC}&calendarId=CAL_ID&startTime=${NOW}&endTime=${WEEK}" \
  -H "Authorization: Bearer ${TOK}" -H 'Version: 2021-04-15'

# 7. Conversations
curl -sS "https://services.leadconnectorhq.com/conversations/search?locationId=${LOC}&limit=20" \
  -H "Authorization: Bearer ${TOK}" -H 'Version: 2021-04-15'

# 8. Refresh, and confirm rotation
curl -sS -X POST https://services.leadconnectorhq.com/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "client_id=${CID}" --data-urlencode "client_secret=${CSEC}" \
  --data-urlencode 'grant_type=refresh_token' \
  --data-urlencode "refresh_token=$(jq -r .refresh_token /tmp/tok.json)" \
  --data-urlencode 'user_type=Location' --data-urlencode "redirect_uri=${REDIRECT}"
# ✓ Confirm the returned refresh_token DIFFERS from the one you sent.
#   Then re-send the OLD one and confirm it now FAILS. This is the §3 race, proven.

# 9. Check rate-limit headers are present
curl -sSD- -o/dev/null "https://services.leadconnectorhq.com/locations/${LOC}" \
  -H "Authorization: Bearer ${TOK}" -H 'Version: 2021-07-28' | grep -i ratelimit
```

**Save every response body.** They become your `/contacts/search`, `/calendars/events`, `/conversations/search` response-shape examples in the LLM system prompt — real payloads beat prose, and they're what makes generated code render real data on the first try.

---

## 10. Risks & open items

| # | Item | Status |
|---|---|---|
| 1 | Marketplace approval blocking day 1 | ✅ **Resolved** — Private app needs no approval |
| 2 | No demo data for the reviewer | ✅ **Resolved** — Sandbox account + seed script |
| 3 | `/calendars/events` time format (epoch ms vs ISO) | ⚠️ **Verify first.** Silent empty-200 failure mode |
| 4 | `/contacts/search` filter DSL grammar | ⚠️ Verify; cross-check against `@gohighlevel/api-client` types |
| 5 | Refresh-token rotation race | ⚠️ **Design for it now** (§3). Bricks the connection if ignored |
| 6 | Sending real SMS/email from a demo | ⚠️ Allowlist-gate the send endpoint; keep out of the Loom |
| 7 | v3 vs date-based versions | ⚠️ Decision made (pin date-based); document it in the README |
| 8 | Sandbox 6-month expiry / fair-use | ℹ️ Irrelevant at this timescale |
| 9 | Redirect URI exact-match across emulator vs prod | ⚠️ Sort out on day 0 — check whether multiple redirect URLs are allowed |

**Note:** the toughest architectural problems in this project — how a `srcdoc` iframe with an opaque origin authenticates to your proxy, and whether SSE survives a Firebase Hosting rewrite — are **not** HighLevel problems. This doc doesn't address them, and they remain the two highest-risk unknowns in the build.

---

## Sources

- [OAuth 2.0 — HighLevel API](https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0/index.html)
- [Step 1: Create a Developer Account](https://marketplace.gohighlevel.com/docs/oauth/CreateDeveloperAccount/index.html)
- [Step 2: Create a Marketplace App](https://marketplace.gohighlevel.com/docs/oauth/CreateMarketplaceApp/index.html)
- [Sandbox Account](https://marketplace.gohighlevel.com/docs/oauth/SandboxAccount)
- [App Testing Guide](https://marketplace.gohighlevel.com/docs/oauth/AppTestingGuide)
- [Marketplace App Distribution Model](https://marketplace.gohighlevel.com/docs/oauth/AppDistribution/index.html)
- [Scopes](https://marketplace.gohighlevel.com/docs/Authorization/Scopes/index.html)
- [API Versioning](https://marketplace.gohighlevel.com/docs/Versioning/)
- [FAQs — rate limits](https://marketplace.gohighlevel.com/docs/oauth/Faqs/index.html)
- [Webhook Integration Guide](https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/index.html)
- [Contacts API](https://marketplace.gohighlevel.com/docs/ghl/contacts/contacts/index.html) · [Conversations](https://marketplace.gohighlevel.com/docs/ghl/conversations/conversations/) · [Calendars](https://marketplace.gohighlevel.com/docs/ghl/calendars/calendars/)
- [Official SDK — GoHighLevel/highlevel-api-sdk](https://github.com/GoHighLevel/highlevel-api-sdk) · [`@gohighlevel/api-client`](https://www.npmjs.com/package/@gohighlevel/api-client)
- [Private App Installation Limits policy](https://www.gohighlevel.com/post/app-marketplace-policy-update-private-app-installation-limits)
- [Private Integrations](https://help.leadconnectorhq.com/support/solutions/articles/155000002774-private-integrations-everything-you-need-to-know)
- [HighLevel Public API v3](https://brewedops.com/blog/highlevel-public-api-v3)
