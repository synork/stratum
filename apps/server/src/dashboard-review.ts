import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { generateText } from "ai";
import type { StoredProvider } from "./database.js";
import { createModel } from "./providers.js";

interface RenderedViewport {
  name: "phone" | "tablet" | "desktop";
  width: number;
  height: number;
  filename: string;
  consoleErrors: string[];
}

const viewports = [
  { name: "phone" as const, width: 390, height: 844 },
  { name: "tablet" as const, width: 768, height: 1024 },
  { name: "desktop" as const, width: 1440, height: 1000 },
];

export class DashboardReviewer {
  private readonly screenshotDir: string;

  constructor(
    dataDir: string,
    private readonly frontendUrl: string,
    private readonly token: string,
    private readonly chromiumPath: string,
  ) {
    this.screenshotDir = path.join(dataDir, "screenshots");
  }

  filePath(filename: string): string {
    if (!/^[a-z0-9-]+\.png$/.test(filename)) throw new Error("Invalid screenshot filename");
    return path.join(this.screenshotDir, filename);
  }

  read(filename: string): Promise<Buffer> {
    return readFile(this.filePath(filename));
  }

  async render(dashboardPath: string): Promise<RenderedViewport[]> {
    if (!dashboardPath.startsWith("/") || dashboardPath.startsWith("//") || dashboardPath.includes("\\")) throw new Error("Dashboard path must be local to Home Assistant");
    const frontendOrigin = new URL(this.frontendUrl).origin;
    const target = new URL(dashboardPath, `${this.frontendUrl.replace(/\/$/, "")}/`);
    if (target.origin !== frontendOrigin) throw new Error("Dashboard path resolved outside Home Assistant");
    await mkdir(this.screenshotDir, { recursive: true, mode: 0o700 });
    const browser = await chromium.launch({ headless: true, ...this.chromiumPath ? { executablePath: this.chromiumPath } : {} });
    const runId = crypto.randomUUID();
    try {
      const rendered: RenderedViewport[] = [];
      for (const viewport of viewports) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: "dark" });
        await context.route("**/*", async (route) => {
          const requestUrl = new URL(route.request().url());
          if (requestUrl.origin === frontendOrigin || requestUrl.protocol === "data:" || requestUrl.protocol === "blob:") await route.continue();
          else await route.abort("blockedbyclient");
        });
        const page = await context.newPage();
        const consoleErrors: string[] = [];
        page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 500)); });
        await page.addInitScript(({ token, hassUrl }) => {
          localStorage.setItem("hassTokens", JSON.stringify({ hassUrl, access_token: token, expires: Date.now() + 3_600_000 }));
        }, { token: this.token, hassUrl: this.frontendUrl });
        await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
        if (new URL(page.url()).origin !== frontendOrigin) throw new Error("Home Assistant redirected outside its configured origin");
        await page.waitForTimeout(1_500);
        const filename = `${runId}-${viewport.name}.png`;
        await page.screenshot({ path: this.filePath(filename), fullPage: true });
        rendered.push({ ...viewport, filename, consoleErrors });
        await context.close();
      }
      return rendered;
    } finally {
      await browser.close();
    }
  }

  async review(provider: StoredProvider, modelId: string, dashboardPath: string) {
    const renders = await this.render(dashboardPath);
    const content: Array<{ type: "text"; text: string } | { type: "file"; data: Uint8Array; mediaType: "image/png" }> = [{
      type: "text",
      text: `Review these Home Assistant dashboard renders at phone, tablet, and desktop sizes. Identify clipping, overflow, missing cards, unreadable hierarchy, wasted space, inconsistent alignment, and console failures. Be concrete and prioritize functional defects. Console errors: ${JSON.stringify(renders.map((render) => ({ viewport: render.name, errors: render.consoleErrors })))}`,
    }];
    for (const render of renders) content.push({ type: "file", data: await readFile(this.filePath(render.filename)), mediaType: "image/png" });
    const result = await generateText({
      model: createModel(provider, modelId),
      messages: [{ role: "user", content }],
      maxOutputTokens: 1_500,
    });
    return { renders, review: result.text, usage: result.usage };
  }
}
