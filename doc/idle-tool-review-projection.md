# Tool-review interaction repair

The tool-action request and invocation are authoritative. The interaction card
is a projection of their outcome. Previously the aggregate maintenance tick
joined these tables repeatedly, even when every card already matched.

The projection worker now reconciles at startup and after committed changes.
It retains a 30-second retry only for a mismatch or failed reconciliation.
Configured idle tools, pending reviews without terminal outcomes, and matching
terminal history have no recurring projection SQL or provider calls. This is
worker quiet, not whole-instance suspension.

## Ownership and trigger contract

`tool-review-projection.ts` owns candidate discovery and pagination. The gateway
retains card interpretation, current-state checks, locks, activity publication,
and the existing continuation callback. The scheduler consumes only `sweep`
and the returned retry obligation. No provider payload enters shared scheduling.
No table or migration is added.

The existing review notification helper now also signals projection repair.
Notifications are awaited before writes and inherit the outer transaction's
commit, rollback, and uncertainty tracking. Unrelated review changes can cause
one empty reconciliation; they do not create a recurring deadline.

| Producer | Notification ownership |
| --- | --- |
| Gateway signing, approval inference, execution claims, provider outcomes, and invalidation | Existing `writeToolReviewChange`; the closed-issue expiry path now uses it too |
| Human approval/rejection | `commitToolActionReview` signals in its existing transaction |
| Pending expiry, approved recovery, interrupted claims, Test-tab settlement | Existing review-write boundary |
| Review-queue invalidation | Existing review-write boundary |
| Interaction withdrawal, skip, terminal-issue expiry | Linked-request resolution signals before the mutation |
| Generic confirmation accept/reject, deleted-addressee cancellation | Projection notification before replacing card state in the owning transaction |
| Sibling supersession, startup duplicate cleanup, new/historical comment supersession | Projection notification before card replacement, including cases where the request is already terminal |
| Comment-based confirmation resolution | Calls the interaction owner inside the same outer transaction; its later comment-ID update shares that signal |

The audited other interaction writers do not create this mismatch: native bridge
and status-committer summary/status-only updates preserve the projection; native
review retirement owns separate completion-review cards; connection and secret
flows own their separate card types. Document-staleness and plan-resume paths
use document targets, while tool cards use `tool-action:` custom targets.
Reflection consent uses its instruction/profile/skill target keys, not tool-action
keys. A future writer that replaces tool-card result state must use the same
transaction notification boundary. A future writer that changes authoritative
tool outcomes must signal the review boundary.

## Repair, concurrency, and lifecycle

The mismatch predicate preserves the previous policy: terminal executed, failed,
expired, or cancelled requests with a linked interaction whose displayed tool
status differs. Cancelled requests display `expired`. Invocation error and result
summaries come from saved state. Repair never repeats a provider action.

Candidate queries page in request-ID order, 100 rows at a time. A card that cannot
yet be projected does not starve later pages. Per-row failures do not prevent
attempting the remaining candidates; failures keep the retry. A final mismatch
check retains retries for no-op repairs rather than silently declaring them done.
The joins inspect existing history on activation. This change removes repeated
idle scans; it does not introduce an indexed projection-debt table or claim that
an activated reconciliation has constant cost independent of history size.

The gateway locks the interaction and request, then checks the current request
status. If another repair already wrote the same status and outcome fields,
it avoids a second write and duplicate activity. Different saved details still
use the existing update path. Missing projection state remains repairable.

The shared deadline worker retains first writes during drain, failed retries,
and changes arriving during reconciliation. Shutdown joins coordinator work.
Startup reconstructs debt from existing rows. With heartbeat scheduling disabled,
startup still performs one pass, preserving the existing disabled-mode contract.
The public/manual combined review sweep remains available; server maintenance
no longer calls it periodically.

## Continuation and sleep limits

Card state is not proof that continuation delivery finished. Existing
`tool_action_deliveries` receipts and their coordinator remain responsible for
that work. Activity publication still occurs after the card transaction; this
slice does not add exactly-once activity delivery or a new outbox.

Signals remain process-local to the supported database owner. Independent SQL
writers and another active server require a separate notification/reconciliation
contract. Cloud eligibility still conservatively blocks retained tool-action
requests. No external wake or sleep-safety guard is relaxed here.

## Verification

Twelve new real-PostgreSQL cases exercise normal approval and single execution,
quiet configured and terminal-history states, four persisted outcome states,
outer commit/rollback, first write during drain, failure retry through drain,
foreground/worker repair contention, multi-page progress past an unprojectable
card, and an administrative card overwrite that reactivates repair. Quiet checks
observe absence of database reads across an hour of controlled time.

The first focused run caught a missing-projection null access in the new
idempotency check; optional access fixes it. The pagination fixture also attempted
to change a referenced request ID; it now orders the additional candidates without
mutating that key. The focused rerun passed all eleven then-existing tests.
After adding the concurrent repair case, all 148 service/startup tests and 92
gateway acceptance tests passed. Workspace typechecking and build passed. All 469 tool-access and 106 interaction
service tests also pass (815 tests across the final selections). The first
interaction run passed 105 cases but timed out in one cleanup hook during a
53-minute local run; the isolated full rerun passed in nine seconds. No production
change or timeout increase was made to force that result. Full repository tests
will run in CI; the local selections do not claim a complete repository test run.
Fresh PR CI/review remains required.
