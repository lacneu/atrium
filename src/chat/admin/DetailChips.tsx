import { type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

// One "detail" cell of an admin list (groups, users): small chips of names
// (server-capped to a preview) + a "+N" overflow badge. Each chip TRUNCATES a long
// name (ellipsis + title tooltip) so a few very long corporate emails / agent /
// chart names never blow out the row. `marker` (manager shield / default star)
// renders before the name; `highlight` switches the chip to the secondary variant
// so it stands out. Shared across tabs so every list renders detail chips
// identically (the charte graphique — see DataTableShell).
export function DetailChips({
  icon,
  total,
  items,
}: {
  icon: ReactNode;
  total: number;
  items: Array<{ label: string; marker?: ReactNode; highlight?: boolean }>;
}) {
  if (total === 0) {
    return (
      <Badge variant="outline" className="oc-group-chip oc-group-chip--empty gap-1">
        {icon}0
      </Badge>
    );
  }
  const hidden = total - items.length;
  return (
    <div className="oc-group-detail">
      {items.map((it, i) => (
        <Badge
          key={i}
          variant={it.highlight ? "secondary" : "outline"}
          className="oc-group-chip gap-1"
          title={it.label}
        >
          {it.marker}
          <span className="oc-group-chip__txt">{it.label}</span>
        </Badge>
      ))}
      {hidden > 0 ? (
        <Badge variant="outline" className="oc-group-chip">
          +{hidden}
        </Badge>
      ) : null}
    </div>
  );
}
