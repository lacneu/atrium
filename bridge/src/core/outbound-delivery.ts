// Outbound DELIVERY instruction. The bridge hosts an agent-generated file as a
// downloadable attachment ONLY when the agent emits a `MEDIA:<absolute path>` line
// (the bridge's media fetcher then fetches it → Convex storage → a download chip).
// An agent that instead writes a markdown link to a local path produces NO download
// (the path isn't browser-openable) and reports "I couldn't attach it". OpenWebUI's
// proven pipe avoids this by INJECTING a standing delivery instruction into the
// gateway message; we mirror that here so deliverables work out-of-the-box without
// per-agent AGENTS.md config. Appended to the GATEWAY message only (never the
// visible Convex text), gated off when outbound media is disabled.

import { fillTemplate, type InboundInjection } from "./instance-config.js";

/**
 * Build the `[LIVRAISON]` instruction telling the agent how to deliver a generated
 * file in THIS webchat channel. `outboundDir` is the dir the bridge's media fetcher
 * reads (OPENCLAW_MEDIA_OUTBOUND_DIR / gateway-http source). Conditional on the
 * agent actually producing a file, so it never forces spurious output.
 */
export function buildDeliveryInstruction(outboundDir: string): string {
  const dir = outboundDir.replace(/\/$/, "");
  return [
    "",
    "[LIVRAISON]",
    `Pour qu'un fichier que tu génères soit téléchargeable par l'utilisateur ` +
      `dans ce webchat : écris-le sous ${dir}/ puis ajoute, dans ta réponse ` +
      `finale, une ligne dédiée EXACTEMENT au format MEDIA:<chemin absolu du ` +
      `fichier>. N'utilise PAS de lien markdown vers un chemin local — il ne ` +
      `serait pas cliquable.`,
  ].join("\n");
}

/**
 * Splice the `media_delivery` injection onto the gateway-bound `message`. Tri-state on
 * the resolved injection Convex sent (see InboundInstanceConfig.injections):
 *   - `enabled:false` (admin disabled — their agents already know to emit `MEDIA:`) →
 *     NOTHING is appended (the message is returned untouched);
 *   - `enabled:true` with a usable template → the admin's resolved text, `{outboundDir}` filled;
 *   - `undefined` (pre-feature Convex) OR a malformed `enabled:true` with an empty template
 *     → the bridge's own default instruction. A present-but-empty entry must FALL BACK to
 *     the default, never silently suppress delivery (only an explicit disable suppresses).
 * Pure + self-contained so the disable path is unit-provable: the returned message must
 * NOT contain `[LIVRAISON]` (or any delivery text) when disabled.
 */
export function applyMediaDeliveryInjection(
  message: string,
  outboundDir: string,
  injection: InboundInjection | undefined,
): string {
  let delivery: string | null;
  if (injection !== undefined && !injection.enabled) {
    delivery = null; // explicit disable — the only case that suppresses
  } else if (injection !== undefined && injection.template.length > 0) {
    delivery =
      "\n" + fillTemplate(injection.template, { outboundDir: outboundDir.replace(/\/$/, "") });
  } else {
    delivery = buildDeliveryInstruction(outboundDir); // absent OR enabled-but-empty
  }
  if (delivery === null) return message;
  return message ? `${message}\n${delivery}` : delivery;
}
