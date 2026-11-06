import * as NodeAssert from "node:assert/strict";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { isKimiAcpAgent, readKimiUsageLimits } from "./kimiUsageLimits.ts";

const token = (userId: string) =>
  `h.${Buffer.from(JSON.stringify({ user_id: userId })).toString("base64url")}.s`;

const GLOBAL_CONFIG = `
default_model = "kimi-code/k3"

[[hooks]]
key = "not-the-oauth-slot"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.ai/coding/v1/"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-0e4f99c69cc27850"
`;

const readKimi = (files: Record<string, string>, requests: string[]) =>
  readKimiUsageLimits({ environment: { HOME: "/home/u" } }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        readFileString: (path) => {
          const contents = files[path.replaceAll("\\", "/")];
          return contents === undefined
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "readFileString",
                  pathOrDescriptor: path,
                }),
              )
            : Effect.succeed(contents);
        },
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(`${request.url} ${request.headers.authorization}`);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              usages: {
                limit_5h: { used_ratio: 0.0382, reset_time: "2026-11-06T12:52:35Z" },
                limit_7d: { used_ratio: 1.2, reset_time: "2026-11-13T07:52:34Z" },
                limit_month_total: { used_ratio: 0.5 },
              },
            }),
          ),
        );
      }),
    ),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

describe("readKimiUsageLimits", () => {
  it.effect("reads the configured account slot and maps Kimi's quota windows", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const limits = yield* readKimi(
        {
          "/home/u/.kimi-code/config.toml": GLOBAL_CONFIG,
          "/home/u/.kimi-code/credentials/kimi-code-env-0e4f99c69cc27850.json": JSON.stringify({
            access_token: token("user-1"),
            expires_at: 3_600,
          }),
          // The legacy CLI's older login must not win over the fresher Kimi Code login.
          "/home/u/.kimi/credentials/kimi-code.json": JSON.stringify({
            access_token: token("user-1"),
            expires_at: 120,
          }),
        },
        requests,
      );
      NodeAssert.deepEqual(requests, [
        `https://api.kimi.ai/coding/v1/usages Bearer ${token("user-1")}`,
      ]);
      NodeAssert.equal(limits.unavailable, undefined);
      NodeAssert.deepEqual(
        limits.windows.map(({ id, kind, usedPercent, resetsAt, windowDurationMins }) => ({
          id,
          kind,
          usedPercent,
          resetsAt,
          windowDurationMins,
        })),
        [
          {
            id: "limit_5h",
            kind: "session",
            usedPercent: 3.82,
            resetsAt: "2026-11-06T12:52:35.000Z",
            windowDurationMins: 300,
          },
          {
            id: "limit_7d",
            kind: "weekly",
            usedPercent: 100,
            resetsAt: "2026-11-13T07:52:34.000Z",
            windowDurationMins: 10_080,
          },
          {
            id: "limit_month_total",
            kind: "monthly",
            usedPercent: 50,
            resetsAt: undefined,
            windowDurationMins: undefined,
          },
        ],
      );
      NodeAssert.equal(
        limits.credentialFingerprint,
        "770d00b55c8853a3e04a856860ffa96a672bfc0c6f82741e4c1824204a5089cc",
      );
    }),
  );

  it.effect("never refreshes an expired login and reports a missing one as unsupported", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const expired = yield* readKimi(
        {
          "/home/u/.kimi/credentials/kimi-code.json": JSON.stringify({
            access_token: token("user-1"),
            expires_at: 10,
          }),
        },
        requests,
      );
      NodeAssert.equal(expired.unavailable?.reason, "probeFailed");
      const signedOut = yield* readKimi(
        {
          "/home/u/.kimi-code/config.toml": GLOBAL_CONFIG,
          "/home/u/.kimi-code/credentials/kimi-code-env-0e4f99c69cc27850.json": JSON.stringify({
            access_token: "",
            expires_at: 0,
          }),
        },
        requests,
      );
      NodeAssert.equal(signedOut.unavailable?.reason, "unsupported");
      NodeAssert.deepEqual(requests, []);
    }),
  );
});

it("recognizes Kimi from the registry id or its local launch command", () => {
  const local = { source: "local" as const, agentId: "" };
  for (const [settings, expected] of [
    [{ source: "registry" as const, agentId: "kimi", commandPath: "", commandArgs: [] }, true],
    [{ source: "registry" as const, agentId: "devin", commandPath: "", commandArgs: [] }, false],
    [
      {
        ...local,
        commandPath: "C:\\Program Files\\nodejs\\node.exe",
        commandArgs: [
          "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs",
          "acp",
        ],
      },
      true,
    ],
    [{ ...local, commandPath: "/usr/local/bin/kimi", commandArgs: ["acp"] }, true],
    [{ ...local, commandPath: "C:\\bin\\copilot.exe", commandArgs: ["--acp"] }, false],
  ] as const) {
    NodeAssert.equal(isKimiAcpAgent(settings), expected);
  }
});
