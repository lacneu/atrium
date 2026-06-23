// De-risk probe (throwaway): can a Node ConvexClient authenticate as an anonymous
// dev user, get provisioned + approved, learn its userId, and make an authed
// reactive call against the local self-hosted backend?
// Run: CONVEX_URL=http://127.0.0.1:3212 node scripts/loadtest/authprobe.mjs
import { ConvexClient } from "convex/browser";

const url = process.env.CONVEX_URL || "http://127.0.0.1:3212";
const client = new ConvexClient(url);
const log = (...a) => console.log(...a);

try {
  // 1. Anonymous sign-in -> bearer token.
  const res = await client.action("auth:signIn", { provider: "anonymous" });
  const token = res?.tokens?.token;
  log("1. signIn token:", token ? "yes" : "NO");
  if (!token) process.exit(1);
  client.setAuth(async () => token);

  // 2. Provision the profile (first user -> admin, rest -> pending).
  const boot = await client.mutation("me:bootstrap", {});
  log("2. bootstrap role:", JSON.stringify(boot));

  // 3. Approve if pending (dev escape hatch; profile now exists).
  if (boot?.role !== "user" && boot?.role !== "admin") {
    const r = await client.mutation("dev:setMyRole", { role: "user" });
    log("3. setMyRole ->", JSON.stringify(r));
  } else {
    log("3. already active, no promotion needed");
  }

  // 4. Learn the userId (for dev-provisioning this user's chats).
  const me = await client.query("me:getMe", { host: "localhost" });
  log("4. getMe keys:", Object.keys(me ?? {}).join(","));
  log("   userId candidate:", me?.userId ?? me?.id ?? me?._id ?? "(none — inspect keys)");

  // 5. The authed reactive query the harness will subscribe to.
  const chats = await client.query("messages:listChats", {});
  log("5. listChats OK:", chats.length, "chats");
} catch (e) {
  log("PROBE FAILED:", String(e?.message ?? e).slice(0, 200));
  process.exitCode = 1;
} finally {
  await client.close();
}
