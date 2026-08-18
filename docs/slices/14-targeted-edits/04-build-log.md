## T4–T8 — the matcher, the ranges, the copy

Consolidated for the same reason as T1–T3: `resolveStep` is one function and the four verbs
share every guard before the match.

- **New:** `functions/src/llm/patch.ts` — `Step` / `LocatedStep`, `findAnchor`, `resolveStep`,
  `applySteps`. Pure; no Firestore, no I/O.
- **Edit:** `functions/src/files/schema.ts` — five `FileRejection` members and their copy, behind
  a second lead-in (`Genesis could not apply the change…`) because a located change failing is
  not "could not save the generated files".
- **Tests:** `patch.spec.ts` 44 cases, `opset.spec.ts` +10.

**Three decisions the plan left open, made here:**

- **`applySteps` returns `{ ok, ops } | { ok, error }`**, matching `validateFileOps`'s existing
  shape rather than a bare union — the call sites read the same way.
- **`patch.ts` returns `FileRejection`, not a private failure type.** The reasons need
  user-facing copy anyway, and one rejection type means one exhaustive `switch`.
- **A CRLF file stays CRLF in the lines the model writes**, not only the ones it does not.
  Mixed endings in one file are the kind of thing nobody notices until a diff.

