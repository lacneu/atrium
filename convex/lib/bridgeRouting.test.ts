// resolveBridgeUrl precedence (Model M): the instance's own bridgeUrl wins, else
// the env BRIDGE_URL fallback (the single-bridge path), else undefined (caller
// fails not_configured). Blank/whitespace is treated as unset.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  resolveBridgeUrl,
  resolveBridgeUrlForDispatch,
  resolveHealthPollTargets,
  resolvePollTargets,
} from "./bridgeRouting";

describe("resolveBridgeUrl", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.BRIDGE_URL;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.BRIDGE_URL;
    else process.env.BRIDGE_URL = prev;
  });

  test("the instance's own bridgeUrl WINS over the env fallback", () => {
    process.env.BRIDGE_URL = "http://env-fallback:1";
    expect(resolveBridgeUrl({ bridgeUrl: "http://instance:9" })).toBe(
      "http://instance:9",
    );
  });

  test("falls back to env BRIDGE_URL when the instance has none", () => {
    process.env.BRIDGE_URL = "http://env-fallback:1";
    expect(resolveBridgeUrl({})).toBe("http://env-fallback:1");
    expect(resolveBridgeUrl(null)).toBe("http://env-fallback:1");
    expect(resolveBridgeUrl(undefined)).toBe("http://env-fallback:1");
  });

  test("returns undefined when neither is set (→ not_configured)", () => {
    delete process.env.BRIDGE_URL;
    expect(resolveBridgeUrl({})).toBeUndefined();
    expect(resolveBridgeUrl(null)).toBeUndefined();
  });

  test("a blank/whitespace value is treated as unset (never a POST to '')", () => {
    process.env.BRIDGE_URL = "http://env-fallback:1";
    expect(resolveBridgeUrl({ bridgeUrl: "   " })).toBe("http://env-fallback:1");
    process.env.BRIDGE_URL = "   ";
    expect(resolveBridgeUrl({})).toBeUndefined();
  });

  test("trims a valid URL", () => {
    delete process.env.BRIDGE_URL;
    expect(resolveBridgeUrl({ bridgeUrl: "  http://x:1  " })).toBe("http://x:1");
  });
});

describe("resolveBridgeUrlForDispatch", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.BRIDGE_URL;
    process.env.BRIDGE_URL = "http://env:1";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.BRIDGE_URL;
    else process.env.BRIDGE_URL = prev;
  });

  const scope = (
    instanceName: string | null,
    served: string | null,
    isSole: boolean,
  ) => ({ instanceName, served, isSole });

  test("the instance's own bridgeUrl WINS regardless of scope", () => {
    expect(
      resolveBridgeUrlForDispatch(
        { bridgeUrl: "http://own:9" },
        scope("jerome", "olivier", false),
      ),
    ).toBe("http://own:9");
  });

  test("no instance row (legacy/unrouted) falls back to env", () => {
    expect(resolveBridgeUrlForDispatch(null, scope(null, null, false))).toBe(
      "http://env:1",
    );
  });

  test("the SOLE instance without its own url falls back to env", () => {
    expect(
      resolveBridgeUrlForDispatch({}, scope("primary", null, true)),
    ).toBe("http://env:1");
  });

  test("the SERVED instance without its own url falls back to env", () => {
    expect(
      resolveBridgeUrlForDispatch({}, scope("olivier", "olivier", false)),
    ).toBe("http://env:1");
  });

  test("a multi-instance, NON-served instance without its own url is NOT cross-attributed (→ undefined)", () => {
    // The leak Codex flagged: jerome (no bridgeUrl, not sole, not served) must NOT
    // inherit the env bridge (olivier's gateway). Delete the scope guard and this
    // returns "http://env:1" instead — the cross-instance misroute.
    expect(
      resolveBridgeUrlForDispatch({}, scope("jerome", "olivier", false)),
    ).toBeUndefined();
  });

  test("no env set → undefined even for the sole instance (not_configured)", () => {
    delete process.env.BRIDGE_URL;
    expect(
      resolveBridgeUrlForDispatch({}, scope("primary", null, true)),
    ).toBeUndefined();
  });
});

describe("resolvePollTargets", () => {
  test("each instance polls its OWN bridgeUrl (no env needed); trailing slash trimmed", () => {
    expect(
      resolvePollTargets(
        [
          { name: "olivier", bridgeUrl: "http://b-olivier:1/" },
          { name: "jerome", bridgeUrl: "http://b-jerome:1" },
        ],
        { envUrl: null, served: null },
      ),
    ).toEqual([
      { name: "olivier", url: "http://b-olivier:1" },
      { name: "jerome", url: "http://b-jerome:1" },
    ]);
  });

  test("own bridgeUrl WINS over env even for the served instance", () => {
    expect(
      resolvePollTargets([{ name: "olivier", bridgeUrl: "http://own:1" }], {
        envUrl: "http://env:1",
        served: "olivier",
      }),
    ).toEqual([{ name: "olivier", url: "http://own:1" }]);
  });

  test("an instance without bridgeUrl uses env ONLY when served or sole", () => {
    // served
    expect(
      resolvePollTargets(
        [
          { name: "olivier", bridgeUrl: null },
          { name: "jerome", bridgeUrl: null },
        ],
        { envUrl: "http://env:1", served: "olivier" },
      ),
    ).toEqual([{ name: "olivier", url: "http://env:1" }]); // jerome skipped

    // sole (no served)
    expect(
      resolvePollTargets([{ name: "only", bridgeUrl: null }], {
        envUrl: "http://env:1",
        served: null,
      }),
    ).toEqual([{ name: "only", url: "http://env:1" }]);
  });

  test("an unattributable instance (no own url, not served, not sole) is dropped", () => {
    expect(
      resolvePollTargets(
        [
          { name: "a", bridgeUrl: null },
          { name: "b", bridgeUrl: null },
        ],
        { envUrl: "http://env:1", served: null },
      ),
    ).toEqual([]);
  });

  test("no env and no own url → nothing to poll", () => {
    expect(
      resolvePollTargets([{ name: "a", bridgeUrl: null }], {
        envUrl: null,
        served: null,
      }),
    ).toEqual([]);
  });
});

describe("resolveHealthPollTargets", () => {
  test("backward-compat: env BRIDGE_URL is polled even with NO instances (name=null)", () => {
    expect(
      resolveHealthPollTargets([], { envUrl: "http://env:1/", served: null }),
    ).toEqual([{ name: null, url: "http://env:1" }]);
  });

  test("env is attributed to the served instance name when set", () => {
    expect(
      resolveHealthPollTargets([], {
        envUrl: "http://env:1",
        served: "primary",
      }),
    ).toEqual([{ name: "primary", url: "http://env:1" }]);
  });

  test("polls each instance's own bridge AND the env (mixed deploy)", () => {
    expect(
      resolveHealthPollTargets(
        [
          { name: "jerome", bridgeUrl: "http://j:1" },
          { name: "primary", bridgeUrl: null },
        ],
        { envUrl: "http://env:1", served: "primary" },
      ),
    ).toEqual([
      { name: "jerome", url: "http://j:1" },
      { name: "primary", url: "http://env:1" },
    ]);
  });

  test("dedups by URL (an instance whose own bridgeUrl equals env is polled once)", () => {
    expect(
      resolveHealthPollTargets([{ name: "primary", bridgeUrl: "http://same:1" }], {
        envUrl: "http://same:1",
        served: "primary",
      }),
    ).toEqual([{ name: "primary", url: "http://same:1" }]);
  });

  test("no env and no own url → nothing to poll", () => {
    expect(
      resolveHealthPollTargets([{ name: "a", bridgeUrl: null }], {
        envUrl: null,
        served: null,
      }),
    ).toEqual([]);
  });
});
