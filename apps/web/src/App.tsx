import React, { startTransition, useDeferredValue, useEffect, useRef, useState, useCallback } from "react";
import {
  Activity,
  Archive,
  ArrowUp,
  Brain,
  Bot,
  Boxes,
  Check,
  ChevronDown,
  CircleAlert,
  Command,
  Copy,
  Eye,
  Gauge,
  HousePlug,
  Layers3,
  Menu,
  Network,
  Pause,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Star,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import type { Entity, Health, Proposal, ProviderSummary } from "@loom/shared";
import { api, type DashboardReview, type MemoryRecord, type ProviderDefinition, type ThreadSummary } from "./api";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Toast {
  id: string;
  message: string;
  type: "info" | "success" | "error" | "warning";
}

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container" role="region" aria-live="polite" aria-label="Notifications">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.type}`}>
          <span>{toast.message}</span>
          <button type="button" className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}

type DiffLine = { type: "added" | "removed" | "unchanged"; value: string };

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const result: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    const oldLine = oldLines[i];
    const newLine = newLines[j];
    if (oldLine !== undefined && newLine !== undefined && oldLine === newLine) {
      result.push({ type: "unchanged", value: oldLine });
      i++; j++;
    } else if (oldLine !== undefined && newLine !== undefined && oldLine !== newLine) {
      // Simple heuristic: check if old line exists later in new, or new line exists later in old
      const oldInNew = newLines.slice(j).indexOf(oldLine);
      const newInOld = oldLines.slice(i).indexOf(newLine);
      if (oldInNew !== -1 && (newInOld === -1 || oldInNew <= newInOld)) {
        result.push({ type: "added", value: newLine });
        j++;
      } else if (newInOld !== -1) {
        result.push({ type: "removed", value: oldLine });
        i++;
      } else {
        result.push({ type: "removed", value: oldLine });
        result.push({ type: "added", value: newLine });
        i++; j++;
      }
    } else if (oldLine !== undefined) {
      result.push({ type: "removed", value: oldLine });
      i++;
    } else if (newLine !== undefined) {
      result.push({ type: "added", value: newLine });
      j++;
    }
  }
  return result;
}

function DiffView({ oldConfig, newConfig }: { oldConfig: Record<string, unknown> | null; newConfig: Record<string, unknown> }) {
  const oldText = JSON.stringify(oldConfig ?? {}, null, 2);
  const newText = JSON.stringify(newConfig, null, 2);
  const diff = computeDiff(oldText, newText);
  const hasChanges = diff.some((line) => line.type !== "unchanged");

  if (!hasChanges && !oldConfig) return <pre className="diff-view diff-view--new">{newText}</pre>;
  if (!hasChanges) return <pre className="diff-view diff-view--same">No changes</pre>;

  return (
    <div className="diff-view">
      {diff.map((line, index) => (
        <div key={index} className={`diff-line diff-line--${line.type}`}>
          <span className="diff-marker">
            {line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}
          </span>
          <span className="diff-content">{line.value || " "}</span>
        </div>
      ))}
    </div>
  );
}

type Mode = "plan" | "build";

interface TranscriptItem {
  id: string;
  role: "user" | "assistant" | "reasoning" | "activity";
  text: string;
  detail?: string;
  status?: "running" | "complete" | "error";
}

interface LastModels {
  providerId: string;
  byProvider: Record<string, string>;
}

interface SessionTab {
  id: string;
  title: string;
  mode: Mode;
  prompt: string;
  transcript: TranscriptItem[];
  entityIds: string[];
  createdAt: string;
  contextSummary?: string;
  compactedThrough?: number;
}

const FAVORITES_KEY = "loom.favorite-models";
const LAST_MODELS_KEY = "loom.last-models";
const SESSION_TABS_KEY = "loom.session-tabs";
const ACTIVE_TAB_KEY = "loom.active-tab";

function createId(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function newSessionTab(): SessionTab {
  return { id: createId(), title: "New session", mode: "plan", prompt: "", transcript: [], entityIds: [], createdAt: new Date().toISOString() };
}

function readSessionTabs(): SessionTab[] {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_TABS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [newSessionTab()];
    const tabs = value.filter((item): item is SessionTab => Boolean(item && typeof item === "object" && "id" in item && "transcript" in item));
    return tabs.length ? tabs : [newSessionTab()];
  } catch { return [newSessionTab()]; }
}

function readStringSet(key: string): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch { return new Set(); }
}

function readLastModels(): LastModels {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_MODELS_KEY) ?? "{}") as Partial<LastModels>;
    return { providerId: typeof value.providerId === "string" ? value.providerId : "", byProvider: value.byProvider && typeof value.byProvider === "object" ? value.byProvider : {} };
  } catch { return { providerId: "", byProvider: {} }; }
}

const starters = [
  "Build a leaving-home automation",
  "Find automations that fight each other",
  "Design a compact phone dashboard",
  "Explain why a light turned on",
];

function StatusDot({ state }: { state: Health["homeAssistant"] | "running" }) {
  return <span className={`status-dot status-dot--${state}`} aria-hidden="true" />;
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
          pre: (props: React.HTMLAttributes<HTMLPreElement> & { children?: React.ReactNode }) => {
            const codeElement = React.Children.toArray(props.children ?? [])[0] as React.ReactElement<{ className?: string; children?: React.ReactNode }> | undefined;
            const codeText = codeElement?.props?.children?.toString() ?? "";
            const lang = codeElement?.props?.className?.toString().replace("language-", "") ?? "";
            return (
              <div className="markdown-code-block">
                <div className="markdown-code-header">
                  <span className="markdown-code-lang">{lang}</span>
                  <button
                    type="button"
                    className="markdown-copy-button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(codeText);
                    }}
                    aria-label="Copy code"
                  >
                    <Copy size={13} />
                  </button>
                </div>
                <pre {...props}>{props.children}</pre>
              </div>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function ReasoningPart({ item }: { item: TranscriptItem }) {
  return (
    <details data-component="reasoning-part" open={item.status === "running"}>
      <summary data-slot="reasoning-trigger"><span data-slot="reasoning-indicator" />Reasoning {item.status === "running" ? "in progress" : ""}</summary>
      <div data-slot="reasoning-content"><MarkdownMessage content={item.text || "Waiting for model-provided reasoning…"} /></div>
    </details>
  );
}

function ToolActivity({ item }: { item: TranscriptItem }) {
  return (
    <details data-component="tool-trigger" data-state={item.status ?? "complete"} open={item.status === "running"}>
      <summary data-slot="basic-tool-tool-trigger-content">
        <span data-slot="basic-tool-tool-indicator"><span data-slot="tool-status-dot" /></span>
        <span data-slot="basic-tool-tool-info"><span data-slot="basic-tool-tool-info-main"><strong data-slot="basic-tool-tool-title">{item.text}</strong>{item.status === "running" && <span data-slot="basic-tool-tool-subtitle">running</span>}{item.status === "error" && <span data-slot="basic-tool-tool-subtitle">error</span>}</span></span>
        <span data-slot="basic-tool-tool-action">+</span>
      </summary>
      {item.detail && <pre data-component="tool-output" data-scrollable>{item.detail}</pre>}
    </details>
  );
}

function UserMessage({ item }: { item: TranscriptItem }) {
  return (
    <article data-component="user-message" className={item.status === "error" ? "message-error" : ""}>
      <div data-slot="user-message-body"><div data-slot="user-message-text">{item.text}</div></div>
      <div data-slot="user-message-copy-wrapper" aria-hidden="true" />
    </article>
  );
}

function AssistantMessage({ item }: { item: TranscriptItem }) {
  return (
    <article data-component="text-part" className={item.status === "error" ? "message-error" : ""}>
      <div data-slot="text-part-body"><MarkdownMessage content={item.text || "Preparing response…"} /></div>
      <div data-slot="text-part-copy-wrapper">{item.status === "running" && <span className="running-label"><StatusDot state="running" />working</span>}</div>
    </article>
  );
}

function ThreadHistoryDialog({ threads, openIds, onOpen, onClose }: { threads: ThreadSummary[]; openIds: Set<string>; onOpen: (id: string) => void; onClose: () => void }) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog thread-dialog" role="dialog" aria-modal="true" aria-labelledby="threads-title">
        <header className="dialog-header"><div><span className="eyebrow">HISTORY</span><h2 id="threads-title">Threads</h2></div><button className="icon-button" type="button" onClick={onClose}><X size={17} /></button></header>
        <div className="thread-list">
          {threads.map((thread) => <button type="button" key={thread.id} onClick={() => onOpen(thread.id)}>
            <Archive size={15} /><span><strong>{thread.title}</strong><small>{new Date(thread.updatedAt).toLocaleString()}</small></span><em>{openIds.has(thread.id) ? "open" : thread.archived ? "archived" : "saved"}</em>
          </button>)}
          {threads.length === 0 && <div className="dialog-empty">No saved threads yet.</div>}
        </div>
      </section>
    </div>
  );
}

function MemoryDialog({ memories, onReload, onClose }: { memories: MemoryRecord[]; onReload: () => Promise<void>; onClose: () => void }) {
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog memory-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-title">
        <header className="dialog-header"><div><span className="eyebrow">PERSISTENT CONTEXT</span><h2 id="memory-title">Memory</h2></div><button className="icon-button" type="button" onClick={onClose}><X size={17} /></button></header>
        <form onSubmit={async (event) => { event.preventDefault(); setError(""); try { await api.saveMemory(content, tags.split(",").map((tag) => tag.trim()).filter(Boolean)); setContent(""); setTags(""); await onReload(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>
          <label className="field"><span>Durable fact or preference</span><textarea rows={3} value={content} onChange={(event) => setContent(event.target.value)} required /></label>
          <label className="field"><span>Tags <small>comma separated</small></span><input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
          {error && <p className="form-error"><CircleAlert size={15} />{error}</p>}
          <div className="dialog-actions"><button className="button button--primary" type="submit">Remember</button></div>
        </form>
        <div className="memory-list">
          {memories.map((memory) => <article key={memory.id}><div><p>{memory.content}</p><small>{memory.tags.join(" · ") || "untagged"}</small></div><button type="button" onClick={async () => { await api.deleteMemory(memory.id); await onReload(); }} aria-label="Delete memory"><Trash2 size={14} /></button></article>)}
          {memories.length === 0 && <div className="dialog-empty">No persistent memories yet.</div>}
        </div>
      </section>
    </div>
  );
}

interface CommandPaletteItem {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  shortcut?: string;
  action: () => void;
  disabled?: boolean;
}

function CommandPalette({ open, onClose, items }: { open: boolean; onClose: () => void; items: CommandPaletteItem[] }) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filteredItems = items.filter((item) =>
    `${item.label} ${item.description} ${item.shortcut ?? ""}`.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    setQuery("");
    setSelectedIndex(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onClose(); return; }
      if (event.key === "ArrowDown") { event.preventDefault(); setSelectedIndex((i) => Math.min(i + 1, filteredItems.length - 1)); }
      if (event.key === "ArrowUp") { event.preventDefault(); setSelectedIndex((i) => Math.max(i - 1, 0)); }
      if (event.key === "Enter") {
        event.preventDefault();
        const item = filteredItems[selectedIndex];
        if (item && !item.disabled) { item.action(); onClose(); }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, filteredItems, selectedIndex, onClose]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog command-palette" role="dialog" aria-modal="true" aria-labelledby="command-title">
        <header className="dialog-header">
          <div><span className="eyebrow">COMMAND PALETTE</span><h2 id="command-title">Search commands</h2></div>
          <kbd className="command-hint">⌘K</kbd>
        </header>
        <label className="search-box"><Command size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Type a command…" autoFocus spellCheck={false} /></label>
        <div className="command-list" ref={listRef} role="listbox" aria-label="Commands">
          {filteredItems.length === 0 ? (
            <div className="dialog-empty">No matching commands</div>
          ) : (
            filteredItems.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                aria-disabled={item.disabled}
                className={`command-item ${index === selectedIndex ? "command-item--selected" : ""} ${item.disabled ? "command-item--disabled" : ""}`}
                onClick={() => { if (!item.disabled) { item.action(); onClose(); } }}
                onMouseEnter={() => setSelectedIndex(index)}
                disabled={item.disabled}
              >
                <span className="command-icon">{item.icon}</span>
                <div className="command-text">
                  <span className="command-label">{item.label}</span>
                  <span className="command-description">{item.description}</span>
                </div>
                {item.shortcut && <kbd className="command-shortcut">{item.shortcut}</kbd>}
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function EntityRow({ entity, selected, onToggle }: { entity: Entity; selected: boolean; onToggle: () => void }) {
  return (
    <button className={`entity-row ${selected ? "entity-row--selected" : ""}`} type="button" onClick={onToggle} aria-pressed={selected}>
      <span className="entity-glyph">{entity.domain.slice(0, 2).toUpperCase()}</span>
      <span className="entity-copy">
        <strong>{entity.friendlyName}</strong>
        <small>{entity.entityId}</small>
      </span>
      <span className={`entity-state ${entity.unavailable ? "entity-state--bad" : ""}`}>{entity.disabled ? "disabled" : entity.state}</span>
    </button>
  );
}

function ProviderDialog({ definitions, providers, favoriteModels, onToggleFavorite, onClose, onChanged }: {
  definitions: ProviderDefinition[];
  providers: ProviderSummary[];
  favoriteModels: Set<string>;
  onToggleFavorite: (providerId: string, modelId: string) => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [kind, setKind] = useState(definitions[0]?.kind ?? "openai");
  const [values, setValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState(definitions[0]?.label ?? "OpenAI");
  const [models, setModels] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyProvider, setBusyProvider] = useState("");
  const [expandedProvider, setExpandedProvider] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const definition = definitions.find((item) => item.kind === kind);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.saveProvider({
        kind,
        label,
        enabled: true,
        config: values,
        models: models.split(/[\n,]/).map((model) => model.trim()).filter(Boolean),
      });
      await onChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="provider-title">
        <header className="dialog-header">
          <div><span className="eyebrow">MODEL ROUTING</span><h2 id="provider-title">Providers</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        {providers.length > 0 && <section className="provider-list">
          {providers.map((provider) => <div className="provider-block" key={provider.id}>
            <article>
            <div><strong>{provider.label}</strong><span>{provider.models.length} compatible · {provider.models.filter((model) => favoriteModels.has(`${provider.id}::${model.id}`)).length} favorites</span></div>
            <button type="button" onClick={() => { setExpandedProvider((current) => current === provider.id ? "" : provider.id); setModelQuery(""); }}><Star size={13} /> Favorites</button>
            <button type="button" disabled={busyProvider === provider.id} onClick={async () => {
              setBusyProvider(provider.id); setError("");
              try { await api.discoverModels(provider.id); await onChanged(); }
              catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
              finally { setBusyProvider(""); }
            }}><RefreshCw size={13} /> Refresh</button>
            <button type="button" className="provider-delete" disabled={busyProvider === provider.id} onClick={async () => {
              if (!window.confirm(`Delete ${provider.label}? The stored credentials will be removed.`)) return;
              setBusyProvider(provider.id); setError("");
              try { await api.deleteProvider(provider.id); await onChanged(); }
              catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
              finally { setBusyProvider(""); }
            }}>Delete</button>
            </article>
            {expandedProvider === provider.id && <div className="model-favorites">
              <label className="search-box"><Search size={14} /><input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="Search models…" autoFocus /></label>
              <div className="model-favorites-list">
                {provider.models.filter((model) => `${model.label} ${model.id}`.toLowerCase().includes(modelQuery.toLowerCase())).slice(0, 100).map((model) => {
                  const favorite = favoriteModels.has(`${provider.id}::${model.id}`);
                  return <button type="button" key={model.id} className={favorite ? "model-favorite model-favorite--active" : "model-favorite"} onClick={() => onToggleFavorite(provider.id, model.id)} aria-pressed={favorite}>
                    <Star size={14} fill={favorite ? "currentColor" : "none"} />
                    <span><strong>{model.label}</strong><small>{model.id}</small></span>
                    <em>{model.capabilities.includes("vision") ? "vision" : "text"}</em>
                  </button>;
                })}
              </div>
            </div>}
          </div>)}
        </section>}
        <form onSubmit={submit}>
          <div className="form-section-title">Add provider</div>
          <label className="field">
            <span>Provider</span>
            <select value={kind} onChange={(event) => {
              const next = event.target.value as ProviderSummary["kind"];
              setKind(next);
              setLabel(definitions.find((item) => item.kind === next)?.label ?? next);
              setValues({});
            }}>
              {definitions.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}
            </select>
          </label>
          <label className="field"><span>Connection name</span><input value={label} onChange={(event) => setLabel(event.target.value)} required /></label>
          <div className="field-grid">
            {definition?.fields.map((field) => (
              <label className="field" key={field.key}>
                <span>{field.label}</span>
                <input
                  type={field.secret ? "password" : "text"}
                  value={values[field.key] ?? ""}
                  placeholder={field.placeholder}
                  required={field.required}
                  autoComplete={field.secret ? "new-password" : "off"}
                  onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                />
              </label>
            ))}
          </div>
          <label className="field"><span>Model IDs <small>optional overrides; models.dev discovery runs automatically</small></span><textarea rows={3} value={models} onChange={(event) => setModels(event.target.value)} /></label>
          {error && <p className="form-error"><CircleAlert size={16} />{error}</p>}
          <footer className="dialog-actions"><button className="button button--quiet" type="button" onClick={onClose}>Close</button><button className="button button--primary" disabled={saving}>{saving ? "Saving…" : "Save provider"}</button></footer>
        </form>
      </section>
    </div>
  );
}

export function App() {
  const [tabs, setTabs] = useState<SessionTab[]>(() => readSessionTabs());
  const [activeTabId, setActiveTabId] = useState(() => localStorage.getItem(ACTIVE_TAB_KEY) ?? "");
  const [health, setHealth] = useState<Health | null>(null);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [definitions, setDefinitions] = useState<ProviderDefinition[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [entityTotal, setEntityTotal] = useState(0);
  const [entityQuery, setEntityQuery] = useState("");
  const deferredEntityQuery = useDeferredValue(entityQuery);
  const [providerOpen, setProviderOpen] = useState(false);
  const [threadHistoryOpen, setThreadHistoryOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [threadHistory, setThreadHistory] = useState<ThreadSummary[]>([]);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [contextOpen, setContextOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [error, setError] = useState("");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [dashboardPath, setDashboardPath] = useState("/lovelace/0");
  const [dashboardReview, setDashboardReview] = useState<DashboardReview | null>(null);
  const [reviewingDashboard, setReviewingDashboard] = useState(false);
  const [reviewedProposals, setReviewedProposals] = useState<Set<string>>(() => new Set());
  const [currentConfigs, setCurrentConfigs] = useState<Record<string, Record<string, unknown> | null>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [entityFilter, setEntityFilter] = useState<"all" | "available" | "unavailable">("all");

  function showToast(message: string, type: Toast["type"] = "info", duration = 4000) {
    const id = createId();
    setToasts((current) => [...current, { id, message, type }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), duration);
  }
  const entitySearchRef = useRef<HTMLInputElement>(null);
  const requestAbortRef = useRef<AbortController | null>(null);
  const [favoriteModels, setFavoriteModels] = useState<Set<string>>(() => readStringSet(FAVORITES_KEY));
  const [lastModels, setLastModels] = useState<LastModels>(() => readLastModels());
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? newSessionTab();
  const mode = activeTab.mode;
  const prompt = activeTab.prompt;
  const transcript = activeTab.transcript;
  const selectedEntities = new Set(activeTab.entityIds);

  function updateActiveTab(update: (tab: SessionTab) => SessionTab) {
    const id = activeTab.id;
    setTabs((current) => current.map((tab) => tab.id === id ? update(tab) : tab));
  }

  function setMode(value: Mode) { updateActiveTab((tab) => ({ ...tab, mode: value })); }
  function setPrompt(value: string) { updateActiveTab((tab) => ({ ...tab, prompt: value })); }
  function setTranscript(value: TranscriptItem[] | ((current: TranscriptItem[]) => TranscriptItem[])) {
    updateActiveTab((tab) => ({ ...tab, transcript: typeof value === "function" ? value(tab.transcript) : value }));
  }
  function setSelectedEntities(value: Set<string> | ((current: Set<string>) => Set<string>)) {
    updateActiveTab((tab) => {
      const next = typeof value === "function" ? value(new Set(tab.entityIds)) : value;
      return { ...tab, entityIds: [...next] };
    });
  }

  function createTab() {
    const tab = newSessionTab();
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  }

  function closeTab(id: string) {
    const closing = tabs.find((tab) => tab.id === id);
    if (closing) void api.saveThread(id, closing).then(() => api.archiveThread(id)).then(() => api.threads()).then(setThreadHistory).catch(() => undefined);
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      const remaining = current.filter((tab) => tab.id !== id);
      if (remaining.length === 0) {
        const replacement = newSessionTab();
        setActiveTabId(replacement.id);
        return [replacement];
      }
      if (id === activeTabId) setActiveTabId(remaining[Math.max(0, index - 1)]?.id ?? remaining[0]!.id);
      return remaining;
    });
  }

  async function reloadMemories() { setMemories(await api.memories()); }

  async function openStoredThread(id: string) {
    const existing = tabs.find((tab) => tab.id === id);
    if (existing) { setActiveTabId(id); setThreadHistoryOpen(false); return; }
    const stored = await api.thread(id);
    const state = stored.state as SessionTab;
    setTabs((current) => [...current, state]);
    setActiveTabId(id);
    setThreadHistoryOpen(false);
  }

  async function loadProviders() {
    try {
      const items = await api.providers();
      setProviders(items);
      const hasFavorite = (provider: ProviderSummary) => provider.models.some((model) => favoriteModels.has(`${provider.id}::${model.id}`));
      const preferredProviderId = selectedProvider || lastModels.providerId;
      const first = items.find((provider) => provider.enabled && hasFavorite(provider));
      const current = items.find((provider) => provider.id === preferredProviderId && provider.enabled && hasFavorite(provider));
      if (!current) {
        setSelectedProvider(first?.id ?? "");
        setSelectedModel(first?.models.find((model) => favoriteModels.has(`${first.id}::${model.id}`))?.id ?? "");
      } else {
        const savedModel = lastModels.byProvider[current.id];
        const nextModel = current.models.find((model) => model.id === (selectedModel || savedModel) && favoriteModels.has(`${current.id}::${model.id}`))
          ?? current.models.find((model) => favoriteModels.has(`${current.id}::${model.id}`));
        setSelectedProvider(current.id);
        setSelectedModel(nextModel?.id ?? "");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  useEffect(() => {
    Promise.all([api.health(), api.providerDefinitions(), api.providers(), api.proposals()]).then(([nextHealth, nextDefinitions, nextProviders, nextProposals]) => {
      setHealth(nextHealth);
      setDefinitions(nextDefinitions);
      setProviders(nextProviders);
      setProposals(nextProposals);
      let availableFavorites = favoriteModels;
      const hasValidFavorite = nextProviders.some((provider) => provider.models.some((model) => availableFavorites.has(`${provider.id}::${model.id}`)));
      if (!hasValidFavorite) {
        const provider = nextProviders.find((item) => item.enabled && item.models.length > 0);
        const model = provider?.models.find((item) => item.id === lastModels.byProvider[provider.id])
          ?? provider?.models.find((item) => item.id === "google/gemini-2.5-flash-lite")
          ?? provider?.models.find((item) => item.id === "openai/gpt-4.1-mini")
          ?? provider?.models[0];
        if (provider && model) {
          availableFavorites = new Set([...availableFavorites, `${provider.id}::${model.id}`]);
          setFavoriteModels(availableFavorites);
          setLastModels({ providerId: provider.id, byProvider: { ...lastModels.byProvider, [provider.id]: model.id } });
        }
      }
      const preferred = nextProviders.find((provider) => provider.id === lastModels.providerId && provider.enabled && provider.models.some((model) => availableFavorites.has(`${provider.id}::${model.id}`)))
        ?? nextProviders.find((provider) => provider.enabled && provider.models.some((model) => availableFavorites.has(`${provider.id}::${model.id}`)));
      if (preferred) {
        const savedModel = lastModels.byProvider[preferred.id];
        const model = preferred.models.find((item) => item.id === savedModel && availableFavorites.has(`${preferred.id}::${item.id}`))
          ?? preferred.models.find((item) => availableFavorites.has(`${preferred.id}::${item.id}`));
        setSelectedProvider(preferred.id); setSelectedModel(model?.id ?? "");
      }
    }).catch((cause) => setError(cause.message));
  }, []);

  useEffect(() => { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favoriteModels])); }, [favoriteModels]);
  useEffect(() => { localStorage.setItem(LAST_MODELS_KEY, JSON.stringify(lastModels)); }, [lastModels]);
  useEffect(() => { localStorage.setItem(SESSION_TABS_KEY, JSON.stringify(tabs)); }, [tabs]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      Promise.all(tabs.map((tab) => api.saveThread(tab.id, tab))).then(() => api.threads()).then(setThreadHistory).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [tabs]);
  useEffect(() => {
    Promise.all([api.threads(), api.memories()]).then(([nextThreads, nextMemories]) => { setThreadHistory(nextThreads); setMemories(nextMemories); }).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (tabs.some((tab) => tab.id === activeTabId)) return;
    if (tabs[0]) setActiveTabId(tabs[0].id);
  }, [tabs, activeTabId]);
  useEffect(() => { if (activeTabId) localStorage.setItem(ACTIVE_TAB_KEY, activeTabId); }, [activeTabId]);
  useEffect(() => {
    if (!selectedProvider || !selectedModel) return;
    setLastModels((current) => current.providerId === selectedProvider && current.byProvider[selectedProvider] === selectedModel
      ? current
      : { providerId: selectedProvider, byProvider: { ...current.byProvider, [selectedProvider]: selectedModel } });
  }, [selectedProvider, selectedModel]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api.entities(deferredEntityQuery).then((result) => startTransition(() => {
        setEntities(result.entities);
        setEntityTotal(result.total);
      })).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [deferredEntityQuery]);

  async function refreshEntities() {
    setError("");
    try {
      await api.refreshEntities();
      const [nextHealth, result] = await Promise.all([api.health(), api.entities(entityQuery)]);
      setHealth(nextHealth);
      setEntities(result.entities);
      setEntityTotal(result.total);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function submitPrompt(text = prompt) {
    const clean = text.trim();
    if (!clean || running) return;
    if (!selectedProvider || !selectedModel) { setError("Choose a favorite model before sending."); setProviderOpen(true); return; }
    if (activeTab.title === "New session") {
      const title = clean.length > 42 ? `${clean.slice(0, 39)}…` : clean;
      updateActiveTab((tab) => ({ ...tab, title }));
    }
    const userItem: TranscriptItem = { id: createId(), role: "user", text: clean };
    const history = transcript.slice(activeTab.compactedThrough ?? 0).reduce<Array<{ role: "user" | "assistant"; content: string }>>((result, item) => {
      if ((item.role !== "user" && item.role !== "assistant") || item.status === "running" || !item.text) return result;
      const previous = result.at(-1);
      if (item.role === "assistant" && previous?.role === "assistant") previous.content += `\n\n${item.text}`;
      else result.push({ role: item.role, content: item.text });
      return result;
    }, []);
    if (history.length > 100) { setError("This thread has too many uncompacted turns. Use Compact before sending another message."); return; }
    setTranscript((items) => [...items, userItem]);
    setPrompt("");
    setRunning(true);
    setError("");
    const abortController = new AbortController();
    requestAbortRef.current = abortController;
    try {
      const response = await fetch(api.chatUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: selectedProvider, modelId: selectedModel, mode, prompt: clean, history, contextSummary: activeTab.contextSummary ?? "", contextEntityIds: [...selectedEntities] }),
        signal: abortController.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Agent request failed with ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          if (!event.startsWith("data: ")) continue;
          const data = JSON.parse(event.slice(6)) as { type: string; id?: string; delta?: string; detail?: string; message?: string; tool?: string; state?: string; callId?: string };
          if (data.type === "text-start" && data.id) setTranscript((items) => items.some((item) => item.id === data.id) ? items : [...items, { id: data.id!, role: "assistant", text: "", status: "running" }]);
          if (data.type === "text" && data.id && data.delta) setTranscript((items) => {
            const existing = items.some((item) => item.id === data.id);
            return existing ? items.map((item) => item.id === data.id ? { ...item, text: item.text + data.delta } : item) : [...items, { id: data.id!, role: "assistant", text: data.delta!, status: "running" }];
          });
          if (data.type === "text-end" && data.id) setTranscript((items) => items.map((item) => item.id === data.id ? { ...item, status: "complete" } : item));
          if (data.type === "reasoning-start" && data.id) setTranscript((items) => items.some((item) => item.id === data.id) ? items : [...items, { id: data.id!, role: "reasoning", text: "", status: "running" }]);
          if (data.type === "reasoning" && data.id && data.delta) setTranscript((items) => {
            const existing = items.some((item) => item.id === data.id);
            return existing ? items.map((item) => item.id === data.id ? { ...item, text: item.text + data.delta } : item) : [...items, { id: data.id!, role: "reasoning", text: data.delta!, status: "running" }];
          });
          if (data.type === "reasoning-end" && data.id) setTranscript((items) => items.map((item) => item.id === data.id ? { ...item, status: "complete" } : item));
          if (data.type === "tool" && data.callId) setTranscript((items) => {
            const id = `tool-${data.callId}`;
            const existing = items.some((item) => item.id === id);
            const activity: TranscriptItem = { id, role: "activity", text: data.tool?.replaceAll("_", " ") ?? "tool", ...(data.detail ? { detail: data.detail } : {}), status: data.state === "error" ? "error" : data.state === "complete" ? "complete" : "running" };
            return existing ? items.map((item) => {
              if (item.id !== id) return item;
              const nextDetail = data.detail ?? item.detail;
              return { ...activity, ...(nextDetail ? { detail: nextDetail } : {}) };
            }) : [...items, activity];
          });
          if (data.type === "error") throw new Error(data.message ?? "Provider failed");
          if (data.type === "abort") throw new DOMException("Stopped", "AbortError");
        }
      }
      setTranscript((items) => items.map((item) => item.status === "running" ? { ...item, status: "complete" } : item));
      setProposals(await api.proposals());
    } catch (cause) {
      const stopped = cause instanceof DOMException && cause.name === "AbortError";
      const message = stopped ? "Stopped by you." : cause instanceof Error ? cause.message : String(cause);
      setTranscript((items) => [...items.map((item) => item.status === "running" ? { ...item, status: stopped ? "complete" as const : "error" as const } : item), { id: createId(), role: "assistant", text: message, status: stopped ? "complete" : "error" }]);
    } finally { requestAbortRef.current = null; setRunning(false); }
  }

  const activeProvider = providers.find((provider) => provider.id === selectedProvider);
  const favoriteProviders = providers.filter((provider) => provider.enabled && provider.models.some((model) => favoriteModels.has(`${provider.id}::${model.id}`)));
  const activeFavoriteModels = activeProvider?.models.filter((model) => favoriteModels.has(`${activeProvider.id}::${model.id}`)) ?? [];
  const visibleEntities = entities.filter((entity) => entityFilter === "all" || (entityFilter === "available" ? !entity.unavailable : entity.unavailable));
  const uncompactedMessages = transcript.slice(activeTab.compactedThrough ?? 0).filter((item) => (item.role === "user" || item.role === "assistant") && item.text);
  const estimatedContextTokens = Math.ceil(((activeTab.contextSummary?.length ?? 0) + uncompactedMessages.reduce((total, item) => total + item.text.length, 0) + prompt.length) / 4);
  const draftProposals = proposals.filter((proposal) => proposal.status === "draft");

  async function compactThread() {
    if (!selectedProvider || !selectedModel) { setError("Choose a model before compacting."); return; }
    const messages = uncompactedMessages.reduce<Array<{ role: "user" | "assistant"; content: string }>>((result, item) => {
      const role = item.role as "user" | "assistant";
      const previous = result.at(-1);
      if (role === "assistant" && previous?.role === "assistant") previous.content += `\n\n${item.text}`;
      else result.push({ role, content: item.text });
      return result;
    }, []);
    if (messages.length === 0) { setError("There is no new conversation to compact."); return; }
    setCompacting(true); setError("");
    try {
      const result = await api.compactThread(activeTab.id, { providerId: selectedProvider, modelId: selectedModel, existingSummary: activeTab.contextSummary ?? "", messages });
      updateActiveTab((tab) => ({ ...tab, contextSummary: result.summary, compactedThrough: tab.transcript.length }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCompacting(false); }
  }

  function toggleFavorite(providerId: string, modelId: string) {
    const key = `${providerId}::${modelId}`;
    const removing = favoriteModels.has(key);
    const next = new Set(favoriteModels);
    if (removing) next.delete(key); else next.add(key);
    setFavoriteModels(next);
    if (!removing) {
      if (!selectedProvider || selectedProvider === providerId && !selectedModel) {
        setSelectedProvider(providerId);
        setSelectedModel(modelId);
      }
      return;
    }
    if (selectedProvider === providerId && selectedModel === modelId) {
      const provider = providers.find((item) => item.id === providerId);
      const replacement = provider?.models.find((model) => next.has(`${providerId}::${model.id}`));
      if (replacement) setSelectedModel(replacement.id);
      else {
        const nextProvider = providers.find((item) => item.models.some((model) => next.has(`${item.id}::${model.id}`)));
        const nextModel = nextProvider?.models.find((model) => next.has(`${nextProvider.id}::${model.id}`));
        setSelectedProvider(nextProvider?.id ?? "");
        setSelectedModel(nextModel?.id ?? "");
      }
    }
  }

  async function inspectDashboard() {
    if (!selectedProvider || !selectedModel) { setProviderOpen(true); return; }
    const model = activeProvider?.models.find((item) => item.id === selectedModel);
    if (!model?.capabilities.includes("vision")) { setError("Select a model marked as vision-capable before inspecting a dashboard."); return; }
    setReviewingDashboard(true);
    setError("");
    setDashboardReview(null);
    setInspectorOpen(true);
    try {
      setDashboardReview(await api.reviewDashboard({ providerId: selectedProvider, modelId: selectedModel, dashboardPath }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setReviewingDashboard(false); }
  }

  const commandItems = useCallback((): CommandPaletteItem[] => [
    { id: "new-session", label: "New session", description: "Start a fresh conversation", icon: <Plus size={15} />, shortcut: "⌘N", action: createTab },
    { id: "toggle-context", label: "Toggle Home Assistant context", description: "Show or hide the entity panel", icon: <HousePlug size={15} />, shortcut: "⌘E", action: () => setContextOpen((v) => !v) },
    { id: "toggle-evidence", label: "Toggle evidence panel", description: "Show or hide the run ledger", icon: <SlidersHorizontal size={15} />, shortcut: "⌘J", action: () => setInspectorOpen((v) => !v) },
    { id: "manage-providers", label: "Manage providers", description: "Configure AI models and favorites", icon: <Settings2 size={15} />, shortcut: "⌘P", action: () => setProviderOpen(true) },
    { id: "refresh-entities", label: "Refresh entity inventory", description: "Reload entities from Home Assistant", icon: <RefreshCw size={15} />, shortcut: "⌘R", action: refreshEntities },
    { id: "compact-thread", label: "Compact thread", description: "Summarize conversation to save tokens", icon: <Sparkles size={15} />, shortcut: "⌘L", action: compactThread, disabled: uncompactedMessages.length === 0 },
    { id: "review-dashboard", label: "Review dashboard", description: "Render and analyze a Lovelace dashboard", icon: <Eye size={15} />, shortcut: "⌘D", action: inspectDashboard },
    { id: "thread-history", label: "Open thread history", description: "Browse and restore saved threads", icon: <Archive size={15} />, shortcut: "⌘H", action: () => { setThreadHistoryOpen(true); void api.threads().then(setThreadHistory); } },
    { id: "memory", label: "Open memory", description: "Manage persistent context memories", icon: <Brain size={15} />, shortcut: "⌘M", action: () => { setMemoryOpen(true); void reloadMemories(); } },
    { id: "switch-mode", label: `Switch to ${mode === "plan" ? "Build" : "Plan"} mode`, description: mode === "plan" ? "Enable drafting tools" : "Disable drafting, read-only", icon: <Workflow size={15} />, shortcut: "⌘B", action: () => setMode(mode === "plan" ? "build" : "plan") },
    { id: "stop-generation", label: "Stop generation", description: "Abort the current model response", icon: <Square size={15} />, shortcut: "Esc", action: () => requestAbortRef.current?.abort(), disabled: !running },
  ], [mode, running, uncompactedMessages.length, activeTab.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setCommandOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <button className="brand-mark" type="button" onClick={() => setContextOpen(true)} aria-label="Open Home Assistant context"><HousePlug size={15} /></button>
        </div>
        <div className="titlebar-tabs" role="tablist" aria-label="Sessions">
          {tabs.map((tab) => <div className="titlebar-tab-slot" key={tab.id}>
            <div className={tab.id === activeTab.id ? "titlebar-tab titlebar-tab--active" : "titlebar-tab"} role="tab" tabIndex={0} aria-selected={tab.id === activeTab.id} onClick={() => setActiveTabId(tab.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setActiveTabId(tab.id); }}>
              <Workflow size={14} /><span>{tab.title}</span>
            </div>
            <button className="titlebar-close" type="button" onClick={() => closeTab(tab.id)} aria-label={`Close ${tab.title}`}><X size={13} /></button>
          </div>)}
          <button className="titlebar-new" type="button" onClick={createTab} aria-label="New session"><Plus size={15} /></button>
        </div>
        <div className="system-readout">
          <span><StatusDot state={health?.homeAssistant ?? "unconfigured"} />{health?.homeAssistant ?? "checking"}</span>
          <button className="titlebar-action" type="button" onClick={() => { setThreadHistoryOpen(true); void api.threads().then(setThreadHistory); }} aria-label="Open thread history"><Archive size={15} /></button>
          <button className="titlebar-action" type="button" onClick={() => { setMemoryOpen(true); void reloadMemories(); }} aria-label="Open memory"><Brain size={15} /></button>
          <button className="titlebar-action" type="button" onClick={() => setInspectorOpen(true)} aria-label="Open review panel"><SlidersHorizontal size={15} /></button>
          <button className="titlebar-action" type="button" onClick={() => setProviderOpen(true)} aria-label="Manage models"><Settings2 size={15} /></button>
        </div>
      </header>

      <aside className={`context-panel ${contextOpen ? "context-panel--open" : ""}`}>
        <div className="panel-heading">
          <div><span className="eyebrow">HOME ASSISTANT</span><h2>Context</h2></div>
          <button className="icon-button" type="button" onClick={() => setContextOpen(false)} aria-label="Close context"><X size={18} /></button>
        </div>
        <div className="context-summary">
          <span><HousePlug size={16} />{entityTotal} entities</span>
          <button type="button" onClick={refreshEntities} aria-label="Refresh entity inventory"><RefreshCw size={15} /></button>
        </div>
        <label className="search-box"><Search size={15} /><input ref={entitySearchRef} value={entityQuery} onChange={(event) => setEntityQuery(event.target.value)} placeholder="Name, entity, area…" /></label>
        <div className="filter-strip">
          {(["all", "available", "unavailable"] as const).map((filter) => <button key={filter} type="button" className={entityFilter === filter ? "filter-chip filter-chip--active" : "filter-chip"} onClick={() => setEntityFilter(filter)}>{filter}</button>)}
        </div>
        <div className="entity-list" aria-live="polite">
          {visibleEntities.map((entity) => <EntityRow key={entity.entityId} entity={entity} selected={selectedEntities.has(entity.entityId)} onToggle={() => setSelectedEntities((current) => {
            const next = new Set(current);
            if (next.has(entity.entityId)) next.delete(entity.entityId); else next.add(entity.entityId);
            return next;
          })} />)}
          {visibleEntities.length === 0 && <div className="empty-compact"><Network size={20} /><span>{health?.homeAssistant === "unconfigured" ? "Entity index connects when installed as an add-on." : "No entities match this scope."}</span></div>}
        </div>
      </aside>

      <main key={activeTab.id} className={`workbench ${transcript.length === 0 ? "workbench--empty" : ""}`}>
        <section className="conversation" aria-live="polite">
          {transcript.length === 0 ? (
            <div className="welcome-state">
              <div className="wordmark" data-word="stratum"><span>stratum</span></div>
              <div className="studio-tag">By Synork</div>
            </div>
          ) : <div data-slot="session-turn-list">{transcript.map((item) => item.role === "reasoning" ? <ReasoningPart key={item.id} item={item} /> : item.role === "activity" ? <ToolActivity key={item.id} item={item} /> : item.role === "user" ? <UserMessage key={item.id} item={item} /> : <AssistantMessage key={item.id} item={item} />)}</div>}
          {error && <div className="error-banner"><CircleAlert size={17} />{error}</div>}
        </section>

        <footer className="composer-wrap">
          {draftProposals.length > 0 && <div className="draft-bar">
            <span className="draft-bar-title"><Boxes size={15} />Pending draft{`s`}</span>
            {draftProposals.map((proposal) => {
              const reviewed = reviewedProposals.has(proposal.id);
              return (
                <div className="draft-card" key={proposal.id}>
                  <div className="draft-card-copy">
                    <strong>{proposal.title}</strong>
                    <span>{proposal.type} · {proposal.resourceId}</span>
                    {!proposal.validation.valid && <em className="draft-card-warning">{proposal.validation.errors.join(" · ")}</em>}
                  </div>
                  <details className="draft-card-config" onToggle={async (event) => {
                    if (event.currentTarget.open) {
                      setReviewedProposals((current) => new Set(current).add(proposal.id));
                      if (!(proposal.id in currentConfigs)) {
                        try { const current = await api.getResourceCurrent(proposal.type, proposal.resourceId); setCurrentConfigs((prev) => ({ ...prev, [proposal.id]: current })); }
                        catch { setCurrentConfigs((prev) => ({ ...prev, [proposal.id]: null })); }
                      }
                    }
                  }}>
                    <summary>{reviewed && proposal.validation.valid ? <Check size={12} /> : <Search size={12} />} Review exact {proposal.type} configuration{reviewed ? " · reviewed" : ""}</summary>
                    <div className="proposal-config-content">
                      <pre>{JSON.stringify(proposal.payload, null, 2)}</pre>
                      <DiffView oldConfig={currentConfigs[proposal.id] ?? null} newConfig={proposal.payload} />
                    </div>
                  </details>
                  <div className="draft-card-actions">
                    <button type="button" onClick={async () => {
                      try { await api.rejectProposal(proposal.id); setProposals(await api.proposals()); showToast(`Rejected "${proposal.title}"`, "warning"); }
                      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
                    }}>Reject</button>
                    {proposal.type === "dashboard" && <button type="button" disabled={!proposal.validation.valid || reviewingDashboard} onClick={async () => {
                      if (!selectedProvider || !selectedModel) { setProviderOpen(true); return; }
                      const model = activeProvider?.models.find((item) => item.id === selectedModel);
                      if (!model?.capabilities.includes("vision")) { setError("Select a vision-capable model for dashboard preview."); return; }
                      setReviewingDashboard(true); setDashboardReview(null);
                      try { setDashboardReview(await api.previewProposal(proposal.id, { providerId: selectedProvider, modelId: selectedModel })); }
                      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
                      finally { setReviewingDashboard(false); }
                    }}><Eye size={13} /> Preview</button>}
                    <button type="button" className="draft-card-approve" disabled={!proposal.validation.valid || !reviewed} title={!reviewed ? "Open Review exact configuration below to confirm it" : "Publish this draft to Home Assistant"} onClick={async () => {
                      try { await api.approveProposal(proposal.id); const next = await api.proposals(); setProposals(next); showToast(`Published "${proposal.title}" to Home Assistant`, "success"); }
                      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
                    }}>Approve &amp; deploy</button>
                  </div>
                </div>
              );
            })}
          </div>}
          <form className="composer" data-component="prompt-input-v2" onSubmit={(event) => { event.preventDefault(); submitPrompt(); }}>
            {selectedEntities.size > 0 && <div className="context-chips">{[...selectedEntities].map((entityId) => <button type="button" key={entityId} onClick={() => setSelectedEntities((current) => { const next = new Set(current); next.delete(entityId); return next; })}>{entityId}<X size={11} /></button>)}</div>}
            <textarea data-component="prompt-input" value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitPrompt(); }
            }} placeholder={mode === "build" ? "What should Stratum build as a local draft?" : "What should Stratum investigate or plan?"} rows={2} />
            <div className="composer-actions" data-slot="prompt-input-controls">
              <div className="composer-controls" data-slot="prompt-input-controls-left">
                <button className="tool-button tool-button--icon" type="button" onClick={() => { setContextOpen(true); window.setTimeout(() => entitySearchRef.current?.focus(), 50); }} aria-label="Add Home Assistant context"><Plus size={17} /></button>
                <select value={mode} onChange={(event) => setMode(event.target.value as Mode)} aria-label="Agent mode"><option value="plan">Plan</option><option value="build">Build</option></select>
                {favoriteProviders.length === 0 ? <button className="tool-button" type="button" onClick={() => setProviderOpen(true)}><Star size={13} /> Choose model</button> : <>
                  <select value={selectedProvider} onChange={(event) => {
                    const providerId = event.target.value;
                    const provider = providers.find((item) => item.id === providerId);
                    const savedModel = lastModels.byProvider[providerId];
                    const model = provider?.models.find((item) => item.id === savedModel && favoriteModels.has(`${providerId}::${item.id}`)) ?? provider?.models.find((item) => favoriteModels.has(`${providerId}::${item.id}`));
                    setSelectedProvider(providerId); setSelectedModel(model?.id ?? ""); setLastModels((current) => ({ ...current, providerId }));
                  }} aria-label="Provider">{favoriteProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select>
                  <select value={selectedModel} onChange={(event) => { const modelId = event.target.value; setSelectedModel(modelId); }} aria-label="Favorite model">{activeFavoriteModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select>
                </>}
                <button className="tool-button context-compact" type="button" onClick={() => { void compactThread(); }} disabled={compacting || uncompactedMessages.length === 0} title={`Estimated active context: ${estimatedContextTokens.toLocaleString()} tokens`}><Sparkles size={13} />{compacting ? "Compacting" : "Compact"}<span>{estimatedContextTokens < 1_000 ? estimatedContextTokens : `${(estimatedContextTokens / 1_000).toFixed(1)}k`}</span></button>
                <button className="tool-button" type="button" onClick={() => setInspectorOpen(true)}><SlidersHorizontal size={13} /> Review</button>
              </div>
              {running ? <button className="stop-button" data-slot="prompt-input-submit" type="button" onClick={() => requestAbortRef.current?.abort()}><Square size={14} fill="currentColor" /> Stop</button> : <button className="send-button" data-slot="prompt-input-submit" type="submit" disabled={!prompt.trim()} aria-label="Send"><ArrowUp size={18} /></button>}
            </div>
          </form>
        </footer>
      </main>

      <aside className={`evidence-panel ${inspectorOpen ? "evidence-panel--open" : ""}`}>
        <div className="panel-heading"><div><span className="eyebrow">EVIDENCE</span><h2>Run ledger</h2></div><button className="icon-button" type="button" onClick={() => setInspectorOpen(false)} aria-label="Close evidence"><X size={18} /></button></div>
        <div className={entityTotal ? "ledger-state" : "ledger-state ledger-state--muted"}><span className="ledger-index">01</span><div><strong>Home Assistant context</strong><small>{entityTotal ? `${entityTotal} entities indexed` : "Inventory unavailable"}</small></div>{entityTotal ? <Check size={16} /> : <CircleAlert size={16} />}</div>
        <div className="ledger-state"><span className="ledger-index">02</span><div><strong>{mode} mode</strong><small>{mode === "build" ? "Read tools and local drafting enabled" : "Read-only agent tools enabled"}</small></div><Activity size={16} /></div>
        <div className="ledger-state"><span className="ledger-index">03</span><div><strong>Thread context</strong><small>{activeTab.contextSummary ? `Compacted summary + ${estimatedContextTokens.toLocaleString()} estimated active tokens` : `${estimatedContextTokens.toLocaleString()} estimated tokens · not compacted`}</small></div><Sparkles size={16} /></div>
        <section className="evidence-visual-action">
          <label><span>Rendered dashboard review</span><input value={dashboardPath} onChange={(event) => setDashboardPath(event.target.value)} placeholder="/lovelace/0" /></label>
          <button type="button" onClick={inspectDashboard} disabled={reviewingDashboard}><Eye size={14} />{reviewingDashboard ? "Rendering…" : "Review at 3 widths"}</button>
        </section>
        {dashboardReview && <section className="visual-result">
          <div className="visual-strip">{dashboardReview.renders.map((render) => <figure key={render.name}><img src={api.screenshotUrl(render.filename)} alt={`${render.name} dashboard render`} /><figcaption>{render.name} · {render.width}px</figcaption></figure>)}</div>
          <h3>Visual finding</h3><p>{dashboardReview.review}</p>
        </section>}
        {proposals.length === 0 ? <div className="evidence-empty"><Gauge size={23} /><h3>No draft yet</h3><p>Generated automation or dashboard configurations and visual-review results appear here.</p></div> : proposals.map((proposal) => (
          <article className="proposal-card" key={proposal.id}>
            <header><span>{proposal.type}</span><strong>{proposal.status}</strong></header>
            <h3>{proposal.title}</h3>
            <p>{proposal.explanation}</p>
            <div className={proposal.validation.valid ? "validation validation--good" : "validation validation--bad"}>{proposal.validation.valid ? "Basic reference checks passed" : proposal.validation.errors.join(" · ")}</div>
            {proposal.validation.warnings.length > 0 && <div className="proposal-warnings">{proposal.validation.warnings.join(" · ")}</div>}
            <details className="proposal-config" onToggle={async (event) => {
              if (event.currentTarget.open) {
                setReviewedProposals((current) => new Set(current).add(proposal.id));
                if (!(proposal.id in currentConfigs)) {
                  try {
                    const current = await api.getResourceCurrent(proposal.type, proposal.resourceId);
                    setCurrentConfigs((prev) => ({ ...prev, [proposal.id]: current }));
                  } catch {
                    setCurrentConfigs((prev) => ({ ...prev, [proposal.id]: null }));
                  }
                }
              }
            }}>
              <summary>Review exact {proposal.type} configuration</summary>
              <div className="proposal-config-tabs">
                <button type="button" className="config-tab config-tab--active">Proposed</button>
                <button type="button" className="config-tab">Diff</button>
              </div>
              <div className="proposal-config-content">
                <pre>{JSON.stringify(proposal.payload, null, 2)}</pre>
                <DiffView oldConfig={currentConfigs[proposal.id] ?? null} newConfig={proposal.payload} />
              </div>
            </details>
            {proposal.status === "draft" && <div className="proposal-actions">
              <button type="button" onClick={async () => { try { await api.rejectProposal(proposal.id); setProposals(await api.proposals()); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>Reject</button>
              {proposal.type === "dashboard" && <button type="button" disabled={!proposal.validation.valid || reviewingDashboard} onClick={async () => { if (!selectedProvider || !selectedModel) { setProviderOpen(true); return; } const model = activeProvider?.models.find((item) => item.id === selectedModel); if (!model?.capabilities.includes("vision")) { setError("Select a vision-capable model for dashboard preview."); return; } setReviewingDashboard(true); setDashboardReview(null); try { setDashboardReview(await api.previewProposal(proposal.id, { providerId: selectedProvider, modelId: selectedModel })); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setReviewingDashboard(false); } }}><Eye size={13} /> Stage visual preview</button>}
              <button type="button" className="proposal-approve" disabled={!proposal.validation.valid || !reviewedProposals.has(proposal.id)} onClick={async () => { try { await api.approveProposal(proposal.id); setProposals(await api.proposals()); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>Publish reviewed change</button>
            </div>}
            {(proposal.status === "rejected" || proposal.status === "failed") && <div className="proposal-actions"><button type="button" onClick={async () => { try { await api.deleteProposal(proposal.id); setProposals(await api.proposals()); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>Remove record</button></div>}
          </article>
        ))}
        <div className="permission-note"><Boxes size={17} /><div><strong>Agent permission</strong><span>Read and create local drafts; publishing requires review</span></div></div>
      </aside>

      {providerOpen && <ProviderDialog definitions={definitions} providers={providers} favoriteModels={favoriteModels} onToggleFavorite={toggleFavorite} onClose={() => setProviderOpen(false)} onChanged={loadProviders} />}
      {threadHistoryOpen && <ThreadHistoryDialog threads={threadHistory} openIds={new Set(tabs.map((tab) => tab.id))} onOpen={(id) => { void openStoredThread(id); }} onClose={() => setThreadHistoryOpen(false)} />}
      {memoryOpen && <MemoryDialog memories={memories} onReload={reloadMemories} onClose={() => setMemoryOpen(false)} />}
      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} items={commandItems()} />
      {(contextOpen || inspectorOpen) && <button className="mobile-scrim" type="button" aria-label="Close panels" onClick={() => { setContextOpen(false); setInspectorOpen(false); }} />}
      <ToastContainer toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((t) => t.id !== id))} />
    </div>
  );
}
