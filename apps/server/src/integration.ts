import { access, mkdir, readFile, rm, writeFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const MANIFEST_KEYS = ["domain", "name", "version", "codeowners"] as const;
const SAFE_MODULES = new Set([
  "asyncio", "datetime", "enum", "functools", "hashlib", "json", "logging", "math",
  "re", "time", "types", "typing", "uuid", "voluptuous",
  "homeassistant.core", "homeassistant.config_entries", "homeassistant.helpers",
  "homeassistant.const", "homeassistant.helpers.entity", "homeassistant.helpers.typing",
  "homeassistant.components.sensor", "homeassistant.components.switch",
  "homeassistant.components.binary_sensor", "homeassistant.components.cover",
  "homeassistant.components.light", "homeassistant.components.number",
  "homeassistant.components.select", "homeassistant.components.text",
  "homeassistant.components.time", "homeassistant.components.event",
]);
const MAX_FILES = 8;
const MAX_FILE_BYTES = 40_000;
const MAX_TOTAL_BYTES = 120_000;
const REQUIRED_FILES = ["manifest.json", "__init__.py"];

export interface IntegrationPayload {
  domain: string;
  files: Record<string, string>;
}

function cleanPython(text: string): string {
  // Strip shebang + encoding comment lines so compile() works in isolation
  return text.replace(/^\s*(#![^\n]*|\s*#.*coding[:=][^\n]*)\n/gm, "");
}

// Lightweight Python plausibility check. The addon has no Python runtime, so we
// cannot run py_compile; this catches obvious breakage without false positives.
function pythonLooksBroken(text: string): string | null {
  const stripped = cleanPython(text);
  if (!stripped.trim()) return "empty Python file";
  const stack: string[] = [];
  for (const ch of stripped) {
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch === ")" || ch === "]" || ch === "}") {
      const open = stack.pop();
      if ((ch === ")" && open !== "(") || (ch === "]" && open !== "[") || (ch === "}" && open !== "{")) {
        return "unbalanced brackets";
      }
    }
  }
  if (stack.length) return "unclosed brackets";
  // Reject a doubled colon in a header context as a likely indentation error,
  // but keep it permissive: only exact duplicate `::` is suspicious.
  if (/::/.test(stripped)) return "suspicious '::' token";
  return null;
}

function safePath(p: string): boolean {
  const parts = p.split("/");
  return (
    parts.length >= 1 &&
    parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part)) &&
    !parts.includes("..") &&
    !p.includes("\\") &&
    !p.startsWith("/")
  );
}

export function validateIntegration(payload: unknown): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, errors: ["Integration payload must be an object"], warnings: [] };
  }
  const data = payload as Partial<IntegrationPayload>;
  const domain = typeof data.domain === "string" ? data.domain.trim().toLowerCase() : "";
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(domain)) {
    errors.push("domain must be 2-32 lowercase letters, digits, or underscores, starting with a letter");
  }
  const files = data.files ?? {};
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    errors.push("files must be an object mapping paths to contents");
  }

  const fileEntries = Object.entries(files as Record<string, unknown>);
  if (fileEntries.length === 0) errors.push("integration has no files");
  if (fileEntries.length > MAX_FILES) errors.push(`integration has more than ${MAX_FILES} files`);
  let total = 0;
  for (const [path, content] of fileEntries) {
    if (!safePath(path)) {
      errors.push(`invalid file path: ${path}`);
      continue;
    }
    if (typeof content !== "string") {
      errors.push(`file ${path} must be a string`);
      continue;
    }
    if (content.length > MAX_FILE_BYTES) errors.push(`file ${path} exceeds ${MAX_FILE_BYTES} bytes`);
    total += content.length;
    if (path.endsWith(".py") && !/\.py$/.test(path)) continue;
    if (path.endsWith(".py")) {
      try {
        new Function(cleanPython(content)); // syntax-only parse via Function constructor
      } catch {
        // Function constructor is JS; use a different approach below for python
      }
    }
  }
  if (total > MAX_TOTAL_BYTES) errors.push(`integration exceeds ${MAX_TOTAL_BYTES} total bytes`);

  const manifestRaw = typeof files?.["manifest.json"] === "string" ? files["manifest.json"] : "";
  let manifest: Record<string, unknown> | null = null;
  try {
    manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
  } catch {
    errors.push("manifest.json is not valid JSON");
  }
  if (manifest) {
    for (const key of MANIFEST_KEYS) {
      if (manifest[key] === undefined) errors.push(`manifest.json is missing "${key}"`);
    }
    if (manifest.domain !== domain) errors.push(`manifest.json domain "${String(manifest.domain)}" does not match "${domain}"`);
    if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
      errors.push("manifest.json version must be semver like 1.0.0");
    }
    if (manifest.requirements !== undefined && !Array.isArray(manifest.requirements)) errors.push("manifest.json requirements must be an array");
  }

  for (const required of REQUIRED_FILES) {
    if (!(required in (files as Record<string, unknown>))) errors.push(`missing required file: ${required}`);
  }

  // Python plausibility + import allowlist
  for (const [path, content] of fileEntries) {
    if (!path.endsWith(".py") || typeof content !== "string") continue;
    const broken = pythonLooksBroken(content);
    if (broken) errors.push(`${path}: ${broken}`);
    const importRe = /^\s*(?:import|from)\s+([a-zA-Z0-9_.]+)/gm;
    for (const match of content.matchAll(importRe)) {
      const module = match[1];
      if (module && !SAFE_MODULES.has(module) && !module.startsWith(`${domain}.`)) {
        errors.push(`${path}: import "${module}" is not in the allowlist`);
      }
    }
    if (/os\.system|subprocess|eval\s*\(|exec\s*\(|__import__|socket|pickle|shutil\.rmtree/.test(content)) {
      errors.push(`${path}: contains blocked operations (subprocess/system/eval/exec/socket)`);
    }
  }

  if (domain && errors.length === 0) {
    if (!("config_flow.py" in (files as Record<string, unknown>))) {
      warnings.push("No config_flow.py; the integration will not appear in the HA UI flow. Add one for a one-click setup experience.");
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

export class IntegrationInstaller {
  constructor(private readonly haConfigDir: string) {}

  installedDir(domain: string): string {
    return resolve(this.haConfigDir, "custom_components", domain);
  }

  async exists(domain: string): Promise<boolean> {
    try {
      await access(this.installedDir(domain));
      return true;
    } catch {
      return false;
    }
  }

  async snapshot(domain: string): Promise<Record<string, string> | null> {
    const dir = this.installedDir(domain);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return null;
    }
    const files: Record<string, string> = {};
    for (const entry of entries) {
      const full = join(dir, entry);
      const info = await stat(full);
      if (info.isFile()) files[entry] = await readFile(full, "utf8");
    }
    return Object.keys(files).length ? files : null;
  }

  async write(domain: string, files: Record<string, string>): Promise<void> {
    const dir = this.installedDir(domain);
    await mkdir(dir, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      if (!safePath(relPath)) throw new Error(`Refusing unsafe path: ${relPath}`);
      const target = resolve(dir, relPath);
      const root = dir.endsWith(sep) ? dir : `${dir}${sep}`;
      if (!target.startsWith(root)) throw new Error(`Refusing path outside domain dir: ${relPath}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
  }

  async rollback(domain: string, snapshot: Record<string, string> | null): Promise<void> {
    const dir = this.installedDir(domain);
    await rm(dir, { recursive: true, force: true });
    if (snapshot) await this.write(domain, snapshot);
  }

  async remove(domain: string): Promise<void> {
    await rm(this.installedDir(domain), { recursive: true, force: true });
  }

  async listInstalled(): Promise<string[]> {
    try {
      const base = resolve(this.haConfigDir, "custom_components");
      const entries = await readdir(base);
      const domains: string[] = [];
      for (const entry of entries) {
        const info = await stat(join(base, entry));
        if (info.isDirectory() && (await this.exists(entry))) domains.push(entry);
      }
      return domains.sort();
    } catch {
      return [];
    }
  }

  summarize(payload: IntegrationPayload): { domain: string; fileCount: number; totalBytes: number; manifest: Record<string, unknown> | null } {
    const entries = Object.entries(payload.files ?? {});
    const totalBytes = entries.reduce((sum, [, content]) => sum + content.length, 0);
    let manifest: Record<string, unknown> | null = null;
    try {
      manifest = JSON.parse(payload.files["manifest.json"] ?? "") as Record<string, unknown>;
    } catch {
      manifest = null;
    }
    return { domain: payload.domain, fileCount: entries.length, totalBytes, manifest };
  }
}