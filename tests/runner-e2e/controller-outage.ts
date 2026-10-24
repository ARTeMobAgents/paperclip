import { setTimeout as delay } from "node:timers/promises";

export interface ControllerOutage {
  signal: "SIGTERM" | "SIGKILL";
  holdMs: number;
}

export interface ControllerOutageReceipt extends ControllerOutage {
  schema: "paperclip.e2e.controller-outage/v1";
  requestId: string;
  previousPid: number;
  replacementPid?: number;
  startedAt: string;
  stoppedAfterMs?: number;
  cacheDiscarded?: boolean;
  replacementStartedAfterMs?: number;
  readyAfterMs?: number;
}

export function parseControllerOutage(value: unknown): ControllerOutage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid controller outage");
  const { signal, holdMs } = value as Record<string, unknown>;
  if ((signal !== "SIGTERM" && signal !== "SIGKILL") || !Number.isSafeInteger(holdMs)
    || Number(holdMs) < 0 || Number(holdMs) > 300_000) throw new Error("Controller outage requires SIGTERM/SIGKILL and 0..300000 integer milliseconds");
  return { signal, holdMs: Number(holdMs) };
}

export function configuredControllerOutage(env: NodeJS.ProcessEnv): ControllerOutage {
  const raw = env.PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS ?? "1000";
  if (!/^\d+$/.test(raw)) throw new Error("Invalid PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS");
  return parseControllerOutage({ signal: env.PAPERCLIP_RUNNER_E2E_CONTROLLER_STOP_SIGNAL ?? "SIGKILL", holdMs: Number(raw) });
}

/** A fault receipt is required in addition to the runner's continuity receipts. */
export function validControllerOutageReceipt(value: unknown, expected?: ControllerOutage, requestId?: string): value is ControllerOutageReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as ControllerOutageReceipt;
  try { parseControllerOutage(r); } catch { return false; }
  const durations = [r.stoppedAfterMs, r.replacementStartedAfterMs, r.readyAfterMs];
  return r.schema === "paperclip.e2e.controller-outage/v1"
    && typeof r.requestId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(r.requestId)
    && typeof r.startedAt === "string" && Number.isFinite(Date.parse(r.startedAt))
    && Number.isSafeInteger(r.previousPid) && r.previousPid > 0
    && Number.isSafeInteger(r.replacementPid) && Number(r.replacementPid) > 0 && r.previousPid !== r.replacementPid
    && r.cacheDiscarded === true
    && durations.every(ms => typeof ms === "number" && Number.isFinite(ms) && ms >= 0)
    && r.replacementStartedAfterMs! - r.stoppedAfterMs! >= r.holdMs
    && r.readyAfterMs! >= r.replacementStartedAfterMs!
    && r.readyAfterMs! < 420_000
    && (requestId === undefined || r.requestId === requestId)
    && (!expected || (r.signal === expected.signal && r.holdMs === expected.holdMs));
}

/** Test harness only. Owners supply process cleanup, HTTP probing and cache paths.
 * No database mutation, runner command or production recovery hook is involved.
 */
export async function replaceController<T extends { pid?: number }>(input: {
  requestId: string; previousPid: number; outage: ControllerOutage;
  stop: (signal: ControllerOutage["signal"]) => Promise<void>;
  waitForUnhealthy: () => Promise<void>;
  discardCache: () => Promise<void>;
  start: () => Promise<T>;
  waitForReady: (replacement: T) => Promise<void>;
  cancelled: () => boolean;
  record: (receipt: ControllerOutageReceipt) => Promise<void>;
}): Promise<ControllerOutageReceipt> {
  const outage = parseControllerOutage(input.outage);
  const started = performance.now();
  const receipt: ControllerOutageReceipt = { schema: "paperclip.e2e.controller-outage/v1",
    requestId: input.requestId, previousPid: input.previousPid, startedAt: new Date().toISOString(), ...outage };
  const check = () => { if (input.cancelled()) throw new Error("Wrapper shutdown interrupted the controller outage"); };
  const record = () => input.record({ ...receipt });
  check();
  await record(); // Failed attempts retain the boundary they actually reached.
  await input.stop(outage.signal);
  await input.waitForUnhealthy();
  receipt.stoppedAfterMs = performance.now() - started;
  await record();
  await input.discardCache();
  receipt.cacheDiscarded = true;
  await record();
  while (performance.now() - started - receipt.stoppedAfterMs < outage.holdMs) {
    check();
    await delay(Math.min(100, outage.holdMs - (performance.now() - started - receipt.stoppedAfterMs)));
  }
  check();
  receipt.replacementStartedAfterMs = performance.now() - started;
  await record();
  const replacement = await input.start();
  receipt.replacementPid = replacement.pid;
  await record();
  await input.waitForReady(replacement);
  check();
  receipt.readyAfterMs = performance.now() - started;
  await record();
  if (!validControllerOutageReceipt(receipt, outage, input.requestId)) throw new Error("Controller outage did not produce a qualifying replacement receipt");
  return receipt;
}
