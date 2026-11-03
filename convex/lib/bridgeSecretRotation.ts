import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

type Candidate = {
  rotationId: string;
  principalId: string;
  hashedSecret: string;
  prefix: string;
  lastFour: string;
};

async function receipt(ctx: MutationCtx, instanceId: Id<"instances">) {
  return await ctx.db
    .query("bridgeSecretRotations")
    .withIndex("by_instanceId", (q) => q.eq("instanceId", instanceId))
    .unique();
}

/** Explicit replacement/revocation invalidates all outstanding rotation handles. */
export async function clearBridgeSecretRotation(
  ctx: MutationCtx,
  instanceId: Id<"instances">,
): Promise<void> {
  const row = await receipt(ctx, instanceId);
  if (row !== null) await ctx.db.delete("bridgeSecretRotations", row._id);
}

/** Keep the candidate outside the authentication table until its durable seal. */
export async function stageBridgeSecretRotation(
  ctx: MutationCtx,
  instanceId: Id<"instances">,
  candidate: Candidate,
): Promise<void> {
  const previous = await receipt(ctx, instanceId);
  if (previous !== null && previous.phase !== "retired") {
    throw new ConvexError("bridge_rotation_pending");
  }
  const active = await ctx.db
    .query("bridgeAuth")
    .withIndex("by_instance", (q) => q.eq("instanceId", instanceId))
    .take(2);
  if (active.length !== 1) throw new ConvexError("bridge_rotation_requires_one_secret");
  const collision = await ctx.db
    .query("bridgeAuth")
    .withIndex("by_hash", (q) => q.eq("hashedSecret", candidate.hashedSecret))
    .unique();
  const pendingCollision = await ctx.db
    .query("bridgeSecretRotations")
    .withIndex("by_candidateHash", (q) => q.eq("candidateHash", candidate.hashedSecret))
    .unique();
  if (collision !== null || pendingCollision !== null) {
    throw new ConvexError("bridge_rotation_secret_collision");
  }
  if (previous !== null) await ctx.db.delete("bridgeSecretRotations", previous._id);
  await ctx.db.insert("bridgeSecretRotations", {
    instanceId,
    rotationId: candidate.rotationId,
    principalId: candidate.principalId,
    phase: "staged",
    predecessorId: active[0]!._id,
    predecessorHash: active[0]!.hashedSecret,
    candidateHash: candidate.hashedSecret,
    prefix: candidate.prefix,
    lastFour: candidate.lastFour,
    createdAt: Date.now(),
  });
}

/** A handle belongs to one exact instance and the authenticated service principal. */
export async function finishBridgeSecretRotation(
  ctx: MutationCtx,
  args: {
    name: string;
    rotationId: string;
    principalId: string;
    operation: "seal" | "retire";
  },
): Promise<"sealed" | "already-sealed" | "already-active" | "retired" | "already-retired"> {
  const instances = await ctx.db
    .query("instances")
    .withIndex("by_name", (q) => q.eq("name", args.name.trim()))
    .take(2);
  if (instances.length !== 1) throw new ConvexError("bridge_rotation_not_found");
  const instanceId = instances[0]!._id;
  const row = await receipt(ctx, instanceId);
  if (row === null || row.rotationId !== args.rotationId || row.principalId !== args.principalId) {
    throw new ConvexError("bridge_rotation_not_found");
  }
  const active = await ctx.db
    .query("bridgeAuth")
    .withIndex("by_instance", (q) => q.eq("instanceId", instanceId))
    .take(3);
  const matches = (auth: Doc<"bridgeAuth">, id: Id<"bridgeAuth"> | undefined, hash: string) =>
    auth._id === id && auth.hashedSecret === hash;
  const predecessor = active.find((auth) => matches(auth, row.predecessorId, row.predecessorHash));
  const candidate = active.find((auth) => matches(auth, row.candidateId, row.candidateHash));
  if (row.phase === "retired") {
    if (active.length !== 1 || candidate === undefined) throw new ConvexError("bridge_rotation_drift");
    return args.operation === "seal" ? "already-active" : "already-retired";
  }
  if (row.phase === "staged") {
    if (args.operation !== "seal") throw new ConvexError("bridge_rotation_not_sealed");
    if (active.length !== 1 || predecessor === undefined) throw new ConvexError("bridge_rotation_drift");
    const collision = await ctx.db
      .query("bridgeAuth")
      .withIndex("by_hash", (q) => q.eq("hashedSecret", row.candidateHash))
      .unique();
    if (collision !== null) throw new ConvexError("bridge_rotation_drift");
    const candidateId = await ctx.db.insert("bridgeAuth", {
      instanceId,
      hashedSecret: row.candidateHash,
      prefix: row.prefix,
      lastFour: row.lastFour,
      createdAt: Date.now(),
      createdByPrincipal: args.principalId,
    });
    await ctx.db.patch("bridgeSecretRotations", row._id, { phase: "sealed", candidateId });
    return "sealed";
  }
  if (active.length !== 2 || predecessor === undefined || candidate === undefined) {
    throw new ConvexError("bridge_rotation_drift");
  }
  if (args.operation === "seal") return "already-sealed";
  await ctx.db.delete("bridgeAuth", predecessor._id);
  await ctx.db.patch("bridgeSecretRotations", row._id, { phase: "retired" });
  return "retired";
}
