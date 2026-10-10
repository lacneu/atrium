import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { AutheliaLoginStatus, LoginBoundary } from "./AutheliaLogin";
import { m } from "./paraglide/messages.js";
import type { AutheliaLoginState } from "./lib/autheliaLogin";

vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signIn: vi.fn() }) }));

describe("the actual login boundary hides the chooser", () => {
  const chooser = createElement("button", {}, m.app_signin_google());
  test.each([undefined, { autheliaOnly: true, authelia: true }, { autheliaOnly: true, authelia: false }])("no Google while loading or using exclusive mode (%j)", (providers) => {
    const html = renderToStaticMarkup(createElement(LoginBoundary, { providers, children: chooser }));
    expect(html).not.toContain(m.app_signin_google());
    expect(html).not.toContain("<button");
  });
  test("other installations still render their existing chooser", () => {
    const html = renderToStaticMarkup(createElement(LoginBoundary, { providers: { autheliaOnly: false, authelia: true }, children: chooser }));
    expect(html).toContain(m.app_signin_google());
  });
});

describe("exclusive Authelia status surface", () => {
  test.each(["redirecting", "failed", "signed-out", "unavailable"] as const)("%s never offers Google or another provider chooser", (state: AutheliaLoginState) => {
    const html = renderToStaticMarkup(createElement(AutheliaLoginStatus, { state, retry: () => {} }));
    expect(html).not.toContain(m.app_signin_google());
    expect(html).not.toContain(m.app_signin_microsoft());
    expect(html).not.toContain(m.app_signin_title());
    expect(html).not.toContain(m.app_signin_anonymous());
    expect(html).toContain('role="status"');
    expect(html.includes("<button")).toBe(state === "failed" || state === "signed-out");
  });
});
