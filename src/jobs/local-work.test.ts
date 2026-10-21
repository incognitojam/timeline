import { describe, expect, test } from "bun:test";
import { LocalWorkGate } from "./local-work";

describe("LocalWorkGate", () => {
  test("waiters run FIFO and failures release ownership", async () => {
    const gate = new LocalWorkGate();
    const release = Promise.withResolvers<void>();
    const order: number[] = [];
    const first = gate.run(async () => { order.push(1); await release.promise; });
    const second = gate.run(() => { order.push(2); throw new Error("test failure"); });
    const secondResult = second.catch((error: unknown) => error);
    const third = gate.run(() => { order.push(3); });
    await Promise.resolve();
    expect(order).toEqual([1]);
    release.resolve();
    await Promise.all([first, secondResult, third]);
    expect(await secondResult).toEqual(new Error("test failure"));
    expect(order).toEqual([1, 2, 3]);
  });

  test("aborting a waiter rejects promptly and never runs its callback", async () => {
    const gate = new LocalWorkGate();
    const release = Promise.withResolvers<void>();
    const first = gate.run(() => release.promise);
    const controller = new AbortController();
    let entered = false;
    const waiting = gate.run(() => { entered = true; }, controller.signal);
    const rejected = waiting.catch((error: unknown) => error);
    controller.abort(new Error("Stopped"));
    expect(await rejected).toEqual(new Error("Stopped"));
    expect(entered).toBe(false);
    release.resolve();
    await first;
    await gate.run(() => {});
    expect(entered).toBe(false);
  });

  test("abort does not release an active callback before it settles", async () => {
    const gate = new LocalWorkGate();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let secondEntered = false;
    const first = gate.run(async () => { started.resolve(); await release.promise; }, controller.signal);
    await started.promise;
    const second = gate.run(() => { secondEntered = true; });
    controller.abort();
    await Promise.resolve();
    expect(secondEntered).toBe(false);
    release.resolve();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });

  test("abort between acquiring and entering the callback still releases ownership", async () => {
    const gate = new LocalWorkGate();
    const controller = new AbortController();
    let entered = false;
    const work = gate.run(() => { entered = true; }, controller.signal);
    const rejected = work.catch((error: unknown) => error);
    controller.abort(new Error("Stopped"));
    expect(await rejected).toEqual(new Error("Stopped"));
    await gate.run(() => {});
    expect(entered).toBe(false);
  });
});
