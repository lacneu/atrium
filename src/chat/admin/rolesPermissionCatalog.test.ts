/// <reference types="vite/client" />
//
// The roles UI catalogue, held in LOCKSTEP with the server's permission list.
//
// An API key is always a service account, and the wildcard `admin` role cannot
// be given to one — so a permission that gates a route and is absent from this
// catalogue can be granted to nobody, and the route answers 403 to every
// supported caller. That shipped once: `media.repair` gated the lost-delivery
// repair while no role could hold it.

import { describe, expect, test } from "vitest";
import { PERMISSION_GROUPS } from "./RolesTab";
import { PERMISSIONS, WILDCARD } from "../../../convex/lib/rbac";

const CATALOGUE = PERMISSION_GROUPS.flatMap((g) => g.keys.map((k) => k.key));
const KNOWN = new Set<string>(Object.values(PERMISSIONS));

describe("the roles catalogue and the server's permissions agree", () => {
  test("every offered key is a REAL permission (no typo grants nothing)", () => {
    for (const key of CATALOGUE) {
      expect(KNOWN.has(key), `unknown permission offered: ${key}`).toBe(true);
    }
  });

  test("no key is offered twice", () => {
    expect(new Set(CATALOGUE).size).toBe(CATALOGUE.length);
  });

  // The permissions that gate a WRITE a service account is meant to perform.
  // Each is deliberately absent from some built-in role, so the catalogue is
  // the only way an operator can grant it.
  test("the service-grantable repair permissions are offered", () => {
    for (const key of [PERMISSIONS.SELF_HEAL, PERMISSIONS.MEDIA_REPAIR]) {
      expect(CATALOGUE, `not grantable from the UI: ${key}`).toContain(key);
    }
  });

  // The RAW WILDCARD is never offered. `admin.manage` is offered on purpose and
  // is NOT the wildcard: `roleHasPermission` matches "*" or the exact key, so
  // holding `admin.manage` opens only the routes that gate on it. Offering "*"
  // would hand a service account everything, which is what
  // HUMAN_ONLY_ROLE_KEYS exists to prevent.
  test("the raw wildcard is never offered (admin.manage is not it)", () => {
    expect(CATALOGUE).not.toContain(WILDCARD);
    expect(CATALOGUE).toContain(PERMISSIONS.ADMIN_MANAGE);
  });
});
