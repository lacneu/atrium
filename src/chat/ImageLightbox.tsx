// Image lightbox: a single app-level viewer any image opens into (message
// media — user attachments AND agent-generated — plus the composer preview).
// Images render as THUMBNAILS in the thread (a wall of full-width images makes
// a conversation unreadable); a click opens the full image here with zoom
// (fit <-> actual size), a browser-native fullscreen toggle, open-in-tab, and
// keyboard/backdrop/Escape close. Self-contained (own context + portal) so it
// works from anywhere under <LightboxProvider> without prop-drilling.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, X, ExternalLink, ZoomIn, ZoomOut } from "lucide-react";
import { m } from "@/paraglide/messages.js";

interface LightboxImage {
  url: string;
  name: string;
}

interface LightboxApi {
  open: (image: LightboxImage) => void;
}

const LightboxContext = createContext<LightboxApi | null>(null);

/** Open the lightbox from anywhere under the provider. Returns a no-op opener
 *  when no provider is mounted (defensive — never throws). */
export function useLightbox(): LightboxApi {
  return useContext(LightboxContext) ?? { open: () => {} };
}

export function LightboxProvider({ children }: { children: React.ReactNode }) {
  const [image, setImage] = useState<LightboxImage | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  const open = useCallback((img: LightboxImage) => {
    setImage(img);
    setActualSize(false);
  }, []);

  const close = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    setImage(null);
    setFullscreen(false);
  }, []);

  // Escape closes; the effect is scoped to an open lightbox.
  useEffect(() => {
    if (image === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [image, close]);

  // Keep the fullscreen toggle in sync if the user exits fullscreen via the OS/Esc.
  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = overlayRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void el.requestFullscreen().catch(() => {});
    }
  }, []);

  return (
    <LightboxContext.Provider value={{ open }}>
      {children}
      {image !== null
        ? createPortal(
            <div
              ref={overlayRef}
              className="oc-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={image.name}
              onClick={(e) => {
                // Backdrop click closes; clicks on the image/toolbar don't.
                if (e.target === e.currentTarget) close();
              }}
            >
              <div className="oc-lightbox__bar">
                <span className="oc-lightbox__name" title={image.name}>
                  {image.name}
                </span>
                <button
                  type="button"
                  className="oc-lightbox__btn"
                  onClick={() => setActualSize((v) => !v)}
                  aria-label={
                    actualSize ? m.lightbox_fit() : m.lightbox_actual_size()
                  }
                  title={actualSize ? m.lightbox_fit() : m.lightbox_actual_size()}
                >
                  {actualSize ? <ZoomOut size={18} /> : <ZoomIn size={18} />}
                </button>
                <button
                  type="button"
                  className="oc-lightbox__btn"
                  onClick={toggleFullscreen}
                  aria-label={
                    fullscreen ? m.lightbox_exit_fullscreen() : m.lightbox_fullscreen()
                  }
                  title={
                    fullscreen ? m.lightbox_exit_fullscreen() : m.lightbox_fullscreen()
                  }
                >
                  {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                </button>
                <a
                  className="oc-lightbox__btn"
                  href={image.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={m.lightbox_open_tab()}
                  title={m.lightbox_open_tab()}
                >
                  <ExternalLink size={18} />
                </a>
                <button
                  type="button"
                  className="oc-lightbox__btn"
                  onClick={close}
                  aria-label={m.lightbox_close()}
                  title={m.lightbox_close()}
                >
                  <X size={18} />
                </button>
              </div>
              <div
                className={`oc-lightbox__stage${actualSize ? " oc-lightbox__stage--scroll" : ""}`}
                onClick={(e) => {
                  // The stage fills the space around the image; a click on it
                  // (not on the image itself) is a backdrop click -> close.
                  if (e.target === e.currentTarget) close();
                }}
              >
                <img
                  src={image.url}
                  alt={image.name}
                  className={
                    actualSize ? "oc-lightbox__img--actual" : "oc-lightbox__img--fit"
                  }
                  decoding="async"
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </LightboxContext.Provider>
  );
}
