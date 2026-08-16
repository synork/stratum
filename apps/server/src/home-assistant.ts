import WebSocket from "ws";
import type { Entity } from "@loom/shared";

interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
}

interface RegistryEntity { entity_id: string; area_id: string | null; device_id: string | null; disabled_by: string | null; platform: string | null; name: string | null; original_name: string | null; }
interface RegistryDevice { id: string; area_id: string | null; name: string | null; name_by_user: string | null; }
interface RegistryArea { area_id: string; name: string; floor_id: string | null; }
interface LovelaceDashboard { id: string; url_path: string; title: string; mode: "storage" | "yaml"; }
export const helperDomains = ["input_boolean", "input_number", "input_text", "input_select", "input_datetime", "counter", "timer", "schedule"] as const;
export type HelperDomain = typeof helperDomains[number];

const secretPattern = /(token|password|secret|api.?key|access.?key|code|credential)/i;

// HA automation config schema accepts these top-level keys. Agents occasionally
// include metadata keys (type, id, resourceId, _comment) which HA rejects with
// "extra keys not allowed". Strip everything not in the whitelist so publishing
// never fails on a stray field.
export function sanitizeAutomationPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set([
    "alias", "description", "trigger", "condition", "action", "mode",
    "max", "max_exceeded", "variables", "trigger_variables", "id",
    "enabled", "initial_state",
  ]);
  // Optional keys HA types strictly as dictionaries; agents sometimes set
  // them to strings/arrays/empty objects which HA rejects. Drop them unless
  // they are genuinely non-empty plain objects.
  const dictKeys = new Set(["variables", "trigger_variables"]);
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => {
      if (!allowed.has(key)) return false;
      if (dictKeys.has(key)) {
        const value = payload[key];
        return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length > 0;
      }
      return true;
    }),
  );
}

function sanitizeAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => !secretPattern.test(key)));
}

export class HomeAssistantClient {
  private entities: Entity[] = [];
  private areas: RegistryArea[] = [];
  private devices: RegistryDevice[] = [];
  private lastError: string | null = null;
  private refreshed = false;

  constructor(private readonly baseUrl: string, private readonly wsUrl: string, private readonly token: string) {}

  get configured(): boolean { return Boolean(this.baseUrl && this.token); }
  get connected(): boolean { return this.configured && this.refreshed && this.lastError === null; }
  get count(): number { return this.entities.length; }
  get error(): string | null { return this.lastError; }

  list(): Entity[] { return this.entities; }

  search(query: string, limit = 60): Entity[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.entities
      .map((entity) => {
        const haystack = `${entity.entityId} ${entity.friendlyName} ${entity.domain} ${entity.areaId ?? ""}`.toLowerCase();
        return { entity, score: terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) };
      })
      .filter(({ score }) => terms.length === 0 || score > 0)
      .sort((a, b) => b.score - a.score || a.entity.friendlyName.localeCompare(b.entity.friendlyName))
      .slice(0, Math.min(limit, 200))
      .map(({ entity }) => entity);
  }

  areaList(): RegistryArea[] { return this.areas; }
  deviceList(): RegistryDevice[] { return this.devices; }

  appSlugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  }

  automationList() {
    return this.entities.filter((entity) => entity.domain === "automation").map((entity) => ({
      entityId: entity.entityId,
      id: typeof entity.attributes.id === "string" ? entity.attributes.id : entity.entityId.slice("automation.".length),
      name: entity.friendlyName,
      state: entity.state,
      lastTriggered: entity.attributes.last_triggered ?? null,
    }));
  }

  async dashboardList(): Promise<LovelaceDashboard[]> {
    return this.wsCommand<LovelaceDashboard[]>("lovelace/dashboards/list");
  }

  async entityHistory(entityId: string, hours: number): Promise<unknown> {
    if (!this.entities.some((entity) => entity.entityId === entityId)) throw new Error(`Unknown entity: ${entityId}`);
    const start = new Date(Date.now() - hours * 3_600_000).toISOString();
    const path = `/history/period/${encodeURIComponent(start)}?filter_entity_id=${encodeURIComponent(entityId)}&minimal_response&no_attributes`;
    const response = await this.request(path);
    if (!response.ok) throw new Error(`History returned ${response.status}`);
    const raw = (await response.json()) as Array<Array<Record<string, unknown>>>;
    const states = raw[0] ?? [];
    return states.map((entry) => ({
      state: entry.state,
      lastChanged: entry.last_changed,
      lastUpdated: entry.last_updated ?? null,
    }));
  }

  async logbook(entityId: string, hours: number): Promise<unknown> {
    if (!this.entities.some((entity) => entity.entityId === entityId)) throw new Error(`Unknown entity: ${entityId}`);
    const start = new Date(Date.now() - hours * 3_600_000).toISOString();
    const path = `/logbook/${encodeURIComponent(start)}?entity=${encodeURIComponent(entityId)}`;
    const response = await this.request(path);
    if (!response.ok) throw new Error(`Logbook returned ${response.status}`);
    return response.json();
  }

  async helperList(domain?: HelperDomain): Promise<Record<HelperDomain, unknown[]>> {
    const domains = domain ? [domain] : helperDomains;
    const pairs = await Promise.all(domains.map(async (item) => [item, await this.wsCommand<unknown[]>(`${item}/list`)] as const));
    const result = Object.fromEntries(pairs.filter(([, helpers]) => helpers.length > 0)) as Record<HelperDomain, unknown[]>;
    if (domain) return result;
    return result;
  }

  validateHelper(domain: HelperDomain, config: Record<string, unknown>): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (typeof config.name !== "string" || config.name.trim() === "") errors.push("Helper requires a non-empty name");
    if (config.icon != null && (typeof config.icon !== "string" || !config.icon.startsWith("mdi:"))) warnings.push("Icon should normally use an mdi: icon name");
    if (domain === "input_number") {
      if (typeof config.min !== "number" || typeof config.max !== "number") errors.push("Input number requires numeric min and max");
      else if (config.max <= config.min) errors.push("Input number max must be greater than min");
      if (typeof config.initial === "number" && typeof config.min === "number" && typeof config.max === "number" && (config.initial < config.min || config.initial > config.max)) errors.push("Input number initial must be within min and max");
    }
    if (domain === "input_select") {
      if (!Array.isArray(config.options) || config.options.length === 0 || config.options.some((item) => typeof item !== "string")) errors.push("Input select requires a non-empty string options array");
      else if (new Set(config.options).size !== config.options.length) errors.push("Input select options must be unique");
      if (typeof config.initial === "string" && Array.isArray(config.options) && !config.options.includes(config.initial)) errors.push("Input select initial must be one of its options");
    }
    if (domain === "input_datetime" && config.has_date !== true && config.has_time !== true) errors.push("Input datetime requires has_date or has_time");
    if (domain === "input_text") {
      if (config.min != null && (!Number.isInteger(config.min) || Number(config.min) < 0)) errors.push("Input text min must be a non-negative integer");
      if (config.max != null && (!Number.isInteger(config.max) || Number(config.max) < 1)) errors.push("Input text max must be a positive integer");
      if (typeof config.min === "number" && typeof config.max === "number" && config.max < config.min) errors.push("Input text max must be greater than or equal to min");
    }
    if (domain === "counter" && config.step != null && (!Number.isInteger(config.step) || Number(config.step) <= 0)) errors.push("Counter step must be a positive integer");
    if (domain === "schedule") {
      const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
      for (const day of days) if (config[day] != null && !Array.isArray(config[day])) errors.push(`Schedule ${day} must be an array`);
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  async createHelper(domain: HelperDomain, config: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { id: _id, type: _type, ...safeConfig } = config;
    return this.wsCommand<Record<string, unknown>>(`${domain}/create`, safeConfig);
  }

  async getHelper(domain: HelperDomain, id: string): Promise<Record<string, unknown> | null> {
    try { return await this.wsCommand<Record<string, unknown>>(`${domain}/get`, { id }); }
    catch { return null; }
  }

  validateAutomation(payload: Record<string, unknown>): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const known = new Set(this.entities.map((entity) => entity.entityId));
    const inspect = (value: unknown, key = "") => {
      if (key === "entity_id") {
        const ids = Array.isArray(value) ? value : [value];
        for (const id of ids) if (typeof id === "string" && !id.includes("{{") && !known.has(id)) errors.push(`Unknown entity: ${id}`);
      }
      if (Array.isArray(value)) value.forEach((item) => inspect(item));
      else if (value && typeof value === "object") Object.entries(value).forEach(([childKey, item]) => inspect(item, childKey));
    };
    inspect(payload);
    if (!payload.triggers && !payload.trigger) errors.push("Automation requires at least one trigger");
    if (!payload.actions && !payload.action) errors.push("Automation requires at least one action");
    if (!payload.description) warnings.push("Add a description so future edits preserve intent");
    return { valid: errors.length === 0, errors, warnings };
  }

  async getAutomation(id: string): Promise<Record<string, unknown> | null> {
    const response = await this.request(`/config/automation/config/${encodeURIComponent(id)}`);
    if (response.status !== 404) {
      if (!response.ok) throw new Error(`Read automation returned ${response.status}`);
      return response.json() as Promise<Record<string, unknown>>;
    }
    // Direct lookup by id was a 404. Try to resolve non-numeric / alias IDs
    // against the automation config list (used by list_automations) so
    // inspect_automation and list_automations agree on IDs. If the list
    // endpoint is unavailable on this HA version, treat the automation as
    // "not found" rather than failing the whole operation.
    try {
      const listResponse = await this.request("/config/automation/config/list");
      if (!listResponse.ok) return null;
      const configs = (await listResponse.json()) as Array<Record<string, unknown>>;
      const needle = id.replace(/^automation\./, "");
      const match = configs.find((config) => {
        const configId = typeof config.id === "string" || typeof config.id === "number" ? String(config.id) : "";
        const entityId = typeof config.entity_id === "string" ? config.entity_id : "";
        const alias = typeof config.alias === "string" ? config.alias : "";
        return configId === id || configId === needle || entityId === id || entityId === `automation.${needle}` || alias === needle;
      });
      return match ?? null;
    } catch {
      return null;
    }
  }

  async publishAutomation(id: string, payload: Record<string, unknown>): Promise<void> {
    const sanitized = sanitizeAutomationPayload(payload);
    const response = await this.request(`/config/automation/config/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(sanitized) });
    if (!response.ok) throw new Error(`Publish automation returned ${response.status}: ${await response.text()}`);
    const reload = await this.request("/services/automation/reload", { method: "POST", body: "{}" });
    if (!reload.ok) throw new Error(`Automation saved, but reload returned ${reload.status}`);
  }

  validateDashboard(payload: Record<string, unknown>): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const views = payload.views;
    if (!Array.isArray(views) || views.length === 0) errors.push("Dashboard requires at least one view");
    const known = new Set(this.entities.map((entity) => entity.entityId));
    const inspect = (value: unknown, key = "") => {
      if ((key === "entity" || key === "entity_id") && typeof value === "string" && !value.includes("{{") && !known.has(value)) errors.push(`Unknown entity: ${value}`);
      if (Array.isArray(value)) value.forEach((item) => inspect(item));
      else if (value && typeof value === "object") Object.entries(value).forEach(([childKey, item]) => inspect(item, childKey));
    };
    inspect(payload);
    if (Array.isArray(views) && views.some((view) => view && typeof view === "object" && !("title" in view))) warnings.push("Every view should have a title for navigation and accessibility");
    return { valid: errors.length === 0, errors: [...new Set(errors)], warnings };
  }

  async getDashboard(urlPath: string): Promise<Record<string, unknown> | null> {
    try { return await this.wsCommand<Record<string, unknown>>("lovelace/config", { url_path: urlPath, force: true }); }
    catch { return null; }
  }

  async publishDashboard(urlPath: string, payload: Record<string, unknown>): Promise<void> {
    // HA's config/save only works against a dashboard that is already
    // registered in storage. If the target url_path doesn't exist yet, create
    // it first (same as the preview flow), otherwise saving fails with
    // "Unknown config specified".
    const dashboards = await this.wsCommand<LovelaceDashboard[]>("lovelace/dashboards/list");
    if (!dashboards.some((dashboard) => dashboard.url_path === urlPath)) {
      const title = typeof payload.title === "string" && payload.title.trim() ? payload.title : urlPath.replace(/[_-]+/g, " ");
      await this.wsCommand("lovelace/dashboards/create", {
        url_path: urlPath,
        title,
        mode: "storage",
        require_admin: true,
        show_in_sidebar: true,
      });
    }
    await this.wsCommand("lovelace/config/save", { url_path: urlPath, config: payload });
  }

  async createDashboardPreview(proposalId: string, title: string, payload: Record<string, unknown>): Promise<string> {
    const urlPath = `loom-preview-${proposalId.slice(0, 8)}`;
    const dashboards = await this.wsCommand<LovelaceDashboard[]>("lovelace/dashboards/list");
    if (!dashboards.some((dashboard) => dashboard.url_path === urlPath)) {
      await this.wsCommand("lovelace/dashboards/create", {
        url_path: urlPath,
        title: `Stratum preview: ${title}`,
        mode: "storage",
        require_admin: true,
        show_in_sidebar: false,
      });
    }
    await this.publishDashboard(urlPath, payload);
    return `/${urlPath}/0`;
  }

  async deleteDashboardPreview(proposalId: string): Promise<void> {
    const urlPath = `loom-preview-${proposalId.slice(0, 8)}`;
    const dashboards = await this.wsCommand<LovelaceDashboard[]>("lovelace/dashboards/list");
    const preview = dashboards.find((dashboard) => dashboard.url_path === urlPath);
    if (preview) await this.wsCommand("lovelace/dashboards/delete", { dashboard_id: preview.id });
  }

  async reloadCoreConfig(): Promise<void> {
    await this.wsCommand("homeassistant/reload_core_config");
  }

  async refresh(): Promise<void> {
    if (!this.configured) return;
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/states`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Home Assistant states returned ${response.status}`);
      const states = await response.json() as HaState[];
      const registry = this.wsUrl ? await this.loadRegistries() : { entities: [], devices: [], areas: [] };
      const entityRegistry = new Map(registry.entities.map((entity) => [entity.entity_id, entity]));
      const deviceRegistry = new Map(registry.devices.map((device) => [device.id, device]));
      this.areas = registry.areas;
      this.devices = registry.devices;
      const stateEntities = states.map((state) => {
        const registered = entityRegistry.get(state.entity_id);
        const device = registered?.device_id ? deviceRegistry.get(registered.device_id) : undefined;
        const areaId = registered?.area_id ?? device?.area_id ?? null;
        return {
          entityId: state.entity_id,
          state: state.state,
          friendlyName: typeof state.attributes.friendly_name === "string" ? state.attributes.friendly_name : state.entity_id,
          domain: state.entity_id.split(".", 1)[0] ?? "unknown",
          areaId,
          deviceId: registered?.device_id ?? null,
          integration: registered?.platform ?? null,
          attributes: sanitizeAttributes(state.attributes),
          lastChanged: state.last_changed,
          unavailable: state.state === "unavailable" || state.state === "unknown",
          disabled: Boolean(registered?.disabled_by),
        };
      });
      const stateIds = new Set(states.map((state) => state.entity_id));
      const registryOnly: Entity[] = registry.entities.filter((entity) => !stateIds.has(entity.entity_id)).map((entity) => {
        const device = entity.device_id ? deviceRegistry.get(entity.device_id) : undefined;
        return {
          entityId: entity.entity_id,
          state: entity.disabled_by ? "disabled" : "not_loaded",
          friendlyName: entity.name ?? entity.original_name ?? entity.entity_id,
          domain: entity.entity_id.split(".", 1)[0] ?? "unknown",
          areaId: entity.area_id ?? device?.area_id ?? null,
          deviceId: entity.device_id,
          integration: entity.platform,
          attributes: { disabled_by: entity.disabled_by },
          lastChanged: "",
          unavailable: true,
          disabled: Boolean(entity.disabled_by),
        };
      });
      this.entities = [...stateEntities, ...registryOnly].sort((a, b) => a.entityId.localeCompare(b.entityId));
      this.lastError = null;
      this.refreshed = true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, "content-type": "application/json", ...init?.headers },
      signal: AbortSignal.timeout(20_000),
    });
  }

  private wsCommand<T = void>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (!this.wsUrl) return Promise.reject(new Error("Home Assistant WebSocket is not configured"));
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl, { handshakeTimeout: 10_000 });
      const timeout = setTimeout(() => { socket.close(); reject(new Error(`${type} timed out`)); }, 20_000);
      const fail = (error: unknown) => { clearTimeout(timeout); socket.close(); reject(error instanceof Error ? error : new Error(String(error))); };
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; id?: number; success?: boolean; result?: T; error?: { message?: string }; message?: string };
        if (message.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: this.token }));
        else if (message.type === "auth_invalid") fail(new Error(message.message ?? "Home Assistant authentication failed"));
        else if (message.type === "auth_ok") socket.send(JSON.stringify({ id: 1, type, ...payload }));
        else if (message.type === "result" && message.id === 1) {
          clearTimeout(timeout);
          socket.close();
          if (!message.success) reject(new Error(message.error?.message ?? `${type} failed`));
          else resolve(message.result as T);
        }
      });
      socket.on("error", fail);
    });
  }

  private loadRegistries(): Promise<{ entities: RegistryEntity[]; devices: RegistryDevice[]; areas: RegistryArea[] }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl, { handshakeTimeout: 10_000 });
      let id = 1;
      const results = new Map<number, unknown>();
      const timeout = setTimeout(() => { socket.close(); reject(new Error("Home Assistant WebSocket timed out")); }, 15_000);
      const finish = () => {
        if (results.size !== 3) return;
        clearTimeout(timeout);
        socket.close();
        resolve({
          entities: results.get(1) as RegistryEntity[],
          devices: results.get(2) as RegistryDevice[],
          areas: results.get(3) as RegistryArea[],
        });
      };
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; id?: number; success?: boolean; result?: unknown; message?: string };
        if (message.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: this.token }));
        else if (message.type === "auth_invalid") { clearTimeout(timeout); reject(new Error(message.message ?? "Home Assistant authentication failed")); }
        else if (message.type === "auth_ok") {
          socket.send(JSON.stringify({ id: id++, type: "config/entity_registry/list" }));
          socket.send(JSON.stringify({ id: id++, type: "config/device_registry/list" }));
          socket.send(JSON.stringify({ id: id++, type: "config/area_registry/list" }));
        } else if (message.type === "result" && message.id) {
          if (!message.success) { clearTimeout(timeout); reject(new Error(`Registry request ${message.id} failed`)); return; }
          results.set(message.id, message.result);
          finish();
        }
      });
      socket.on("error", (error) => { clearTimeout(timeout); reject(error); });
    });
  }
}
