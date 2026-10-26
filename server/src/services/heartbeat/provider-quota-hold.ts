import { and, desc, eq, gte, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentRuntimeState, heartbeatRuns } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";

/**
 * A terminal provider-quota failure is a shared model-capacity signal, not a
 * per-task retry hint. Until the provider-supported recovery window (or a
 * bounded fallback) elapses, automatic wakes must be parked instead of paying
 * for another zero-token invocation.
 *
 * The hold is derived from persisted terminal run rows: no new table, no
 * migration, and a restart keeps the hold because it is recomputed from the
 * latest terminal quota run. A later successful run for the same capacity
 * retires the hold immediately, so a recovered provider is never blocked until
 * the old clock expires.
 */
export const PROVIDER_QUOTA_HOLD_FALLBACK_MS = 60 * 60 * 1000;

/** Only terminal evidence inside this window can hold new wakes. */
export const PROVIDER_QUOTA_HOLD_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;

export type ProviderQuotaHold = {
  runId: string;
  agentId: string;
  issueId: string | null;
  retryAt: Date;
  capacityKey: string;
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Identity of the model capacity a run consumes. A managed AI connection
 * carries a provider/biller pair; local adapters fall back to the
 * adapter/provider pair because they share the host's logged-in account.
 *
 * The key must stay coarser than a task: the observed 2026-10-25 storm was one
 * Codex subscription shared by every local Codex agent on the host.
 */
export function resolveProviderQuotaCapacityKey(input: {
  adapterType?: string | null;
  adapterConfig?: unknown;
  runtimeConfig?: unknown;
  billingIdentity?: unknown;
}): string {
  const billing = parseObject(input.billingIdentity);
  const adapterConfig = parseObject(input.adapterConfig);
  const runtimeConfig = parseObject(input.runtimeConfig);
  const runtimeConnection = parseObject(runtimeConfig.aiConnection);
  const provider = (
    readNonEmptyString(billing.provider) ??
    readNonEmptyString(adapterConfig.provider) ??
    readNonEmptyString(runtimeConnection.provider) ??
    readNonEmptyString(input.adapterType) ??
    "unknown"
  ).toLowerCase();
  const biller = readNonEmptyString(billing.biller)?.toLowerCase();
  if (biller && biller !== "unknown") return `${provider}:biller:${biller}`;
  const account =
    readNonEmptyString(billing.accountName) ??
    readNonEmptyString(billing.identity) ??
    readNonEmptyString(billing.sessionIdentity);
  if (account) return `${provider}:account:${account}`;
  return `${provider}:adapter:${readNonEmptyString(input.adapterType)?.toLowerCase() ?? "unknown"}`;
}

/**
 * Resolve the instant a terminal quota run authorises the next invocation.
 * Explicit persisted reset metadata wins. A timezone-less clock in provider
 * text is not an absolute instant, so the bounded fallback is anchored to the
 * run finish and is never inferred from message wording.
 */
export function readProviderQuotaHoldRetryAt(
  run: {
    resultJson?: unknown;
    finishedAt?: Date | string | null;
  },
  now = new Date(),
): Date | null {
  const resultJson = parseObject(run.resultJson);
  const persisted =
    readNonEmptyString(resultJson.providerQuotaRetryNotBefore) ??
    readNonEmptyString(resultJson.transientRetryNotBefore) ??
    readNonEmptyString(resultJson.retryNotBefore);
  if (persisted) {
    const parsed = new Date(persisted);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > now.getTime()) {
      return parsed;
    }
    return null;
  }

  const finishedAt = run.finishedAt ? new Date(run.finishedAt) : null;
  if (!finishedAt || Number.isNaN(finishedAt.getTime())) return null;
  const fallback = new Date(finishedAt.getTime() + PROVIDER_QUOTA_HOLD_FALLBACK_MS);
  return fallback.getTime() > now.getTime() ? fallback : null;
}

/**
 * Automatic wakes are parked; explicit human actions keep their authority and
 * typed continuation paths (failed-run retry, task retry, durable chat/case/
 * dot/muse handoffs, execution reconciliation) keep their own semantics.
 */
export function shouldParkAutomaticWakeForProviderQuota(input: {
  manualUserWake?: boolean;
  failedRunId?: string | null;
  taskRetryRequestId?: string | null;
  durableChatRequest?: unknown;
  durableCaseHandoffRequest?: unknown;
  durableDotRequest?: unknown;
  durableMuseRequest?: unknown;
  requestedByActorType?: string | null;
  executionReconciliationWake?: boolean;
}): boolean {
  return Boolean(
    !input.manualUserWake &&
      !input.failedRunId &&
      !input.taskRetryRequestId &&
      !input.durableChatRequest &&
      !input.durableCaseHandoffRequest &&
      !input.durableDotRequest &&
      !input.durableMuseRequest &&
      input.requestedByActorType !== "user" &&
      !input.executionReconciliationWake,
  );
}

async function readAgentCapacityKey(
  db: Db,
  input: { companyId: string; agentId: string },
): Promise<{
  capacityKey: string;
  adapterType: string;
  adapterConfig: unknown;
  runtimeConfig: unknown;
} | null> {
  const [agent] = await db
    .select({
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
      runtimeConfig: agents.runtimeConfig,
    })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
    .limit(1);
  if (!agent) return null;
  const [runtimeState] = await db
    .select({ stateJson: agentRuntimeState.stateJson })
    .from(agentRuntimeState)
    .where(
      and(
        eq(agentRuntimeState.agentId, input.agentId),
        eq(agentRuntimeState.companyId, input.companyId),
      ),
    )
    .limit(1);
  return {
    capacityKey: resolveProviderQuotaCapacityKey({
      adapterType: agent.adapterType,
      adapterConfig: agent.adapterConfig,
      runtimeConfig: agent.runtimeConfig,
      billingIdentity: parseObject(runtimeState?.stateJson).billingIdentity,
    }),
    adapterType: agent.adapterType,
    adapterConfig: agent.adapterConfig,
    runtimeConfig: agent.runtimeConfig,
  };
}

/**
 * Find the newest terminal state that covers this agent's model capacity.
 * The newest matching row is authoritative: an older, longer window must not
 * outlive a newer state, and a successful run retires the hold immediately.
 */
export async function findActiveProviderQuotaHold(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    now?: Date;
  },
): Promise<ProviderQuotaHold | null> {
  const now = input.now ?? new Date();
  const current = await readAgentCapacityKey(db, input);
  if (!current) return null;

  const rows = await db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      issueId: heartbeatRuns.issueId,
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      resultJson: heartbeatRuns.resultJson,
      finishedAt: heartbeatRuns.finishedAt,
      agentAdapterType: agents.adapterType,
      agentAdapterConfig: agents.adapterConfig,
      agentRuntimeConfig: agents.runtimeConfig,
      agentStateJson: agentRuntimeState.stateJson,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .leftJoin(
      agentRuntimeState,
      eq(agentRuntimeState.agentId, heartbeatRuns.agentId),
    )
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        inArray(heartbeatRuns.status, [...TERMINAL_STATUSES]),
        gte(
          heartbeatRuns.finishedAt,
          new Date(now.getTime() - PROVIDER_QUOTA_HOLD_LOOKBACK_MS),
        ),
        or(
          eq(heartbeatRuns.errorCode, "provider_quota"),
          eq(heartbeatRuns.status, "succeeded"),
        ),
      ),
    )
    .orderBy(desc(heartbeatRuns.finishedAt))
    .limit(200);

  for (const row of rows) {
    const capacityKey = resolveProviderQuotaCapacityKey({
      adapterType: row.agentAdapterType,
      adapterConfig: row.agentAdapterConfig,
      runtimeConfig: row.agentRuntimeConfig,
      billingIdentity: parseObject(row.agentStateJson).billingIdentity,
    });
    if (capacityKey !== current.capacityKey) continue;
    if (row.errorCode !== "provider_quota") return null;

    const retryAt = readProviderQuotaHoldRetryAt(row, now);
    if (!retryAt) return null;
    return {
      runId: row.id,
      agentId: row.agentId,
      issueId:
        row.issueId ??
        readNonEmptyString(parseObject(row.contextSnapshot).issueId) ??
        null,
      retryAt,
      capacityKey,
    };
  }

  return null;
}
