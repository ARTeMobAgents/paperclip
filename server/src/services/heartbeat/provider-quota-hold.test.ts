import { createDb, companies, agents, heartbeatRuns, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import {
  PROVIDER_QUOTA_HOLD_FALLBACK_MS,
  PROVIDER_QUOTA_HOLD_LOOKBACK_MS,
  findActiveProviderQuotaHold,
  readProviderQuotaHoldRetryAt,
  resolveProviderQuotaCapacityKey,
  shouldParkAutomaticWakeForProviderQuota,
} from "./provider-quota-hold.js";

describe("provider quota capacity key", () => {
  it("prefers an explicit provider/biller pair over the local adapter", () => {
    expect(
      resolveProviderQuotaCapacityKey({
        adapterType: "codex_local",
        billingIdentity: { provider: "OpenAI", biller: "ChatGPT" },
      }),
    ).toBe("openai:biller:chatgpt");
  });

  it("keeps a managed account distinct and falls back to the local adapter", () => {
    expect(
      resolveProviderQuotaCapacityKey({
        adapterType: "codex_local",
        billingIdentity: { provider: "openai", sessionIdentity: "acct-1" },
      }),
    ).toBe("openai:account:acct-1");
    expect(
      resolveProviderQuotaCapacityKey({ adapterType: "codex_local" }),
    ).toBe("codex_local:adapter:codex_local");
  });
});

describe("provider quota reset resolution", () => {
  const now = new Date("2026-10-25T12:00:00.000Z");

  it("uses a persisted absolute reset when it is still in the future", () => {
    expect(
      readProviderQuotaHoldRetryAt(
        {
          resultJson: { providerQuotaRetryNotBefore: "2026-10-25T12:30:00.000Z" },
          finishedAt: "2026-10-25T11:59:00.000Z",
        },
        now,
      ),
    ).toEqual(new Date("2026-10-25T12:30:00.000Z"));
  });

  it("never invents an instant from provider clock text and instead bounds the wait", () => {
    const finishedAt = new Date(now.getTime() - 10 * 60 * 1000);
    expect(
      readProviderQuotaHoldRetryAt(
        {
          resultJson: {
            errorFamily: "provider_quota",
            errorMessage: "You've hit your limit. Try again at 2:11 AM.",
          },
          finishedAt,
        },
        now,
      ),
    ).toEqual(new Date(finishedAt.getTime() + PROVIDER_QUOTA_HOLD_FALLBACK_MS));
  });

  it("does not hold after an expired persisted reset", () => {
    expect(
      readProviderQuotaHoldRetryAt(
        {
          resultJson: { providerQuotaRetryNotBefore: "2026-10-25T11:00:00.000Z" },
          finishedAt: "2026-10-25T10:00:00.000Z",
        },
        now,
      ),
    ).toBeNull();
  });
});

describe("automatic wake parking policy", () => {
  it("parks automatic wakes but keeps explicit human and typed continuations", () => {
    expect(shouldParkAutomaticWakeForProviderQuota({ requestedByActorType: "system" })).toBe(true);
    expect(shouldParkAutomaticWakeForProviderQuota({ manualUserWake: true, requestedByActorType: "user" })).toBe(false);
    expect(shouldParkAutomaticWakeForProviderQuota({ failedRunId: "run-1" })).toBe(false);
    expect(shouldParkAutomaticWakeForProviderQuota({ taskRetryRequestId: "wake-1" })).toBe(false);
    expect(shouldParkAutomaticWakeForProviderQuota({ durableChatRequest: {} })).toBe(false);
    expect(shouldParkAutomaticWakeForProviderQuota({ durableCaseHandoffRequest: {} })).toBe(false);
    expect(shouldParkAutomaticWakeForProviderQuota({ durableDotRequest: {} })).toBe(false);
    expect(shouldParkAutomaticWakeForProviderQuota({ durableMuseRequest: {} })).toBe(false);
    expect(shouldParkAutomaticWakeForProviderQuota({ executionReconciliationWake: true })).toBe(false);
    expect(shouldParkAutomaticWakeForProviderQuota({ requestedByActorType: "user" })).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping provider quota hold database tests: ${support.reason}`);
describe.skipIf(!support.supported)("provider quota hold", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-provider-quota-hold");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Quota hold", issuePrefix: "QH" }).returning();
    const [codex] = await db.insert(agents).values({
      companyId: company.id,
      name: "Codex agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const [claude] = await db.insert(agents).values({
      companyId: company.id,
      name: "Claude agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
    }).returning();
    return { company, codex, claude };
  }

  async function terminalRun(input: {
    companyId: string;
    agentId: string;
    status: "failed" | "succeeded" | "cancelled" | "timed_out";
    finishedAt: Date;
    errorCode?: string | null;
    resultJson?: Record<string, unknown>;
    issueId?: string | null;
  }) {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      invocationSource: "automation",
      errorCode: input.errorCode ?? null,
      resultJson: input.resultJson ?? {},
      issueId: input.issueId ?? null,
      finishedAt: input.finishedAt,
      contextSnapshot: input.issueId ? { issueId: input.issueId } : {},
    }).returning();
    return run;
  }

  it("holds the same capacity until the persisted reset and leaves other capacities free", async () => {
    const { company, codex, claude } = await fixture();
    const now = new Date("2026-10-25T12:00:00.000Z");
    const resetAt = new Date("2026-10-25T12:30:00.000Z");
    await terminalRun({
      companyId: company.id,
      agentId: codex.id,
      status: "failed",
      errorCode: "provider_quota",
      finishedAt: new Date(now.getTime() - 5 * 60 * 1000),
      resultJson: { providerQuotaRetryNotBefore: resetAt.toISOString() },
    });

    await expect(
      findActiveProviderQuotaHold(db, { companyId: company.id, agentId: codex.id, now }),
    ).resolves.toMatchObject({ retryAt: resetAt, capacityKey: "codex_local:adapter:codex_local" });
    await expect(
      findActiveProviderQuotaHold(db, { companyId: company.id, agentId: claude.id, now }),
    ).resolves.toBeNull();
  });

  it("uses a bounded window when the quota run has no absolute reset", async () => {
    const { company, codex } = await fixture();
    const now = new Date("2026-10-25T12:00:00.000Z");
    const finishedAt = new Date(now.getTime() - 10 * 60 * 1000);
    await terminalRun({
      companyId: company.id,
      agentId: codex.id,
      status: "failed",
      errorCode: "provider_quota",
      finishedAt,
      resultJson: {
        errorFamily: "provider_quota",
        errorMessage: "You've hit your limit. Try again at 2:11 AM.",
      },
    });

    await expect(
      findActiveProviderQuotaHold(db, { companyId: company.id, agentId: codex.id, now }),
    ).resolves.toMatchObject({
      retryAt: new Date(finishedAt.getTime() + PROVIDER_QUOTA_HOLD_FALLBACK_MS),
    });
  });

  it("retires the hold as soon as a newer run on the same capacity succeeds", async () => {
    const { company, codex } = await fixture();
    const now = new Date("2026-10-25T12:00:00.000Z");
    await terminalRun({
      companyId: company.id,
      agentId: codex.id,
      status: "failed",
      errorCode: "provider_quota",
      finishedAt: new Date(now.getTime() - 30 * 60 * 1000),
      resultJson: { providerQuotaRetryNotBefore: new Date(now.getTime() + 30 * 60 * 1000).toISOString() },
    });
    await terminalRun({
      companyId: company.id,
      agentId: codex.id,
      status: "succeeded",
      finishedAt: new Date(now.getTime() - 5 * 60 * 1000),
    });

    await expect(
      findActiveProviderQuotaHold(db, { companyId: company.id, agentId: codex.id, now }),
    ).resolves.toBeNull();
  });

  it("ignores terminal quota evidence outside the lookback window", async () => {
    const { company, codex } = await fixture();
    const now = new Date("2026-10-25T12:00:00.000Z");
    await terminalRun({
      companyId: company.id,
      agentId: codex.id,
      status: "failed",
      errorCode: "provider_quota",
      finishedAt: new Date(now.getTime() - PROVIDER_QUOTA_HOLD_LOOKBACK_MS - 60 * 60 * 1000),
      resultJson: { providerQuotaRetryNotBefore: new Date(now.getTime() + 60 * 60 * 1000).toISOString() },
    });

    await expect(
      findActiveProviderQuotaHold(db, { companyId: company.id, agentId: codex.id, now }),
    ).resolves.toBeNull();
  });
});
