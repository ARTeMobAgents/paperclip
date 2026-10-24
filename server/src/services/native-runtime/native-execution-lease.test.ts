import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { startNativeSessionExecutionLeaseRenewal } from "./native-execution-lease.js";

function fixture() {
  const returning = vi.fn(async () => [{ runId: "run" }]);
  const update = vi.fn(() => ({ set: () => ({ where: () => ({ returning }) }) }));
  return { update, returning, input: { db: { update } as unknown as Db, runId: "run", companyId: "company", issueId: "issue",
    leaseOwner: "owner", attempt: 1, controller: { bootId: "boot", pid: 1, processStartedAt: new Date() }, remote: true,
    onLost: vi.fn(async () => undefined) } };
}
afterEach(() => vi.useRealTimers());
describe("native execution renewal ownership", () => {
  it("shares one timer across preparation and execution and stops idle SQL after both release", async () => {
    vi.useFakeTimers();
    const { input, update } = fixture();
    const preparation = startNativeSessionExecutionLeaseRenewal(input);
    const execution = startNativeSessionExecutionLeaseRenewal(input);
    expect(update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(update).toHaveBeenCalledTimes(2);
    await preparation.stop();
    await preparation.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(update).toHaveBeenCalledTimes(3);
    await execution.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(update).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not queue SQL behind a slow renewal and fences a lost owner", async () => {
    vi.useFakeTimers();
    const { input, update, returning } = fixture();
    let complete!: (value: { runId: string }[]) => void;
    returning.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const guard = startNativeSessionExecutionLeaseRenewal(input);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(update).toHaveBeenCalledTimes(1);
    complete([]);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(update).toHaveBeenCalledTimes(1);
    expect(input.onLost).toHaveBeenCalledTimes(1);
    expect(() => startNativeSessionExecutionLeaseRenewal(input)).toThrow("native_session_lease_lost");
    await expect(guard.stop()).rejects.toThrow("native_session_lease_lost");
    expect(vi.getTimerCount()).toBe(0);
  });
});
