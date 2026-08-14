import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import { Database } from "./database.js";
import { HomeAssistantClient } from "./home-assistant.js";
import { DashboardReviewer } from "./dashboard-review.js";
import { ResearchTools } from "./research.js";

class StubHA extends HomeAssistantClient {
  configured = false;
  connected = false;
  count = 0;
  list() {
    return [];
  }
  search(_query: string, _limit = 60) {
    return [];
  }
  async refresh() {
    this.connected = false;
  }
}

let tmpDir: string;
let database: Database;
let homeAssistant: StubHA;
let dashboardReviewer: DashboardReviewer;
let research: ResearchTools;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "stratum-test-"));
  database = new Database(tmpDir);
  homeAssistant = new StubHA("http://ha", "ws://ha/ws", "token");
  dashboardReviewer = new DashboardReviewer(tmpDir, "http://ha:8123", "token", "/usr/bin/chromium");
  research = new ResearchTools(database, "");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("HTTP layer (createApp)", () => {
  it("GET /api/health returns deep diagnostics", async () => {
    const app = await createApp({
      database,
      homeAssistant,
      dashboardReviewer,
      research,
    });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      homeAssistant: string;
      entityCount: number;
      providerCount: number;
      version: string;
    };
    expect(body.status).toBe("ok");
    expect(body.homeAssistant).toBe("unconfigured");
    expect(body.entityCount).toBe(0);
    expect(body.providerCount).toBe(0);
    expect(typeof body.version).toBe("string");
    await app.close();
  });

  it("GET /api/providers/definitions returns the catalog", async () => {
    const app = await createApp({ database, homeAssistant, dashboardReviewer, research });
    const res = await app.inject({ method: "GET", url: "/api/providers/definitions" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ kind: string; label: string; fields: unknown[] }>;
    expect(body.length).toBeGreaterThanOrEqual(8);
    expect(body.find((p) => p.kind === "openrouter")).toBeDefined();
    await app.close();
  });

  it("GET /api/providers returns the empty list initially", async () => {
    const app = await createApp({ database, homeAssistant, dashboardReviewer, research });
    const res = await app.inject({ method: "GET", url: "/api/providers" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it("rejects malformed provider payloads with zod 400", async () => {
    const app = await createApp({ database, homeAssistant, dashboardReviewer, research });
    const res = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: { kind: "openrouter" }, // missing label + config
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("GET /api/entities validates query string max length", async () => {
    const app = await createApp({ database, homeAssistant, dashboardReviewer, research });
    const huge = "x".repeat(500);
    const res = await app.inject({ method: "GET", url: `/api/entities?q=${huge}` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("GET /api/entities caps limit to 200", async () => {
    const app = await createApp({ database, homeAssistant, dashboardReviewer, research });
    const res = await app.inject({ method: "GET", url: "/api/entities?limit=9999" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("GET /api/threads returns the empty list", async () => {
    const app = await createApp({ database, homeAssistant, dashboardReviewer, research });
    const res = await app.inject({ method: "GET", url: "/api/threads" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it("GET /api/proposals returns the empty list", async () => {
    const app = await createApp({ database, homeAssistant, dashboardReviewer, research });
    const res = await app.inject({ method: "GET", url: "/api/proposals" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it("GET /api/memories returns the empty list", async () => {
    const app = await createApp({ database, homeAssistant, dashboardReviewer, research });
    const res = await app.inject({ method: "GET", url: "/api/memories" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it("rejects overlong memory content with 400", async () => {
    const app = await createApp({ database, homeAssistant, dashboardReviewer, research });
    const res = await app.inject({
      method: "POST",
      url: "/api/memories",
      payload: { content: "x".repeat(5_000), tags: [] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("GET /api/resources/:type/:resourceId/current rejects unknown type", async () => {
    const app = await createApp({ database, homeAssistant, dashboardReviewer, research });
    const res = await app.inject({ method: "GET", url: "/api/resources/bogus/x/current" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rate limits /api/chat to 3 fast requests per second", async () => {
    const app = await createApp({ database, homeAssistant, dashboardReviewer, research });
    // Burn the first 3 quickly (provider not found still goes through rate limiter)
    const results: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: {
          providerId: "_x_",
          modelId: "_x_",
          mode: "plan",
          prompt: "hi",
          history: [],
          contextSummary: "",
          contextEntityIds: [],
        },
      });
      results.push(r.statusCode);
    }
    // First three: 400 (validation), fourth: 429 (rate limited)
    expect(results[0]).toBe(400);
    expect(results[1]).toBe(400);
    expect(results[2]).toBe(400);
    expect(results[3]).toBe(429);
    await app.close();
  });
});