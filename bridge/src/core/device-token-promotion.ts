import type { BridgeConfig } from "../config.js";

/**
 * How long to wait before re-attempting a persistence whose outcome we never
 * learned, and how many times. Bounded: this is a best-effort repair, not a queue.
 */
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 120_000] as const;

/** Persist a paired device token and switch future connections to it in memory.
 *
 *  `scheduleRetry` is injectable so a test can drive the retry without waiting on
 *  real timers; production uses an UNREF'd timer, which must never be the reason a
 *  process stays alive. */
export function deviceTokenPromotion(
  config: BridgeConfig,
  fetchImpl: typeof fetch = fetch,
  scheduleRetry: (run: () => void, delayMs: number) => void = (run, delayMs) => {
    setTimeout(run, delayMs).unref?.();
  },
):
  | ((
      token: string,
      issuedAtMs?: number,
    ) => Promise<"stored" | "unchanged" | "superseded">)
  | undefined {
  const bridgeSecret = config.bridgeInstanceSecret?.trim();
  const identity = config.deviceIdentity;
  if (!bridgeSecret || identity === null || config.kind === "hermes") {
    return undefined;
  }
  /**
   * The token whose persistence is still owed, if any. A LOST answer is the case
   * this exists for: we adopt the token in memory so the live connection keeps
   * working, but Convex may still hold the bootstrap — and after a bridge restart
   * it is Convex that is read back, so a gateway that has since revoked the
   * bootstrap would leave the bridge unable to connect at all.
   *
   * Assuming "the next handshake will retry" is not enough: `auth.deviceToken` is
   * OPTIONAL in the contract, and a reconnect that succeeds with the in-memory
   * token may re-issue nothing. The repair has to be scheduled here.
   */
  let owed: { token: string; issuedAtMs?: number } | null = null;

  const attempt = async (
    token: string,
    issuedAtMs: number | undefined,
    retryIndex: number,
  ): Promise<"stored" | "unchanged" | "superseded"> => {
    let response: Response;
    try {
      response = await fetchImpl(
        `${config.convexHttpActionsUrl.replace(/\/+$/, "")}/bridge/device-token`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bridgeSecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            deviceId: identity.id,
            publicKey: identity.publicKey,
            token,
            ...(issuedAtMs === undefined ? {} : { issuedAtMs }),
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      // TRANSPORT failure: the write may well have LANDED and only its answer been
      // lost. Adopt the token in memory anyway — the gateway just issued it, so it
      // is valid to connect with whatever Convex ended up storing, and keeping the
      // superseded bootstrap instead is what left the bridge unable to reconnect
      // once the gateway rotated it. Still thrown, so the caller keeps the current
      // connection; the repair is SCHEDULED below, because no later handshake is
      // guaranteed to re-issue a token (`auth.deviceToken` is optional).
      config.openclawToken = token;
      armRetry(token, issuedAtMs, retryIndex);
      throw new Error("device token promotion endpoint is unreachable");
    }
    if (!response.ok) {
      // An explicit REFUSAL is different: Convex answered, and it said no. Nothing
      // was stored, so the in-memory token stays as it was.
      throw new Error("device token promotion was rejected");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // Unreadable answer — same uncertainty as a transport failure.
      config.openclawToken = token;
      armRetry(token, issuedAtMs, retryIndex);
      throw new Error("device token promotion returned an invalid response");
    }
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      (body as Record<string, unknown>).ok !== true ||
      !["stored", "unchanged", "superseded"].includes(
        String((body as Record<string, unknown>).outcome),
      )
    ) {
      // A 2xx whose BODY makes no sense — a proxy's own page, a truncated answer —
      // carries the same uncertainty as an unreadable one: the write may well have
      // landed. Adopt, for the same reason. Only an explicit non-2xx refusal is an
      // answer we can act on.
      config.openclawToken = token;
      armRetry(token, issuedAtMs, retryIndex);
      throw new Error("device token promotion returned an invalid response");
    }
    const outcome = (body as Record<string, unknown>).outcome as
      | "stored"
      | "unchanged"
      | "superseded";
    // SUPERSEDED is an explicit, successful answer: Convex is holding a token
    // issued AFTER this one, from a handshake that overlapped ours. Adopting our
    // older value here would put memory out of step with what is stored, and every
    // reconnect and media request would then present a credential Convex no longer
    // knows about. Leave the in-memory token alone and say so.
    if (outcome !== "superseded") config.openclawToken = token;
    // ANY definite answer clears the debt, whatever it says and whichever token it
    // was about. Convex's state is known at this point, and re-pushing an older
    // owed value would be exactly the walk backwards this module exists to avoid.
    owed = null;
    return outcome;
  };

  /** Re-attempt a persistence whose outcome was never learned. Superseded by any
   *  newer token: only the LATEST owed value is worth storing. */
  function armRetry(
    token: string,
    issuedAtMs: number | undefined,
    retryIndex: number,
  ): void {
    owed = { token, issuedAtMs };
    const delay = RETRY_DELAYS_MS[retryIndex];
    if (delay === undefined) return; // attempts exhausted; the debt stays visible
    scheduleRetry(() => {
      if (owed?.token !== token) return; // a newer promotion took over
      void attempt(token, issuedAtMs, retryIndex + 1).catch(() => {
        /* each attempt arms the next; nothing further to do here */
      });
    }, delay);
  }

  return (token: string, issuedAtMs?: number) => attempt(token, issuedAtMs, 0);
}
