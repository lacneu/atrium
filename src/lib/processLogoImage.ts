// Client-side logo NORMALIZER. Decodes any image the browser can read
// (PNG/JPEG/WebP/GIF/AVIF via createImageBitmap; SVG via <img>) and RE-ENCODES it
// to a bounded WebP on a canvas. Re-encoding is both a transform (uniform format
// + size, EXIF stripped) AND a safety step: a polyglot/scripted SVG becomes inert
// raster pixels. The returned Blob is what gets uploaded; the server then
// magic-byte-validates it (see convex/charts.ts setChartLogo). Best-practice refs:
// canvas re-encode + client resize (Cloudinary/PQINA), re-encode to neutralize
// payloads (OWASP secure upload), SVG → raster to remove XSS surface (DOMPurify/SVG).
import { m } from "@/paraglide/messages.js";

const MAX_INPUT_BYTES = 12 * 1024 * 1024; // reject absurd inputs before decoding
const MAX_W = 480; // fit box (handles wordmark logos; topbar shows it small)
const MAX_H = 160;
const WEBP_QUALITY = 0.92;

type Decoded = {
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup: () => void;
};

/** Options for {@link processLogoImage}. */
export type ProcessLogoOptions = {
  /**
   * Invert RGB (preserving alpha) to PROPOSE the opposite-mode variant. For the
   * common monochrome brand mark this flips dark↔light ink cleanly; for a colored
   * logo it is a hue-shifted starting suggestion the user can replace.
   */
  invert?: boolean;
};

/** Decode + downscale + (optionally invert) + re-encode to a bounded WebP Blob. */
export async function processLogoImage(
  file: Blob,
  opts: ProcessLogoOptions = {},
): Promise<Blob> {
  if (!file.type.startsWith("image/")) {
    throw new Error(m.charts_logo_err_not_image());
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error(m.charts_logo_err_too_large());
  }
  const { source, width, height, cleanup } = await decodeImage(file);
  try {
    // Fit within the box, preserve aspect, never upscale raster. A vector (SVG)
    // MAY scale up to the box so it rasterizes crisply.
    const isVector = file.type === "image/svg+xml";
    const scale = Math.min(
      MAX_W / width,
      MAX_H / height,
      isVector ? Number.POSITIVE_INFINITY : 1,
    );
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(m.charts_logo_err_process());
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, w, h);
    if (opts.invert) {
      const data = ctx.getImageData(0, 0, w, h);
      const px = data.data;
      for (let i = 0; i < px.length; i += 4) {
        px[i] = 255 - px[i]; // R
        px[i + 1] = 255 - px[i + 1]; // G
        px[i + 2] = 255 - px[i + 2]; // B
        // px[i + 3] (alpha) preserved
      }
      ctx.putImageData(data, 0, 0);
    }
    const blob =
      (await canvasToBlob(canvas, "image/webp", WEBP_QUALITY)) ??
      (await canvasToBlob(canvas, "image/png"));
    if (!blob) throw new Error(m.charts_logo_err_encode());
    return blob;
  } finally {
    cleanup();
  }
}

async function decodeImage(file: Blob): Promise<Decoded> {
  // SVG: <img> rasterizes it (createImageBitmap doesn't reliably handle SVG).
  if (file.type === "image/svg+xml") return decodeViaImg(file);
  // Raster incl. AVIF/WebP/GIF/PNG/JPEG: createImageBitmap decodes if supported.
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      return {
        source: bmp,
        width: bmp.width,
        height: bmp.height,
        cleanup: () => bmp.close(),
      };
    } catch {
      // fall through to the <img> path (older browser / unusual format)
    }
  }
  return decodeViaImg(file);
}

async function decodeViaImg(file: Blob): Promise<Decoded> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(m.charts_logo_err_decode()));
      img.src = url;
    });
    // An SVG with no intrinsic size reports ~300x150 in most browsers — fine, we
    // fit to the box anyway; guard against 0.
    const width = img.naturalWidth || 300;
    const height = img.naturalHeight || 150;
    return { source: img, width, height, cleanup: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}
