// "Move to..." folder picker — ONE component for both moves:
//   - a CHAT into a folder (any folder is a valid target, plus "no folder");
//   - a FOLDER under another folder (targets failing canNest — cycles or the
//     depth cap — are disabled; the root entry re-parents to top level).
// Owns its data: subscribes to listProjects only while open (Convex dedupes
// with the sidebar's subscription). Validation is defensive on BOTH sides —
// the server re-checks canNest either way.

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { Check, CornerUpLeft, Folder } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { canNest, flattenForPicker } from "../../convex/lib/folderTree";
import { projectHue } from "./sidebarPalette";
import "./folderTreePicker.css";

type ProjectRow = {
  _id: Id<"projects">;
  name: string;
  color: string | null;
  parentId: Id<"projects"> | null;
  sortKey: number;
};

export function FolderTreePicker({
  open,
  onOpenChange,
  title,
  movingFolderId,
  currentId,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  /** Set when MOVING A FOLDER: gates targets through canNest (cycle + depth). */
  movingFolderId?: Id<"projects">;
  /** The current location (chat's folder / folder's parent): shown checked. */
  currentId: Id<"projects"> | null;
  onPick: (folderId: Id<"projects"> | null) => void;
}) {
  const projects = useQuery(
    api.projects.listProjects,
    open ? {} : "skip",
  ) as ProjectRow[] | undefined;
  const [term, setTerm] = useState("");

  const entries = useMemo(() => {
    const list = projects ?? [];
    const flat = flattenForPicker(list);
    const q = term.trim().toLowerCase();
    const shown =
      q === ""
        ? flat
        : flat.filter((e) => e.node.name.toLowerCase().includes(q));
    return shown.map((e) => ({
      ...e,
      disabled:
        movingFolderId !== undefined &&
        !canNest(list, movingFolderId, e.node._id),
    }));
  }, [projects, term, movingFolderId]);

  const close = () => {
    onOpenChange(false);
    setTerm("");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setTerm("");
        onOpenChange(o);
      }}
    >
      <DialogContent className="oc-folderpick" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={m.folder_picker_filter_placeholder()}
        />
        <div className="oc-folderpick__list" role="listbox">
          {/* Root entry: "no folder" for a chat, "top level" for a folder. */}
          <button
            type="button"
            role="option"
            aria-selected={currentId === null}
            className="oc-folderpick__opt"
            onClick={() => {
              onPick(null);
              close();
            }}
          >
            <CornerUpLeft size={14} aria-hidden className="oc-folderpick__ico" />
            <span className="oc-folderpick__name">
              {m.folder_picker_root_option()}
            </span>
            {currentId === null ? (
              <Check size={13} aria-hidden className="oc-folderpick__check" />
            ) : null}
          </button>
          {entries.length === 0 ? (
            <p className="oc-folderpick__empty">{m.folder_picker_no_target()}</p>
          ) : (
            entries.map(({ node, depth, disabled }) => (
              <button
                type="button"
                key={node._id}
                role="option"
                aria-selected={node._id === currentId}
                disabled={disabled}
                className="oc-folderpick__opt"
                style={
                  {
                    "--pick-depth": depth - 1,
                    "--proj-hue": projectHue(node),
                  } as React.CSSProperties
                }
                onClick={() => {
                  onPick(node._id);
                  close();
                }}
              >
                <Folder size={14} aria-hidden className="oc-folderpick__ico" />
                <span className="oc-folderpick__name">{node.name}</span>
                {node._id === currentId ? (
                  <Check
                    size={13}
                    aria-hidden
                    className="oc-folderpick__check"
                  />
                ) : null}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
