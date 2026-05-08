import { Request } from "express";
import { Config, RelayProviderConfig } from "../config";
import { AvailableAccount } from "../accounts/manager";
import { withTimeoutSignal } from "../utils/abort";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function relayModel(config: RelayProviderConfig, model: string): string {
  const prefix = config["strip-model-prefix"];
  if (prefix && model.startsWith(prefix)) return model.slice(prefix.length);
  return model;
}

function buildRelayHeaders(
  relay: RelayProviderConfig,
  stream: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    ...(relay.headers || {}),
  };
  const keyHeader = relay["api-key-header"];
  if (keyHeader) {
    headers[keyHeader] = relay["api-key"];
  } else {
    headers.Authorization = `Bearer ${relay["api-key"]}`;
  }
  return headers;
}

export function normalizeRelayBody(
  body: any,
  relay: RelayProviderConfig,
): any {
  if (!body || typeof body !== "object") return body;
  const next = { ...body };
  if (typeof next.model === "string") {
    next.model = relayModel(relay, next.model);
  }
  return next;
}

export interface CallRelayOptions {
  body?: any;
  request: Request;
  account: AvailableAccount;
  config: Config;
  relay: RelayProviderConfig;
  path: "/v1/chat/completions" | "/v1/messages" | "/v1/messages/count_tokens";
  signal?: AbortSignal;
}

export async function callRelay(options: CallRelayOptions): Promise<Response> {
  const { request, config, relay, path } = options;
  const body = normalizeRelayBody(options.body ?? request.body, relay);
  const stream = !!body?.stream;
  const timeoutMs = stream
    ? config.timeouts["stream-messages-ms"]
    : path === "/v1/messages/count_tokens"
      ? config.timeouts["count-tokens-ms"]
      : config.timeouts["messages-ms"];
  const url = `${trimTrailingSlash(relay["base-url"])}${path}`;

  try {
    return await fetch(url, {
      method: "POST",
      headers: buildRelayHeaders(relay, stream),
      body: JSON.stringify(body),
      signal: withTimeoutSignal(timeoutMs, options.signal),
    });
  } catch (err: any) {
    const cause = err?.cause;
    const detail = cause
      ? `${cause.code || cause.name || "error"}: ${cause.message || String(cause)}`
      : err?.message || String(err);
    throw new Error(`relay upstream fetch failed: ${detail}`);
  }
}

