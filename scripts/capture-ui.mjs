import { chromium } from "playwright-core";

const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto("http://127.0.0.1:18099", { waitUntil: "networkidle" });
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    await page.screenshot({ path: `/tmp/opencode/loom-${viewport.name}.png`, fullPage: true });
    console.log(JSON.stringify({ viewport: viewport.name, dimensions, errors }));
    await page.close();
  }
} finally {
  await browser.close();
}
