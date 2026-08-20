import { describe, expect, it, vi } from "vitest";
import type { InstanceData } from "../src/config.js";
import { startRegistrationDiscovery } from "../src/core/registration-discovery.js";

const data: InstanceData = {
  instanceName: "olivier",
  gatewayUrl: "wss://gateway.example/ws",
  token: "token",
  deviceIdentity: { id: "device", publicKey: "public", privateKey: "private" },
  gatewayVersion: null,
  gatewayHttpUrl: null,
  kind: "openclaw",
};

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("registration discovery", () => {
  it("retries a not-yet-approved device and stops after convergence", async () => {
    const callbacks: Array<() => void> = [];
    const setTimer = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    });
    const discover = vi
      .fn<(value: InstanceData) => Promise<void>>()
      .mockRejectedValueOnce(new Error("not paired"))
      .mockResolvedValue(undefined);
    const log = vi.fn();

    startRegistrationDiscovery({
      data,
      discover,
      intervalMs: 2_000,
      log,
      setTimer,
      clearTimer: vi.fn(),
    });
    await flush();

    expect(discover).toHaveBeenCalledTimes(1);
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 2_000);
    expect(log).toHaveBeenCalledTimes(1);

    callbacks[0]!();
    await flush();

    expect(discover).toHaveBeenCalledTimes(2);
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("cancels a scheduled retry during graceful shutdown", async () => {
    const callbacks: Array<() => void> = [];
    const clearTimer = vi.fn();
    const discover = vi.fn().mockRejectedValue(new Error("not paired"));
    const controller = startRegistrationDiscovery({
      data,
      discover,
      intervalMs: 2_000,
      setTimer: (callback) => {
        callbacks.push(callback);
        return 7 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer,
    });
    await flush();

    controller.stop();
    callbacks[0]!();
    await flush();

    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(discover).toHaveBeenCalledTimes(1);
  });
});
