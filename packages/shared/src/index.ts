import { z } from "zod";

export const providerKindSchema = z.enum([
  "openai",
  "anthropic",
  "openrouter",
  "azure-foundry",
  "amazon-bedrock",
  "synorkai",
  "openai-compatible",
  "ollama-compatible",
]);

export type ProviderKind = z.infer<typeof providerKindSchema>;

export const modelCapabilitySchema = z.enum([
  "text",
  "streaming",
  "tools",
  "structured-output",
  "vision",
  "usage",
]);

export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

export const providerSummarySchema = z.object({
  id: z.string(),
  kind: providerKindSchema,
  label: z.string(),
  configured: z.boolean(),
  enabled: z.boolean(),
  models: z.array(z.object({
    id: z.string(),
    label: z.string(),
    capabilities: z.array(modelCapabilitySchema),
  })),
});

export type ProviderSummary = z.infer<typeof providerSummarySchema>;

export const entitySchema = z.object({
  entityId: z.string(),
  state: z.string(),
  friendlyName: z.string(),
  domain: z.string(),
  areaId: z.string().nullable(),
  deviceId: z.string().nullable(),
  integration: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()),
  lastChanged: z.string(),
  unavailable: z.boolean(),
  disabled: z.boolean(),
});

export type Entity = z.infer<typeof entitySchema>;

export const activitySchema = z.object({
  id: z.string(),
  kind: z.enum(["plan", "tool", "approval", "evidence", "error"]),
  title: z.string(),
  detail: z.string(),
  status: z.enum(["queued", "running", "waiting", "complete", "error"]),
  timestamp: z.string(),
});

export type Activity = z.infer<typeof activitySchema>;

export const healthSchema = z.object({
  status: z.literal("ok"),
  homeAssistant: z.enum(["connected", "unavailable", "unconfigured"]),
  entityCount: z.number().int().nonnegative(),
  version: z.string(),
});

export type Health = z.infer<typeof healthSchema>;

export const proposalSchema = z.object({
  id: z.string(),
  type: z.enum(["automation", "dashboard", "helper", "integration"]),
  resourceId: z.string(),
  title: z.string(),
  explanation: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(["draft", "approved", "published", "rejected", "failed"]),
  validation: z.object({
    valid: z.boolean(),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  createdAt: z.string(),
});

export type Proposal = z.infer<typeof proposalSchema>;
