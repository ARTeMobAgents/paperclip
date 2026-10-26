---
name: native-continuity
description: >
  Classify and recover interrupted agent work with native Paperclip signals.
  Use when a task looks stuck after a provider quota failure, a CI/QA
  transition, or a live run with no output, and decide the single legal next
  action without retries, overlays, or a custom scheduler.
---

# Native continuity

Use this skill before waking, retrying, or reassigning a task that looks stuck.
The goal is one task-bound wake for the real owner after a valid trigger, with
readback. Never infer authority from a stale monitor, an old comment, or a
cancelled run.

## Classify first

Read the latest terminal run, the issue, and the recovery actions before
choosing an action. Keep these classes separate; they have different fixes.

1. **provider_quota** - the provider rejected the call for shared capacity.
   Treat it as capacity-scoped, not task-scoped. While the persisted reset (or
   the bounded fallback) is active, automatic wakes are parked. Do not parse a
   timezone-less clock such as "try again at 2:11 AM" into an absolute instant.
2. **CI RED or QA NEEDS_FIX** - the source task has a new exact-head delivery.
   A previously scheduled monitor is now obsolete. It must not delay review of
   the new SHA, and it must not wake a second owner.
3. **Silent live run** - a run is `running` with no output sequence or empty
   log. Do not retry or kill it blindly. Require a typed operator receipt that
   names the process/PID/PGID and the effect of stopping it.
4. **Owner HOLD** - the task is owner-held or blocked. No timer, quota error,
   or retry may reopen it or schedule a future continuation.

## Required evidence

- **RED**: show the wrong next action on current behavior - a scheduled monitor
  delaying a now-actionable source fix, a QA task idle after exact-head CI is
  GREEN, a running adapter with `lastOutputSeq=0`, or a timer reopening a
  held task.
- **GREEN**: one task-bound wake for the single source owner after the valid
  trigger; readback of the created run; a new exact-head CI/QA result for the
  source fix; the old monitor cancelled or ignored only for that task.
- For a silent live run, GREEN requires the typed operator receipt before any
  retry.

## Hard limits

- No custom scheduler, daemon, cron, or source overlay. Use the native queue
  and monitor paths.
- No blind retries, no replay of cancelled runs, and no waking a takeover or
  unrelated owner.
- Do not convert an HOLD task into a future continuation.
- Do not claim live success without readback of the run/verdict.
