import { describe, it, expect } from "vitest";
import { KeyPool, AllKeysBusyError } from "../src/core/keyPool.js";

describe("KeyPool", () => {
  it("selects least-in-flight keys", () => {
    const pool = new KeyPool(["a", "b", "c"]);
    const l1 = pool.acquire(); // a (all 0, round-robin)
    const l2 = pool.acquire(); // b
    const l3 = pool.acquire(); // c
    expect(new Set([l1.key, l2.key, l3.key])).toEqual(new Set(["a", "b", "c"]));

    // Release b; next acquire should reuse b (now least in-flight = 0).
    l2.release();
    const l4 = pool.acquire();
    expect(l4.key).toBe("b");
  });

  it("round-robins between equal in-flight keys", () => {
    const pool = new KeyPool(["a", "b"]);
    const first = pool.acquire();
    first.release();
    const second = pool.acquire();
    second.release();
    // Two acquisitions on an idle pool should spread across both keys.
    expect(first.key).not.toBe(second.key);
  });

  it("benches a key on cooldown and routes around it", () => {
    let t = 1000;
    const pool = new KeyPool(["a", "b"], () => t);
    pool.cooldown("a", 5000);
    expect(pool.availableCount()).toBe(1);

    const lease = pool.acquire();
    expect(lease.key).toBe("b");

    // After cooldown expires, "a" is available again.
    t = 6001;
    expect(pool.availableCount()).toBe(2);
  });

  it("throws AllKeysBusyError when every key is cooling, with soonest retry", () => {
    let t = 0;
    const pool = new KeyPool(["a", "b"], () => t);
    pool.cooldown("a", 3000);
    pool.cooldown("b", 8000);
    try {
      pool.acquire();
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AllKeysBusyError);
      expect((e as AllKeysBusyError).retryAtMs).toBe(3000);
    }
  });

  it("release is idempotent (double release does not underflow)", () => {
    const pool = new KeyPool(["a"]);
    const lease = pool.acquire();
    lease.release();
    lease.release();
    expect(pool.status()[0].inFlight).toBe(0);
  });

  it("masks keys in status output", () => {
    const pool = new KeyPool(["sk-or-abcd1234"]);
    expect(pool.status()[0].masked).toBe("...1234");
  });
});
