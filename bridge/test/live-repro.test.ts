// LIVE diagnostic probe (NOT a unit test) — gated by LIVE_REPRO=1, skipped otherwise.
// Reproduces the prod incident against the local OpenClaw gateway. The crash is in
// the TURN (the agent reading a PDF via media-understanding for a text/image-only
// gpt-5.5 model), so we must let the turn RUN — consume frames through finalize/
// error, not just the chat.send ack. Run:
//   LIVE_REPRO=1 REAL_PDF=<path> npx vitest run test/live-repro.test.ts
import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { buildSessionKey } from "../src/providers/openclaw/session-keys.js";
import { loadConfig } from "../src/config.js";

const LIVE = process.env.LIVE_REPRO === "1";

(LIVE ? it : it.skip)(
  "prod scenario: PDF attachment + 'convert this file', turn run to completion",
  async () => {
    for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0 && !line.trimStart().startsWith("#")) {
        const k = line.slice(0, eq).trim();
        if (!process.env[k]) process.env[k] = line.slice(eq + 1);
      }
    }
    const cfg = loadConfig();
    const conn = await OpenClawConnection.connect(
      cfg.openclawGatewayUrl,
      cfg.openclawToken,
      cfg.deviceIdentity,
    );

    const pdfPath = process.env.REAL_PDF;
    const pdfBytes = pdfPath ? readFileSync(pdfPath) : Buffer.from("%PDF-1.4\n" + "A".repeat(800_000));
    console.log(`\n[probe] PDF: ${pdfPath ?? "synthetic"} (${pdfBytes.length} bytes)`);

    const sessionKey = buildSessionKey(`repro-turn-${Date.now()}`, "main", "olivier");
    // Simulate bridge re-hydration on a pruned/fresh session: prepend a large
    // synthetic "prior turns" history to the message. REPRO_HISTORY_KB controls
    // the size. Tests whether a huge message + attachment is rejected (the user's
    // pruning hypothesis) or accepted (gateway `message` has no maxLength).
    const historyKb = Number(process.env.REPRO_HISTORY_KB ?? "0");
    const history =
      historyKb > 0
        ? "Utilisateur: question precedente\nAssistant: reponse precedente\n".repeat(
            Math.ceil((historyKb * 1024) / 64),
          ) + "\n\n"
        : "";
    const messageText = history + "converti ce fichier en markdown";
    console.log(`[probe] message length: ${messageText.length} chars (history ${historyKb}KB)`);
    const params: Record<string, unknown> = {
      sessionKey,
      message: messageText,
      idempotencyKey: `repro-turn-${Date.now()}`,
      attachments: [
        {
          type: "file",
          mimeType: "application/pdf",
          fileName: "Organizational_Friction_Index.pdf",
          content: pdfBytes.toString("base64"),
        },
      ],
    };

    let ack: string;
    try {
      await conn.request("chat.send", params, 45_000);
      ack = "chat.send ACKED";
    } catch (e) {
      const err = e as { code?: string; message?: string };
      console.log(`\n[RESULT] chat.send FAILED (pre-ack) code=${err.code} msg=${(err.message ?? String(e)).slice(0, 200)}`);
      conn.close();
      expect(true).toBe(true);
      return;
    }
    console.log(`\n[probe] ${ack} — consuming turn frames...`);

    // Consume the turn's inbound frames until a final/error or a hard timeout.
    const errors: string[] = [];
    let finalSeen = false;
    let frameCount = 0;
    const deadline = Date.now() + 120_000;
    const consume = (async () => {
      for await (const frame of conn.frames()) {
        frameCount++;
        const s = JSON.stringify(frame);
        if (/RangeError|Maximum call stack|INVALID_REQUEST|lifecycle\/error|"error"/i.test(s)) {
          errors.push(s.slice(0, 240));
        }
        const p = (frame as { payload?: { state?: string; stream?: string; data?: { phase?: string } } }).payload;
        if (p?.state === "final" || p?.data?.phase === "error" || p?.stream === "lifecycle") {
          if (p?.state === "final") finalSeen = true;
        }
        if (finalSeen || Date.now() > deadline) break;
      }
    })();
    await Promise.race([consume, new Promise((r) => setTimeout(r, 125_000))]);
    conn.close();

    console.log(`\n[RESULT] turn ran: frames=${frameCount} finalSeen=${finalSeen} errorFrames=${errors.length}`);
    for (const e of errors.slice(0, 5)) console.log(`  ERR: ${e}`);
    expect(true).toBe(true); // diagnostic; the RESULT + gateway logs are the deliverable
  },
  200_000,
);
