import { afterEach, expect, it, vi } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import { createLiveEventDelivery, LIVE_DELIVERY_MAX_BYTES, LIVE_DELIVERY_MAX_ITEMS } from "./live-event-delivery.js";

const event = (seq = 1, runId = "run-1"): LiveEvent => ({ id: seq, companyId: "company", type: "heartbeat.run.log",
  createdAt: "2026-10-24T00:00:00Z", payload: { runId, agentId: "agent", seq, chunk: "output" } });
function fixture(authorize = vi.fn(async (value: LiveEvent) => value as LiveEvent | null)) {
  const frames: any[] = [];
  const socket = { readyState: 1, bufferedAmount: 0, send: vi.fn((text: string, callback?: (error?: Error) => void) => {
    frames.push(JSON.parse(text)); callback?.();
  }), close: vi.fn() };
  const decorate = vi.fn(async (value: LiveEvent) => ({ ...value, toastEligible: true }));
  const onError = vi.fn();
  const delivery = createLiveEventDelivery({ socket, authorize, decorate, onError });
  const subscribe = (runIds: string[], revision = 1) => delivery.receive(JSON.stringify({ type: "live.interests", version: 1, revision, runIds }));
  return { socket, frames, delivery, subscribe, authorize, decorate, onError };
}
const settle = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

it("leaves older clients on the full stream and negotiates only after a client hello", async () => {
  const f = fixture();
  expect(f.frames).toEqual([]);
  f.delivery.enqueue(event()); await settle();
  expect(f.frames[0].payload.chunk).toBe("output");
  f.delivery.receive(JSON.stringify({ type: "live.hello", version: 1 }));
  expect(f.frames.at(-1)).toMatchObject({ type: "live.capabilities", capabilities: ["run-interests"] });
  f.delivery.dispose();
});
it("filters full transcripts before authorization while keeping bounded authorized activity and lifecycle", async () => {
  const f = fixture(); f.subscribe([]);
  const original = event();
  for (let i = 0; i < 512; i++) f.delivery.enqueue({ ...original, id: i });
  f.delivery.enqueue({ ...event(), type: "heartbeat.run.status", payload: { runId: "run-1", status: "succeeded" } });
  await settle();
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.frames.filter(frame => frame.type === "heartbeat.run.log")).toEqual([]);
  expect(f.frames.find(frame => frame.type === "heartbeat.run.activity").payload).toEqual({ runId: "run-1", agentId: "agent", lastOutputAt: original.createdAt });
  expect(f.frames.at(-1)).toMatchObject({ type: "heartbeat.run.status", toastEligible: true });
  expect(original.payload.chunk).toBe("output");
  f.delivery.dispose();
});
it("reauthorizes each interested delivery and rechecks interests after an asynchronous permission lookup", async () => {
  let release!: (event: LiveEvent) => void;
  const f = fixture(vi.fn(() => new Promise<LiveEvent>(resolve => { release = resolve; })));
  f.subscribe(["run-1"]); f.delivery.enqueue(event());
  f.subscribe([], 2); release(event()); await settle();
  expect(f.frames.filter(frame => frame.type === "heartbeat.run.log")).toEqual([]);
  expect(f.frames.at(-1)).toMatchObject({ type: "live.subscribed", revision: 2 });
  f.delivery.dispose();
});
it("cannot turn run interest into authorization or bypass delivery redaction", async () => {
  const f = fixture(vi.fn(async value => value.payload.seq === 1 ? { ...value, payload: { ...value.payload, chunk: "redacted" } } : null));
  f.subscribe(["run-1"]); f.delivery.enqueue(event()); f.delivery.enqueue(event(2)); await settle();
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.frames.filter(frame => frame.type === "heartbeat.run.log").map(frame => frame.payload.chunk)).toEqual(["redacted"]);
  f.delivery.dispose();
});
it.each(["items", "bytes"])("bounds queued %s, notifies resynchronization and resumes only after a new revision", async kind => {
  let release!: (event: LiveEvent) => void;
  const f = fixture(vi.fn(() => new Promise<LiveEvent>(resolve => { release = resolve; })));
  f.subscribe(["run-1"]); f.delivery.enqueue(event());
  if (kind === "items") for (let i = 0; i < LIVE_DELIVERY_MAX_ITEMS; i++) f.delivery.enqueue(event(i + 2));
  else f.delivery.enqueue({ ...event(2), payload: { ...event(2).payload, chunk: "x".repeat(LIVE_DELIVERY_MAX_BYTES) } });
  expect(f.delivery.metrics()).toMatchObject({ needsResync: true });
  expect(f.delivery.metrics().retainedBytes).toBeLessThanOrEqual(LIVE_DELIVERY_MAX_BYTES);
  expect(f.delivery.metrics().retainedItems).toBeLessThanOrEqual(LIVE_DELIVERY_MAX_ITEMS);
  expect(f.frames.filter(frame => frame.type === "live.resync")).toHaveLength(1);
  release(event()); await settle();
  expect(f.frames.filter(frame => frame.type === "heartbeat.run.log")).toHaveLength(0);
  f.subscribe(["run-1"], 2);
  expect(f.delivery.metrics().needsResync).toBe(false);
  f.delivery.dispose();
});
it("closes persistent congestion on its pending-work deadline without another source event", async () => {
  vi.useFakeTimers();
  const f = fixture(); f.subscribe(["run-1"]); f.socket.bufferedAmount = LIVE_DELIVERY_MAX_BYTES;
  f.delivery.enqueue(event()); await vi.advanceTimersByTimeAsync(5_000);
  expect(f.socket.close).toHaveBeenCalledWith(1013, "persistent event backlog");
  f.delivery.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("recovers failed delivery reads through resync rather than silently claiming healthy streaming", async () => {
  const f = fixture(vi.fn(async () => { throw new Error("permission database unavailable"); }));
  f.subscribe(["run-1"]); f.delivery.enqueue(event()); await settle();
  expect(f.frames.at(-1)).toMatchObject({ type: "live.resync" });
  expect(f.onError).toHaveBeenCalledOnce(); f.delivery.dispose();
});
it("rejects unbounded interest sets and stale revision commands", () => {
  const f = fixture(); f.subscribe(["run-1"]); f.subscribe([], 1);
  expect(f.socket.close).toHaveBeenCalledWith(1008, "invalid run interests");
  const other = fixture(); other.subscribe(Array.from({ length: 1001 }, (_, i) => `run-${i}`));
  expect(other.socket.close).toHaveBeenCalled();
  f.delivery.dispose(); other.delivery.dispose();
});
