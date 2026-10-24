// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HeartbeatRunEvent, LiveEvent } from "@paperclipai/shared";
import { __liveUpdatesTestUtils, type CompanyLiveEventHandler } from "../../context/LiveUpdatesProvider";
import { LiveTranscriptInterests } from "../../lib/live-transcript-interests";
import { useNativeRunTranscripts } from "./useNativeRunTranscripts";

const events = vi.hoisted(() => vi.fn());
vi.mock("../../api/heartbeats", () => ({ heartbeatsApi: { events } }));
vi.mock("./native-run-events", () => ({ nativeRunEventsToTranscript: (rows: HeartbeatRunEvent[]) => rows }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { LiveEventSubscriptionContext } = __liveUpdatesTestUtils;
let root: Root;
let store: LiveTranscriptInterests;
let listeners: Set<CompanyLiveEventHandler>;
let sent: Array<{ revision?: number; runIds?: string[] }>;
let latest: ReturnType<typeof useNativeRunTranscripts>;
let subscription: { companyId: string; transcripts: LiveTranscriptInterests; subscribe: (fn: CompanyLiveEventHandler) => () => void };
const row = (seq: number, message = `row ${seq}`): HeartbeatRunEvent => ({
  id: seq, seq, runId: "run-1", companyId: "company-1", agentId: "agent-1", eventType: "item.completed",
  stream: null, level: null, color: null, message, payload: {}, createdAt: new Date("2026-10-24T00:00:00Z"),
});
function emit(seq: number) {
  const value = row(seq);
  const event: LiveEvent = { id: seq, companyId: value.companyId, type: "heartbeat.run.event", createdAt: value.createdAt.toISOString(), payload: { ...value } };
  for (const listener of listeners) listener(event);
}
function Probe({ companyId = "company-1", enabled = true }: { companyId?: string; enabled?: boolean }) {
  latest = useNativeRunTranscripts([{ id: "run-1", status: "running", runtimeMode: "native" }], { companyId, enabled });
  return null;
}
async function render(companyId = "company-1", enabled = true) {
  await act(async () => root.render(<LiveEventSubscriptionContext.Provider value={subscription}><Probe companyId={companyId} enabled={enabled} /></LiveEventSubscriptionContext.Provider>));
}
async function negotiate() {
  await act(async () => {
    store.open({ send: text => sent.push(JSON.parse(text)) });
    store.receive({ type: "live.capabilities", version: 1, capabilities: ["run-interests"] });
    store.receive({ type: "live.subscribed", version: 1, revision: sent.at(-1)?.revision });
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  events.mockReset().mockResolvedValue([]);
  root = createRoot(document.createElement("div"));
  store = new LiveTranscriptInterests(); listeners = new Set(); sent = [];
  subscription = { companyId: "company-1", transcripts: store, subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; } };
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.useRealTimers(); });

it("merges history arriving after live output without losing rows or duplicating a sequence", async () => {
  let complete!: (rows: HeartbeatRunEvent[]) => void;
  events.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await render();
  await act(async () => emit(3));
  expect(events).toHaveBeenCalledTimes(1);
  await act(async () => complete([row(1), row(2), row(3, "canonical row 3")]));
  expect(latest.transcriptByRun.get("run-1")).toEqual([row(1), row(2), row(3, "canonical row 3")]);
});

it("performs no recurring history reads after an acknowledged catch-up, and retries a failed catch-up", async () => {
  await render(); await negotiate();
  const reads = events.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(90_000));
  expect(events).toHaveBeenCalledTimes(reads);
  events.mockRejectedValueOnce(new Error("temporary history outage"));
  await act(async () => {
    store.receive({ type: "live.resync", version: 1, revision: sent.at(-1)?.revision });
    store.receive({ type: "live.subscribed", version: 1, revision: sent.at(-1)?.revision });
  });
  expect(latest.errorsByRun.has("run-1")).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(latest.errorsByRun.size).toBe(0);
  const recoveredReads = events.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(90_000));
  expect(events).toHaveBeenCalledTimes(recoveredReads);
});

it("withdraws disabled views and rejects events from the previous company", async () => {
  await render(); await negotiate();
  await act(async () => emit(1));
  expect(latest.transcriptByRun.get("run-1")).toHaveLength(1);
  await render("company-1", false);
  expect(sent.at(-1)?.runIds).toEqual([]);
  const reads = events.mock.calls.length;
  await act(async () => { emit(2); await vi.advanceTimersByTimeAsync(30_000); });
  expect(events).toHaveBeenCalledTimes(reads);
  expect(latest.transcriptByRun.get("run-1")).toHaveLength(1);
  await render("company-2");
  await act(async () => emit(3));
  expect(latest.transcriptByRun.get("run-1") ?? []).toEqual([]);
});
