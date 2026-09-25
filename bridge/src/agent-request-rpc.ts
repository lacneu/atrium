// The one gateway shape the agent-request code talks to: an OpenClaw connection's
// `request`, which resolves the whole RESPONSE FRAME.
//
// Taken as an OBJECT and called by its method name, never wrapped in a
// `(method, params) => …` adapter: an adapter hides the method behind a variable,
// and the RPC scope ratchet (test/rpc-scope.test.ts) can then no longer see which
// gateway methods Atrium sends — the question and approval calls were invisible to
// it for exactly that reason.

export interface GatewayRpc {
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

/** The payload of a gateway response frame (`{type:"res", ok, payload}`). */
export function payloadOf(frame: unknown): unknown {
  if (typeof frame !== "object" || frame === null) return null;
  return (frame as { payload?: unknown }).payload ?? null;
}
