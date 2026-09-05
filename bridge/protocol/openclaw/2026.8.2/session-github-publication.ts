// VENDORED VERBATIM from openclaw/openclaw @ v2026.8.2 — packages/gateway-protocol/src/schema/session-github-publication.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const GitHubPublicationTitleSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\r\\n]*\\S[^\\r\\n]*$",
});
export const GitHubPublicationBodySchema = Type.String({ minLength: 1, maxLength: 8 * 1024 });

export const SessionGitHubPublishParamsSchema = closedObject({
  sessionKey: Type.Optional(NonEmptyString),
  idempotencyKey: NonEmptyString,
  title: Type.Optional(GitHubPublicationTitleSchema),
  body: Type.Optional(GitHubPublicationBodySchema),
});

const SessionGitHubPublicationBaseSchema = {
  requestId: NonEmptyString,
};

export const SessionGitHubPublicationRequestedSchema = closedObject({
  ...SessionGitHubPublicationBaseSchema,
  status: Type.Literal("requested"),
  message: NonEmptyString,
});
export const SessionGitHubPublicationPublishingSchema = closedObject({
  ...SessionGitHubPublicationBaseSchema,
  status: Type.Literal("publishing"),
  message: NonEmptyString,
});
export const SessionGitHubPublicationPublishedSchema = closedObject({
  ...SessionGitHubPublicationBaseSchema,
  status: Type.Literal("published"),
  url: NonEmptyString,
  repository: NonEmptyString,
  branch: NonEmptyString,
  headCommit: NonEmptyString,
});
export const SessionGitHubPublicationFailedSchema = closedObject({
  ...SessionGitHubPublicationBaseSchema,
  status: Type.Literal("failed"),
  code: Type.Union([
    Type.Literal("identity_changed"),
    Type.Literal("identity_unavailable"),
    Type.Literal("session_changed"),
    Type.Literal("workspace_changed"),
    Type.Literal("not_git"),
    Type.Literal("not_github"),
    Type.Literal("no_changes"),
    Type.Literal("push_rejected"),
    Type.Literal("github_rejected"),
    Type.Literal("unavailable"),
  ]),
  message: NonEmptyString,
  nextAction: NonEmptyString,
});

export const SessionGitHubPublicationResultSchema = Type.Union([
  SessionGitHubPublicationRequestedSchema,
  SessionGitHubPublicationPublishingSchema,
  SessionGitHubPublicationPublishedSchema,
  SessionGitHubPublicationFailedSchema,
]);

export type SessionGitHubPublishParams = Static<typeof SessionGitHubPublishParamsSchema>;
export type SessionGitHubPublicationRequested = Static<
  typeof SessionGitHubPublicationRequestedSchema
>;
export type SessionGitHubPublicationPublishing = Static<
  typeof SessionGitHubPublicationPublishingSchema
>;
export type SessionGitHubPublicationPublished = Static<
  typeof SessionGitHubPublicationPublishedSchema
>;
export type SessionGitHubPublicationFailed = Static<typeof SessionGitHubPublicationFailedSchema>;
export type SessionGitHubPublicationResult = Static<typeof SessionGitHubPublicationResultSchema>;
