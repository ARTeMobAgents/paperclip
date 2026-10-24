import { describe, expect, it, vi } from "vitest";
import { configuredControllerOutage, parseControllerOutage, replaceController, validControllerOutageReceipt } from "./controller-outage.js";

function fixture() {
  const order: string[] = [];
  const receipts: unknown[] = [];
  return { order, receipts, input: {
    requestId: "calibration", previousPid: 100, outage: { signal: "SIGKILL" as const, holdMs: 20 },
    stop: async (signal: string) => { order.push(signal); },
    waitForUnhealthy: async () => { order.push("http-down"); },
    discardCache: async () => { order.push("empty-cache"); },
    start: vi.fn(async () => { order.push("start"); return { pid: 200 }; }),
    waitForReady: async () => { order.push("ready"); }, cancelled: () => false,
    record: async (receipt: unknown) => { receipts.push(receipt); },
  } };
}

describe("controller outage qualification", () => {
  it("records an actual bounded outage before starting the successor", async () => {
    const f = fixture();
    const receipt = await replaceController(f.input);
    expect(f.order).toEqual(["SIGKILL", "http-down", "empty-cache", "start", "ready"]);
    expect(receipt.replacementStartedAfterMs! - receipt.stoppedAfterMs!).toBeGreaterThanOrEqual(20);
    expect(validControllerOutageReceipt(receipt, f.input.outage)).toBe(true);
    expect(validControllerOutageReceipt(receipt, { signal: "SIGTERM", holdMs: 20 })).toBe(false);
    expect(validControllerOutageReceipt(receipt, { signal: "SIGKILL", holdMs: 300_000 })).toBe(false);
    expect(validControllerOutageReceipt(receipt, f.input.outage, "another-attempt")).toBe(false);
    expect(f.receipts[0]).not.toHaveProperty("readyAfterMs");
    expect(f.receipts.at(-1)).toEqual(receipt);
  });

  it.each(["stop", "waitForUnhealthy", "discardCache", "start", "waitForReady"] as const)("retains incomplete evidence when %s fails", async stage => {
    const f = fixture();
    f.input[stage] = vi.fn(async () => { throw new Error(stage); });
    await expect(replaceController(f.input)).rejects.toThrow(stage);
    expect(f.receipts.length).toBeGreaterThan(0);
    expect(f.receipts.every(receipt => !validControllerOutageReceipt(receipt))).toBe(true);
  });

  it("cancels during the offline interval without launching another server", async () => {
    const f = fixture();
    f.input.cancelled = () => f.order.includes("empty-cache");
    await expect(replaceController(f.input)).rejects.toThrow("shutdown interrupted");
    expect(f.input.start).not.toHaveBeenCalled();
  });

  it.each([-1, 300001, 0.5, NaN, Infinity, "300000", null])("rejects invalid duration %s before signaling", holdMs => {
    expect(() => parseControllerOutage({ signal: "SIGKILL", holdMs })).toThrow();
  });
  it.each(["", "-1", "1e3", "NaN", " 1000", "300001"])("rejects invalid environment duration %s", value => {
    expect(() => configuredControllerOutage({ PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS: value })).toThrow();
  });
  it("accepts the five-minute contract without extending the runner grace", () => {
    expect(configuredControllerOutage({ PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS: "300000" }))
      .toEqual({ signal: "SIGKILL", holdMs: 300000 });
    expect(validControllerOutageReceipt({ schema: "paperclip.e2e.controller-outage/v1", requestId: "late",
      signal: "SIGKILL", holdMs: 300000, previousPid: 1, replacementPid: 2, startedAt: new Date().toISOString(),
      stoppedAfterMs: 0, cacheDiscarded: true, replacementStartedAfterMs: 300000, readyAfterMs: 420000 })).toBe(false);
  });
});
