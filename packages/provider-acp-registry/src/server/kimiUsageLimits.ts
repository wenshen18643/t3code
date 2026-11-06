import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import type { AcpRegistrySettings } from "../settings.ts";

const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_OAUTH_KEY = "oauth/kimi-code";
const MANAGED_PROVIDER_TABLE = 'providers."managed:kimi-code"';

const Credential = Schema.Struct({ access_token: Schema.String, expires_at: Schema.Finite });
const decodeCredential = Schema.decodeEffect(Schema.fromJsonString(Credential));
const QuotaEntry = Schema.Struct({
  used_ratio: Schema.Finite,
  reset_time: Schema.optional(Schema.String),
});
const UsageResponse = Schema.Struct({
  usages: Schema.optional(
    Schema.Struct({
      limit_5h: Schema.optional(QuotaEntry),
      limit_7d: Schema.optional(QuotaEntry),
      limit_month_total: Schema.optional(QuotaEntry),
    }),
  ),
});
const TokenClaims = Schema.Struct({ user_id: Schema.optional(Schema.String) });
const decodeTokenClaims = Schema.decodeUnknownOption(Schema.fromJsonString(TokenClaims));

/** The registry ships the Python `kimi` CLI; `@moonshot-ai/kimi-code` runs as a local command. */
export function isKimiAcpAgent(
  settings: Pick<AcpRegistrySettings, "source" | "agentId" | "commandPath" | "commandArgs">,
): boolean {
  if (settings.source !== "local") return settings.agentId === "kimi";
  const executable = settings.commandPath.split(/[\\/]/).pop() ?? "";
  return (
    /^kimi(-cli)?(\.exe|\.cmd)?$/i.test(executable) ||
    settings.commandArgs.some((arg) => /[\\/]@moonshot-ai[\\/]kimi-code[\\/]/i.test(arg))
  );
}

/** Reads the managed account's endpoint and credential slot without a full TOML parser. */
function readKimiManagedAccount(configToml: string) {
  let table = "";
  let baseUrl = DEFAULT_BASE_URL;
  let oauthKey = DEFAULT_OAUTH_KEY;
  for (const line of configToml.split(/\r?\n/)) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      table = header[1]!.replace(/\s+/g, "");
      continue;
    }
    const entry = /^\s*(base_url|key)\s*=\s*"([^"]*)"/.exec(line);
    if (entry?.[1] === "base_url" && table === MANAGED_PROVIDER_TABLE) baseUrl = entry[2]!;
    if (entry?.[1] === "key" && table === `${MANAGED_PROVIDER_TABLE}.oauth`) oauthKey = entry[2]!;
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), oauthKey };
}

function kimiUsageWindows(
  usages: (typeof UsageResponse.Type)["usages"],
): ServerProviderUsageWindow[] {
  const windows: ServerProviderUsageWindow[] = [];
  for (const [id, kind, label, windowDurationMins] of [
    ["limit_5h", "session", "5-hour", 5 * 60],
    ["limit_7d", "weekly", "Weekly", 7 * 24 * 60],
    ["limit_month_total", "monthly", "Monthly", undefined],
  ] as const) {
    const entry = usages?.[id];
    if (!entry) continue;
    const resetsAt = Option.getOrUndefined(DateTime.make(entry.reset_time ?? ""));
    windows.push({
      id,
      kind,
      label,
      usedPercent: clampPercent(entry.used_ratio * 100),
      ...(resetsAt ? { resetsAt: DateTime.formatIso(resetsAt) } : {}),
      ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
    });
  }
  return windows;
}

/**
 * Kimi rotates refresh tokens, so refreshing here could sign the CLI out. Only a
 * live access token is used; Kimi renews it while it runs, and stale reads keep
 * the last published limits.
 */
export const readKimiUsageLimits = Effect.fn("readKimiUsageLimits")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = input.environment;
    const home = env.HOME || env.USERPROFILE || (yield* HostProcess.HomeDirectory);
    const homes = [
      ...new Set(
        [
          env.KIMI_CODE_HOME,
          path.join(home, ".kimi-code"),
          env.KIMI_SHARE_DIR,
          path.join(home, ".kimi"),
        ].filter((dir): dir is string => Boolean(dir)),
      ),
    ];
    const accounts = yield* Effect.forEach(homes, (dir) =>
      Effect.gen(function* () {
        const config = yield* fs
          .readFileString(path.join(dir, "config.toml"))
          .pipe(Effect.orElseSucceed(() => ""));
        const { baseUrl, oauthKey } = readKimiManagedAccount(config);
        const slot = /^oauth\/([\w.-]+)$/.exec(oauthKey)?.[1];
        if (!slot || !baseUrl.startsWith("https://")) return undefined;
        const credential = yield* fs
          .readFileString(path.join(dir, "credentials", `${slot}.json`))
          .pipe(Effect.flatMap(decodeCredential));
        return credential.access_token ? { baseUrl, ...credential } : undefined;
      }).pipe(Effect.orElseSucceed(() => undefined)),
    );
    const signedIn = accounts
      .filter((account) => account !== undefined)
      .sort((left, right) => right.expires_at - left.expires_at);
    if (signedIn.length === 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Sign in to Kimi Code to see its limits.",
      });
    }
    const now = yield* Clock.currentTimeMillis;
    const account = signedIn.find((candidate) => candidate.expires_at * 1000 > now + 30_000);
    if (!account) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Kimi limits refresh while Kimi Code is in use.",
      });
    }
    const client = yield* HttpClient.HttpClient;
    const body = yield* client
      .execute(
        HttpClientRequest.get(`${account.baseUrl}/usages`).pipe(
          HttpClientRequest.bearerToken(account.access_token),
          HttpClientRequest.acceptJson,
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
      );
    const windows = kimiUsageWindows(body.usages);
    if (windows.length === 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "This Kimi account has no subscription limits.",
      });
    }
    // Claims only group the same account across environments; the API already verified the token.
    const claims = Buffer.from(account.access_token.split(".")[1] ?? "", "base64url");
    const userId = Option.getOrUndefined(decodeTokenClaims(claims.toString("utf8")))?.user_id;
    const digest = yield* Digest.Digest;
    const credentialFingerprint = userId
      ? yield* digest
          .digest(Digest.sha256, new TextEncoder().encode(`kimi-account\0${userId}`))
          .pipe(Effect.map(Hex.encode), Effect.orDie)
      : undefined;
    return {
      ...makeUsageLimits({ checkedAt, windows }),
      ...(credentialFingerprint ? { credentialFingerprint } : {}),
    };
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Could not read Kimi limits.",
      }),
    ),
  );
});
