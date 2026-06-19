// Outbound DELIVERY instruction. The bridge hosts an agent-generated file as a
// downloadable attachment ONLY when the agent emits a `MEDIA:<absolute path>` line
// (the bridge's media fetcher then fetches it → Convex storage → a download chip).
// An agent that instead writes a markdown link to a local path produces NO download
// (the path isn't browser-openable) and reports "I couldn't attach it". OpenWebUI's
// proven pipe avoids this by INJECTING a standing delivery instruction into the
// gateway message; we mirror that here so deliverables work out-of-the-box without
// per-agent AGENTS.md config. Appended to the GATEWAY message only (never the
// visible Convex text), gated off when outbound media is disabled.

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
