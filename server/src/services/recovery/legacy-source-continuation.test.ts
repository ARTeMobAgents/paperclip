import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { recoveryService } from "./service.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("legacy disposition repair source hand-back", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("legacy-source-continuation-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  it("queues one ordinary task-bound turn after a comment/status-only repair", async () => {
    const [company] = await db.insert(companies).values({ name: "Source hand-back fixture", issuePrefix: "SHF" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Source owner", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.id, title: "Implement code and tests", description: "The source fix is still pending",
      status: "todo", assigneeAgentId: agent.id,
    }).returning();
    const [repair] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, status: "succeeded", runtimeMode: "legacy",
      livenessState: "advanced", contextSnapshot: {
        issueId: issue.id, source: "issue.deliberate_wait_disposition_repair",
        legacyDispositionEpisode: { id: "same-episode", attempt: 2, maxAttempts: 2 },
      },
    }).returning();
    const enqueueWakeup = vi.fn(async (agentId: string, options?: { idempotencyKey?: string | null; contextSnapshot?: Record<string, unknown> }) => {
      const [wake] = await db.insert(agentWakeupRequests).values({
        companyId: company.id, agentId, source: "automation", status: "queued",
        idempotencyKey: options?.idempotencyKey, payload: options?.contextSnapshot,
      }).returning();
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: company.id, agentId, status: "queued", runtimeMode: "legacy",
        wakeupRequestId: wake.id, contextSnapshot: options?.contextSnapshot,
      }).returning();
      await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
      return run;
    });
    const service = recoveryService(db, { enqueueWakeup });

    expect(await service.reconcileLegacyContinuation(repair.id)).toBe("queued");
    expect(enqueueWakeup).toHaveBeenCalledOnce();
    const [, options] = enqueueWakeup.mock.calls[0]!;
    expect(options).toMatchObject({
      idempotencyKey: expect.stringContaining(":source_continuation"),
      contextSnapshot: {
        issueId: issue.id, taskId: issue.id, source: "issue.disposition_repair_source_continuation",
        legacyDispositionSourceContinuation: true, retryOfRunId: repair.id,
      },
    });
    expect(options?.contextSnapshot?.legacyDispositionEpisode).toBeUndefined();
    expect(await service.reconcileLegacyContinuation(repair.id)).toBe("skipped");
    expect(enqueueWakeup).toHaveBeenCalledOnce();
  });
});
