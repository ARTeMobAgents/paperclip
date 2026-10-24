// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { HeartbeatRun } from "@paperclipai/shared";
import { afterEach, expect, it, vi } from "vitest";
import { __liveUpdatesTestUtils } from "../context/LiveUpdatesProvider";
import { LiveTranscriptInterests } from "../lib/live-transcript-interests";
import { LogViewer } from "./AgentDetail";
import { LogViewer as ProductionLogViewer } from "./AgentDetail.production";

const { log, events, empty } = vi.hoisted(() => ({ log: vi.fn(), events: vi.fn(async () => []), empty: [] }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { log, events } }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: () => ({ data: empty }),
}));
vi.mock("../adapters", () => ({
  getUIAdapter: () => null,
  onAdapterChange: () => () => {},
  buildTranscript: (lines: unknown[]) => lines,
}));
vi.mock("../components/transcript/RunTranscriptView", () => ({
  RunTranscriptView: ({ entries }: { entries: Array<{ chunk: string }> }) => <div>{entries.map(line => line.chunk).join(" ")}</div>,
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); log.mockReset(); events.mockClear(); });

it.each([LogViewer, ProductionLogViewer])("retains legacy history and reads only the next offset on visibility recovery (%#)", async (Viewer) => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const row = (seq: number, chunk: string) => JSON.stringify({ seq, ts: `2026-09-10T12:00:0${seq}Z`, stream: "stdout", chunk }) + "\n";
  const first = row(1, "retained history");
  const second = row(2, "new output");
  log.mockResolvedValueOnce({ content: first, nextOffset: first.length });
  const run = { id: "run-1", companyId: "company-1", agentId: "agent-1", status: "succeeded", logRef: "log" } as HeartbeatRun;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Viewer run={run} adapterType="codex_local" />));
    expect(container.textContent).toContain("retained history");
    await act(async () => {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("retained history");
    let complete!: (value: { content: string; nextOffset: number }) => void;
    log.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await act(async () => {
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.textContent).toContain("retained history");
    expect(log).toHaveBeenLastCalledWith("run-1", first.length, expect.any(Number), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await act(async () => complete({ content: second, nextOffset: first.length + second.length }));
    expect(container.textContent).toContain("retained history new output");
    log.mockResolvedValueOnce({ content: first, nextOffset: first.length });
    await act(async () => root.render(<Viewer run={{ ...run, id: "run-2" }} adapterType="codex_local" />));
    expect(log).toHaveBeenLastCalledWith("run-2", 0, expect.any(Number), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(container.textContent).not.toContain("new output");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each([LogViewer, ProductionLogViewer])("uses shared streaming and retains fallback reads until negotiation (%#)", async (Viewer) => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const socket = vi.fn();
  vi.stubGlobal("WebSocket", class { constructor() { socket(); } });
  log.mockResolvedValue({ content: "", nextOffset: 0 });
  const run = { id: "run-1", companyId: "company-1", agentId: "agent-1", status: "running", logRef: "log" } as HeartbeatRun;
  const root = createRoot(document.createElement("div"));
  const transcripts = new LiveTranscriptInterests();
  const messages: Array<{ revision?: number; runIds?: string[] }> = [];
  const subscription = { companyId: "company-1", transcripts, subscribe: () => () => {} };
  const { LiveEventSubscriptionContext } = __liveUpdatesTestUtils;
  try {
    await act(async () => root.render(<LiveEventSubscriptionContext.Provider value={subscription}><Viewer run={run} adapterType="codex_local" /></LiveEventSubscriptionContext.Provider>));
    const initialReads = log.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(log.mock.calls.length).toBeGreaterThan(initialReads);
    expect(events).toHaveBeenCalled();
    await act(async () => {
      transcripts.open({ send: text => messages.push(JSON.parse(text)) });
      transcripts.receive({ type: "live.capabilities", version: 1, capabilities: ["run-interests"] });
      transcripts.receive({ type: "live.subscribed", version: 1, revision: messages.at(-1)?.revision });
    });
    expect(messages.at(-1)?.runIds).toEqual([run.id]);
    const readsWhenConnected = log.mock.calls.length;
    const eventReadsWhenConnected = events.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(90_000));
    expect(log).toHaveBeenCalledTimes(readsWhenConnected);
    expect(events).toHaveBeenCalledTimes(eventReadsWhenConnected);
    expect(socket).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
  expect(messages.at(-1)?.runIds).toEqual([]);
});
