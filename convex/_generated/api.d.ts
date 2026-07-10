/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as agentFileCuration from "../agentFileCuration.js";
import type * as agentFiles from "../agentFiles.js";
import type * as agents from "../agents.js";
import type * as anomalies from "../anomalies.js";
import type * as apiKeys from "../apiKeys.js";
import type * as apiRateLimit from "../apiRateLimit.js";
import type * as auth from "../auth.js";
import type * as bridge from "../bridge.js";
import type * as bridgeAuth from "../bridgeAuth.js";
import type * as bridgeHealth from "../bridgeHealth.js";
import type * as bridge_credentials from "../bridge_credentials.js";
import type * as bridge_ingest from "../bridge_ingest.js";
import type * as charts from "../charts.js";
import type * as chatFork from "../chatFork.js";
import type * as chatSummaries from "../chatSummaries.js";
import type * as chats from "../chats.js";
import type * as compat from "../compat.js";
import type * as crons from "../crons.js";
import type * as deliveryTiming from "../deliveryTiming.js";
import type * as dev from "../dev.js";
import type * as deviceIdentity from "../deviceIdentity.js";
import type * as documentAttachments from "../documentAttachments.js";
import type * as feedback from "../feedback.js";
import type * as fileRenditions from "../fileRenditions.js";
import type * as files from "../files.js";
import type * as groups from "../groups.js";
import type * as http from "../http.js";
import type * as instanceSecrets from "../instanceSecrets.js";
import type * as instanceSync from "../instanceSync.js";
import type * as integrations_config from "../integrations/config.js";
import type * as integrations_enrich from "../integrations/enrich.js";
import type * as integrations_langfuse from "../integrations/langfuse.js";
import type * as integrations_opik from "../integrations/opik.js";
import type * as integrations_otlp from "../integrations/otlp.js";
import type * as integrations_otlpSecret from "../integrations/otlpSecret.js";
import type * as integrations_otlpShared from "../integrations/otlpShared.js";
import type * as integrations_shared from "../integrations/shared.js";
import type * as integrations_ship from "../integrations/ship.js";
import type * as integrations_status from "../integrations/status.js";
import type * as introspect from "../introspect.js";
import type * as kpi from "../kpi.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_agentTypes from "../lib/agentTypes.js";
import type * as lib_apiAuth from "../lib/apiAuth.js";
import type * as lib_apikeys from "../lib/apikeys.js";
import type * as lib_attachmentLimits from "../lib/attachmentLimits.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_authDomains from "../lib/authDomains.js";
import type * as lib_bridgeRouting from "../lib/bridgeRouting.js";
import type * as lib_chartValidation from "../lib/chartValidation.js";
import type * as lib_charts from "../lib/charts.js";
import type * as lib_chatRenderState from "../lib/chatRenderState.js";
import type * as lib_compat from "../lib/compat.js";
import type * as lib_crypto_cipher from "../lib/crypto/cipher.js";
import type * as lib_crypto_convexValidator from "../lib/crypto/convexValidator.js";
import type * as lib_crypto_keyProvider from "../lib/crypto/keyProvider.js";
import type * as lib_curation from "../lib/curation.js";
import type * as lib_diagnose from "../lib/diagnose.js";
import type * as lib_domains from "../lib/domains.js";
import type * as lib_envLabel from "../lib/envLabel.js";
import type * as lib_files from "../lib/files.js";
import type * as lib_filters from "../lib/filters.js";
import type * as lib_groupAccess from "../lib/groupAccess.js";
import type * as lib_instanceConfig from "../lib/instanceConfig.js";
import type * as lib_locales from "../lib/locales.js";
import type * as lib_mediaName from "../lib/mediaName.js";
import type * as lib_mediaTransport from "../lib/mediaTransport.js";
import type * as lib_messageOrder from "../lib/messageOrder.js";
import type * as lib_openclawThread from "../lib/openclawThread.js";
import type * as lib_outboxQueue from "../lib/outboxQueue.js";
import type * as lib_promptInjections from "../lib/promptInjections.js";
import type * as lib_provenance from "../lib/provenance.js";
import type * as lib_rbac from "../lib/rbac.js";
import type * as lib_rehydrateTrace from "../lib/rehydrateTrace.js";
import type * as lib_rehydration from "../lib/rehydration.js";
import type * as lib_schemaRegistry from "../lib/schemaRegistry.js";
import type * as lib_search from "../lib/search.js";
import type * as lib_serverLocale from "../lib/serverLocale.js";
import type * as lib_subAgentFailure from "../lib/subAgentFailure.js";
import type * as lib_timeRange from "../lib/timeRange.js";
import type * as lib_uiPrefs from "../lib/uiPrefs.js";
import type * as me from "../me.js";
import type * as messages from "../messages.js";
import type * as metricsProbe from "../metricsProbe.js";
import type * as notifications from "../notifications.js";
import type * as observability from "../observability.js";
import type * as openclaw from "../openclaw.js";
import type * as projects from "../projects.js";
import type * as routing from "../routing.js";
import type * as search from "../search.js";
import type * as send from "../send.js";
import type * as stream from "../stream.js";
import type * as stuckStreams from "../stuckStreams.js";
import type * as subAgentInteractions from "../subAgentInteractions.js";
import type * as subAgentReports from "../subAgentReports.js";
import type * as subAgents from "../subAgents.js";
import type * as turnRetry from "../turnRetry.js";
import type * as uploads from "../uploads.js";
import type * as version from "../version.js";
import type * as voice from "../voice.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  agentFileCuration: typeof agentFileCuration;
  agentFiles: typeof agentFiles;
  agents: typeof agents;
  anomalies: typeof anomalies;
  apiKeys: typeof apiKeys;
  apiRateLimit: typeof apiRateLimit;
  auth: typeof auth;
  bridge: typeof bridge;
  bridgeAuth: typeof bridgeAuth;
  bridgeHealth: typeof bridgeHealth;
  bridge_credentials: typeof bridge_credentials;
  bridge_ingest: typeof bridge_ingest;
  charts: typeof charts;
  chatFork: typeof chatFork;
  chatSummaries: typeof chatSummaries;
  chats: typeof chats;
  compat: typeof compat;
  crons: typeof crons;
  deliveryTiming: typeof deliveryTiming;
  dev: typeof dev;
  deviceIdentity: typeof deviceIdentity;
  documentAttachments: typeof documentAttachments;
  feedback: typeof feedback;
  fileRenditions: typeof fileRenditions;
  files: typeof files;
  groups: typeof groups;
  http: typeof http;
  instanceSecrets: typeof instanceSecrets;
  instanceSync: typeof instanceSync;
  "integrations/config": typeof integrations_config;
  "integrations/enrich": typeof integrations_enrich;
  "integrations/langfuse": typeof integrations_langfuse;
  "integrations/opik": typeof integrations_opik;
  "integrations/otlp": typeof integrations_otlp;
  "integrations/otlpSecret": typeof integrations_otlpSecret;
  "integrations/otlpShared": typeof integrations_otlpShared;
  "integrations/shared": typeof integrations_shared;
  "integrations/ship": typeof integrations_ship;
  "integrations/status": typeof integrations_status;
  introspect: typeof introspect;
  kpi: typeof kpi;
  "lib/access": typeof lib_access;
  "lib/agentTypes": typeof lib_agentTypes;
  "lib/apiAuth": typeof lib_apiAuth;
  "lib/apikeys": typeof lib_apikeys;
  "lib/attachmentLimits": typeof lib_attachmentLimits;
  "lib/audit": typeof lib_audit;
  "lib/authDomains": typeof lib_authDomains;
  "lib/bridgeRouting": typeof lib_bridgeRouting;
  "lib/chartValidation": typeof lib_chartValidation;
  "lib/charts": typeof lib_charts;
  "lib/chatRenderState": typeof lib_chatRenderState;
  "lib/compat": typeof lib_compat;
  "lib/crypto/cipher": typeof lib_crypto_cipher;
  "lib/crypto/convexValidator": typeof lib_crypto_convexValidator;
  "lib/crypto/keyProvider": typeof lib_crypto_keyProvider;
  "lib/curation": typeof lib_curation;
  "lib/diagnose": typeof lib_diagnose;
  "lib/domains": typeof lib_domains;
  "lib/envLabel": typeof lib_envLabel;
  "lib/files": typeof lib_files;
  "lib/filters": typeof lib_filters;
  "lib/groupAccess": typeof lib_groupAccess;
  "lib/instanceConfig": typeof lib_instanceConfig;
  "lib/locales": typeof lib_locales;
  "lib/mediaName": typeof lib_mediaName;
  "lib/mediaTransport": typeof lib_mediaTransport;
  "lib/messageOrder": typeof lib_messageOrder;
  "lib/openclawThread": typeof lib_openclawThread;
  "lib/outboxQueue": typeof lib_outboxQueue;
  "lib/promptInjections": typeof lib_promptInjections;
  "lib/provenance": typeof lib_provenance;
  "lib/rbac": typeof lib_rbac;
  "lib/rehydrateTrace": typeof lib_rehydrateTrace;
  "lib/rehydration": typeof lib_rehydration;
  "lib/schemaRegistry": typeof lib_schemaRegistry;
  "lib/search": typeof lib_search;
  "lib/serverLocale": typeof lib_serverLocale;
  "lib/subAgentFailure": typeof lib_subAgentFailure;
  "lib/timeRange": typeof lib_timeRange;
  "lib/uiPrefs": typeof lib_uiPrefs;
  me: typeof me;
  messages: typeof messages;
  metricsProbe: typeof metricsProbe;
  notifications: typeof notifications;
  observability: typeof observability;
  openclaw: typeof openclaw;
  projects: typeof projects;
  routing: typeof routing;
  search: typeof search;
  send: typeof send;
  stream: typeof stream;
  stuckStreams: typeof stuckStreams;
  subAgentInteractions: typeof subAgentInteractions;
  subAgentReports: typeof subAgentReports;
  subAgents: typeof subAgents;
  turnRetry: typeof turnRetry;
  uploads: typeof uploads;
  version: typeof version;
  voice: typeof voice;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
