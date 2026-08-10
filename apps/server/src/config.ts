import path from "node:path";

export const config = {
  port: Number(process.env.PORT ?? 8099),
  host: process.env.HOST ?? "0.0.0.0",
  dataDir: process.env.DATA_DIR ?? path.resolve("data"),
  haBaseUrl: process.env.HA_BASE_URL ?? "",
  haWsUrl: process.env.HA_WS_URL ?? "",
  haToken: process.env.HA_TOKEN ?? "",
  haFrontendUrl: process.env.HA_FRONTEND_URL ?? "http://127.0.0.1:8123",
  chromiumPath: process.env.CHROMIUM_PATH ?? "",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  webDist: process.env.WEB_DIST ?? path.resolve("apps/web/dist"),
};
