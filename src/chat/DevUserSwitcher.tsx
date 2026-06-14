import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Wrench } from "lucide-react";
import { api } from "./convexApi";
import { m } from "@/paraglide/messages.js";

type Role = "pending" | "user" | "admin";
const ROLES: Role[] = ["admin", "user", "pending"];

// DEV-ONLY user switcher. Visible ONLY when the deployment has the dev Anonymous
// provider on (`authProviders.anonymous`) — never in production. Removes the
// CLI-and-ids friction of multi-user testing: list every account + role, a
// one-click "become admin" escape hatch (so you're never stuck on a non-admin /
// pending session), per-user role control, and "act as" (reuses the audited
// admin impersonation). Nothing here exists in prod (the queries are dev-gated
// server-side AND this component renders null when anon is off).
export function DevUserSwitcher() {
  const providers = useQuery(api.me.authProviders);
  const isDev = providers?.anonymous === true;
  const [open, setOpen] = useState(false);

  const users = useQuery(api.dev.listUsersDev, isDev ? {} : "skip");
  const imp = useQuery(api.me.getImpersonation) as
    | { impersonating: false }
    | { impersonating: true; targetLabel: string; realLabel: string }
    | undefined;
  const setMyRole = useMutation(api.dev.setMyRole);
  const setRole = useMutation(api.dev.setRole);
  const startImp = useMutation(api.admin.startImpersonation);
  const stopImp = useMutation(api.admin.stopImpersonation);

  if (!isDev) return null;

  const me = users?.find((u) => u.isMe);
  const amAdmin = me?.role === "admin";
  const impersonating = imp?.impersonating === true;
  const others = (users ?? []).filter((u) => !u.isMe);

  return (
    <>
      <button
        type="button"
        className="oc-devfab"
        onClick={() => setOpen(true)}
        title={m.devswitch_fab_title()}
      >
        <Wrench size={13} />
        DEV
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{m.devswitch_dialog_title()}</DialogTitle>
            <DialogDescription>
              {m.devswitch_dialog_description()}
            </DialogDescription>
          </DialogHeader>

          {/* Current session — role self-service (escape hatch). */}
          <div className="oc-devsw__me">
            <span className="oc-devsw__melabel">
              {m.devswitch_me_label({ canonical: me?.canonical ?? "…" })}{" "}
              <Badge variant="outline">{me?.role ?? "…"}</Badge>
            </span>
            <div className="oc-devsw__roles">
              {ROLES.map((r) => (
                <Button
                  key={r}
                  type="button"
                  size="xs"
                  variant={me?.role === r ? "secondary" : "ghost"}
                  disabled={me?.role === r}
                  onClick={() => void setMyRole({ role: r })}
                >
                  {r === "admin"
                    ? m.devswitch_become_admin()
                    : r === "user"
                      ? m.devswitch_become_user()
                      : m.devswitch_become_pending()}
                </Button>
              ))}
            </div>
          </div>

          {impersonating ? (
            <div className="oc-devsw__imp">
              {m.devswitch_impersonating_prefix()}{" "}
              <strong>{imp.targetLabel}</strong>.
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void stopImp()}
              >
                {m.devswitch_stop()}
              </Button>
            </div>
          ) : null}

          {/* Other accounts. */}
          <div className="oc-devsw__list">
            {others.length === 0 ? (
              <p className="oc-devsw__empty">
                {m.devswitch_empty_state()}
              </p>
            ) : (
              others.map((u) => (
                <div key={u.profileId} className="oc-devsw__row">
                  <span className="oc-devsw__label">
                    {u.name || u.email || u.canonical || u.userId.slice(0, 8)}
                  </span>
                  <select
                    className="oc-devsw__select"
                    value={u.role}
                    disabled={!u.canonical}
                    onChange={(e) =>
                      u.canonical &&
                      void setRole({
                        canonical: u.canonical,
                        role: e.target.value as Role,
                      })
                    }
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={!amAdmin || u.role === "pending"}
                    title={
                      !amAdmin
                        ? m.devswitch_actas_need_admin()
                        : u.role === "pending"
                          ? m.devswitch_actas_pending_blocked()
                          : m.devswitch_actas_tooltip()
                    }
                    onClick={() => {
                      void startImp({ profileId: u.profileId });
                      setOpen(false);
                    }}
                  >
                    {m.devswitch_act_as()}
                  </Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
