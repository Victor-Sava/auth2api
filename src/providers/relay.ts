import { RelayProviderConfig } from "../config";
import { AccountManager } from "../accounts/manager";
import { PKCECodes, ProviderId, TokenData } from "../auth/types";
import { callRelay } from "../upstream/relay-api";
import { Provider, UpstreamCallContext, ProviderOAuthInfo } from "./types";

const RELAY_OAUTH: ProviderOAuthInfo = {
  callbackPort: 0,
  callbackPath: "/relay/config",
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeRelayId(id: string): string {
  const safe = id.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_");
  return safe.startsWith("relay:") ? safe : `relay:${safe}`;
}

function relayAccountToken(
  config: RelayProviderConfig,
  providerId: ProviderId,
): TokenData {
  return {
    accessToken: config["api-key"],
    refreshToken: config["api-key"],
    email: config.name || config.id,
    expiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString(),
    accountUuid: config.id,
    provider: providerId,
  };
}

export function buildRelayProvider(config: RelayProviderConfig): Provider {
  const providerId = normalizeRelayId(config.id) as ProviderId;
  const manager = new AccountManager("", {
    provider: providerId,
    refresh: async () => relayAccountToken(config, providerId),
  });
  manager.addInMemoryAccount(relayAccountToken(config, providerId));

  const modelSet = new Set(config.models || []);
  const prefixes = config["model-prefixes"] || [];
  const stripPrefix = config["strip-model-prefix"];
  if (stripPrefix) prefixes.push(stripPrefix);
  const prefixedModels = stripPrefix
    ? (config.models || []).map((m) => `${stripPrefix}${m}`)
    : [];

  return {
    id: providerId,
    nativeFormat:
      config.protocol === "anthropic-messages"
        ? "anthropic-messages"
        : "openai-chat",
    manager,
    oauth: RELAY_OAUTH,
    matchesModel: (model: string) => {
      if (modelSet.has(model)) return true;
      if (prefixedModels.includes(model)) return true;
      return prefixes.some((prefix) => model.startsWith(prefix));
    },
    buildAuthUrl: (_state: string, _pkce: PKCECodes) => {
      throw new Error("Relay providers are configured in config.yaml");
    },
    exchangeCode: async () => {
      throw new Error("Relay providers do not implement OAuth exchange");
    },
    listModels: async () => {
      const ids = new Set<string>(config.models || []);
      for (const model of prefixedModels) ids.add(model);
      if (stripPrefix && prefixes.includes(stripPrefix) && ids.size === 0) {
        ids.add(`${stripPrefix}*`);
      }
      return Array.from(ids).map((id) => ({
        id,
        owned_by: config.name || config.id.replace(/^relay:/, ""),
      }));
    },
    callMessages: (opts: UpstreamCallContext) => {
      const path =
        config.protocol === "anthropic-messages"
          ? "/v1/messages"
          : "/v1/chat/completions";
      return callRelay({
        body: opts.body,
        request: opts.request,
        account: opts.account,
        config: opts.config,
        relay: config,
        path,
        signal: opts.signal,
      });
    },
    callCountTokens: config["count-tokens"]
      ? (opts: UpstreamCallContext) =>
          callRelay({
            body: opts.body,
            request: opts.request,
            account: opts.account,
            config: opts.config,
            relay: config,
            path: "/v1/messages/count_tokens",
            signal: opts.signal,
          })
      : undefined,
  };
}

export function relayModelRegex(config: RelayProviderConfig): RegExp | null {
  const prefixes = config["model-prefixes"] || [];
  if (!prefixes.length) return null;
  return new RegExp(`^(${prefixes.map(escapeRegex).join("|")})`);
}
