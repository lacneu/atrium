import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { clampPage, PDF_ZOOM_STEPS, type PdfZoom } from "./documentViewerView";

// PDF renderer for the Document Viewer panel: a thumbnail rail (one entry per
// page, click to jump) + the current page on a canvas + a page/zoom toolbar —
// the layout users know from ChatGPT/Drive-style viewers. pdfjs-dist is
// LAZY-IMPORTED on first mount so the main bundle never pays for it; the worker
// is a same-origin bundled asset (CSP-safe on a self-hosted install).
//
// Rendering is canvas-only (no text/annotation layers) — Release A is a READER;
// selection/search can layer on later without changing this structure.

// Minimal structural types for the lazily-imported pdfjs objects (the real
// types live in pdfjs-dist; importing them statically would defeat the lazy
// split, so we type the small surface we use).
type PdfPage = {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: { canvas: HTMLCanvasElement; viewport: unknown }): {
    promise: Promise<void>;
    cancel(): void;
  };
};
type PdfDocument = {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
};

// Hard bound on the thumbnail rail: a 500-page PDF must not queue 500 canvas
// renders. Navigation past the cap still works via the toolbar pager.
const MAX_THUMBNAILS = 60;

export function PdfViewer({ url, filename }: { url: string; filename: string }) {
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<PdfZoom>("fit");

  // Load the document (and the library) once per URL. destroy() on cleanup
  // frees the worker-side document — switching files repeatedly must not leak.
  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDocument | null = null;
    setDoc(null);
    setError(false);
    setPage(1);
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        const d = (await pdfjs.getDocument({ url }).promise) as unknown as PdfDocument;
        if (cancelled) {
          void d.destroy();
          return;
        }
        loaded = d;
        setDoc(d);
      } catch (e) {
        console.error("[docviewer] pdf load failed:", (e as Error)?.message ?? e);
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
  }, [url]);

  if (error) {
    return (
      <div className="oc-docviewer__fallback">
        <p>{m.docviewer_error()}</p>
        <a href={url} target="_blank" rel="noopener noreferrer" className="oc-docviewer__fallbacklink">
          {m.docviewer_open_tab()}
        </a>
      </div>
    );
  }
  if (doc === null) {
    return <div className="oc-docviewer__loading">{m.docviewer_loading()}</div>;
  }
  const pageCount = doc.numPages;
  const current = clampPage(page, pageCount);
  return (
    <div className="oc-docviewer__pdf">
      <div className="oc-docviewer__toolbar">
        <button
          type="button"
          className="oc-docviewer__navbtn"
          onClick={() => setPage((p) => clampPage(p - 1, pageCount))}
          disabled={current <= 1}
          aria-label={m.docviewer_prev_page()}
        >
          <ChevronLeft size={15} />
        </button>
        <span className="oc-docviewer__pageinfo">
          {current} / {pageCount}
        </span>
        <button
          type="button"
          className="oc-docviewer__navbtn"
          onClick={() => setPage((p) => clampPage(p + 1, pageCount))}
          disabled={current >= pageCount}
          aria-label={m.docviewer_next_page()}
        >
          <ChevronRight size={15} />
        </button>
        <select
          className="oc-docviewer__zoom"
          value={String(zoom)}
          onChange={(e) => {
            const v = e.target.value;
            setZoom(v === "fit" ? "fit" : (Number(v) as PdfZoom));
          }}
          aria-label={m.docviewer_zoom_aria()}
        >
          {PDF_ZOOM_STEPS.map((z) => (
            <option key={String(z)} value={String(z)}>
              {z === "fit" ? m.docviewer_zoom_fit() : `${Math.round((z as number) * 100)}%`}
            </option>
          ))}
        </select>
      </div>
      <div className="oc-docviewer__pdfbody">
        {pageCount > 1 ? (
          <div className="oc-docviewer__rail" aria-label={m.docviewer_pages_aria()}>
            {Array.from({ length: Math.min(pageCount, MAX_THUMBNAILS) }, (_, i) => (
              <Thumbnail
                key={i + 1}
                doc={doc}
                page={i + 1}
                active={i + 1 === current}
                onClick={() => setPage(i + 1)}
              />
            ))}
            {pageCount > MAX_THUMBNAILS ? (
              <span className="oc-docviewer__railmore">
                +{pageCount - MAX_THUMBNAILS}
              </span>
            ) : null}
          </div>
        ) : null}
        <MainPage doc={doc} page={current} zoom={zoom} filename={filename} />
      </div>
    </div>
  );
}

/** The current page, rendered at the chosen zoom ("fit" = panel width) with
 *  devicePixelRatio sharpness. Re-renders on page/zoom/panel resize; an
 *  in-flight render is cancelled before the next starts (pdfjs requirement). */
function MainPage({
  doc,
  page,
  zoom,
  filename,
}: {
  doc: PdfDocument;
  page: number;
  zoom: PdfZoom;
  filename: string;
}) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [holderWidth, setHolderWidth] = useState(0);

  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setHolderWidth((prev) => (Math.abs(prev - w) > 1 ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    (async () => {
      try {
        const p = await doc.getPage(page);
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        const base = p.getViewport({ scale: 1 });
        const scale =
          zoom === "fit"
            ? Math.max(0.1, (holderWidth - 16) / base.width)
            : zoom;
        const dpr = window.devicePixelRatio || 1;
        const viewport = p.getViewport({ scale: scale * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        const t = p.render({ canvas, viewport });
        task = t;
        await t.promise;
      } catch (e) {
        // A cancelled render throws a RenderingCancelledException — benign.
        const name = (e as { name?: string })?.name;
        if (name !== "RenderingCancelledException") {
          console.error("[docviewer] page render failed:", (e as Error)?.message ?? e);
        }
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, zoom, holderWidth]);

  return (
    <div ref={holderRef} className="oc-docviewer__main">
      <canvas ref={canvasRef} className="oc-docviewer__canvas" aria-label={filename} />
    </div>
  );
}

/** One rail thumbnail, rendered ONCE at rail width (cheap, cached by keeping
 *  the canvas mounted). */
function Thumbnail({
  doc,
  page,
  active,
  onClick,
}: {
  doc: PdfDocument;
  page: number;
  active: boolean;
  onClick: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    (async () => {
      try {
        const p = await doc.getPage(page);
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        const base = p.getViewport({ scale: 1 });
        const scale = 104 / base.width; // rail width ≈ 104px content
        const viewport = p.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const t = p.render({ canvas, viewport });
        task = t;
        await t.promise;
      } catch (e) {
        const name = (e as { name?: string })?.name;
        if (name !== "RenderingCancelledException") {
          console.error("[docviewer] thumbnail render failed:", (e as Error)?.message ?? e);
        }
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page]);
  return (
    <button
      type="button"
      className={`oc-docviewer__thumb${active ? " is-active" : ""}`}
      onClick={onClick}
      aria-label={m.docviewer_goto_page({ page })}
      aria-current={active ? "true" : undefined}
    >
      <canvas ref={canvasRef} className="oc-docviewer__thumbcanvas" />
      <span className="oc-docviewer__thumbnum">{page}</span>
    </button>
  );
}
