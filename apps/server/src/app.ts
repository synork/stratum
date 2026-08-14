import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { generateText } from "ai";
import { providerKindSchema } from "@loom/shared";
import { z } from "zod";
import { runAgent } from "./agent.js";
import { DashboardReviewer } from "./dashboard-review.js";
import { helperDomains, type HelperDomain, type HomeAssistantClient } from "./home-assistant.js";
import { createModel, discoverModels, providerDefinitions, toSummary } from "./providers.js";
import { ResearchTools } from "./research.js";
import type { Database } from "./database.js";

export interface AppDeps {
  database: Database;
  homeAssistant: HomeAssistantClient;
  dashboardReviewer: DashboardReviewer;
  research: ResearchTools;
  webDist?: string;
  logLevel?: string;
}

export async function createApp(deps: AppDeps): Promise<FastifyInstance> {
  const { database, homeAssistant, dashboardReviewer, research, webDist, logLevel } = deps;
  const app = Fastify({ logger: { level: logLevel ?? "info" } });
  await app.register(cors, { origin: false });

  // Return 400 (not 500) on zod validation errors so the UI can surface the message
  app.setErrorHandler((error: unknown, _request, reply) => {
    const err = error as { issues?: Array<{ path: (string | number)[]; message: string }>; statusCode?: number; message?: string };
    if (err.issues && Array.isArray(err.issues)) {
      const message = err.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      return reply.code(400).send({ error: message });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    app.log.error({ err: error }, "Unhandled error");
    return reply.code(500).send({ error: "Internal server error" });
  });

  app.get("/api/health", async () => ({
    status: "ok" as const,
    homeAssistant: !homeAssistant.configured
      ? ("unconfigured" as const)
      : homeAssistant.connected
        ? ("connected" as const)
        : ("unavailable" as const),
    entityCount: homeAssistant.count,
    providerCount: database.listProviders().filter((p) => p.enabled).length,
    version: "0.2.0",
  }));

  app.get("/api/providers/definitions", async () => providerDefinitions);
  app.get("/api/providers", async () => Promise.all(database.listProviders().map(toSummary)));

  const providerInput = z.object({
    id: z.string().optional(),
    kind: providerKindSchema,
    label: z.string().min(1).max(80),
    enabled: z.boolean().default(true),
    config: z.record(z.string(), z.unknown()),
    models: z.array(z.string()).default([]),
  });

  app.post("/api/providers", async (request, reply) => {
    const input = providerInput.parse(request.body);
    const existing = input.id ? database.getProvider(input.id) : undefined;
    const mergedConfig = { ...existing?.config, ...input.config };
    for (const [key, value] of Object.entries(mergedConfig)) if (value === "••••••••") mergedConfig[key] = existing?.config[key];
    const provider = { ...input, id: input.id ?? randomUUID(), config: mergedConfig };
    if (provider.models.length === 0) {
      try {
        provider.models = await discoverModels(provider);
      } catch (error) {
        app.log.warn({ error, provider: provider.kind }, "Automatic model discovery failed");
      }
    }
    database.saveProvider(provider);
    return reply.code(existing ? 200 : 201).send(await toSummary(provider));
  });

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) => {
    database.deleteProvider(request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/providers/:id/discover", async (request, reply) => {
    const provider = database.getProvider(request.params.id);
    if (!provider) return reply.code(404).send({ error: "Provider not found" });
    const models = await discoverModels(provider);
    provider.models = models;
    database.saveProvider(provider);
    return { models };
  });

  app.get("/api/entities", async (request) => {
    const query = z
      .object({
        q: z.string().max(200).default(""),
        limit: z.coerce.number().int().min(1).max(200).default(60),
        includeDisabled: z.coerce.boolean().default(false),
      })
      .parse(request.query);
    const { includeDisabled } = query;
    const all = homeAssistant.list();
    const filtered = all.filter((e) => includeDisabled || !e.disabled);
    const lower = query.q.toLowerCase().trim();
    const ranked = lower
      ? filtered
          .map((e) => {
            const hay = `${e.entityId} ${e.friendlyName} ${e.domain} ${e.areaId ?? ""}`.toLowerCase();
            return { e, score: hay.includes(lower) ? 1 : 0 };
          })
          .filter(({ score }) => score > 0)
          .map(({ e }) => e)
      : filtered;
    return { entities: ranked.slice(0, query.limit), total: filtered.length };
  });

  app.post("/api/entities/refresh", async () => {
    await homeAssistant.refresh();
    return { count: homeAssistant.count };
  });

  const dashboardReviewInput = z.object({
    providerId: z.string(),
    modelId: z.string(),
    dashboardPath: z
      .string()
      .startsWith("/")
      .refine((path) => !path.includes("\\") && !path.startsWith("//"), "Dashboard path must remain on Home Assistant"),
  });
  app.post("/api/dashboard/review", async (request, reply) => {
    const input = dashboardReviewInput.parse(request.body);
    const provider = database.getProvider(input.providerId);
    if (!provider || !provider.enabled) return reply.code(400).send({ error: "Select an enabled vision provider" });
    const model = (await toSummary(provider)).models.find((item) => item.id === input.modelId);
    if (!model?.capabilities.includes("vision")) return reply.code(400).send({ error: "Select a vision-capable model" });
    return dashboardReviewer.review(provider, input.modelId, input.dashboardPath);
  });

  app.get<{ Params: { filename: string } }>("/api/screenshots/:filename", async (request, reply) => {
    return reply.type("image/png").send(await dashboardReviewer.read(request.params.filename));
  });

  // Rate limiting: simple in-memory token bucket per route family, per IP
  const buckets = new Map<string, { tokens: number; updated: number }>();
  const refill = (key: string, rate: number, capacity: number) => {
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: capacity, updated: now };
    const elapsed = (now - b.updated) / 1000;
    b.tokens = Math.min(capacity, b.tokens + elapsed * rate);
    b.updated = now;
    if (b.tokens < 1) {
      buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    return true;
  };
  const rateLimit = (ratePerSec: number, capacity: number) => async (request: { ip: string }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    const key = `${request.ip}`;
    if (!refill(key, ratePerSec, capacity)) {
      return reply.code(429).send({ error: "Too many requests. Please slow down." });
    }
  };

  // Simple per-IP concurrency limiter for /api/chat
  const chatInflight = new Map<string, number>();
  const chatLimit = 2;

  const chatInput = z.object({
    providerId: z.string(),
    modelId: z.string(),
    mode: z.enum(["plan", "build"]),
    prompt: z.string().min(1).max(30_000),
    history: z
      .array(
        z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(30_000) }),
      )
      .max(100)
      .default([]),
    contextSummary: z.string().max(80_000).default(""),
    contextEntityIds: z.array(z.string()).max(50).default([]),
  });
  app.post(
    "/api/chat",
    { preHandler: [rateLimit(0.5, 3)] },
    async (request, reply) => {
      const input = chatInput.parse(request.body);
      const provider = database.getProvider(input.providerId);
      if (!provider || !provider.enabled) return reply.code(400).send({ error: "Select an enabled provider" });
      if (!provider.models.includes(input.modelId)) return reply.code(400).send({ error: "Select a discovered model" });

      const ip = request.ip;
      const current = chatInflight.get(ip) ?? 0;
      if (current >= chatLimit) {
        return reply.code(429).send({ error: "Too many concurrent runs. Wait for the current turn to finish." });
      }
      chatInflight.set(ip, current + 1);

      const abortController = new AbortController();
      request.raw.once("aborted", () => abortController.abort());
      reply.raw.once("close", () => {
        chatInflight.set(ip, Math.max(0, (chatInflight.get(ip) ?? 1) - 1));
        if (!reply.raw.writableEnded) abortController.abort();
      });
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const result = runAgent(
        provider,
        input.modelId,
        input.mode,
        input.prompt,
        input.history,
        input.contextSummary,
        input.contextEntityIds,
        homeAssistant,
        database,
        research,
        abortController.signal,
      );
      const runId = randomUUID();
      let sequence = 0;
      const textIds = new Map<string, string>();
      const reasoningIds = new Map<string, string>();
      const eventId = (kind: string, id: string, map: Map<string, string>) => {
        const current = map.get(id);
        if (current) return current;
        const next = `${runId}-${kind}-${sequence++}-${id}`;
        map.set(id, next);
        return next;
      };
      const detail = (value: unknown) => {
        try {
          return JSON.stringify(value, null, 2).slice(0, 40_000);
        } catch {
          return String(value).slice(0, 40_000);
        }
      };
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(": ping\n\n");
        } catch {
          /* connection already closed */
        }
      }, 15_000);
      try {
        for await (const part of result.stream) {
          if (part.type === "text-start")
            reply.raw.write(
              `data: ${JSON.stringify({ type: "text-start", id: eventId("text", part.id, textIds) })}\n\n`,
            );
          else if (part.type === "text-delta")
            reply.raw.write(
              `data: ${JSON.stringify({ type: "text", id: eventId("text", part.id, textIds), delta: part.text })}\n\n`,
            );
          else if (part.type === "text-end") {
            reply.raw.write(
              `data: ${JSON.stringify({ type: "text-end", id: eventId("text", part.id, textIds) })}\n\n`,
            );
            textIds.delete(part.id);
          } else if (part.type === "reasoning-start")
            reply.raw.write(
              `data: ${JSON.stringify({ type: "reasoning-start", id: eventId("reasoning", part.id, reasoningIds) })}\n\n`,
            );
          else if (part.type === "reasoning-delta")
            reply.raw.write(
              `data: ${JSON.stringify({ type: "reasoning", id: eventId("reasoning", part.id, reasoningIds), delta: part.text })}\n\n`,
            );
          else if (part.type === "reasoning-end") {
            reply.raw.write(
              `data: ${JSON.stringify({ type: "reasoning-end", id: eventId("reasoning", part.id, reasoningIds) })}\n\n`,
            );
            reasoningIds.delete(part.id);
          } else if (part.type === "tool-input-start")
            reply.raw.write(
              `data: ${JSON.stringify({ type: "tool", state: "running", tool: part.toolName, callId: `${runId}-${part.id}` })}\n\n`,
            );
          else if (part.type === "tool-call")
            reply.raw.write(
              `data: ${JSON.stringify({ type: "tool", state: "running", tool: part.toolName, callId: `${runId}-${part.toolCallId}`, detail: detail(part.input) })}\n\n`,
            );
          else if (part.type === "tool-result")
            reply.raw.write(
              `data: ${JSON.stringify({ type: "tool", state: "complete", tool: part.toolName, callId: `${runId}-${part.toolCallId}`, detail: detail(part.output) })}\n\n`,
            );
          else if (part.type === "tool-error")
            reply.raw.write(
              `data: ${JSON.stringify({ type: "tool", state: "error", tool: part.toolName, callId: `${runId}-${part.toolCallId}`, detail: detail(part.error) })}\n\n`,
            );
          else if (part.type === "error")
            reply.raw.write(`data: ${JSON.stringify({ type: "error", message: String(part.error) })}\n\n`);
          else if (part.type === "abort")
            reply.raw.write(`data: ${JSON.stringify({ type: "abort" })}\n\n`);
        }
        const usage = await result.usage;
        reply.raw.write(`data: ${JSON.stringify({ type: "finish", usage })}\n\n`);
      } catch (error) {
        reply.raw.write(
          `data: ${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) })}\n\n`,
        );
      } finally {
        clearInterval(heartbeat);
        chatInflight.set(ip, Math.max(0, (chatInflight.get(ip) ?? 1) - 1));
        reply.raw.end();
      }
    },
  );

  app.get("/api/proposals", async () => database.listProposals());

  app.get<{ Params: { type: string; resourceId: string } }>(
    "/api/resources/:type/:resourceId/current",
    async (request, reply) => {
      const { type, resourceId } = request.params;
      try {
        if (type === "automation") return await homeAssistant.getAutomation(resourceId);
        if (type === "dashboard") return await homeAssistant.getDashboard(resourceId);
        if (type === "helper") {
          const [domain, id] = resourceId.split(".");
          if (!domain || !id) return reply.code(400).send({ error: "Invalid helper resource ID" });
          if (!helperDomains.includes(domain as HelperDomain))
            return reply.code(400).send({ error: "Unknown helper domain" });
          return await homeAssistant.getHelper(domain as HelperDomain, id);
        }
        return reply.code(400).send({ error: "Unknown resource type" });
      } catch (error) {
        if (error instanceof Error && error.message.includes("404"))
          return reply.code(404).send({ error: "Resource not found" });
        throw error;
      }
    },
  );

  const threadStateSchema = z.object({
    id: z.string(),
    title: z.string().max(200),
    mode: z.enum(["plan", "build"]),
    prompt: z.string().max(30_000),
    transcript: z
      .array(
        z.object({
          id: z.string(),
          role: z.enum(["user", "assistant", "reasoning", "activity"]),
          text: z.string().max(120_000),
          detail: z.string().max(40_000).optional(),
          status: z.enum(["running", "complete", "error"]).optional(),
        }),
      )
      .max(500),
    entityIds: z.array(z.string()).max(100),
    createdAt: z.string(),
    contextSummary: z.string().max(80_000).optional(),
    compactedThrough: z.number().int().min(0).optional(),
  });

  app.get("/api/threads", async () =>
    database.listThreads().map((thread) => ({
      id: thread.id,
      title: thread.title,
      archived: thread.archived,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    })),
  );

  app.get<{ Params: { id: string } }>("/api/threads/:id", async (request, reply) => {
    const thread = database.getThread(request.params.id);
    return thread ? thread : reply.code(404).send({ error: "Thread not found" });
  });

  app.put<{ Params: { id: string } }>("/api/threads/:id", async (request, reply) => {
    const state = threadStateSchema.parse(request.body);
    if (state.id !== request.params.id) return reply.code(400).send({ error: "Thread ID mismatch" });
    database.saveThread(state.id, state.title, state, false);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/threads/:id/archive", async (request, reply) => {
    database.archiveThread(request.params.id);
    return reply.code(204).send();
  });

  app.get("/api/memories", async (request) => {
    const query = z.object({ q: z.string().max(500).default("") }).parse(request.query);
    return database.listMemories(query.q);
  });

  app.post(
    "/api/memories",
    { preHandler: [rateLimit(2, 10)] },
    async (request, reply) => {
      const input = z
        .object({
          content: z.string().min(1).max(4_000),
          tags: z.array(z.string().max(50)).max(20).default([]),
        })
        .parse(request.body);
      return reply.code(201).send(database.saveMemory(input.content, input.tags));
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/memories/:id",
    { preHandler: [rateLimit(2, 10)] },
    async (request, reply) => {
      database.deleteMemory(request.params.id);
      return reply.code(204).send();
    },
  );

  const compactInput = z.object({
    providerId: z.string(),
    modelId: z.string(),
    existingSummary: z.string().max(80_000).default(""),
    messages: z
      .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(120_000) }))
      .min(1)
      .max(200),
  });
  app.post<{ Params: { id: string } }>("/api/threads/:id/compact", async (request, reply) => {
    const input = compactInput.parse(request.body);
    const provider = database.getProvider(input.providerId);
    if (!provider || !provider.enabled || !provider.models.includes(input.modelId))
      return reply.code(400).send({ error: "Select a configured model" });
    const transcript = input.messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
    const result = await generateText({
      model: createModel(provider, input.modelId),
      system: `Compact a Stratum Home Assistant thread into durable working context. Preserve user requirements, preferences, entity IDs, decisions, drafts, unresolved questions, safety constraints, and relevant tool findings. Remove greetings, repetition, and obsolete intermediate reasoning. Do not invent facts. Return concise Markdown under these headings when relevant: Goal, User preferences, Home Assistant context, Decisions, Work completed, Open questions.`,
      prompt: `${input.existingSummary ? `Existing compacted summary:\n${input.existingSummary}\n\n` : ""}New conversation to merge:\n${transcript}`,
      maxOutputTokens: 4_000,
    });
    return { summary: result.text, usage: result.usage };
  });

  app.delete<{ Params: { id: string } }>("/api/proposals/:id", async (request, reply) => {
    const proposal = database.getProposal(request.params.id);
    if (!proposal) return reply.code(404).send({ error: "Proposal not found" });
    if (proposal.status === "published") return reply.code(409).send({ error: "Published records cannot be removed" });
    if (proposal.type === "dashboard") await homeAssistant.deleteDashboardPreview(proposal.id);
    database.deleteProposal(proposal.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/proposals/:id/approve", async (request, reply) => {
    const proposal = database.getProposal(request.params.id);
    if (!proposal) return reply.code(404).send({ error: "Proposal not found" });
    if (proposal.status !== "draft") return reply.code(409).send({ error: `Proposal is already ${proposal.status}` });
    if (proposal.type === "automation") proposal.validation = homeAssistant.validateAutomation(proposal.payload);
    else if (proposal.type === "dashboard") proposal.validation = homeAssistant.validateDashboard(proposal.payload);
    else {
      const domain = proposal.payload.domain;
      const helperConfig = proposal.payload.config;
      if (
        !helperDomains.includes(domain as HelperDomain) ||
        !helperConfig ||
        typeof helperConfig !== "object" ||
        Array.isArray(helperConfig)
      )
        return reply.code(422).send({ error: "Invalid helper proposal" });
      proposal.validation = homeAssistant.validateHelper(
        domain as HelperDomain,
        helperConfig as Record<string, unknown>,
      );
    }
    if (!proposal.validation.valid) {
      database.saveProposal(proposal);
      return reply.code(422).send({ error: proposal.validation.errors.join("; ") });
    }
    proposal.status = "approved";
    database.saveProposal(proposal);
    try {
      const before =
        proposal.type === "automation"
          ? await homeAssistant.getAutomation(proposal.resourceId)
          : proposal.type === "dashboard"
            ? await homeAssistant.getDashboard(proposal.resourceId)
            : null;
      if (proposal.type === "automation") await homeAssistant.publishAutomation(proposal.resourceId, proposal.payload);
      else if (proposal.type === "dashboard")
        await homeAssistant.publishDashboard(proposal.resourceId, proposal.payload);
      else {
        const domain = proposal.payload.domain as HelperDomain;
        const helperConfig = proposal.payload.config as Record<string, unknown>;
        const created = await homeAssistant.createHelper(domain, helperConfig);
        proposal.resourceId = `${domain}.${String(created.id ?? proposal.resourceId.split(".").at(-1))}`;
      }
      database.saveRevision(proposal.type, proposal.resourceId, before, proposal.payload);
      if (proposal.type === "dashboard") await homeAssistant.deleteDashboardPreview(proposal.id);
      proposal.status = "published";
      database.saveProposal(proposal);
      await homeAssistant.refresh();
      return proposal;
    } catch (error) {
      proposal.status = "failed";
      database.saveProposal(proposal);
      throw error;
    }
  });

  const previewInput = z.object({ providerId: z.string(), modelId: z.string() });
  app.post<{ Params: { id: string } }>("/api/proposals/:id/preview", async (request, reply) => {
    const proposal = database.getProposal(request.params.id);
    if (!proposal) return reply.code(404).send({ error: "Proposal not found" });
    if (proposal.type !== "dashboard") return reply.code(400).send({ error: "Only dashboards have visual previews" });
    if (proposal.status !== "draft") return reply.code(409).send({ error: `Proposal is already ${proposal.status}` });
    proposal.validation = homeAssistant.validateDashboard(proposal.payload);
    database.saveProposal(proposal);
    if (!proposal.validation.valid) return reply.code(422).send({ error: proposal.validation.errors.join("; ") });
    const input = previewInput.parse(request.body);
    const provider = database.getProvider(input.providerId);
    if (!provider || !provider.enabled) return reply.code(400).send({ error: "Select an enabled vision provider" });
    const model = (await toSummary(provider)).models.find((item) => item.id === input.modelId);
    if (!model?.capabilities.includes("vision")) return reply.code(400).send({ error: "Select a vision-capable model" });
    const previewPath = await homeAssistant.createDashboardPreview(proposal.id, proposal.title, proposal.payload);
    return { previewPath, ...(await dashboardReviewer.review(provider, input.modelId, previewPath)) };
  });

  app.post<{ Params: { id: string } }>("/api/proposals/:id/reject", async (request, reply) => {
    const proposal = database.getProposal(request.params.id);
    if (!proposal) return reply.code(404).send({ error: "Proposal not found" });
    if (proposal.status !== "draft") return reply.code(409).send({ error: `Proposal is already ${proposal.status}` });
    if (proposal.type === "dashboard") await homeAssistant.deleteDashboardPreview(proposal.id);
    proposal.status = "rejected";
    database.saveProposal(proposal);
    return proposal;
  });

  if (webDist) {
    try {
      const { access } = await import("node:fs/promises");
      await access(webDist);
      await app.register(fastifyStatic, {
        root: webDist,
        wildcard: false,
        cacheControl: false,
        setHeaders(res, path) {
          const serverResponse = res.raw as ServerResponse;
          if (path.endsWith(".html"))
            serverResponse.setHeader("cache-control", "no-cache, no-store, must-revalidate");
          else if (/[.-][A-Za-z0-9_-]{8}\.(js|css|woff2?)$/.test(path))
            serverResponse.setHeader("cache-control", "public, max-age=31536000, immutable");
          else serverResponse.setHeader("cache-control", "public, max-age=0, must-revalidate");
        },
      });
      app.setNotFoundHandler((request, reply) =>
        request.url.startsWith("/api/")
          ? reply.code(404).send({ error: "Not found" })
          : reply.sendFile("index.html"),
      );
    } catch {
      app.log.info("Web build not found; API-only development mode");
    }
  }

  return app;
}