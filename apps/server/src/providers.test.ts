import { describe, expect, it } from "vitest";
import { createModel, providerDefinitions, toSummary } from "./providers.js";
import type { StoredProvider } from "./database.js";

describe("provider registry", () => {
  it("ships every required provider", () => {
    expect(providerDefinitions.map((provider) => provider.kind)).toEqual([
      "openai",
      "anthropic",
      "openrouter",
      "azure-foundry",
      "amazon-bedrock",
      "synorkai",
      "openai-compatible",
      "ollama-compatible",
    ]);
  });

  it.each(providerDefinitions)("constructs a $label model without making a network call", ({ kind, label }) => {
    const provider: StoredProvider = {
      id: kind,
      kind,
      label,
      enabled: true,
      config: {
        apiKey: "test-key",
        baseUrl: kind === "ollama-compatible" ? "http://127.0.0.1:11434/v1" : "https://example.test/v1",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
      },
      models: ["test-model"],
    };
    expect(createModel(provider, "test-model")).toBeDefined();
  });

  it("never includes credentials in browser summaries", async () => {
    const provider: StoredProvider = {
      id: "private",
      kind: "openai-compatible",
      label: "Private",
      enabled: true,
      config: { apiKey: "must-not-leak" },
      models: ["gpt-test"],
    };
    expect(JSON.stringify(await toSummary(provider))).not.toContain("must-not-leak");
  });
});
