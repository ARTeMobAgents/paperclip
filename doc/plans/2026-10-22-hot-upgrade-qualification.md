# Hot-upgrade qualification

Date: 2026-10-22. Owner: the existing Runner protocol, native runtime integration,
and Product E2E harnesses. Related implementation: [hot upgrades](2026-10-21-daytona-hot-upgrades.md),
[continuity runbook](../testing-native-remote-continuity.md), PR #17097.

## Acceptance contract

An admitted remote agent keeps its sandbox, runner process, provider session and
active turn while the control plane is unavailable for up to 300 seconds.
Server-dependent calls wait and reconnect. After HTTP returns, admitted work and
queued launches recover automatically and new work can launch without an operator
drain. The runner's existing 420-second reconnect grace includes server startup
and ownership acquisition; tests must not reset that deadline on each retry.

Postgres, the instance encryption key and the sandbox survive. This does not
promise HTTP availability while the only web server is offline, survival of a
destroyed sandbox, retroactive support in older running binaries, or reconstruction
of an acknowledged display-only log tail. Never repeat a provider turn or external
effect to fill a display gap.

## Review stack and ownership (2026-10-24)

Four PRs, reviewed in this order. PR #17097 is reused for the runner slice.
The full pre-split branch is retained as `codex/hot-upgrades-reference-2026-10-24`
at `858cfd1fdf621c56a8ce7615bdf5aecc9cf1bb61`.

| Slice | Owns | Acceptance evidence |
| --- | --- | --- |
| Runner contract | Optional opaque checkpoints, authenticated cursors, durability barriers, retention and deadlines; one-process scripted executor fixture | Outage progress, waiting, replay, persistence failures and backpressure; consumer compatibility and protocol/dependency checks |
| Server adoption | Postgres migration/encryption, transactional fencing, startup/expired-owner recovery, tool authority, detach/Stop/finalization and bounded retention | Real Postgres races, empty disk, uncertain mutations with independent effect ledger, admission and SQL gates |
| Upgrade qualification | Existing supervisor and installed-artifact verification; immutable A/B upgrade and compatible rollback, phase receipts and hosted paths | Natural lease acquisition, original execution identity, exact artifacts, short/full outages, cleanup and admission within 420 seconds |
| Transcript delivery | Additive WebSocket negotiation and run interests; shared visible browser subscriptions, catch-up and bounded delivery | Native/legacy journeys, subscription races, reconnect, congestion, company/access changes and measured viewer costs |

Tests and documentation ship with their owning behavior. Qualification defects
are fixed in the owning earlier slice. Transcript delivery is functionally
independent and has no migration. Browser interest never changes harness execution,
PRP ACKs, checkpoints, accounting or canonical logs.

The deterministic fixture links the production runner core and a scripted
`CommandExecutor` in one process. Its counter records completed workload steps;
no auxiliary daemon, HTTP service, production test endpoint or fake-provider
admission option is introduced. It distinguishes useful progress from waiting
on control-plane results and from bounded output backpressure. Synthetic execution
never qualifies an underlying harness.

Compatibility starts at the first hot-upgrade-capable protocol release. Test the
oldest supported artifact and previous release, as well as compatible rollback.
A frozen branch artifact is explicitly development-build evidence until releases
exist; HTTP readiness or a replacement task is insufficient evidence of continuity.

## Current execution evidence (2026-10-24)

Latest qualification changes and limits:

- The recovery integration file now passes 37 tests against a disposable Docker
  Postgres database. Five optional container-profile cases remain skipped.
  This includes prepared-launch adoption and warm callback ownership. The
  previous macOS semaphore setup failure was diagnosed before switching test
  infrastructure; it was not a recovery failure or a passing attempt.
- The supervisor records HTTP readiness, natural ownership acquisition,
  authenticated attachment, resumed canonical ingestion, and final backlog
  settlement separately. Its observer reads the existing coordinator and the
  Runner-owned checkpoint evidence projection. Authentication requires the
  durable connection count to increase; replaying saved events alone cannot
  pass. Times are observation upper bounds. The observer never renews or edits
  leases and never invokes recovery. Its qualification-only SQL is excluded
  from product SQL cost measurements.
- The remote workflow accepts admitted plugin task identities without treating
  the web-server PID as a remote runner PID. It permits the original turn to
  finish during the outage. An A/B/A manifest requires two independently graded
  replacements; one passing restart cannot stand in for rollback.
- The credential-free migration smoke creates an empty disposable database on
  an explicitly supplied Postgres server. A applies its own migrations before
  B starts. The embedded test helper pre-migrates databases, so it is rejected
  for artifact migration proof. A/B revisions with identical migration journals
  establish compatible startup/rollback only, not a nontrivial forward migration.
- Development artifact preparation exposed packaging gaps in plain `pnpm deploy`:
  its CLI self-reference pointed outside the installation, public entrypoints and
  CLI dependencies were not materialized, and bundled server dependencies and
  runtime skills were incomplete. These failed startup attempts ran zero agents.
  The fixture uses the existing release manifest generators and bundled-package
  preparer, stages release skills, and contains all dependency links before
  freezing a new complete-tree hash. No failed tree is qualified.

The 300-second active-agent upgrade, hosted continuity, representative concurrent
admission, stale-owner partition, browser journeys, and released-version matrix
remain acceptance gates. Do not infer them from the unit or zero-agent smoke
results below.

- Runner PR [#17097](https://github.com/paperclipai/paperclip/pull/17097)
  contains the optional contract and one-process fixture. Server PR
  [#17439](https://github.com/paperclipai/paperclip/pull/17439) contains its
  Postgres consumer. Both remain drafts until their outstanding gates pass.
- The fixture passed all three scenarios (external persistence, filesystem-only
  consumer, and reconnect deadline); 191 controller/profile tests, 96 Rust
  durability tests and 11 replay-parity tests passed on the initial split.
- Real Postgres cost comparison: 8 and 512 text chunks each produced 8 checkpoint
  writes, 7 transactions and 14 changed rows for identical control operations.
  Both measured zero streaming checkpoint SQL/transactions/rows and zero idle
  SQL. WAL was 37,408 and 37,528 bytes, respectively; this diagnostic is not a
  production capacity estimate. Private receipt:
  `/tmp/paperclip-hot-upgrade-pr2-sql-cost-20261024-2.json`.
- Independent mutation tests passed for both a lost HTTP response after the
  project row committed and a lost runner response after the API receipt was
  saved. Each checked the business table independently and counted one dispatch.
- The real-process recovery suite passed 35 cases and exposed one prepared-task
  adoption failure: recovery lacked the original working directory. The runner
  repair reads the checkpoint's original launch descriptor without re-preparing
  resources; its focused process regression passed. The broader post-fix rerun
  remains pending: macOS exhausted system-wide Postgres semaphores during setup.
  No production reliability claim is based on the failed setup.
- The initial runner slice passed workspace typecheck. The broad local test run
  was interrupted after concurrent database campaigns exhausted host resources;
  it is not a passing full-suite result. Three dependency-boundary violations
  existed unchanged on the selected master baseline and remain to be resolved
  or reported explicitly. CI and review completion are still pending.
- Installed-artifact qualification now supports a manifest selected by
  `PAPERCLIP_RUNNER_E2E_UPGRADE_ARTIFACTS`, with distinct A/B complete installation
  tree hashes, entrypoint pins, baked-in build revisions and an A/B/A sequence.
  The existing supervisor verifies each installed tree before launch and checks
  `/api/health`'s actual serving commit. It never supplies a build SHA to the
  server environment. The credential-free replacement smoke runs the sequence
  against one surviving Postgres instance, but explicitly qualifies **zero agent
  turns**. Active continuity, natural ownership/attachment phase receipts, full
  300-second A/B and rollback runs, and hosted evidence remain outstanding.

## Evidence layers

| Layer | Execution and owner | What it proves | Cadence |
| --- | --- | --- | --- |
| Protocol | Runner tests; controlled ACK/persistence/effect faults | Replay, authenticated sparse cursors, durable barriers, bounded queues | Every relevant PR |
| Recovery integration | Real Postgres and Rust runner; deterministic provider | Ownership races, encryption, empty cache, side-effect settlement, same turn | Every relevant PR |
| Server replacement | Product E2E wrapper kills/replaces the actual main server; production HTTP workflow | Startup adoption, natural lease timing, same sandbox/run, finalization and admission | Relevant PR; exact hosted cell before release |
| Version compatibility | Immutable server A then B, admitted runner digest, real migrations; compatible rollback | Upgrade contract across different artifacts | Before release |
| Efficiency | Identical scripted workload with and without checkpoints, plus restart burst | Incremental DB work, latency, throughput, backlog and resource bounds | Relevant PR; capacity campaign before release |

Keep these claims separate. A scripted provider is a reproducible correctness
instrument, not a qualification of the real provider or Daytona. A same-version
restart is not an A-to-B upgrade. A wrapper test is not an agent continuity test.

## Fault and workload matrix

Start with one server replacement and one cost comparison; extend the same harness
rather than create parallel recovery implementations or production test switches.

| Axis | Required cases |
| --- | --- |
| Fault | Graceful stop; SIGKILL; transport partition with old owner alive |
| Unavailability | Short; around the natural lease expiry; full 300 seconds |
| Work at boundary | Streaming; server read waiting; mutation committed with response lost; completion during outage; queued launch |
| Competition | Two successors; stale owner resumes; Stop/authority change; second restart during recovery |
| Versions | A to B plus migrations; B to compatible A; unsupported runner fails explicitly |
| Load | Expected peak; twice peak; synchronized reconnects; idle with retained history |

The harness records that the original run was active at injection. An unexercised
boundary fails, even if a later task succeeds. Use deterministic gates for the
scripted workload; wall-clock sleeps alone cannot establish where an effect was.
Never edit lease timestamps or recovery state in a server-replacement journey.

## Hard correctness gates

- Preserve sandbox lease, runner PID **and process start identity**, provider
  session and active turn. The provider call ledger must show one turn start.
- Check an external fixture's effect ledger independently: a write occurs once,
  including when its response is lost. Tool-ID deduplication alone is insufficient.
- An uncertain write is visibly held; an ordinary read can retry under current
  authority. A stale owner cannot write a command or acknowledge an event.
- The original run commits once, including accounting and workspace finalization;
  no stranded operation or recovery action remains.
- Queued/admitted work resumes and a newly submitted task launches after readiness.
- Record fault receipt, actual elapsed outage, server readiness, natural ownership
  eligibility, reattachment and backlog-drained times separately. Recovery must
  fit the original 420-second grace. A healthy HTTP endpoint alone cannot pass.
- Missing provenance, missing boundary evidence, unexpected skips, cleanup failure
  and automatic retry do not qualify an attempt.

## Efficiency gates and measurements

The lean design keeps control state, not a second transcript. The existing run
log, business writes and 20-second lease renewals remain baseline work.

1. **Zero checkpoint writes for ordinary text chunks.** Compare a small stream
   and a much larger stream with the same control operations. Assert callback,
   SQL and changed-row counts, not just final table size. Updates to one row are
   still load. Calibration must make a deliberate extra write fail the gate.
2. **Zero added checkpoint SQL while idle after startup.** Exercise both empty
   and retained history. Retention may do its bounded startup pass; the existing
   filesystem cleanup timer must not query checkpoint rows.
3. **Measure each control boundary.** Capture checkpoint transactions, inserted/
   updated/deleted rows, payload bytes, WAL bytes and lock waits in an isolated
   Postgres database. Report measurement-query overhead separately. Never count
   a mocked persistence callback as a WAL measurement.
4. **Compare normal-operation cost first**, then restart cost: same fixed seed,
   concurrent agents, output rate, tool mix and duration; warmup plus repeated
   paired samples. Report throughput, CPU, peak RSS and p50/p95/p99 control latency.
   Provisional acceptance is at most 5% throughput regression at expected peak;
   establish the baseline and expected peak before treating that as a release gate.
5. **Bound backlog and recovery pressure.** A five-minute outage must fit the
   configured runner outbox budget and drain without starving new commands or
   fresh admissions. At twice peak, pressure must remain bounded and explicit.

Do not infer production dollars or capacity from a laptop timing result. Persist
raw sample counts and distributions; noisy timing is diagnostic, not a flaky
single-sample CI assertion. Structural zero-write checks are deterministic gates.

## Attempt record and implementation order

Every attempt retains the two server revisions/artifact digests, runner digest,
workload configuration, fault receipt, monotonic elapsed times, independent effect
ledger, recovery identity, database measurements and cleanup outcome. Store private
logs under the existing harness private-artifact policy; publish only sanitized
receipts. Keep failed attempts alongside subsequent successes; no automatic retries.

1. Add a bounded, cancellable actual-server outage to the existing restart wrapper,
   with a receipt the remote continuity grader requires. Test missing/incorrect
   receipts and real process replacement. Leave the existing finalization fault
   and local process ownership contracts intact.
2. Add repeatable Postgres checkpoint-write measurements to the existing native
   integration suite, including the zero-stream-write gate and a positive control.
3. Run the exact hosted remote continuity cell at short and full-contract outages.
   Resolve the image-builder disk failure before another paid attempt. Do not
   promote a suite that failed before sandbox launch.
4. Extend to pinned A/B artifacts, deterministic mixed workload/effect faults,
   two-owner contention, outbox pressure and the paired peak-load benchmark.

## Evidence status at the start of this slice

- Existing tests cover authenticated sparse replay, transactional checkpoint
  fencing, uncertain tool recovery, delta updates and idle/retention behavior.
- The 300-second integration proof uses real Postgres/Rust and a scripted provider,
  deletes controller files, and retains the active turn. It **manually expires a
  lease and does not replace the main server**; it is not the server-upgrade gate.
- The hosted `everyday-workflows.runner-codex.daytona.recover-controller` cell
  already replaces the server and grades original-run identity and finalization,
  but needs an explicit outage receipt and configurable crash/outage duration.
- Hosted attempts 39613279281 and 39616972414 failed in image preparation with
  ENOSPC before sandbox launch. No Daytona continuity pass is claimed.
- Different server versions, independent external-effect counting, mixed-load
  capacity/WAL measurements and production cost estimates are not yet qualified.

Implementation results and exact commands belong below, with their limitations.

## Implemented qualification slice

- `tests/runner-e2e/controller-outage.ts` owns bounded fault injection and
  monotonic phase receipts. The actual server wrapper uses it only for the
  explicit remote cache-replacement cell. Signal, minimum hold (0..300000 ms),
  old/new process IDs and incomplete attempts are inspectable. Cancellation
  prevents a successor launch. Missing/short/foreign fault receipts fail grading.
- The existing hosted cell defaults to SIGKILL and a 1000 ms hold, requires this
  receipt, and forbids automatic retries. Its definition version and harness
  fingerprint changed. The full hold is selectable using
  `PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS=300000`; SIGTERM is also selectable.
- `controller-replacement-smoke.ts` is a credential-free actual-main-server
  probe with Postgres owned by the test driver. It checks unchanged Postgres
  start time, existing HTTP data, new HTTP mutations and complete process cleanup.
  It deliberately reports `activeAgentContinuityQualified: false`.
- The native restart integration suite now measures actual checkpoint SQL through
  postgres.js, checkpoint transactions/changed rows/bytes, diagnostic cluster WAL,
  and elapsed time for identical control operations with 8 versus 512 text chunks.
  The fixture holds text until control setup settles, then each released stream
  must add zero SQL statements, transactions or changed rows. Total control setup
  counts remain diagnostic because batching can vary. A subsequent real control
  write calibrates the observer. A settled-stream interval must issue zero SQL. Broader
  idle cleanup remains covered by the existing retention tests. These timings and
  WAL values are not a paired capacity benchmark or production cost estimate.

Commands (run from the repository root):

```sh
pnpm test:e2e:runner:typecheck
pnpm test:e2e:runner:unit -- --maxWorkers=2
node cli/node_modules/tsx/dist/cli.mjs tests/runner-e2e/controller-replacement-smoke.ts
PAPERCLIP_TEST_CHECKPOINT_COST_REPORT=/tmp/checkpoint-cost-attempt-1.json pnpm exec vitest run server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts -t 'keeps checkpoint SQL independent' --maxWorkers=1
```

Choose a new cost-report filename for each attempt; existing evidence is never
overwritten. Build the existing Rust fake provider after changing its fixture
flags (`cargo build --manifest-path packages/paperclip-runner/runner/Cargo.toml
--locked -p paperclip-runner-core --bin fake-codex-app-server`). No LLM credentials
are needed for these local probes.

Initial evidence on 2026-10-22:

- 50 focused fault/oracle tests passed. Server typecheck passed.
- Actual-main-server SIGKILL smoke passed: a 1000 ms confirmed-down hold, readiness
  62.82 seconds after injection, unchanged Postgres start time, data continuity,
  new mutation and confirmed cleanup. This used source revision 436b2ce12 plus
  the working changes, not two released artifacts.
- The real Postgres/Rust cost gate passed with 64 times as many text chunks.
  Earlier 4096-chunk attempts exceeded the original ten-second observation bound;
  they did not establish a DB regression or pass. The fast gate now uses 8/512
  and a bounded 60-second observation window. Large backlog capacity remains a
  separate gate, not silently qualified by this smaller sample.
- The first smoke launcher attempt failed on workspace package imports before
  server launch. Direct source imports fixed the standalone entrypoint.
- The first complete support-suite run had 3571 passing tests, two explicit skips,
  and five failures in existing catalog version/count and Daytona image-input
  assertions. These must be reconciled before calling this slice PR-ready.

Follow-up validation on the merged branch (`d0a0b830e7`, plus the request-receipt
correlation check):

- The full **300000 ms** actual-main-server SIGKILL smoke passed with Postgres
  continuously alive, old controller cache unavailable, existing data readable,
  a new HTTP mutation accepted and cleanup confirmed. This remains a zero-provider
  startup/DB proof; it does not upgrade the hosted agent result to a pass.
- The complete native restart integration file passed **34 tests**, with five
  Docker-dependent cases skipped. The focused protocol and Copilot identity
  suites passed **191 tests**. Fault/oracle tests passed **50 tests**.
- Workspace `pnpm -r typecheck` and `pnpm build` passed. Earlier typecheck attempts
  found a sandbox IPC restriction and Rust fixture formatting; the permitted,
  formatted rerun passed. The merged source preserves master's Copilot v58 and
  declares the combined recovery transport as v59, including Docker image inputs.
- The reconciled Product E2E support run passed 3573 tests and skipped two, but one
  file's worker failed to start. Its separate rerun passed all three tests, and
  the follow-on Node suite passed 128 tests. The full invocation remains recorded
  as incomplete; it is not relabeled a clean full-suite run.

Measured control-checkpoint cost for one scripted turn:

| Text chunks | Transactions | SQL writes | Changed rows | Plaintext checkpoint bytes | Cluster WAL bytes | Settled-stream idle SQL |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 8 | 7 | 8 | 14 | 13618 | 37224 | 0 |
| 512 | 7 | 8 | 14 | 13636 | 37632 | 0 |

Control operations are included; the output stream adds no checkpoint writes.
WAL is a diagnostic cluster-level observation, including possible background
work, not an exact attribution or threshold. This is not the promised paired
peak-capacity campaign. A new control command after each sample produced a real
SQL write, establishing that the observer was active.

Still outstanding: hosted active-agent proof (including the full 300-second
outage), version A/B artifacts and migration/rollback, deterministic mixed
work/effect ledger, natural-lease race matrix, and paired peak/overload measurements.
The hosted blocker was confirmed in the retained build log: BuildKit exhausted
disk while exporting the image, before the workflow could launch any sandbox.

Review found a read-recovery gap: the copied retry list omitted identity, people,
skill and workspace reads. Their saved inputs could remain pending after a lost
response. Recovery now consumes the Runner's existing canonical side-effect
classification, plus read/mutation metadata on server bridge definitions. The
server shim exposes that existing Runner metadata; it adds no alternate authority.
Read replay calls the normal executor and therefore rechecks advertisement,
company/run scope, current grants and file confinement. External tool annotations
never authorize uncertain-effect replay. Four focused Postgres regressions passed,
including actual file reads, company isolation, missing-file settlement, revoked
workspace grants, stale leases and cancellation. Initial attempts used the wrong
catalog projection and lacked the shim export; existing read tests and typecheck
caught both before the corrected run passed.

Master advanced during final verification. The merge preserves its released
0372 workspace-restore migration and regenerates the combined checkpoint table
and header index as 0373_powerful_mentor from the complete master snapshot. The
checkpoint SQL retains its idempotent guards; the latest five snapshots remain.
This supersedes the earlier 0372/0373 checkpoint numbering in the historical plan.

The merged CI run caught a timing assumption in the initial cost comparison:
control messages coalesced into seven SQL writes in one sample and eight in the
other. That is a failed attempt, not a zero-write proof. The fixture now holds
text behind an explicit release file until turn-start events and command results
are durably settled. Each text-only interval must independently cause zero SQL,
transactions and changed rows; total control counts are measurements, not equality
assertions. The existing positive control still verifies the SQL observer.
The first gated local attempt passed: both 8 and 512 chunks added zero SQL,
transactions and changed rows, with zero idle SQL and a successful positive
control. The full merged restart suite passed 36 tests (five Docker-only skips),
and all 29 tool-authority tests passed on a serial rerun after an initial database
setup timeout. Workspace typecheck also passed after the migration merge.
