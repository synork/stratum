import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { convert } from "html-to-text";
import type { Database } from "./database.js";

const MAX_BYTES = 1_000_000;
const MAX_TEXT = 120_000;

function privateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item))) return true;
  const [a = 0, b = 0] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 168
    || a === 100 && b >= 64 && b <= 127
    || a === 198 && (b === 18 || b === 19);
}

function privateIp(address: string): boolean {
  if (isIP(address) === 4) return privateIpv4(address);
  const value = address.toLowerCase();
  if (value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith("::ffff:")) return privateIpv4(value.slice(7));
  return false;
}

export async function assertPublicUrl(input: string): Promise<URL> {
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP and HTTPS URLs are supported");
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) throw new Error("Private network URLs are not allowed");
  if (isIP(hostname) && privateIp(hostname)) throw new Error("Private network URLs are not allowed");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((item) => privateIp(item.address))) throw new Error("URL resolves to a private network address");
  return url;
}

async function fetchPublic(input: string, init: RequestInit = {}): Promise<{ url: string; status: number; contentType: string; body: Uint8Array }> {
  let url = await assertPublicUrl(input);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect ${response.status} had no location`);
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) throw new Error("Response is larger than 1 MB");
    if (!response.body) throw new Error("Response had no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error("Response exceeded 1 MB"); }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return { url: url.toString(), status: response.status, contentType: response.headers.get("content-type") ?? "", body };
  }
  throw new Error("Too many redirects");
}

function decoded(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

function githubSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`Invalid GitHub ${label}`);
  return value;
}

function githubPath(value: string): string {
  if (value.split("/").some((part) => part === "..")) throw new Error("GitHub paths cannot contain ..");
  return value.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function cleanText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function decodeRedirect(href: string): string | null {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    if (url.hostname === "duckduckgo.com" && url.pathname === "/l/") {
      const target = url.searchParams.get("uddg");
      if (target) return target;
    }
    return href.startsWith("//") ? `https:${href}` : href;
  } catch { return null; }
}

export class ResearchTools {
  constructor(private readonly database: Database, private readonly githubToken: string) {}

  async webFetch(url: string): Promise<{ url: string; status: number; contentType: string; content: string }> {
    const result = await fetchPublic(url, { headers: { "user-agent": "Stratum/0.2 (+Home Assistant)" } });
    if (result.status < 200 || result.status >= 300) throw new Error(`Web fetch returned ${result.status}`);
    const raw = decoded(result.body);
    const content = result.contentType.includes("text/html")
      ? convert(raw, { wordwrap: false, selectors: [{ selector: "script", format: "skip" }, { selector: "style", format: "skip" }] })
      : raw;
    return { url: result.url, status: result.status, contentType: result.contentType, content: content.slice(0, MAX_TEXT) };
  }

  async webSearch(query: string): Promise<unknown> {
    const provider = this.database.listProviders().find((item) => item.kind === "synorkai" && item.enabled);
    if (!provider) return this.duckDuckGoSearch(query);
    const apiKey = typeof provider.config.apiKey === "string" ? provider.config.apiKey : "";
    const baseUrl = typeof provider.config.baseUrl === "string" && provider.config.baseUrl ? provider.config.baseUrl : "https://api.synork.dev/api/v1/public";
    try {
      const result = await fetchPublic(`${baseUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}`, {
        headers: { "X-API-Key": apiKey, "user-agent": "Stratum/0.2 (+Home Assistant)" },
      });
      if (result.status < 200 || result.status >= 300) throw new Error(`SynorkAi search returned ${result.status}`);
      return JSON.parse(decoded(result.body)) as unknown;
    } catch (error) {
      return this.duckDuckGoSearch(query, error instanceof Error ? error.message : String(error));
    }
  }

  private async duckDuckGoSearch(query: string, providerNote?: string): Promise<unknown> {
    const result = await fetchPublic(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "user-agent": "Stratum/0.2 (+Home Assistant); duckduckgo keyless fetch" },
    });
    if (result.status < 200 || result.status >= 300) throw new Error(`DuckDuckGo search returned ${result.status}`);
    const html = decoded(result.body);
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const matches = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
    matches.forEach((match, index) => {
      const url = decodeRedirect(match[1] ?? "");
      if (!url) return;
      results.push({
        title: cleanText(stripHtml(match[2] ?? "")) || url,
        url,
        snippet: cleanText(stripHtml(snippets[index]?.[1] ?? "")),
      });
    });
    return {
      engine: "duckduckgo-keyless",
      provider_note: providerNote ?? "keyless fallback, no API key required",
      count: results.length,
      results,
    };
  }

  async githubSearch(query: string): Promise<unknown> {
    return this.githubJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=10`);
  }

  async githubTree(owner: string, repo: string, path = "", ref?: string): Promise<unknown> {
    const base = `https://api.github.com/repos/${githubSegment(owner, "owner")}/${githubSegment(repo, "repository")}/contents/${githubPath(path)}`;
    return this.githubJson(ref ? `${base}?ref=${encodeURIComponent(ref)}` : base);
  }

  async githubRead(owner: string, repo: string, path: string, ref?: string): Promise<{ path: string; content: string }> {
    const result = await this.githubTree(owner, repo, path, ref) as { type?: string; content?: string; encoding?: string; size?: number; path?: string };
    if (result.type !== "file" || !result.content) throw new Error("GitHub path is not a readable file");
    if ((result.size ?? 0) > MAX_BYTES) throw new Error("GitHub file is larger than 1 MB");
    const content = result.encoding === "base64" ? Buffer.from(result.content.replace(/\n/g, ""), "base64").toString("utf8") : result.content;
    return { path: result.path ?? path, content: content.slice(0, MAX_TEXT) };
  }

  private async githubJson(url: string): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "Stratum/0.2 (+Home Assistant)", "x-github-api-version": "2022-11-28" };
    if (this.githubToken) headers.authorization = `Bearer ${this.githubToken}`;
    const result = await fetchPublic(url, { headers });
    if (result.status < 200 || result.status >= 300) throw new Error(`GitHub returned ${result.status}: ${decoded(result.body).slice(0, 300)}`);
    return JSON.parse(decoded(result.body)) as unknown;
  }
}
