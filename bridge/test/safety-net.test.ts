import { describe, it, expect, vi } from "vitest";
import {
  formatReason,
  installProcessSafetyNet,
  installServerFailFast,
} from "../src/core/safety-net.js";

describe("formatReason", () => {
  it("renders an Error with its full stack", () => {
    const e = new Error("boom");
    expect(formatReason(e)).toBe(e.stack);
    expect(formatReason(e)).toContain("boom");
  });

  it("renders a stack-less Error as name: message", () => {
    const e = new Error("nope");
    e.stack = undefined;
    expect(formatReason(e)).toBe("Error: nope");
  });

  it("passes a string reason through unchanged", () => {
    expect(formatReason("plain reason")).toBe("plain reason");
  });

  it("serializes a plain object reason", () => {
    expect(formatReason({ code: "X" })).toBe('{"code":"X"}');
  });

  it("falls back to String() on a non-serializable (circular) reason", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatReason(circular)).toBe("[object Object]");
  });
});

describe("installProcessSafetyNet", () => {
  it("registers handlers that LOG and keep the process alive, then dispose cleanly", () => {
    const beforeRej = new Set(process.listeners("unhandledRejection"));
    const beforeExc = new Set(process.listeners("uncaughtException"));

    const log = { error: vi.fn() };
    const dispose = installProcessSafetyNet(log);

    // Exactly one new handler per event (identified by set difference, robust to
    // any handlers the test runner itself installs).
    const newRej = process
      .listeners("unhandledRejection")
      .filter((l) => !beforeRej.has(l));
    const newExc = process
      .listeners("uncaughtException")
      .filter((l) => !beforeExc.has(l));
    expect(newRej).toHaveLength(1);
    expect(newExc).toHaveLength(1);

    // The handler must NOT exit the process — surviving the error is the point.
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    (newRej[0] as (r: unknown) => void)(new Error("stray rejection"));
    (newExc[0] as (e: unknown) => void)(new Error("stray exception"));

    expect(exitSpy).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(2);
    // `?.[0]` keeps the typecheck happy under noUncheckedIndexedAccess (the
    // toHaveBeenCalledTimes assertion already proves both calls exist).
    const rejMsg = String(log.error.mock.calls[0]?.[0]);
    const excMsg = String(log.error.mock.calls[1]?.[0]);
    expect(rejMsg).toContain("unhandledRejection");
    expect(rejMsg).toContain("stray rejection");
    expect(excMsg).toContain("uncaughtException");
    expect(excMsg).toContain("stray exception");

    exitSpy.mockRestore();

    // Disposer removes exactly what we added — no handler leak across the suite.
    dispose();
    expect(
      process.listeners("unhandledRejection").filter((l) => !beforeRej.has(l)),
    ).toHaveLength(0);
    expect(
      process.listeners("uncaughtException").filter((l) => !beforeExc.has(l)),
    ).toHaveLength(0);
  });
});

describe("installServerFailFast", () => {
  it("exits non-zero when the HTTP server emits 'error' (a bind failure must NOT be swallowed into an alive-but-deaf bridge)", () => {
    let captured: ((err: Error) => void) | null = null;
    const server = {
      on: (_event: "error", listener: (err: Error) => void) => {
        captured = listener;
      },
    };
    const log = { error: vi.fn() };
    const exit = vi.fn();

    installServerFailFast(server, { log, exit });
    expect(captured).not.toBeNull();

    // Simulate EADDRINUSE at boot.
    (captured as unknown as (err: Error) => void)(new Error("listen EADDRINUSE"));

    expect(exit).toHaveBeenCalledWith(1);
    expect(String(log.error.mock.calls[0]?.[0])).toContain("EADDRINUSE");
  });
});
