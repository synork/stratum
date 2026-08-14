import type { Entity, Health, Proposal, ProviderSummary } from "@loom/shared";

function apiUrl(path: string): string {
  const pathname = window.location.pathname.endsWith("/") ? window.location.pathname : `${window.location.pathname}/`;
  return new URL(`api/${path.replace(/^\//, "")}`, `${window.location.origin}${pathname}`).toString();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(apiUrl(path), {
    ...init,
    headers,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(payload.error ?? `Request failed with ${response.status}`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export interface ProviderField {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
}

export interface ProviderDefinition {
  kind: ProviderSummary["kind"];
  label: string;
  fields: ProviderField[];
}

export interface DashboardReview {
  renders: Array<{ name: "phone" | "tablet" | "desktop"; width: number; height: number; filename: string; consoleErrors: string[] }>;
  review: string;
  usage: unknown;
}

export interface ThreadSummary {
  id: string;
  title: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredThread {
  id: string;
  title: string;
  state: unknown;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRecord {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ResourceCurrent {
  type: "automation" | "dashboard" | "helper";
  resourceId: string;
  current: Record<string, unknown> | null;
}

export const api = {
  health: () => request<Health>("health"),
  providers: () => request<ProviderSummary[]>("providers"),
  providerDefinitions: () => request<ProviderDefinition[]>("providers/definitions"),
  saveProvider: (body: unknown) => request<ProviderSummary>("providers", { method: "POST", body: JSON.stringify(body) }),
  deleteProvider: (id: string) => request<void>(`providers/${id}`, { method: "DELETE" }),
  discoverModels: (id: string) => request<{ models: string[] }>(`providers/${id}/discover`, { method: "POST" }),
  entities: (query: string) => request<{ entities: Entity[]; total: number }>(`entities?q=${encodeURIComponent(query)}&limit=80`),
  refreshEntities: () => request<{ count: number }>("entities/refresh", { method: "POST" }),
  chatUrl: () => apiUrl("chat"),
  proposals: () => request<Proposal[]>("proposals"),
  deleteProposal: (id: string) => request<void>(`proposals/${id}`, { method: "DELETE" }),
  approveProposal: (id: string) => request<Proposal>(`proposals/${id}/approve`, { method: "POST" }),
  rejectProposal: (id: string) => request<Proposal>(`proposals/${id}/reject`, { method: "POST" }),
  reviewDashboard: (body: { providerId: string; modelId: string; dashboardPath: string }) => request<DashboardReview>("dashboard/review", { method: "POST", body: JSON.stringify(body) }),
  screenshotUrl: (filename: string) => apiUrl(`screenshots/${encodeURIComponent(filename)}`),
  previewProposal: (id: string, body: { providerId: string; modelId: string }) => request<DashboardReview & { previewPath: string }>(`proposals/${id}/preview`, { method: "POST", body: JSON.stringify(body) }),
  getResourceCurrent: (type: "automation" | "dashboard" | "helper", resourceId: string) => request<Record<string, unknown> | null>(`resources/${type}/${encodeURIComponent(resourceId)}/current`),
  threads: () => request<ThreadSummary[]>("threads"),
  thread: (id: string) => request<StoredThread>(`threads/${id}`),
  saveThread: (id: string, state: unknown) => request<void>(`threads/${id}`, { method: "PUT", body: JSON.stringify(state) }),
  archiveThread: (id: string) => request<void>(`threads/${id}/archive`, { method: "POST" }),
  compactThread: (id: string, body: { providerId: string; modelId: string; existingSummary: string; messages: Array<{ role: "user" | "assistant"; content: string }> }) => request<{ summary: string; usage: unknown }>(`threads/${id}/compact`, { method: "POST", body: JSON.stringify(body) }),
  memories: (query = "") => request<MemoryRecord[]>(`memories?q=${encodeURIComponent(query)}`),
  saveMemory: (content: string, tags: string[]) => request<MemoryRecord>("memories", { method: "POST", body: JSON.stringify({ content, tags }) }),
  deleteMemory: (id: string) => request<void>(`memories/${id}`, { method: "DELETE" }),
  integrations: () => request<Array<{ domain: string; installed: boolean }>>("integrations"),
  deleteIntegration: (domain: string) => request<void>(`integrations/${encodeURIComponent(domain)}`, { method: "DELETE" }),
};
