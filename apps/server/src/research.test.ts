import { describe, expect, it } from "vitest";
import { assertPublicUrl, cleanText, decodeRedirect } from "./research.js";

describe("research URL safety", () => {
  it.each(["http://localhost/test", "http://127.0.0.1/test", "http://192.168.1.10", "http://homeassistant.local"])("blocks private URL %s", async (url) => {
    await expect(assertPublicUrl(url)).rejects.toThrow(/private/i);
  });

  it("blocks non-web protocols", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/HTTP/i);
  });

  it("allows a public HTTPS host", async () => {
    await expect(assertPublicUrl("https://github.com/anomalyco/opencode")).resolves.toBeInstanceOf(URL);
  });
});

describe("keyless search parsing", () => {
  it("decodes DuckDuckGo redirect links back to the target URL", () => {
    const target = "https://example.com/a%20b?x=1";
    const redirect = `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc123`;
    expect(decodeRedirect(redirect)).toBe(target);
  });

  it("passes absolute and protocol-relative links through", () => {
    expect(decodeRedirect("https://example.com/page")).toBe("https://example.com/page");
    expect(decodeRedirect("//www.bbc.com/")).toBe("https://www.bbc.com/");
  });

  it("cleans entities and whitespace from titles and snippets", () => {
    expect(cleanText("  Home &amp; Garden &quot;Ideas&quot;  ")).toBe("Home & Garden \"Ideas\"");
    expect(cleanText("a&nbsp;&nbsp;b")).toBe("a b");
  });
});
