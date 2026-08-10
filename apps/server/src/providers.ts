import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ModelCapability, ProviderKind, ProviderSummary } from "@loom/shared";
import type { StoredProvider } from "./database.js";

export interface ProviderDefinition {
  kind: ProviderKind;
  label: string;
  fields: Array<{
    key: string;
    label: string;
    secret?: boolean;
    required?: boolean;
    placeholder?: string;
  }>;
}

export const providerDefinitions: ProviderDefinition[] = [
  { kind: "openai", label: "OpenAI", fields: [{ key: "apiKey", label: "API key", secret: true, required: true }, { key: "baseUrl", label: "Base URL", placeholder: "https://api.openai.com/v1" }] },
  { kind: "anthropic", label: "Anthropic", fields: [{ key: "apiKey", label: "API key", secret: true, required: true }, { key: "baseUrl", label: "Base URL", placeholder: "https://api.anthropic.com/v1" }] },
  { kind: "openrouter", label: "OpenRouter", fields: [{ key: "apiKey", label: "API key", secret: true, required: true }] },
  { kind: "azure-foundry", label: "Azure AI Foundry", fields: [{ key: "apiKey", label: "API key", secret: true, required: true }, { key: "baseUrl", label: "Foundry endpoint", required: true }, { key: "apiVersion", label: "API version", placeholder: "preview" }] },
  { kind: "amazon-bedrock", label: "Amazon Bedrock", fields: [{ key: "region", label: "AWS region", required: true, placeholder: "us-east-1" }, { key: "accessKeyId", label: "Access key ID", secret: true }, { key: "secretAccessKey", label: "Secret access key", secret: true }, { key: "sessionToken", label: "Session token", secret: true }, { key: "apiKey", label: "Bedrock API key", secret: true }] },
  { kind: "synorkai", label: "SynorkAi", fields: [{ key: "apiKey", label: "API key", secret: true, required: true }, { key: "baseUrl", label: "Base URL", placeholder: "https://api.synork.dev/api/v1/public" }] },
  { kind: "openai-compatible", label: "OpenAI compatible", fields: [{ key: "baseUrl", label: "Base URL", required: true }, { key: "apiKey", label: "API key", secret: true }, { key: "headers", label: "Custom headers (JSON)" }] },
  { kind: "ollama-compatible", label: "Ollama compatible", fields: [{ key: "baseUrl", label: "Base URL", required: true, placeholder: "http://homeassistant.local:11434/v1" }, { key: "apiKey", label: "API key", secret: true }] },
];

const text = (config: Record<string, unknown>, key: string): string | undefined => {
  const value = config[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const optional = <K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> => value ? { [key]: value } as Record<K, string> : {};

const parseHeaders = (value: unknown): Record<string, string> => {
  if (typeof value !== "string" || value.trim() === "") return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Custom headers must be a JSON object");
  return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]));
};

interface ModelsDevModel {
  id: string;
  name: string;
  attachment?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  modalities?: { input?: string[]; output?: string[] };
}

interface ModelsDevProvider {
  id: string;
  name: string;
  models: Record<string, ModelsDevModel>;
}

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

const modelsDevProviderIds: Partial<Record<ProviderKind, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  openrouter: "openrouter",
  "azure-foundry": "azure",
  "amazon-bedrock": "amazon-bedrock",
};

let catalogCache: { expiresAt: number; value: ModelsDevCatalog } | undefined;
let catalogRequest: Promise<ModelsDevCatalog> | undefined;

async function modelsDevCatalog(): Promise<ModelsDevCatalog> {
  if (catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache.value;
  catalogRequest ??= fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(20_000) })
    .then(async (response) => {
      if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
      const value = await response.json() as ModelsDevCatalog;
      catalogCache = { expiresAt: Date.now() + 3_600_000, value };
      return value;
    })
    .finally(() => { catalogRequest = undefined; });
  return catalogRequest;
}

async function catalogModels(kind: ProviderKind): Promise<Map<string, ModelsDevModel>> {
  const providerId = modelsDevProviderIds[kind];
  if (!providerId) return new Map();
  const provider = (await modelsDevCatalog())[providerId];
  return new Map(Object.values(provider?.models ?? {}).map((model) => [model.id, model]));
}

export function createModel(provider: StoredProvider, modelId: string): LanguageModel {
  const values = provider.config;
  switch (provider.kind) {
    case "openai":
      return createOpenAI({ ...optional("apiKey", text(values, "apiKey")), ...optional("baseURL", text(values, "baseUrl")) })(modelId);
    case "anthropic":
      return createAnthropic({ ...optional("apiKey", text(values, "apiKey")), ...optional("baseURL", text(values, "baseUrl")) })(modelId);
    case "openrouter":
      return createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        ...optional("apiKey", text(values, "apiKey")),
        headers: { "HTTP-Referer": "http://homeassistant.local", "X-Title": "Stratum" },
      })(modelId);
    case "azure-foundry":
      return createAzure({
        ...optional("baseURL", text(values, "baseUrl")),
        ...optional("apiKey", text(values, "apiKey")),
        ...optional("apiVersion", text(values, "apiVersion")),
      })(modelId);
    case "amazon-bedrock":
      return createAmazonBedrock({
        ...optional("region", text(values, "region")),
        ...optional("accessKeyId", text(values, "accessKeyId")),
        ...optional("secretAccessKey", text(values, "secretAccessKey")),
        ...optional("sessionToken", text(values, "sessionToken")),
        ...optional("apiKey", text(values, "apiKey")),
      })(modelId);
    case "synorkai": {
      const baseURL = text(values, "baseUrl") ?? "https://api.synork.dev/api/v1/public";
      const apiKey = text(values, "apiKey");
      return createOpenAICompatible({
        name: "synorkai",
        baseURL: `${baseURL.replace(/\/$/, "")}/ai`,
        headers: apiKey ? { "X-API-Key": apiKey } : {},
        fetch: async (input, init) => {
          const url = String(input).replace(/\/chat\/completions$/, "/chat");
          return fetch(url, init);
        },
      })(modelId);
    }
    case "openai-compatible":
      return createOpenAICompatible({
        name: `custom-${provider.id}`,
        baseURL: text(values, "baseUrl") ?? "",
        ...optional("apiKey", text(values, "apiKey")),
        headers: parseHeaders(values.headers),
      })(modelId);
    case "ollama-compatible":
      return createOpenAICompatible({
        name: "ollama",
        baseURL: text(values, "baseUrl") ?? "http://127.0.0.1:11434/v1",
        apiKey: text(values, "apiKey") ?? "ollama",
      })(modelId);
    default: {
      const exhaustive: never = provider.kind;
      throw new Error(`Unsupported provider: ${String(exhaustive)}`);
    }
  }
}

function inferredCapabilities(modelId: string, catalogModel?: ModelsDevModel): ModelCapability[] {
  if (catalogModel) {
    const input = catalogModel.modalities?.input ?? [];
    const output = catalogModel.modalities?.output ?? [];
    const capabilities: ModelCapability[] = ["streaming", "usage"];
    if (input.includes("text") || output.includes("text")) capabilities.push("text");
    if (catalogModel.tool_call) capabilities.push("tools");
    if (catalogModel.structured_output) capabilities.push("structured-output");
    if (input.includes("image")) capabilities.push("vision");
    return capabilities;
  }
  const id = modelId.toLowerCase();
  const capabilities: ModelCapability[] = ["text", "streaming", "tools"];
  if (!/(mini|nano|micro|text-only)/.test(id)) capabilities.push("vision");
  capabilities.push("structured-output", "usage");
  return capabilities;
}

export async function toSummary(provider: StoredProvider): Promise<ProviderSummary> {
  const catalog = await catalogModels(provider.kind).catch(() => new Map<string, ModelsDevModel>());
  return {
    id: provider.id,
    kind: provider.kind,
    label: provider.label,
    configured: Object.keys(provider.config).length > 0,
    enabled: provider.enabled,
    models: provider.models.map((model) => {
      const catalogModel = catalog.get(model);
      return { id: model, label: catalogModel?.name ?? model, capabilities: inferredCapabilities(model, catalogModel) };
    }),
  };
}

interface ModelItem { id?: string; name?: string; model?: string; }
interface ModelListResponse { data?: ModelItem[]; models?: ModelItem[]; }

async function discoverNativeModels(provider: StoredProvider): Promise<string[]> {
  const values = provider.config;
  let url = "";
  let headers: Record<string, string> = {};

  switch (provider.kind) {
    case "openai":
      url = `${(text(values, "baseUrl") ?? "https://api.openai.com/v1").replace(/\/$/, "")}/models`;
      headers.Authorization = `Bearer ${text(values, "apiKey") ?? ""}`;
      break;
    case "anthropic":
      url = `${(text(values, "baseUrl") ?? "https://api.anthropic.com/v1").replace(/\/$/, "")}/models`;
      headers = { "x-api-key": text(values, "apiKey") ?? "", "anthropic-version": "2023-06-01" };
      break;
    case "openrouter":
      url = "https://openrouter.ai/api/v1/models";
      headers.Authorization = `Bearer ${text(values, "apiKey") ?? ""}`;
      break;
    case "synorkai":
      url = `${(text(values, "baseUrl") ?? "https://api.synork.dev/api/v1/public").replace(/\/$/, "")}/ai/models`;
      headers["X-API-Key"] = text(values, "apiKey") ?? "";
      break;
    case "openai-compatible":
      url = `${(text(values, "baseUrl") ?? "").replace(/\/$/, "")}/models`;
      if (text(values, "apiKey")) headers.Authorization = `Bearer ${text(values, "apiKey")}`;
      headers = { ...headers, ...parseHeaders(values.headers) };
      break;
    case "ollama-compatible": {
      const base = (text(values, "baseUrl") ?? "http://127.0.0.1:11434/v1").replace(/\/$/, "").replace(/\/v1$/, "");
      url = `${base}/api/tags`;
      break;
    }
    case "azure-foundry":
    case "amazon-bedrock":
      return provider.models;
  }

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${provider.label} returned ${response.status}`);
  const payload = await response.json() as ModelListResponse;
  const models = payload.data ?? payload.models ?? [];
  return models.map((model) => model.id ?? model.model ?? model.name).filter((id): id is string => Boolean(id)).sort();
}

export async function discoverModels(provider: StoredProvider): Promise<string[]> {
  const [catalogResult, nativeResult] = await Promise.allSettled([
    catalogModels(provider.kind),
    discoverNativeModels(provider),
  ]);
  const catalog = catalogResult.status === "fulfilled" ? [...catalogResult.value.values()]
    .filter((model) => model.tool_call && model.modalities?.output?.includes("text"))
    .map((model) => model.id) : [];
  const native = nativeResult.status === "fulfilled" ? nativeResult.value : [];
  const discovered = catalog.length > 0 ? catalog : native;
  const models = [...new Set([...discovered, ...provider.models])].sort();
  if (models.length === 0 && nativeResult.status === "rejected") throw nativeResult.reason;
  return models;
}
