import { m } from "@/paraglide/messages.js";

// Display description for a role. Built-in roles get a LOCALIZED description
// (key-mapped m.role_desc_<key>), kept in lockstep with convex/lib/rbac
// BUILTIN_ROLES (the stored English description is the API/fallback canonical;
// this is the user-facing FR/EN copy). Custom roles show their admin-authored
// stored description (single-language) verbatim. Returns null when there is
// nothing to show (an unknown built-in key with no stored description, or a
// custom role with no description) so callers can hide the line entirely.

const BUILTIN_ROLE_DESC: Record<string, () => string> = {
  pending: m.role_desc_pending,
  user: m.role_desc_user,
  admin: m.role_desc_admin,
  observer: m.role_desc_observer,
  agent: m.role_desc_agent,
};

export function roleDescription(role: {
  key: string;
  builtin: boolean;
  description: string | null;
}): string | null {
  if (role.builtin) {
    const localized = BUILTIN_ROLE_DESC[role.key];
    if (localized) return localized();
  }
  return role.description;
}
