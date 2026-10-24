import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { issueThreadInteractions, toolActionRequests, toolInvocations, type Db } from "@paperclipai/db";

export function toolReviewProjectionService(db: Db, reflect: (input: {
  actionRequestId: string;
  status: "executed" | "failed" | "expired" | "cancelled";
  errorCode: string | null;
  errorMessage: string | null;
  resultSummary: string | null;
}) => Promise<void>) {
  const mismatch = and(
    inArray(toolActionRequests.status, ["executed", "failed", "expired", "cancelled"]),
    sql`coalesce(${issueThreadInteractions.result}->'toolAction'->>'status', '') <> case when ${toolActionRequests.status} = 'cancelled' then 'expired' else ${toolActionRequests.status} end`,
  );
  const candidates = (cursor?: string) => db
    .select({ request: toolActionRequests, invocation: toolInvocations })
    .from(toolActionRequests)
    .innerJoin(issueThreadInteractions, eq(issueThreadInteractions.id, toolActionRequests.interactionId))
    .innerJoin(toolInvocations, eq(toolInvocations.id, toolActionRequests.invocationId))
    .where(and(mismatch, cursor ? gt(toolActionRequests.id, cursor) : undefined))
    .orderBy(asc(toolActionRequests.id));

  return {
    async sweep() {
      let cursor: string | undefined;
      let scanned = 0;
      const failures: unknown[] = [];
      for (;;) {
        const rows = await candidates(cursor).limit(100);
        for (const { request, invocation } of rows) {
          try {
            await reflect({ actionRequestId: request.id,
              status: request.status as "executed" | "failed" | "expired" | "cancelled",
              errorCode: invocation.errorCode, errorMessage: invocation.errorMessage,
              resultSummary: invocation.resultSummary?.summary ?? null });
          } catch (error) { failures.push(error); }
        }
        scanned += rows.length;
        if (rows.length < 100) break;
        cursor = rows[rows.length - 1].request.id;
      }
      if (failures.length) throw new AggregateError(failures, "Tool review projection repair failed");
      return { scanned, retry: (await candidates().limit(1)).length > 0 };
    },
  };
}
