import { expect, it } from "vitest";
import { LiveTranscriptInterests } from "./live-transcript-interests";
function fixture() {
  const store = new LiveTranscriptInterests(); const sent: any[] = [];
  const socket = { send: (text: string) => sent.push(JSON.parse(text)) };
  const capable = () => store.receive({ type: "live.capabilities", version: 1, capabilities: ["run-interests"] });
  const acknowledge = () => store.receive({ type: "live.subscribed", version: 1, revision: sent.at(-1).revision });
  return { store, sent, socket, capable, acknowledge };
}
it("unions ref-counted consumers and acknowledges the applied revision before becoming healthy", () => {
  const f = fixture(); const releaseA = f.store.acquire(["run-1"]); f.store.open(f.socket);
  expect(f.sent).toEqual([{ type: "live.hello", version: 1, capabilities: ["run-interests"] }]);
  f.capable(); expect(f.sent.at(-1).runIds).toEqual(["run-1"]); expect(f.store.snapshot().healthy).toBe(false);
  f.acknowledge(); expect(f.store.snapshot().healthy).toBe(true);
  const releaseB = f.store.acquire(["run-1"]);
  expect(f.sent).toHaveLength(2);
  releaseA(); expect(f.sent).toHaveLength(2);
  releaseB(); expect(f.sent.at(-1)).toMatchObject({ revision: 2, runIds: [] });
  releaseB(); expect(f.sent).toHaveLength(3);
});
it("handles subscription races, resync and reconnect without accepting an old ACK", () => {
  const f = fixture(); f.store.open(f.socket); f.capable();
  f.store.acquire(["run-1"]); f.store.acquire(["run-2"]);
  f.store.receive({ type: "live.subscribed", version: 1, revision: 1 });
  expect(f.store.snapshot().healthy).toBe(false);
  f.acknowledge(); const epoch = f.store.snapshot().epoch;
  f.store.receive({ type: "live.resync", version: 1, revision: f.sent.at(-1).revision });
  expect(f.store.snapshot()).toMatchObject({ healthy: false });
  f.acknowledge(); expect(f.store.snapshot().epoch).toBeGreaterThan(epoch);
  f.store.close(); expect(f.store.snapshot().healthy).toBe(false);
  f.store.open(f.socket); f.capable(); expect(f.sent.at(-1)).toMatchObject({ revision: 1, runIds: ["run-1", "run-2"] });
});
it("keeps older servers on HTTP fallback without inventing support", () => {
  const f = fixture(); f.store.acquire(["run-1"]); f.store.open(f.socket);
  expect(f.store.receive({ type: "heartbeat.run.log", payload: {} })).toBe(false);
  expect(f.store.snapshot().healthy).toBe(false);
});
it("keeps fallback available across socket-close races and excessive interests", () => {
  const f = fixture();
  expect(() => f.store.open({ send() { throw new Error("socket closed"); } })).not.toThrow();
  expect(f.store.snapshot().healthy).toBe(false);
  const release = f.store.acquire(Array.from({ length: 1_001 }, (_, index) => `run-${index}`));
  f.store.open(f.socket); f.capable();
  expect(f.sent.at(-1).runIds).toHaveLength(1_000);
  f.acknowledge(); expect(f.store.snapshot().healthy).toBe(false);
  release(); f.acknowledge(); expect(f.store.snapshot().healthy).toBe(true);
  expect(f.store.receive({ type: 42 })).toBe(false);
});
