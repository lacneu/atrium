import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Download, MoreVertical, RotateCcw, Trash2 } from "lucide-react";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

// Settings › Fichiers — owner-scoped listing of every file exchanged across the
// user's conversations (inbound uploads + outbound agent files), with filters on
// direction / conversation / bridge / type. Read-only (view + download). Backed
// by api.files.listMine (the `files` denormalization table). Available to ALL
// approved users (gated on chats.read; the query enforces owner scope).

const ALL = "all"; // Select sentinel → query arg undefined (no filter)

type Category =
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "document"
  | "archive"
  | "other";

function categoryLabel(c: string): string {
  switch (c) {
    case "image":
      return m.files_category_image();
    case "audio":
      return m.files_category_audio();
    case "video":
      return m.files_category_video();
    case "pdf":
      return m.files_category_pdf();
    case "document":
      return m.files_category_document();
    case "archive":
      return m.files_category_archive();
    default:
      return m.files_category_other();
  }
}

export function FilesTab() {
  const [direction, setDirection] = useState<string>(ALL);
  const [chatId, setChatId] = useState<string>(ALL);
  const [instanceName, setInstanceName] = useState<string>(ALL);
  const [category, setCategory] = useState<string>(ALL);
  // The file awaiting delete confirmation (null = dialog closed).
  const [pendingDelete, setPendingDelete] = useState<{
    id: Id<"files">;
    filename: string;
  } | null>(null);
  const softDelete = useMutation(api.files.softDelete);
  const toast = useToast();

  function resetFilters() {
    setDirection(ALL);
    setChatId(ALL);
    setInstanceName(ALL);
    setCategory(ALL);
  }

  async function confirmDelete() {
    const target = pendingDelete;
    setPendingDelete(null); // close the dialog immediately; the row drops reactively
    if (!target) return;
    try {
      await softDelete({ fileId: target.id });
      toast.success(m.files_delete_toast());
    } catch (err) {
      toast.error(m.files_delete_error(), err);
    }
  }

  const data = useQuery(api.files.listMine, {
    direction:
      direction === ALL
        ? undefined
        : (direction as "inbound" | "outbound"),
    chatId: chatId === ALL ? undefined : (chatId as Id<"chats">),
    instanceName: instanceName === ALL ? undefined : instanceName,
    category: category === ALL ? undefined : category,
  });

  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(getLocale(), {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [],
  );

  if (data === undefined) {
    return <p className="oc-admin__hint">{m.common_loading()}</p>;
  }

  const { files, facets, truncated, cap } = data;
  const anyFilter =
    direction !== ALL ||
    chatId !== ALL ||
    instanceName !== ALL ||
    category !== ALL;

  return (
    <>
      <p className="oc-admin__hint">{m.files_description()}</p>

      <div
        className="oc-files__filters"
        style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "12px 0" }}
      >
        {/* Direction */}
        <Select value={direction} onValueChange={setDirection}>
          <SelectTrigger size="sm" aria-label={m.files_filter_direction()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.files_filter_direction_all()}</SelectItem>
            <SelectItem value="inbound">
              {m.files_direction_inbound()}
            </SelectItem>
            <SelectItem value="outbound">
              {m.files_direction_outbound()}
            </SelectItem>
          </SelectContent>
        </Select>

        {/* Conversation */}
        <Select value={chatId} onValueChange={setChatId}>
          <SelectTrigger size="sm" aria-label={m.files_filter_conversation()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              {m.files_filter_conversation_all()}
            </SelectItem>
            {facets.chats.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Bridge — self-hides when everything is one provider (mirrors the
            sidebar bridge badge). */}
        {facets.multiProvider ? (
          <Select value={instanceName} onValueChange={setInstanceName}>
            <SelectTrigger size="sm" aria-label={m.files_filter_bridge()}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{m.files_filter_bridge_all()}</SelectItem>
              {facets.instances.map((i) => (
                <SelectItem key={i} value={i}>
                  {i}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {/* Type */}
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger size="sm" aria-label={m.files_filter_type()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.files_filter_type_all()}</SelectItem>
            {facets.categories.map((c) => (
              <SelectItem key={c} value={c}>
                {categoryLabel(c)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Reset — shown only when a filter is active, pushed to the RIGHT edge of
            the filter row (`margin-left: auto`), mirroring the FilterBar
            convention (.oc-filterbar__reset) used by the other settings tabs. */}
        {anyFilter ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={resetFilters}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              marginLeft: "auto",
            }}
          >
            <RotateCcw size={14} aria-hidden />
            {m.files_reset()}
          </Button>
        ) : null}
      </div>

      {files.length === 0 ? (
        <p className="oc-admin__hint">
          {anyFilter ? m.files_empty_filtered() : m.files_empty()}
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m.files_col_name()}</TableHead>
                <TableHead>{m.files_col_type()}</TableHead>
                <TableHead>{m.files_col_direction()}</TableHead>
                <TableHead>{m.files_col_conversation()}</TableHead>
                <TableHead>{m.files_col_date()}</TableHead>
                <TableHead className="text-right">
                  {m.files_col_action()}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((f) => (
                <TableRow key={f._id}>
                  <TableCell
                    className="font-medium"
                    style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }}
                    title={f.filename}
                  >
                    {f.filename}
                  </TableCell>
                  <TableCell title={f.mimeType}>
                    {categoryLabel(f.category as Category)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {f.direction === "inbound"
                        ? m.files_direction_inbound()
                        : m.files_direction_outbound()}
                    </Badge>
                  </TableCell>
                  <TableCell
                    style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}
                    title={f.chatTitle}
                  >
                    {f.chatTitle}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {dateFmt.format(f.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={m.files_actions()}
                        >
                          <MoreVertical size={16} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {f.url ? (
                          <DropdownMenuItem asChild>
                            {/* download where same-origin allows; cross-origin the
                                browser opens it in the new tab by content-type. */}
                            <a
                              href={f.url}
                              download={f.filename}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Download size={14} />
                              {m.files_download()}
                            </a>
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem disabled>
                            <Download size={14} />
                            {m.files_unavailable()}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() =>
                            setPendingDelete({
                              id: f._id,
                              filename: f.filename,
                            })
                          }
                        >
                          <Trash2 size={14} />
                          {m.files_delete()}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {truncated ? (
            <p className="oc-admin__hint" style={{ marginTop: 8 }}>
              {m.files_truncated({ cap })}
            </p>
          ) : null}
        </>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.files_delete_confirm_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.files_delete_confirm_desc()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.chat_cancel()}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              {m.files_delete()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
