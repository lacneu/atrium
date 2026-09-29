// Settings › Trash › orphaned files: run the logical orphan sweep as a dry run,
// read its report, and apply it (convex/blobSweep.ts). requireAdmin and every
// apply condition are enforced server-side; this card only presents them.
// Applying puts the orphans in the QUARANTINE (convex/blobQuarantine.ts): each is
// deleted when its quarantine ends, if nothing references it by then — and even
// then only its `_storage` record: the bytes are reclaimed by the operator's
// physical collector (deploy/gc, docs/installation/BACKUP.md), not from here.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ScanSearch, Trash2 } from "lucide-react";
import { api } from "../convexApi";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";
import { getLocale } from "@/paraglide/runtime.js";
import { m } from "@/paraglide/messages.js";
import { formatFileSize } from "../fileMetaView";
import { sweepView } from "./blobSweepView";

export function BlobSweepCard() {
  const rows = useQuery(api.blobSweep.listBlobSweeps, {});
  const quarantine = useQuery(api.blobQuarantine.quarantineSettings, {});
  const start = useMutation(api.blobSweep.startBlobSweep);
  const confirm = useConfirm();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const locale = getLocale();
  const size = (bytes: number) => formatFileSize(bytes, locale);
  const view = sweepView(rows ?? [], Date.now());
  const report = view.report;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast({ title: m.blobsweep_error(), description: (e as Error).message, variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const dryRun = () => run(() => start({ mode: "dryRun" }));
  const apply = async () => {
    if (report === null) return;
    const ok = await confirm({
      title: m.blobsweep_apply_confirm_title({ count: report.orphans.count }),
      description: m.blobsweep_apply_confirm_desc({ size: size(report.orphans.bytes) }),
      confirmLabel: m.blobsweep_apply(),
      destructive: true,
    });
    if (ok) await run(() => start({ mode: "apply", confirms: report._id }));
  };

  return (
    <section className="oc-trash__body" aria-labelledby="oc-blobsweep-title">
      <div className="oc-trash__head">
        <h3 id="oc-blobsweep-title" className="oc-trash__heading">
          {m.blobsweep_title()}
        </h3>
        <div className="oc-trash__actions">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || view.running !== null}
            onClick={() => void dryRun()}
          >
            <ScanSearch /> {m.blobsweep_run()}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            disabled={busy || view.applyBlock !== null}
            onClick={() => void apply()}
          >
            <Trash2 /> {m.blobsweep_apply()}
          </Button>
        </div>
      </div>
      <p className="oc-trash__hint">{m.blobsweep_intro({
          days: report?.minAgeDays ?? 7,
          quarantine: quarantine?.days ?? 7,
        })}</p>
      {rows === undefined ? (
        <p className="oc-trash__hint">{m.app_loading()}</p>
      ) : null}
      {view.running !== null ? (
        <p className="oc-trash__hint">
          {m.blobsweep_running({ scanned: view.running.blobsScanned })}
        </p>
      ) : null}
      {rows !== undefined && report === null && view.running === null ? (
        <p className="oc-trash__empty">{m.blobsweep_none()}</p>
      ) : null}
      {report !== null ? (
        <div className="oc-trash__hint">
          <p>
            {m.blobsweep_report({
              date: formatDateTime(report.finishedAt ?? report.startedAt),
              count: report.orphans.count,
              size: size(report.orphans.bytes),
              scanned: report.blobsScanned,
            })}
          </p>
          <ul>
            <li>
              {m.blobsweep_origin_upload({
                count: report.byOrigin.upload?.count ?? 0,
                size: size(report.byOrigin.upload?.bytes ?? 0),
              })}
            </li>
            <li>
              {m.blobsweep_origin_unregistered({
                count: report.byOrigin.unregistered?.count ?? 0,
                size: size(report.byOrigin.unregistered?.bytes ?? 0),
              })}
            </li>
          </ul>
          {report.importing > 0 ? <p>{m.blobsweep_importing({ count: report.importing })}</p> : null}
          {report.mirrorMissing > 0 ? (
            <p className="text-destructive">
              {m.blobsweep_mirror_missing({ count: report.mirrorMissing })}
            </p>
          ) : null}
          {view.applyBlock === "expired" ? <p>{m.blobsweep_expired()}</p> : null}
        </div>
      ) : null}
      {view.lastApply !== null ? (
        <p className="oc-trash__hint">
          {view.lastApply.status === "refused"
            ? m.blobsweep_refused({
                date: formatDateTime(view.lastApply.finishedAt ?? view.lastApply.startedAt),
              })
            : m.blobsweep_applied({
                date: formatDateTime(view.lastApply.finishedAt ?? view.lastApply.startedAt),
                count: view.lastApply.deleted.count,
                size: size(view.lastApply.deleted.bytes),
              })}
        </p>
      ) : null}
    </section>
  );
}
