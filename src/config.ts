import crypto from "crypto";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

/**
 * Cloaking configuration for request fingerprinting.
 * Controls how auth2api mimics Claude Code CLI's request signature.
 */
export interface CloakingConfig {
  /** CLI version to impersonate in User-Agent and fingerprint (default: 2.1.88) */
  "cli-version"?: string;
  /** Entrypoint value for billing header (default: cli) */
  entrypoint?: string;
  /**
   * Codex (ChatGPT) provider — protocol-required headers, NOT identity faking.
   * Strings live here so upstream flag-name drift can ship as a YAML edit.
   */
  codex?: {
    "user-agent"?: string;
    originator?: string;
    "cli-version"?: string;
    /** Optional: only set if upstream begins requiring an OpenAI-Beta header. */
    "openai-beta"?: string;
  };
  /**
   * Cursor provider — reverse-engineered, unstable headers for personal local
   * experiments only. Cursor version-gates requests, so keep these overrideable.
   */
  cursor?: {
    "client-version"?: string;
    "client-type"?: string;
    "agent-base-url"?: string;
    "api-base-url"?: string;
    "config-version"?: string;
    "timezone"?: string;
    "ghost-mode"?: string;
  };
}

export interface TimeoutConfig {
  "messages-ms": number;
  "stream-messages-ms": number;
  "count-tokens-ms": number;
}

export type DebugMode = "off" | "errors" | "verbose";

export type RelayProtocol = "openai-chat" | "anthropic-messages";

export interface RelayProviderConfig {
  id: string;
  name?: string;
  protocol: RelayProtocol;
  "base-url": string;
  "api-key": string;
  "api-key-header"?: string;
  models?: string[];
  "model-prefixes"?: string[];
  headers?: Record<string, string>;
  "strip-model-prefix"?: string;
  "count-tokens"?: boolean;
}

export interface Config {
  host: string;
  port: number;
  "auth-dir": string;
  "api-keys": Set<string>;
  "body-limit": string;
  cloaking: CloakingConfig;
  timeouts: TimeoutConfig;
  debug: DebugMode;
  relays: RelayProviderConfig[];
}

// Raw config shape from YAML (api-keys is an array, not a Set)
interface RawConfig extends Omit<Config, "api-keys" | "relays"> {
  "api-keys": string[];
  relays: unknown[];
}

const DEFAULT_RAW: RawConfig = {
  host: "",
  port: 8317,
  "auth-dir": "~/.auth2api",
  "api-keys": [],
  "body-limit": "200mb",
  cloaking: {
    "cli-version": "2.1.88",
    entrypoint: "cli",
  },
  timeouts: {
    "messages-ms": 120000,
    "stream-messages-ms": 600000,
    "count-tokens-ms": 30000,
  },
  debug: "off",
  relays: [],
};

function normalizeDebugMode(value: unknown): DebugMode {
  if (value === true) return "errors";
  if (value === false || value == null) return "off";
  if (value === "off" || value === "errors" || value === "verbose")
    return value;
  return "off";
}

export function isDebugLevel(
  debug: DebugMode,
  level: Exclude<DebugMode, "off">,
): boolean {
  if (debug === "verbose") return true;
  return debug === level;
}

export function resolveAuthDir(dir: string): string {
  if (dir.startsWith("~")) {
    return path.join(process.env.HOME || "/root", dir.slice(1));
  }
  return path.resolve(dir);
}

export function generateApiKey(): string {
  return "sk-" + crypto.randomBytes(32).toString("hex");
}

function normalizeRelays(value: unknown): RelayProviderConfig[] {
  if (!Array.isArray(value)) return [];
  const relays: RelayProviderConfig[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const relay = item as Partial<RelayProviderConfig>;
    if (
      typeof relay.id !== "string" ||
      typeof relay["base-url"] !== "string" ||
      typeof relay["api-key"] !== "string"
    ) {
      continue;
    }
    const protocol =
      relay.protocol === "anthropic-messages" ? relay.protocol : "openai-chat";
    relays.push({
      id: relay.id,
      name: relay.name,
      protocol,
      "base-url": relay["base-url"],
      "api-key": relay["api-key"],
      "api-key-header":
        typeof relay["api-key-header"] === "string"
          ? relay["api-key-header"]
          : undefined,
      models: Array.isArray(relay.models) ? relay.models : [],
      "model-prefixes": Array.isArray(relay["model-prefixes"])
        ? relay["model-prefixes"]
        : [],
      headers:
        relay.headers && typeof relay.headers === "object"
          ? relay.headers
          : undefined,
      "strip-model-prefix":
        typeof relay["strip-model-prefix"] === "string"
          ? relay["strip-model-prefix"]
          : undefined,
      "count-tokens": relay["count-tokens"] === true,
    });
  }
  return relays;
}

export function loadConfig(configPath?: string): Config {
  const filePath = configPath || "config.yaml";
  let raw: RawConfig;

  if (!fs.existsSync(filePath)) {
    console.log(`Config file not found at ${filePath}, using defaults`);
    raw = { ...DEFAULT_RAW };
  } else {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(content) as Partial<RawConfig>;
      raw = {
        ...DEFAULT_RAW,
        ...parsed,
        cloaking: { ...DEFAULT_RAW.cloaking, ...(parsed.cloaking || {}) },
        timeouts: { ...DEFAULT_RAW.timeouts, ...(parsed.timeouts || {}) },
    };
  }

  raw.debug = normalizeDebugMode(raw.debug);
  const relays = normalizeRelays(raw.relays);

  // Auto-generate API key if none configured
  if (!raw["api-keys"] || raw["api-keys"].length === 0) {
    const key = generateApiKey();
    raw["api-keys"] = [key];
    const dir = path.dirname(filePath);
    if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, yaml.dump(raw, { lineWidth: -1 }), {
      mode: 0o600,
    });
    console.log(`\nGenerated API key (saved to ${filePath}):\n\n  ${key}\n`);
  }

  return { ...raw, relays, "api-keys": new Set(raw["api-keys"]) };
}
