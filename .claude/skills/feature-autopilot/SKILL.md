---
name: feature-autopilot
description: Run the whole five-stage slice loop unattended — PRD, plan, build, review, ship, wait for CI, merge, next slice — each stage in a fresh headless session. Use when the user asks to keep building and shipping slices without a human in the loop, to run the remaining slices end to end, or when invoked as /feature-autopilot.
---

# Autopilot — the five-stage loop with no human in it

This skill does not itself write a PRD or any code. It launches
`scripts/autopilot.sh`, which drives the five existing stage skills, one fresh
`claude -p` session per stage, slice after slice, merging each one before the
next begins.

**Argument:** optional slice range — `/feature-autopilot`, `/feature-autopilot 5`
(start at 5), `/feature-autopilot 5-8`, or `/feature-autopilot --only "8 9"`.

## What it actually runs

Per slice: **PRD → plan → build → suite gate → review → suite gate → ship →
squash-merge → checkout main, pull → next slice.**

The merge rides on the *local* gate, which runs the same six suites CI does on
the same commit. CI still runs on main behind the merge; `--wait-ci` puts it
back in front, at the cost of minutes per slice.

The division of labour is the thing worth understanding:

- **The model** does every stage, in a fresh context each time. The handoff between
  stages is the repo — the PRD, the plan, the build log, the review, the code.
  Nothing is carried in memory.
- **The script** owns everything irreversible and everything that counts as
  evidence: running the suite itself rather than trusting a "tests pass" claim,
  checking the stage's artefact exists on disk, waiting on GitHub checks, and
  merging. A stage passed when the file is there and the suite is green.

Sessions get an appended system prompt that forbids `AskUserQuestion` (no one is
there), forbids merging, force-pushing, deploying and weakening tests, and tells
them to stop at their skill's hard stop rather than run the next stage.

## Launching it

Long-running — hours per slice. Launch it in the background and let it be:

```bash
scripts/autopilot.sh                  # slice 3 through 13
scripts/autopilot.sh --from 5         # resume at 5
scripts/autopilot.sh --only "8 9"     # just those
scripts/autopilot.sh --dry-run        # print the queue, run nothing
scripts/autopilot.sh --no-merge       # open the PR, leave the merge to a human
scripts/autopilot.sh --wait-ci        # gate each merge on GitHub checks as well
```

Run it with `run_in_background: true` and report the log paths, or hand the user
the command to run in their own terminal — the second is usually better, since a
run outliving this session is the point.

Useful environment knobs: `AUTOPILOT_MODEL`, `AUTOPILOT_FALLBACK_MODEL`,
`AUTOPILOT_MAX_BUDGET_USD`, `AUTOPILOT_STAGE_RETRIES`, `AUTOPILOT_FIX_ATTEMPTS`,
`TIMEOUT_BUILD` and friends. All documented at the top of the script.

## Watching it

- `.autopilot/autopilot.log` — the run narrative, one line per stage transition
- `.autopilot/logs/<nn>/<stage>.<attempt>.jsonl` — the full transcript of that session
- `.autopilot/logs/<nn>/gate-*.log` — the suite output the gate actually judged
- `.autopilot/state/<nn>.<stage>.done` — stage markers; a re-run resumes from these

`tail -f .autopilot/autopilot.log` is the view worth having open.

## When it stops

It stops rather than guesses. Each of these ends the run with the reason in the log:

| It stopped because | What to do |
|---|---|
| A stage produced no artefact after its retries | Read that stage's `.jsonl`, fix the blocker, re-run — completed stages are skipped |
| The suite stayed red through the fix attempts | Read `gate-*.log`; this usually means a real defect the model could not close |
| CI stayed red through the fix attempts | Read the PR's checks; often environmental (`npm ci`, a file not committed) |
| The working tree was dirty on `main` | Resolve it by hand and re-run |

Re-running is always safe. State markers mean it picks up where it left off
rather than redoing merged work.

## Judgement to apply before launching

- **Check where the build actually is** — `git log --oneline -5` and the status
  table in `docs/IMPLEMENTATION_PLAN.md` §0. Autopilot defaults to starting at
  slice 3; if more has merged since, pass `--from`.
- **Dependencies are strict.** Slices run in order because slice 9 cannot start
  before 8 merged. Don't reorder the queue to parallelise.
- Tell the user plainly what they are authorising: unattended commits, PRs, and
  squash-merges into `main` for every queued slice. That is the whole point of
  the skill, but it should be said once, out loud, before the first merge lands.
