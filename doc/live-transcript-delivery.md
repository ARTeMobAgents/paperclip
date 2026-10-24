# Interested transcript delivery

The company WebSocket is a presentation channel. Its subscriptions cannot change
runner execution, PRP acknowledgements, recovery checkpoints, accounting, or
canonical run logs. Authorization and redaction still run at delivery, including
after access is revoked. A subscription is never an authorization grant.

## Additive negotiation

Older clients receive the existing full event stream. New clients first send
`live.hello` with `version: 1` and `capabilities: ["run-interests"]`. A compatible
server replies with `live.capabilities` carrying the same version and capability.
An older server can ignore the hello; the client retains HTTP polling.

The browser then sends `live.interests`, a monotonically increasing `revision`,
and a replacement `runIds` array. The server applies that complete set before
replying with `live.subscribed` and the applied revision. The browser ignores
stale acknowledgements. Every connection starts a new revision sequence.

All mounted consumers share the existing company connection. Interests are
reference counted: removing one of two views of the same run does not unsubscribe
the other. Disabled views and hidden tabs withdraw their interests. Company and
account changes dispose the old connection. Progress, lifecycle, attention, and
activity notifications continue independently of transcript interests.

For an uninterested run, full `heartbeat.run.event` and `heartbeat.run.log`
payloads become an authorized `heartbeat.run.activity` notification containing
only run ID, agent ID, and last-output time. These notifications are coalesced to
at most one per run per second, driven by output rather than an idle timer.

## Catch-up and ordering

Consumers install their event listener before advertising interest. After the
latest subscription is acknowledged they read canonical history, merging it with
events that arrive during the read. Native events deduplicate by run sequence;
legacy logs also track log identity and persisted byte offsets. Streamed rows
never advance the persisted-history cursor. A second sequence gap observed during
an in-flight read remains pending until history covers it.

Catch-up runs on subscription, reconnect, show, explicit resynchronization, gaps,
and terminal status. Live catch-up drains pending pages. Failed reads retry even
when the socket remains connected. After successful negotiated catch-up there
are no recurring transcript reads. Historical agent-detail logs retain their
existing explicit pagination. Older clients and servers retain fallback polling.

## Backpressure

Each connection retains at most 1,000 queued items and 1 MiB across queued payloads
and socket buffering. Authorization that is still in flight counts toward the
queue. Interests are checked again after asynchronous authorization. Incoming
interest messages have a 64 KiB transport limit and at most 1,000 run IDs.

Overflow discards pending delivery work, invalidates in-flight results, and sends
`live.resync` with the affected revision. The browser replaces its interests and
catches up after the new acknowledgement. It also refreshes active application
queries because overflow can drop lifecycle messages. Persistent congestion
closes the socket with code 1013 after five seconds; this timer exists only while
congestion is pending. An older client is closed on overflow so its normal
reconnect path can catch up.

The server does not persist a browser-specific event backlog. Canonical history
is the recovery source. Execution continues whether there are zero viewers or
many viewers.

## Verification

The delivery tests cover legacy compatibility, authorization/redaction, revoked
access, interest changes during authorization, item and byte bounds, and the
congestion deadline. Browser-hook tests cover reference counting, acknowledgement
races, history/live ordering, failed reads, hide/show, company changes, terminal
catch-up, and zero recurring reads after negotiation.

`server/src/realtime/live-event-delivery.cost.test.ts` compares identical output
with zero interests, one viewer, three browser connections, and simulated socket
congestion. Set `PAPERCLIP_LIVE_DELIVERY_COST_REPORT` to retain its JSON report.
This measures the in-process presentation boundary, not production network or
database cost. CPU, heap deltas, and latency are diagnostic measurements, not
performance assertions. Current acceptance evidence lives in
`doc/plans/2026-10-22-hot-upgrade-qualification.md`.
