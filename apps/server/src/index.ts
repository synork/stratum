import { access } from "node:fs/promises";
import Fastify from "fastify";
import { runAgent } from "./agent.js";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { Database } from "./database.js";
import { DashboardReviewer } from "./dashboard-review.js";
import { HomeAssistantClient } from "./home-assistant.js";
import { ResearchTools } from "./research.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
const database = new Database(config.dataDir);
const homeAssistant = new HomeAssistantClient(config.haBaseUrl, config.haWsUrl, config.haToken);
const dashboardReviewer = new DashboardReviewer(config.dataDir, config.haFrontendUrl, config.haToken, config.chromiumPath);
const research = new ResearchTools(database, config.githubToken);

let webDist: string | undefined;
try {
  await access(config.webDist);
  webDist = config.webDist;
} catch {
  app.log.info("Web build not found; API-only development mode");
}

const server = await createApp(
  webDist
    ? {
        database,
        homeAssistant,
        dashboardReviewer,
        research,
        webDist,
        logLevel: process.env.LOG_LEVEL ?? "info",
      }
    : {
        database,
        homeAssistant,
        dashboardReviewer,
        research,
        logLevel: process.env.LOG_LEVEL ?? "info",
      },
);

// Re-register the logger-handle shim from createApp
server.log.level = process.env.LOG_LEVEL ?? "info";

if (homeAssistant.configured) {
  homeAssistant.refresh().catch((error) => server.log.warn({ error }, "Initial Home Assistant inventory failed"));
  setInterval(
    () => homeAssistant.refresh().catch((error) => server.log.warn({ error }, "Home Assistant inventory refresh failed")),
    60_000,
  ).unref();
}

await server.listen({ port: config.port, host: config.host });