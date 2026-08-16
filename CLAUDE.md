# Genesis — working conventions

Genesis is an AI app builder scoped to the HighLevel ecosystem: describe an app, an LLM
generates code that calls real HighLevel APIs, streamed live into an editor with a preview
rendering real CRM data.

- **What we build:** `docs/PRODUCT_SPEC.md`
- **How HighLevel works:** `docs/HIGHLEVEL_PLATFORM.md`
- **How we build it:** `docs/IMPLEMENTATION_PLAN.md` ← read this before starting any work

## The one rule

Work happens **one vertical slice at a time**, through the five-stage loop in
`docs/IMPLEMENTATION_PLAN.md` §1: discovery + PRD → tech plan → build → review → ship.
Each stage is a skill (`/feature-prd`, `/feature-plan`, `/feature-build`,
`/feature-review`, `/feature-ship`) and each ends in a hard stop.

Never start a slice's implementation before its PRD and tech plan are approved. Never
merge — that is the human's call, always.

## Stack

Vue 3 + TypeScript + Vite + Tailwind + shadcn-vue · Pinia + Vue Router · Firebase (Auth,
Firestore, Cloud Functions v2, Hosting) · Monaco via `@guolao/vue-monaco-editor` · Zod for
all boundary validation.

**LLM:** Claude via `@anthropic-ai/sdk`, model `claude-opus-5`, always streaming
(`client.messages.stream()`). `max_tokens: 64000` on streaming calls. Keep the HighLevel
API cheat-sheet at the front of the system prompt behind a `cache_control` breakpoint —
it is stable across every generation, so it should be a cache read, not a re-send.

Layout: `/frontend`, `/functions`, `firebase.json`, `.firebaserc`, `docs/slices/`,
`scripts/`.

## Testing

Test-first, always: the failing test exists before the implementation. Five levels —
L1 unit (Vitest), L2 component (Vue Test Utils), L3 Firestore rules
(`@firebase/rules-unit-testing`), L4 integration against emulators, L5 e2e (Playwright).
See `docs/IMPLEMENTATION_PLAN.md` §2 for what belongs at each level.

HighLevel and the LLM are **always stubbed** in automated tests, from fixtures in
`tests/fixtures/`. The sandbox account is for manual verification only.

Any new Firestore collection gets security rules and L3 rules tests in the same commit.

## Code standards

TypeScript runs `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noPropertyAccessFromIndexSignature`, and `verbatimModuleSyntax`. ESLint runs
typescript-eslint's `strictTypeChecked` + `stylisticTypeChecked` with type-aware linting, and
eslint-plugin-vue's `flat/recommended` (all three Vue rule tiers). Prettier owns formatting;
ESLint reports only real problems. Zero warnings tolerated.

The judgement calls a linter can't make — discriminated unions over optional-field soup,
`satisfies` over `as`, parse-don't-validate at boundaries, Vue reactivity choices, and the two
project-specific traps (stream accumulation, the Monaco instance) — live in
`.claude/skills/feature-review/references/typescript-vue.md`. Read it before reviewing a slice.

## Conventions

- Branches: `slice/<nn>-<slug>`
- Commits: imperative, one per green TDD cycle (`test:` then `feat:`/`fix:`)
- PR title: `Slice NN — Name`
- Slice docs live in `docs/slices/<nn>-<slug>/`

## Non-negotiables

- No secrets in source, ever. `.env` / Firebase Secret Manager only, `.env.example` kept current.
- All data access scoped to the authenticated user by security rules, not by client code.
- Streaming is mandatory for LLM calls — never request/response.
- Every new screen ships with loading, empty, and error states.
