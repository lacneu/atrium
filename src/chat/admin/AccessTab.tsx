import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { m } from "@/paraglide/messages.js";
import { agentViaLabel, chartViaLabel } from "./accessProvenance";

// Settings > Acces (P5): a READ-ONLY admin introspection screen. Pick a user ->
// see their groups, available agents + charts (with provenance), and effective
// permissions. The provenance (`via`) is computed by the same resolvers the user
// actually goes through (enrichUserAgents / availableChartsForUser), so this view
// can never drift from reality. Gated `admin.manage` on the tab AND re-checked on
// the REAL identity inside introspectUser. No mutations.

type UserRow = {
  _id: string;
  userId: string;
  role: string;
  email: string | null;
  name: string | null;
};

function userLabel(u: { name: string | null; email: string | null; userId: string }): string {
  return u.name || u.email || u.userId.slice(0, 8);
}

export function AccessTab() {
  const users = useQuery(api.admin.listUsers, {}) as UserRow[] | undefined;
  const [userId, setUserId] = useState<string>("");
  const data = useQuery(
    api.introspect.introspectUser,
    userId ? { userId: userId as Id<"users"> } : "skip",
  );

  return (
    <>
      <p className="oc-admin__hint">{m.access_hint()}</p>

      <Select value={userId} onValueChange={setUserId}>
        <SelectTrigger size="sm" aria-label={m.access_pick_user()}>
          <SelectValue placeholder={m.access_pick_user()} />
        </SelectTrigger>
        <SelectContent>
          {(users ?? []).map((u) => (
            <SelectItem key={u._id} value={u.userId}>
              {userLabel(u)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {userId === "" ? (
        <p className="oc-admin__hint">{m.access_empty_pick()}</p>
      ) : data === undefined ? (
        <p className="oc-admin__hint">{m.common_loading()}</p>
      ) : (
        <div className="oc-introspect">
          <section className="oc-introspect__section">
            <h3 className="oc-introspect__title">{m.access_section_identity()}</h3>
            <div className="oc-introspect__id">
              <strong>{data.user.label}</strong>
              <Badge variant="secondary">{data.role}</Badge>
            </div>
          </section>

          <section className="oc-introspect__section">
            <h3 className="oc-introspect__title">{m.access_section_groups()}</h3>
            {data.groups.length === 0 ? (
              <p className="oc-admin__hint">{m.access_none()}</p>
            ) : (
              <div className="oc-introspect__chips">
                {data.groups.map((g) => (
                  <Badge key={g.groupId} variant="secondary">
                    {g.name}
                  </Badge>
                ))}
              </div>
            )}
          </section>

          <section className="oc-introspect__section">
            <h3 className="oc-introspect__title">{m.access_section_agents()}</h3>
            {data.agents.length === 0 ? (
              <p className="oc-admin__hint">{m.access_none()}</p>
            ) : (
              <ul className="oc-introspect__list">
                {data.agents.map((a) => (
                  <li
                    key={`${a.instanceName} ${a.agentId}`}
                    className="oc-introspect__row"
                  >
                    <span className="oc-introspect__name">
                      {a.displayName || a.agentId}
                    </span>
                    {a.isDefault ? (
                      <Badge variant="default">{m.access_default()}</Badge>
                    ) : null}
                    <Badge variant="outline">{agentViaLabel(a.via)}</Badge>
                    <Badge variant="secondary">{a.state}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="oc-introspect__section">
            <h3 className="oc-introspect__title">{m.access_section_charts()}</h3>
            {data.charts.length === 0 ? (
              <p className="oc-admin__hint">{m.access_none()}</p>
            ) : (
              <ul className="oc-introspect__list">
                {data.charts.map((c) => (
                  <li key={c.key} className="oc-introspect__row">
                    <span className="oc-introspect__name">{c.name}</span>
                    <Badge variant="outline">{chartViaLabel(c.via)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="oc-introspect__section">
            <h3 className="oc-introspect__title">{m.access_section_perms()}</h3>
            {data.permissions.length === 0 ? (
              <p className="oc-admin__hint">{m.access_none()}</p>
            ) : (
              <div className="oc-introspect__chips">
                {data.permissions.map((p) => (
                  <Badge key={p} variant="secondary">
                    {p}
                  </Badge>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
