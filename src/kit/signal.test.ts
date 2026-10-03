import { describe, expect, it } from "vitest";
import { batch, computed, effect, signal, untracked } from "./signal";

describe("signal store", () => {
  it("re-runs effects when a read signal changes", () => {
    const a = signal(1);
    const seen: number[] = [];
    effect(() => seen.push(a()));
    a.set(2);
    a.set(2);
    expect(seen).toEqual([1, 2]);
  });

  it("computes derived values", () => {
    const a = signal(2);
    const b = computed(() => a() * 10);
    expect(b()).toBe(20);
    a.set(3);
    expect(b()).toBe(30);
  });

  it("batches updates", () => {
    const a = signal(1);
    const b = signal(1);
    let runs = 0;
    effect(() => {
      a();
      b();
      runs++;
    });
    batch(() => {
      a.set(5);
      b.set(6);
    });
    expect(runs).toBe(2);
  });

  it("stops after dispose and ignores untracked reads", () => {
    const a = signal(1);
    const b = signal(1);
    let runs = 0;
    const stop = effect(() => {
      a();
      untracked(() => b());
      runs++;
    });
    b.set(2);
    expect(runs).toBe(1);
    stop();
    a.set(3);
    expect(runs).toBe(1);
  });

  it("drops dependencies an effect no longer reads", () => {
    const flag = signal(true);
    const a = signal(1);
    let runs = 0;
    effect(() => {
      runs++;
      if (flag()) a();
    });
    flag.set(false);
    a.set(2);
    expect(runs).toBe(2);
  });
});
