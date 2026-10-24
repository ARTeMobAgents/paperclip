import type { Db } from "@paperclipai/db";
import { nativeRunFinalizations } from "@paperclipai/db";
import { and, eq, gt, sql } from "drizzle-orm";
import { currentNativeControllerIdentity, type NativeControllerIdentity } from "./native-restart-recovery.js";
import { REMOTE_CONTROLLER_LEASE_MS } from "./native-runner-recovery-contract.js";

export const NATIVE_SESSION_EXECUTION_LEASE_TTL_MS = 20 * 60_000;
const NATIVE_SESSION_EXECUTION_LEASE_RENEW_INTERVAL_MS = 5 * 60_000;

export async function renewNativeSessionExecutionLease(input: {
  db: Db;
  runId: string;
  companyId: string;
  issueId: string;
  leaseOwner: string;
  attempt: number;
  controller?: NativeControllerIdentity;
  leaseTtlMs?: number;
}): Promise<void> {
  const controller =
    input.controller ?? (await currentNativeControllerIdentity());
  const leaseTtlMs = input.leaseTtlMs ?? NATIVE_SESSION_EXECUTION_LEASE_TTL_MS;
  if (
    !Number.isInteger(leaseTtlMs) ||
    leaseTtlMs < 1_000 ||
    leaseTtlMs > NATIVE_SESSION_EXECUTION_LEASE_TTL_MS
  ) {
    throw new Error("native_session_lease_ttl_invalid");
  }
  const [updated] = await input.db
    .update(nativeRunFinalizations)
    .set({
      leaseExpiresAt: sql`now() + (${leaseTtlMs} * interval '1 millisecond')`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(nativeRunFinalizations.runId, input.runId),
        eq(nativeRunFinalizations.companyId, input.companyId),
        eq(nativeRunFinalizations.issueId, input.issueId),
        eq(nativeRunFinalizations.leaseOwner, input.leaseOwner),
        eq(nativeRunFinalizations.attempt, input.attempt),
        eq(nativeRunFinalizations.controllerBootId, controller.bootId),
        eq(nativeRunFinalizations.controllerPid, controller.pid),
        eq(
          nativeRunFinalizations.controllerProcessStartedAt,
          controller.processStartedAt,
        ),
        gt(nativeRunFinalizations.leaseExpiresAt, sql`now()`),
      ),
    )
    .returning({ runId: nativeRunFinalizations.runId });
  if (!updated) throw new Error("native_session_lease_lost");
}

type RenewalInput = {
  db: Db; runId: string; companyId: string; issueId: string;
  leaseOwner: string; attempt: number; controller: NativeControllerIdentity;
  remote?: boolean;
  onLost: () => Promise<unknown>;
};
export interface NativeExecutionLeaseRenewal { stop(): Promise<void>; }

// Preparation and execution share one renewal timer. Each caller releases its
// own reference; the final release drains any SQL already in flight.
const renewals = new WeakMap<Db, Map<string, {
  input: RenewalInput; references: number; timer: ReturnType<typeof setInterval>;
  pending: Promise<void>; busy: boolean; lost: Error | null;
}>>();

export function startNativeSessionExecutionLeaseRenewal(input: RenewalInput): NativeExecutionLeaseRenewal {
  let owners = renewals.get(input.db);
  if (!owners) { owners = new Map(); renewals.set(input.db, owners); }
  let state = owners.get(input.leaseOwner);
  if (state) {
    if (state.input.runId !== input.runId || state.input.companyId !== input.companyId
      || state.input.issueId !== input.issueId || state.input.attempt !== input.attempt
      || state.input.controller.bootId !== input.controller.bootId || state.input.remote !== input.remote) {
      throw new Error("native_session_renewal_binding_changed");
    }
    if (state.lost) throw state.lost;
    state.references += 1;
  } else {
    const renew = () => {
      if (state!.lost || state!.busy) return;
      state!.busy = true;
      state!.pending = renewNativeSessionExecutionLease({ ...input,
        leaseTtlMs: input.remote ? REMOTE_CONTROLLER_LEASE_MS : undefined })
        .catch(async (error: unknown) => {
          state!.lost = error instanceof Error ? error : new Error("native_session_lease_lost");
          clearInterval(state!.timer);
          await input.onLost().catch(() => undefined);
        }).finally(() => { state!.busy = false; });
    };
    const timer = setInterval(renew, input.remote ? REMOTE_CONTROLLER_LEASE_MS / 3 : NATIVE_SESSION_EXECUTION_LEASE_RENEW_INTERVAL_MS);
    timer.unref?.();
    state = { input, references: 1, timer, pending: Promise.resolve(), busy: false, lost: null };
    owners.set(input.leaseOwner, state);
  }
  const owned = state;
  let stopped = false;
  return { stop: async () => {
    if (!stopped) {
      stopped = true;
      if (--owned.references === 0) {
        clearInterval(owned.timer);
        owners!.delete(input.leaseOwner);
      }
    }
    await owned.pending;
    if (owned.lost) throw owned.lost;
  } };
}
