import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  Activity,
  Archive,
  ArrowUp,
  Brain,
  Boxes,
  Check,
  CircleAlert,
  Command,
  Copy,
  Eye,
  Gauge,
  HousePlug,
  Network,
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
} from "lucide-solid";
import type { Entity, Health, Proposal, ProviderSummary } from "@loom/shared";
import { api, type DashboardReview, type MemoryRecord, type ProviderDefinition, type ThreadSummary } from "./api";
import { SolidMarkdown } from "solid-markdown";
import remarkGfm from "remark-gfm";
import { createHighlighter, type Highlighter } from "shiki";

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

interface Toast {
  id: string;
  message: string;
  type: "info" | "success" | "error" | "warning";
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
  return {
    id: createId(),
    title: "New session",
    mode: "plan",
    prompt: "",
    transcript: [],
    entityIds: [],
    createdAt: new Date().toISOString(),
  };
}

function readSessionTabs(): SessionTab[] {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_TABS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [newSessionTab()];
    const tabs = value.filter(
      (item): item is SessionTab =>
        Boolean(item && typeof item === "object" && "id" in item && "transcript" in item),
    );
    return tabs.length ? tabs : [newSessionTab()];
  } catch {
    return [newSessionTab()];
  }
}

function readStringSet(key: string): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function readLastModels(): LastModels {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_MODELS_KEY) ?? "{}") as Partial<LastModels>;
    return {
      providerId: typeof value.providerId === "string" ? value.providerId : "",
      byProvider:
        value.byProvider && typeof value.byProvider === "object" ? (value.byProvider as Record<string, string>) : {},
    };
  } catch {
    return { providerId: "", byProvider: {} };
  }
}

type DiffLine = { type: "added" | "removed" | "unchanged"; value: string };

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    const oldLine = oldLines[i];
    const newLine = newLines[j];
    if (oldLine !== undefined && newLine !== undefined && oldLine === newLine) {
      result.push({ type: "unchanged", value: oldLine });
      i++;
      j++;
    } else if (oldLine !== undefined && newLine !== undefined && oldLine !== newLine) {
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
        i++;
        j++;
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

/* ── Shiki highlighting (lazy singleton) ── */
let highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark"],
      langs: [
        "yaml",
        "json",
        "javascript",
        "typescript",
        "python",
        "bash",
        "sql",
        "markdown",
        "html",
        "css",
        "xml",
        "properties",
      ],
    });
  }
  return highlighterPromise;
}

function CodeBlock(props: { lang?: string; children: string }) {
  const [html, setHtml] = createSignal<string>("");
  let cancelled = false;
  onMount(() => {
    getHighlighter().then((highlighter) => {
      if (cancelled) return;
      const code = props.children ?? "";
      const lang = props.lang && highlighter.getLoadedLanguages().includes(props.lang as never) ? props.lang : "text";
      try {
        setHtml(highlighter.codeToHtml(code, { lang: lang as never, theme: "github-dark" }));
      } catch {
        setHtml("");
      }
    });
  });
  onCleanup(() => {
    cancelled = true;
  });
  return (
    <div class="lcn-code-block">
      <div class="lcn-code-header">
        <span class="lcn-code-lang">{props.lang || "text"}</span>
        <button
          class="lcn-copy-button"
          type="button"
          aria-label="Copy code"
          onClick={async () => {
            if (navigator.clipboard) await navigator.clipboard.writeText(props.children ?? "");
          }}
        >
          <Copy size={13} />
        </button>
      </div>
      <Show when={html()} fallback={<pre><code>{props.children}</code></pre>}>
        <div class="shiki" innerHTML={html()} />
      </Show>
    </div>
  );
}

function MarkdownMessage(props: { content: string }) {
  return (
    <div class="markdown-body">
      <SolidMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (p: { href?: string | undefined; children?: unknown }) => (
            <a href={p.href} target="_blank" rel="noreferrer">
              {p.children as never}
            </a>
          ),
          pre: (p: { children?: unknown }) => {
            const nodes = Array.isArray(p.children) ? p.children : p.children ? [p.children] : [];
            const codeNode = nodes[0];
            const codeText = typeof codeNode === "string" ? codeNode : (codeNode as { children?: unknown } | undefined)?.children?.toString() ?? "";
            const className = (codeNode as { className?: string } | undefined)?.className?.toString() ?? "";
            const lang = className.replace("language-", "");
            return <CodeBlock lang={lang || "text"} children={codeText} />;
          },
        }}
      >
        {props.content}
      </SolidMarkdown>
    </div>
  );
}

function ReasoningPart(props: { item: TranscriptItem }) {
  return (
    <Show when={props.item.text}>
      <div data-component="reasoning-part" data-running={props.item.status === "running" ? "true" : "false"}>
        <MarkdownMessage content={props.item.text || "Waiting for model-provided reasoning…"} />
      </div>
    </Show>
  );
}

function ToolActivity(props: { item: TranscriptItem }) {
  const [open, setOpen] = createSignal(props.item.status === "running");
  return (
    <div data-component="tool-part-wrapper" data-timeline-part-id={props.item.id}>
      <details
        data-component="tool-trigger"
        data-state={props.item.status ?? "complete"}
        data-clickable="true"
        open={open()}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary data-slot="basic-tool-tool-trigger-content">
          <span data-slot="basic-tool-tool-indicator">
            <span
              data-slot="tool-status-dot"
              style={
                props.item.status === "running"
                  ? { "animation": "pulse-dot 1.6s ease-in-out infinite" }
                  : undefined
              }
            />
          </span>
          <div data-slot="basic-tool-tool-info">
            <div data-slot="basic-tool-tool-info-structured">
              <div data-slot="basic-tool-tool-info-main">
                <span data-slot="basic-tool-tool-title">{props.item.text}</span>
                {props.item.status === "running" && <span data-slot="basic-tool-tool-subtitle">running</span>}
                {props.item.status === "error" && <span data-slot="basic-tool-tool-subtitle">error</span>}
              </div>
              <Show when={props.item.status !== "running"}>
                <span data-slot="basic-tool-tool-action">+</span>
              </Show>
            </div>
          </div>
        </summary>
        <Show when={props.item.detail}>
          <pre data-component="tool-output" data-scrollable>
            {props.item.detail}
          </pre>
        </Show>
      </details>
    </div>
  );
}

function UserMessage(props: { item: TranscriptItem }) {
  return (
    <article data-component="user-message" data-message-id={props.item.id}>
      <div data-slot="user-message-body">
        <div data-slot="user-message-text">{props.item.text}</div>
      </div>
      <div data-slot="user-message-meta">
        <div data-slot="user-message-meta-wrap">
          <span data-slot="user-message-meta-tail" />
        </div>
      </div>
    </article>
  );
}

function AssistantMessage(props: { item: TranscriptItem }) {
  return (
    <article data-component="assistant-message" data-message-id={props.item.id}>
      <div data-component="text-part">
        <div data-slot="text-part-body">
          <MarkdownMessage content={props.item.text || "Preparing response…"} />
        </div>
        {props.item.status === "running" && (
          <div data-slot="text-part-copy-wrapper" data-running="true">
            <span class="running-label">
              <StatusDot state="running" />
              working
            </span>
          </div>
        )}
      </div>
      <div data-slot="message-part-meta" />
    </article>
  );
}

function StatusDot(props: { state: Health["homeAssistant"] | "running" }) {
  const color = createMemo(() => {
    if (props.state === "connected") return "#6bd586";
    if (props.state === "running") return "#a2bcff";
    return "#808080";
  });
  const pulse = props.state === "running";
  return (
    <span
      style={{
        width: "6px",
        height: "6px",
        "border-radius": "50%",
        background: color(),
        animation: pulse ? "pulse-dot 1.2s ease-in-out infinite" : undefined,
      }}
      aria-hidden="true"
    />
  );
}

function EntityRow(props: { entity: Entity; selected: boolean; onToggle: () => void }) {
  return (
    <button class="lcn-entity-row" type="button" onClick={props.onToggle} aria-pressed={props.selected}>
      <span class="lcn-entity-glyph">{props.entity.domain.slice(0, 2).toUpperCase()}</span>
      <span class="lcn-entity-copy">
        <strong>{props.entity.friendlyName}</strong>
        <small>{props.entity.entityId}</small>
      </span>
      <span class={`lcn-entity-state ${props.entity.unavailable ? "lcn-entity-state-bad" : ""}`}>
        {props.entity.disabled ? "disabled" : props.entity.state}
      </span>
    </button>
  );
}

export function App() {
  const [tabs, setTabs] = createSignal<SessionTab[]>(readSessionTabs());
  const [activeTabId, setActiveTabId] = createSignal(localStorage.getItem(ACTIVE_TAB_KEY) ?? "");
  const [health, setHealth] = createSignal<Health | null>(null);
  const [providers, setProviders] = createSignal<ProviderSummary[]>([]);
  const [definitions, setDefinitions] = createSignal<ProviderDefinition[]>([]);
  const [entities, setEntities] = createSignal<Entity[]>([]);
  const [entityTotal, setEntityTotal] = createSignal(0);
  const [entityQuery, setEntityQuery] = createSignal("");
  const [providerOpen, setProviderOpen] = createSignal(false);
  const [threadHistoryOpen, setThreadHistoryOpen] = createSignal(false);
  const [memoryOpen, setMemoryOpen] = createSignal(false);
  const [commandOpen, setCommandOpen] = createSignal(false);
  const [threadHistory, setThreadHistory] = createSignal<ThreadSummary[]>([]);
  const [memories, setMemories] = createSignal<MemoryRecord[]>([]);
  const [contextOpen, setContextOpen] = createSignal(false);
  const [inspectorOpen, setInspectorOpen] = createSignal(false);
  const [selectedEntities, setSelectedEntities] = createSignal<Set<string>>(new Set());
  const [running, setRunning] = createSignal(false);
  const [compacting, setCompacting] = createSignal(false);
  const [error, setError] = createSignal("");
  const [proposals, setProposals] = createSignal<Proposal[]>([]);
  const [dashboardPath, setDashboardPath] = createSignal("/lovelace/0");
  const [dashboardReview, setDashboardReview] = createSignal<DashboardReview | null>(null);
  const [reviewingDashboard, setReviewingDashboard] = createSignal(false);
  const [reviewedProposals, setReviewedProposals] = createSignal<Set<string>>(new Set());
  const [currentConfigs, setCurrentConfigs] = createSignal<Record<string, Record<string, unknown> | null>>({});
  const [entityFilter, setEntityFilter] = createSignal<"all" | "available" | "unavailable">("all");
  const [favoriteModels, setFavoriteModels] = createSignal<Set<string>>(readStringSet(FAVORITES_KEY));
  const [lastModels, setLastModels] = createSignal<LastModels>(readLastModels());
  const [toasts, setToasts] = createSignal<Toast[]>([]);

  let entitySearchRef: HTMLInputElement | undefined;
  let abortController: AbortController | null = null;

  const activeTab = createMemo(() => tabs().find((tab) => tab.id === activeTabId()) ?? tabs()[0] ?? newSessionTab());
  const prompt = createMemo(() => activeTab().prompt);
  const transcript = createMemo(() => activeTab().transcript);
  const mode = createMemo<Mode>(() => activeTab().mode);
  const selectedEntityIds = createMemo(() => selectedEntities());

  function showToast(message: string, type: Toast["type"] = "info", duration = 4000) {
    const id = createId();
    setToasts((current) => [...current, { id, message, type }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), duration);
  }

  function updateActiveTab(update: (tab: SessionTab) => SessionTab) {
    const id = activeTab().id;
    setTabs((current) => current.map((tab) => (tab.id === id ? update(tab) : tab)));
  }

  function setMode(value: Mode) {
    updateActiveTab((tab) => ({ ...tab, mode: value }));
  }

  function setPrompt(value: string) {
    updateActiveTab((tab) => ({ ...tab, prompt: value }));
  }

  function setTranscript(value: TranscriptItem[] | ((current: TranscriptItem[]) => TranscriptItem[])) {
    updateActiveTab((tab) => ({ ...tab, transcript: typeof value === "function" ? value(tab.transcript) : value }));
  }

  function setSelectedEntityIds(value: Set<string> | ((current: Set<string>) => Set<string>)) {
    const result = typeof value === "function" ? value(new Set(selectedEntities())) : value;
    setSelectedEntities(result);
    updateActiveTab((tab) => ({ ...tab, entityIds: [...result] }));
  }

  function createTab() {
    const tab = newSessionTab();
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  }

  function closeTab(id: string) {
    const closing = tabs().find((tab) => tab.id === id);
    if (closing) {
      void api
        .saveThread(id, closing)
        .then(() => api.archiveThread(id))
        .then(() => api.threads())
        .then(setThreadHistory)
        .catch(() => undefined);
    }
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      const remaining = current.filter((tab) => tab.id !== id);
      if (remaining.length === 0) {
        const replacement = newSessionTab();
        setActiveTabId(replacement.id);
        return [replacement];
      }
      if (id === activeTabId()) setActiveTabId(remaining[Math.max(0, index - 1)]?.id ?? remaining[0]!.id);
      return remaining;
    });
  }

  async function reloadMemories() {
    setMemories(await api.memories());
  }

  async function openStoredThread(id: string) {
    const existing = tabs().find((tab) => tab.id === id);
    if (existing) {
      setActiveTabId(id);
      setThreadHistoryOpen(false);
      return;
    }
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const draftProposals = createMemo(() => proposals().filter((proposal) => proposal.status === "draft"));

  const favoriteProviders = createMemo(() =>
    providers().filter(
      (provider) => provider.enabled && provider.models.some((model) => favoriteModels().has(`${provider.id}::${model.id}`)),
    ),
  );

  const activeProvider = createMemo(() => providers().find((provider) => provider.id === activeProviderId()));

  const [activeProviderId, setActiveProviderId] = createSignal("");
  const [activeModelId, setActiveModelId] = createSignal("");

  const activeFavoriteModels = createMemo(() =>
    (activeProvider()?.models ?? []).filter((model) => favoriteModels().has(`${activeProviderId()}::${model.id}`)),
  );

  const visibleEntities = createMemo(() => {
    const filter = entityFilter();
    return entities().filter((entity) => filter === "all" || (filter === "available" ? !entity.unavailable : entity.unavailable));
  });

  const uncompactedMessages = createMemo(() =>
    transcript()
      .slice(activeTab().compactedThrough ?? 0)
      .filter((item) => (item.role === "user" || item.role === "assistant") && item.text),
  );

  const estimatedContextTokens = createMemo(() => {
    const context = activeTab().contextSummary?.length ?? 0;
    const messages = uncompactedMessages().reduce((total, item) => total + item.text.length, 0);
    return Math.ceil((context + messages + prompt().length) / 4);
  });

  onMount(() => {
    Promise.all([api.health(), api.providerDefinitions(), api.providers(), api.proposals()])
      .then(([nextHealth, nextDefinitions, nextProviders, nextProposals]) => {
        setHealth(nextHealth);
        setDefinitions(nextDefinitions);
        setProviders(nextProviders);
        setProposals(nextProposals);
        const last = lastModels();
        const preferred =
          nextProviders.find(
            (provider) => provider.id === last.providerId && provider.enabled && provider.models.length > 0,
          ) ?? nextProviders.find((provider) => provider.enabled && provider.models.length > 0);
        if (preferred) {
          const savedModel = last.byProvider[preferred.id];
          const model =
            preferred.models.find((item) => item.id === savedModel) ??
            preferred.models.find((item) => item.id === "google/gemini-2.5-flash-lite") ??
            preferred.models.find((item) => item.id === "openai/gpt-4.1-mini") ??
            preferred.models[0];
          setActiveProviderId(preferred.id);
          setActiveModelId(model?.id ?? "");
          if (model) {
            setFavoriteModels((current) => new Set([...current, `${preferred.id}::${model.id}`]));
            setLastModels((current) => ({
              providerId: preferred.id,
              byProvider: { ...current.byProvider, [preferred.id]: model.id },
            }));
          }
        }
      })
      .catch((cause) => setError(cause.message));

    void Promise.all([api.threads(), api.memories()]).then(([nextThreads, nextMemories]) => {
      setThreadHistory(nextThreads);
      setMemories(nextMemories);
    });
  });

  // Persist tabs, favorites, last models
  createEffect(() => {
    localStorage.setItem(SESSION_TABS_KEY, JSON.stringify(tabs()));
  });
  createEffect(() => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favoriteModels()]));
  });
  createEffect(() => {
    localStorage.setItem(LAST_MODELS_KEY, JSON.stringify(lastModels()));
  });
  createEffect(() => {
    const id = activeTabId();
    if (id) localStorage.setItem(ACTIVE_TAB_KEY, id);
  });

  // Debounced tab autosave to server
  createEffect(() => {
    const current = tabs();
    const timer = setTimeout(() => {
      void Promise.all(current.map((tab) => api.saveThread(tab.id, tab)))
        .then(() => api.threads())
        .then(setThreadHistory)
        .catch(() => undefined);
    }, 500);
    onCleanup(() => clearTimeout(timer));
  });

  // Remember last selected model
  createEffect(() => {
    const providerId = activeProviderId();
    const modelId = activeModelId();
    if (!providerId || !modelId) return;
    setLastModels((current) =>
      current.providerId === providerId && current.byProvider[providerId] === modelId
        ? current
        : { providerId, byProvider: { ...current.byProvider, [providerId]: modelId } },
    );
  });

  // Debounced entity search
  createEffect(() => {
    const query = entityQuery();
    const timer = setTimeout(() => {
      api
        .entities(query)
        .then((result) => {
          setEntities(result.entities);
          setEntityTotal(result.total);
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    }, 180);
    onCleanup(() => clearTimeout(timer));
  });

  async function refreshEntities() {
    setError("");
    try {
      await api.refreshEntities();
      const [nextHealth, result] = await Promise.all([api.health(), api.entities(entityQuery())]);
      setHealth(nextHealth);
      setEntities(result.entities);
      setEntityTotal(result.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function submitPrompt(text?: string) {
    const clean = (text ?? prompt()).trim();
    if (!clean || running()) return;
    if (!activeProviderId() || !activeModelId()) {
      setError("Choose a favorite model before sending.");
      setProviderOpen(true);
      return;
    }
    if (activeTab().title === "New session") {
      const title = clean.length > 42 ? `${clean.slice(0, 39)}…` : clean;
      updateActiveTab((tab) => ({ ...tab, title }));
    }
    const userItem: TranscriptItem = { id: createId(), role: "user", text: clean };
    const history = transcript()
      .slice(activeTab().compactedThrough ?? 0)
      .reduce<Array<{ role: "user" | "assistant"; content: string }>>((result, item) => {
        if ((item.role !== "user" && item.role !== "assistant") || item.status === "running" || !item.text) return result;
        const previous = result[result.length - 1];
        if (item.role === "assistant" && previous?.role === "assistant") previous.content += `\n\n${item.text}`;
        else result.push({ role: item.role, content: item.text });
        return result;
      }, []);
    if (history.length > 100) {
      setError("This thread has too many uncompacted turns. Use Compact before sending another message.");
      return;
    }
    setTranscript((items) => [...items, userItem]);
    setPrompt("");
    setRunning(true);
    setError("");
    const signal = new AbortController();
    abortController = signal;
    try {
      const response = await fetch(api.chatUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: activeProviderId(),
          modelId: activeModelId(),
          mode: mode(),
          prompt: clean,
          history,
          contextSummary: activeTab().contextSummary ?? "",
          contextEntityIds: [...selectedEntityIds()],
        }),
        signal: signal.signal,
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
          const data = JSON.parse(event.slice(6)) as {
            type: string;
            id?: string;
            delta?: string;
            detail?: string;
            message?: string;
            tool?: string;
            state?: string;
            callId?: string;
          };
          if (data.type === "text-start" && data.id)
            setTranscript((items) => (items.some((item) => item.id === data.id) ? items : [...items, { id: data.id!, role: "assistant", text: "", status: "running" }]));
          if (data.type === "text" && data.id && data.delta)
            setTranscript((items) => {
              const existing = items.some((item) => item.id === data.id);
              return existing
                ? items.map((item) => (item.id === data.id ? { ...item, text: item.text + data.delta } : item))
                : [...items, { id: data.id!, role: "assistant", text: data.delta!, status: "running" }];
            });
          if (data.type === "text-end" && data.id)
            setTranscript((items) => items.map((item) => (item.id === data.id ? { ...item, status: "complete" } : item)));
          if (data.type === "reasoning-start" && data.id)
            setTranscript((items) =>
              items.some((item) => item.id === data.id) ? items : [...items, { id: data.id!, role: "reasoning", text: "", status: "running" }],
            );
          if (data.type === "reasoning" && data.id && data.delta)
            setTranscript((items) => {
              const existing = items.some((item) => item.id === data.id);
              return existing
                ? items.map((item) => (item.id === data.id ? { ...item, text: item.text + data.delta } : item))
                : [...items, { id: data.id!, role: "reasoning", text: data.delta!, status: "running" }];
            });
          if (data.type === "reasoning-end" && data.id)
            setTranscript((items) => items.map((item) => (item.id === data.id ? { ...item, status: "complete" } : item)));
          if (data.type === "tool" && data.callId)
            setTranscript((items) => {
              const id = `tool-${data.callId}`;
              const existing = items.some((item) => item.id === id);
              const activity: TranscriptItem = {
                id,
                role: "activity",
                text: data.tool?.replaceAll("_", " ") ?? "tool",
                ...(data.detail ? { detail: data.detail } : {}),
                status: data.state === "error" ? "error" : data.state === "complete" ? "complete" : "running",
              };
              return existing
                ? items.map((item) => {
                    if (item.id !== id) return item;
                    const nextDetail = data.detail ?? item.detail;
                    return { ...activity, ...(nextDetail ? { detail: nextDetail } : {}) };
                  })
                : [...items, activity];
            });
          if (data.type === "error") throw new Error(data.message ?? "Provider failed");
          if (data.type === "abort") throw new DOMException("Stopped", "AbortError");
        }
      }
      setTranscript((items) => items.map((item) => (item.status === "running" ? { ...item, status: "complete" } : item)));
      setProposals(await api.proposals());
    } catch (cause) {
      const stopped = cause instanceof DOMException && cause.name === "AbortError";
      const message = stopped ? "Stopped by you." : cause instanceof Error ? cause.message : String(cause);
      setTranscript((items) => [
        ...items.map((item) => (item.status === "running" ? { ...item, status: stopped ? "complete" as const : "error" as const } : item)),
        { id: createId(), role: "assistant", text: message, status: stopped ? "complete" : "error" },
      ]);
    } finally {
      abortController = null;
      setRunning(false);
    }
  }

  async function compactThread() {
    if (!activeProviderId() || !activeModelId()) {
      setError("Choose a model before compacting.");
      return;
    }
    const messages = uncompactedMessages().reduce<Array<{ role: "user" | "assistant"; content: string }>>(
      (result, item) => {
        const role = item.role as "user" | "assistant";
        const previous = result[result.length - 1];
        if (role === "assistant" && previous?.role === "assistant") previous.content += `\n\n${item.text}`;
        else result.push({ role, content: item.text });
        return result;
      },
      [],
    );
    if (messages.length === 0) {
      setError("There is no new conversation to compact.");
      return;
    }
    setCompacting(true);
    setError("");
    try {
      const result = await api.compactThread(activeTab().id, {
        providerId: activeProviderId(),
        modelId: activeModelId(),
        existingSummary: activeTab().contextSummary ?? "",
        messages,
      });
      updateActiveTab((tab) => ({ ...tab, contextSummary: result.summary, compactedThrough: tab.transcript.length }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCompacting(false);
    }
  }

  function toggleFavorite(providerId: string, modelId: string) {
    const key = `${providerId}::${modelId}`;
    const removing = favoriteModels().has(key);
    const next = new Set(favoriteModels());
    if (removing) next.delete(key);
    else next.add(key);
    setFavoriteModels(next);
    if (removing && activeProviderId() === providerId && activeModelId() === modelId) {
      const provider = providers().find((item) => item.id === providerId);
      const replacement = provider?.models.find((model) => next.has(`${providerId}::${model.id}`));
      if (replacement) setActiveModelId(replacement.id);
      else {
        const nextProvider = providers().find((item) => item.models.some((model) => next.has(`${item.id}::${model.id}`)));
        const nextModel = nextProvider?.models.find((model) => next.has(`${nextProvider.id}::${model.id}`));
        setActiveProviderId(nextProvider?.id ?? "");
        setActiveModelId(nextModel?.id ?? "");
      }
    }
  }

  function handleProviderChange(providerId: string) {
    const provider = providers().find((item) => item.id === providerId);
    const savedModel = lastModels().byProvider[providerId];
    const model =
      provider?.models.find((item) => item.id === savedModel) ?? provider?.models.find((item) => item.id);
    setActiveProviderId(providerId);
    setActiveModelId(model?.id ?? "");
    setLastModels((current) => ({ ...current, providerId }));
  }

  async function inspectDashboard() {
    if (!activeProviderId() || !activeModelId()) {
      setProviderOpen(true);
      return;
    }
    const model = activeProvider()?.models.find((item) => item.id === activeModelId());
    if (!model?.capabilities.includes("vision")) {
      setError("Select a model marked as vision-capable before inspecting a dashboard.");
      return;
    }
    setReviewingDashboard(true);
    setError("");
    setDashboardReview(null);
    try {
      setDashboardReview(
        await api.reviewDashboard({ providerId: activeProviderId(), modelId: activeModelId(), dashboardPath: dashboardPath() }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReviewingDashboard(false);
    }
  }

  async function approveProposal(proposal: Proposal) {
    try {
      await api.approveProposal(proposal.id);
      const next = await api.proposals();
      setProposals(next);
      showToast(`Published "${proposal.title}" to Home Assistant`, "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function rejectProposal(proposal: Proposal) {
    try {
      await api.rejectProposal(proposal.id);
      setProposals(await api.proposals());
      showToast(`Rejected "${proposal.title}"`, "warning");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function markProposalReviewed(proposal: Proposal) {
    setReviewedProposals((current) => new Set(current).add(proposal.id));
    if (!(proposal.id in currentConfigs())) {
      try {
        const current = await api.getResourceCurrent(proposal.type, proposal.resourceId);
        setCurrentConfigs((prev) => ({ ...prev, [proposal.id]: current }));
      } catch {
        setCurrentConfigs((prev) => ({ ...prev, [proposal.id]: null }));
      }
    }
  }

  // Window-level keyboard shortcuts
  onMount(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setCommandOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  const commandItems = [
    { id: "new-session", label: "New session", description: "Start a fresh conversation", shortcut: "⌘N", action: () => createTab(), disabled: false },
    { id: "manage-providers", label: "Manage providers", description: "Configure AI models and favorites", shortcut: "⌘P", action: () => setProviderOpen(true), disabled: false },
    { id: "refresh-entities", label: "Refresh entity inventory", description: "Reload entities from Home Assistant", shortcut: "⌘R", action: () => void refreshEntities(), disabled: false },
    { id: "compact-thread", label: "Compact thread", description: "Summarize conversation to save tokens", shortcut: "⌘L", action: () => void compactThread(), disabled: uncompactedMessages().length === 0 },
    { id: "review-dashboard", label: "Review dashboard", description: "Render and analyze a Lovelace dashboard", shortcut: "⌘D", action: () => void inspectDashboard(), disabled: false },
    { id: "thread-history", label: "Open thread history", description: "Browse and restore saved threads", shortcut: "⌘H", action: () => { void api.threads().then(setThreadHistory); setThreadHistoryOpen(true); }, disabled: false },
    { id: "memory", label: "Open memory", description: "Manage persistent context memories", shortcut: "⌘M", action: () => { void reloadMemories(); setMemoryOpen(true); }, disabled: false },
    { id: "switch-mode", label: `Switch to ${mode() === "plan" ? "Build" : "Plan"} mode`, description: mode() === "plan" ? "Enable drafting tools" : "Disable drafting, read-only", shortcut: "⌘B", action: () => setMode(mode() === "plan" ? "build" : "plan"), disabled: false },
    { id: "stop-generation", label: "Stop generation", description: "Abort the current model response", shortcut: "Esc", action: () => abortController?.abort(), disabled: !running() },
  ];

  return (
    <div class="lcn-app">
      <header class="lcn-titlebar">
        <button class="lcn-icon-btn lcn-titlebar-home" type="button" aria-label="Home Assistant" onClick={() => setContextOpen(true)} title="Home Assistant">
          <HousePlug size={15} />
        </button>
        <div class="lcn-titlebar-tabs" role="tablist" aria-label="Sessions">
          <For each={tabs()}>
            {(tab) => (
              <div class="lcn-tab" data-active={tab.id === activeTab()?.id ? "true" : "false"} role="tab" aria-selected={tab.id === activeTab()?.id}>
                <button class="lcn-tab-main" type="button" onClick={() => setActiveTabId(tab.id)}>
                  <span>{tab.title}</span>
                </button>
                <button class="lcn-tab-close" type="button" aria-label={`Close ${tab.title}`} onClick={() => closeTab(tab.id)}>
                  <X size={13} />
                </button>
              </div>
            )}
          </For>
          <button class="lcn-icon-btn lcn-titlebar-add" type="button" aria-label="New session" onClick={createTab}>
            <Plus size={16} />
          </button>
        </div>
        <div class="lcn-titlebar-actions">
          <span style={{ display: "flex", "align-items": "center", gap: "6px", color: "var(--v2-text-text-faint)", "font-size": "11px" }}>
            <StatusDot state={health()?.homeAssistant ?? "unconfigured"} />
            {health()?.homeAssistant ?? "checking"}
          </span>
          <button class="lcn-icon-btn" type="button" aria-label="Thread history" onClick={() => { void api.threads().then(setThreadHistory); setThreadHistoryOpen(true); }}>
            <Archive size={15} />
          </button>
          <button class="lcn-icon-btn" type="button" aria-label="Memory" onClick={() => { void reloadMemories(); setMemoryOpen(true); }}>
            <Brain size={15} />
          </button>
          <button class="lcn-icon-btn" type="button" aria-label="Evidence" onClick={() => setInspectorOpen(true)}>
            <SlidersHorizontal size={15} />
          </button>
          <button class="lcn-icon-btn" type="button" aria-label="Providers" onClick={() => setProviderOpen(true)}>
            <Settings2 size={15} />
          </button>
        </div>
      </header>

      <div class="lcn-shell">
        <main class="lcn-workbench">
          <Show
            when={transcript().length === 0}
            fallback={
              <div class="lcn-thread">
                <div class="lcn-conversation">
                  <div class="lcn-column" data-slot="session-turn-list">
                    <For each={transcript()}>
                      {(item) => (
                        <Switch>
                          <Match when={item.role === "reasoning"}>
                            <ReasoningPart item={item} />
                          </Match>
                          <Match when={item.role === "activity"}>
                            <ToolActivity item={item} />
                          </Match>
                          <Match when={item.role === "user"}>
                            <UserMessage item={item} />
                          </Match>
                          <Match when={item.role === "assistant"}>
                            <AssistantMessage item={item} />
                          </Match>
                        </Switch>
                      )}
                    </For>
                    <Show when={error()}>
                      <div class="error-banner">
                        <CircleAlert size={17} />
                        {error()}
                      </div>
                    </Show>
                  </div>
                </div>
                <div class="lcn-composer-wrap">
                  <Show when={draftProposals().length > 0}>
                    <div class="lcn-draft-bar">
                      <span class="lcn-draft-title">
                        <Boxes size={15} />
                        Pending drafts
                      </span>
                      <For each={draftProposals()}>
                        {(proposal) => {
                          const reviewed = createMemo(() => reviewedProposals().has(proposal.id));
                          return (
                            <div class="lcn-draft-card">
                              <div class="lcn-draft-copy">
                                <strong>{proposal.title}</strong>
                                <span>
                                  {proposal.type} · {proposal.resourceId}
                                </span>
                                {!proposal.validation.valid && (
                                  <em style={{ color: "var(--v2-state-fg-danger)", "font-size": "10px" }}>
                                    {proposal.validation.errors.join(" · ")}
                                  </em>
                                )}
                              </div>
                              <details
                                class="lcn-details"
                                onToggle={(event) => {
                                  if (event.currentTarget.open) void markProposalReviewed(proposal);
                                }}
                              >
                                <summary>
                                  {(() => {
                                    const isReviewed = reviewed();
                                    return isReviewed ? <Check size={12} /> : <Search size={12} />;
                                  })()}
                                  Review exact {proposal.type} configuration
                                  {reviewed() ? " · reviewed" : ""}
                                </summary>
                                <div style={{ display: "grid" }}>
                                  <pre>{JSON.stringify(proposal.payload, null, 2)}</pre>
                                  <div class="diff-view">
                                    <For each={computeDiff(JSON.stringify(currentConfigs()[proposal.id] ?? {}, null, 2), JSON.stringify(proposal.payload, null, 2))}>
                                      {(line) => (
                                        <div class={`diff-line diff-line--${line.type}`}>
                                          <span class="diff-marker">{line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}</span>
                                          <span>{line.value || " "}</span>
                                        </div>
                                      )}
                                    </For>
                                  </div>
                                </div>
                              </details>
                              <div class="lcn-draft-actions">
                                <button class="lcn-btn" type="button" onClick={() => void rejectProposal(proposal)}>
                                  Reject
                                </button>
                                <button
                                  class="lcn-btn lcn-btn-primary"
                                  type="button"
                                  disabled={!proposal.validation.valid || !reviewed()}
                                  title={!reviewed() ? "Open Review exact configuration to confirm it" : "Publish this draft to Home Assistant"}
                                  onClick={() => void approveProposal(proposal)}
                                >
                                  Approve &amp; deploy
                                </button>
                              </div>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                  <form
                    class="lcn-composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submitPrompt();
                    }}
                  >
                    <Show when={selectedEntityIds().size > 0}>
                      <div class="lcn-context-chips">
                        <For each={[...selectedEntityIds()]}>
                          {(entityId) => (
                            <button
                              class="lcn-chip"
                              type="button"
                              onClick={() =>
                                setSelectedEntityIds((current) => {
                                  const next = new Set(current);
                                  next.delete(entityId);
                                  return next;
                                })
                              }
                            >
                              {entityId}
                              <X size={11} />
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                    <textarea
                      value={prompt()}
                      onInput={(event) => setPrompt(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void submitPrompt();
                        }
                      }}
                      placeholder={mode() === "build" ? "What should Stratum build as a local draft?" : "What should Stratum investigate or plan?"}
                    />
                    <div class="lcn-composer-actions">
                      <div class="lcn-composer-controls">
                        <button
                          class="lcn-tool-btn"
                          type="button"
                          onClick={() => {
                            const el = document.querySelector<HTMLInputElement>('[data-entity-search]');
                            el?.focus();
                          }}
                          aria-label="Add Home Assistant context"
                        >
                          <Plus size={16} />
                        </button>
                        <select
                          class="lcn-select"
                          value={mode()}
                          onChange={(event) => setMode(event.currentTarget.value as Mode)}
                          aria-label="Agent mode"
                        >
                          <option value="plan">Plan</option>
                          <option value="build">Build</option>
                        </select>
                        <Show
                          when={favoriteProviders().length > 0}
                          fallback={
                            <button class="lcn-tool-btn" type="button" onClick={() => setProviderOpen(true)}>
                              <Star size={13} />
                              Choose model
                            </button>
                          }
                        >
                          <select
                            class="lcn-select"
                            value={activeProviderId()}
                            onChange={(event) => handleProviderChange(event.currentTarget.value)}
                            aria-label="Provider"
                          >
                            <For each={favoriteProviders()}>
                              {(provider) => <option value={provider.id}>{provider.label}</option>}
                            </For>
                          </select>
                          <select
                            class="lcn-select"
                            value={activeModelId()}
                            onChange={(event) => setActiveModelId(event.currentTarget.value)}
                            aria-label="Favorite model"
                          >
                            <For each={activeFavoriteModels()}>
                              {(model) => <option value={model.id}>{model.label}</option>}
                            </For>
                          </select>
                        </Show>
                        <button
                          class="lcn-tool-btn"
                          type="button"
                          onClick={() => void compactThread()}
                          disabled={compacting() || uncompactedMessages().length === 0}
                          title={`Estimated active context: ${estimatedContextTokens().toLocaleString()} tokens`}
                        >
                          <Sparkles size={13} />
                          {compacting() ? "Compacting" : "Compact"}
                          <span class="lcn-token-pill">
                            {estimatedContextTokens() < 1000
                              ? estimatedContextTokens()
                              : `${(estimatedContextTokens() / 1000).toFixed(1)}k`}
                          </span>
                        </button>
                      </div>
                      {(() => {
                        if (running()) {
                          return (
                            <button class="lcn-stop" type="button" onClick={() => abortController?.abort()}>
                              <Square size={14} fill="currentColor" />
                              Stop
                            </button>
                          );
                        }
                        return (
                          <button class="lcn-send" type="submit" disabled={!prompt().trim()} aria-label="Send">
                            <ArrowUp size={18} />
                          </button>
                        );
                      })()}
                    </div>
                  </form>
                </div>
              </div>
            }
          >
            <div class="lcn-new-session">
              <div class="lcn-new-session-inner">
                <div class="lcn-wordmark">
                  strat<span class="lcn-wordmark-accent">um</span>
                </div>
                <div class="lcn-studio-tag">By Synork</div>
                <div class="lcn-composer-wrap lcn-composer-wrap--new">
                  <form
                    class="lcn-composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submitPrompt();
                    }}
                  >
                    <textarea
                      value={prompt()}
                      onInput={(event) => setPrompt(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void submitPrompt();
                        }
                      }}
                      placeholder={mode() === "build" ? "What should Stratum build as a local draft?" : "What should Stratum investigate or plan?"}
                    />
                    <div class="lcn-composer-actions">
                      <div class="lcn-composer-controls">
                        <Show
                          when={favoriteProviders().length > 0}
                          fallback={
                            <button class="lcn-tool-btn" type="button" onClick={() => setProviderOpen(true)}>
                              <Star size={13} />
                              Choose model
                            </button>
                          }
                        >
                          <select
                            class="lcn-select"
                            value={activeProviderId()}
                            onChange={(event) => handleProviderChange(event.currentTarget.value)}
                            aria-label="Provider"
                          >
                            <For each={favoriteProviders()}>
                              {(provider) => <option value={provider.id}>{provider.label}</option>}
                            </For>
                          </select>
                          <select
                            class="lcn-select"
                            value={activeModelId()}
                            onChange={(event) => setActiveModelId(event.currentTarget.value)}
                            aria-label="Favorite model"
                          >
                            <For each={activeFavoriteModels()}>
                              {(model) => <option value={model.id}>{model.label}</option>}
                            </For>
                          </select>
                        </Show>
                      </div>
                      <button class="lcn-send" type="submit" disabled={!prompt().trim()} aria-label="Send">
                        <ArrowUp size={18} />
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            </div>
          </Show>
        </main>

        <aside class="lcn-sidepanel" data-open={inspectorOpen() ? "true" : "false"} role="complementary" aria-label="Evidence">
          <div class="lcn-rail-head">
            <div>
              <div class="lcn-eyebrow">EVIDENCE</div>
              <div class="lcn-rail-title">Run ledger</div>
            </div>
            <SlidersHorizontal size={16} style={{ color: "var(--v2-icon-icon-muted)" }} />
          </div>
          <div class="lcn-ledger">
            <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
              <span style={{ color: "var(--v2-text-text-faint)", "font-family": "ui-monospace, monospace", "font-size": "10px" }}>01</span>
              <div>
                <strong style={{ "font-size": "13px", "font-weight": "500" }}>Home Assistant context</strong>
              </div>
              <Check size={16} style={{ "margin-left": "auto", color: "var(--v2-text-text-accent)" }} />
            </div>
            <small>{entityTotal() ? `${entityTotal()} entities indexed` : "Inventory unavailable"}</small>
          </div>
          <div class="lcn-ledger">
            <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
              <span style={{ color: "var(--v2-text-text-faint)", "font-family": "ui-monospace, monospace", "font-size": "10px" }}>02</span>
              <strong style={{ "font-size": "13px", "font-weight": "500", "text-transform": "capitalize" }}>{mode()} mode</strong>
              <Sparkles size={16} style={{ "margin-left": "auto", color: "var(--v2-text-text-accent)" }} />
            </div>
            <small>{mode() === "build" ? "Read tools and local drafting enabled" : "Read-only agent tools enabled"}</small>
          </div>
          <div class="lcn-ledger">
            <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
              <span style={{ color: "var(--v2-text-text-faint)", "font-family": "ui-monospace, monospace", "font-size": "10px" }}>03</span>
              <strong style={{ "font-size": "13px", "font-weight": "500" }}>Thread context</strong>
              <Activity size={16} style={{ "margin-left": "auto", color: "var(--v2-text-text-accent)" }} />
            </div>
            <small>
              {activeTab().contextSummary
                ? `Compacted summary + ${estimatedContextTokens().toLocaleString()} tokens`
                : `${estimatedContextTokens().toLocaleString()} estimated tokens · not compacted`}
            </small>
          </div>

          <div class="lcn-visual-action">
            <label class="lcn-label">
              <span>Rendered dashboard review</span>
              <input class="lcn-text-input" value={dashboardPath()} onInput={(event) => setDashboardPath(event.currentTarget.value)} placeholder="/lovelace/0" />
            </label>
            <button class="lcn-btn" type="button" onClick={() => void inspectDashboard()} disabled={reviewingDashboard()}>
              <Eye size={14} />
              {reviewingDashboard() ? "Rendering…" : "Review at 3 widths"}
            </button>
          </div>

          <Show when={dashboardReview()}>
            {(review) => (
              <div style={{ padding: "12px 14px", "border-bottom": "0.5px solid var(--v2-border-border-muted)" }}>
                <div class="lcn-visual-strip">
                  <For each={review().renders}>
                    {(render) => (
                      <figure>
                        <img src={api.screenshotUrl(render.filename)} alt={`${render.name} dashboard render`} />
                        <figcaption>
                          {render.name} · {render.width}px
                        </figcaption>
                      </figure>
                    )}
                  </For>
                </div>
                <h4 style={{ margin: "12px 0 5px", "font-size": "13px", "font-weight": "550" }}>Visual finding</h4>
                <p style={{ margin: 0, "max-height": "180px", "overflow-y": "auto", color: "var(--v2-text-text-muted)", "font-size": "12px", "line-height": "20px", "white-space": "pre-wrap" }}>
                  {review().review}
                </p>
              </div>
            )}
          </Show>

          <Show
            when={proposals().length > 0}
            fallback={
              <div class="lcn-empty">
                <Gauge size={26} />
                <h3>No draft yet</h3>
                <p>Generated automation or dashboard configurations and visual-review results appear here.</p>
              </div>
            }
          >
            <For each={proposals()}>
              {(proposal) => (
                <article class="lcn-proposal">
                  <div class="lcn-proposal-head">
                    <span>{proposal.type}</span>
                    <strong>{proposal.status}</strong>
                  </div>
                  <h3>{proposal.title}</h3>
                  <p>{proposal.explanation}</p>
                  <div class={proposal.validation.valid ? "lcn-badge lcn-badge-good" : "lcn-badge lcn-badge-bad"}>
                    {proposal.validation.valid ? "Basic reference checks passed" : proposal.validation.errors.join(" · ")}
                  </div>
                  <Show when={proposal.validation.warnings.length > 0}>
                    <div class="lcn-badge lcn-badge-warn" style={{ "margin-top": "6px" }}>
                      {proposal.validation.warnings.join(" · ")}
                    </div>
                  </Show>
                  <details
                    class="lcn-details"
                    onToggle={(event) => {
                      if (event.currentTarget.open) void markProposalReviewed(proposal);
                    }}
                  >
                    <summary>Review exact {proposal.type} configuration</summary>
                    <pre>{JSON.stringify(proposal.payload, null, 2)}</pre>
                  </details>
                  <Show when={proposal.status === "draft"}>
                    <div class="lcn-proposal-actions">
                      <button class="lcn-btn" type="button" onClick={() => void rejectProposal(proposal)}>
                        Reject
                      </button>
                      <Show when={proposal.type === "dashboard"}>
                        <button
                          class="lcn-btn"
                          type="button"
                          disabled={!proposal.validation.valid || reviewingDashboard()}
                          onClick={async () => {
                            if (!activeProviderId() || !activeModelId()) {
                              setProviderOpen(true);
                              return;
                            }
                            const model = activeProvider()?.models.find((item) => item.id === activeModelId());
                            if (!model?.capabilities.includes("vision")) {
                              setError("Select a vision-capable model for dashboard preview.");
                              return;
                            }
                            setReviewingDashboard(true);
                            setDashboardReview(null);
                            try {
                              setDashboardReview(
                                await api.previewProposal(proposal.id, { providerId: activeProviderId(), modelId: activeModelId() }),
                              );
                            } catch (cause) {
                              setError(cause instanceof Error ? cause.message : String(cause));
                            } finally {
                              setReviewingDashboard(false);
                            }
                          }}
                        >
                          <Eye size={13} />
                          Stage visual preview
                        </button>
                      </Show>
                      <button
                        class="lcn-btn lcn-btn-primary"
                        type="button"
                        disabled={!proposal.validation.valid || !reviewedProposals().has(proposal.id)}
                        onClick={() => void approveProposal(proposal)}
                      >
                        Publish reviewed change
                      </button>
                    </div>
                  </Show>
                  <Show when={proposal.status === "rejected" || proposal.status === "failed"}>
                    <div class="lcn-proposal-actions">
                      <button
                        class="lcn-btn"
                        type="button"
                        onClick={async () => {
                          try {
                            await api.deleteProposal(proposal.id);
                            setProposals(await api.proposals());
                          } catch (cause) {
                            setError(cause instanceof Error ? cause.message : String(cause));
                          }
                        }}
                      >
                        Remove record
                      </button>
                    </div>
                  </Show>
                </article>
              )}
            </For>
          </Show>
          <div style={{ margin: "12px 14px", padding: "10px 12px", display: "flex", "align-items": "center", gap: "8px", "border-radius": "8px", background: "var(--v2-background-bg-layer-02)", color: "var(--v2-text-text-muted)" }}>
            <Boxes size={16} style={{ color: "var(--v2-text-text-accent)" }} />
            <div>
              <div style={{ "font-size": "11px", "font-weight": "500" }}>Agent permission</div>
              <div style={{ "font-size": "10px", color: "var(--v2-text-text-faint)" }}>Read and create local drafts; publishing requires review</div>
            </div>
          </div>
        </aside>
      </div>

      {/* Evidence scrim */}
      <Show when={inspectorOpen()}>
        <div class="lcn-scrim" onClick={() => setInspectorOpen(false)} aria-hidden="true" />
      </Show>

      {/* Context panel */}
      <div
        class="lcn-context"
        data-open={contextOpen() ? "true" : "false"}
        role="complementary"
        aria-label="Home Assistant context"
      >
        <div style={{ padding: "12px 14px", display: "flex", "align-items": "center", "justify-content": "space-between", "border-bottom": "0.5px solid var(--v2-border-border-muted)" }}>
          <div>
            <div class="lcn-eyebrow">HOME ASSISTANT</div>
            <div class="lcn-rail-title">Context</div>
          </div>
          <button class="lcn-icon-btn" type="button" aria-label="Close context" onClick={() => setContextOpen(false)}>
            <X size={18} />
          </button>
        </div>
        <div style={{ height: "36px", margin: "8px 12px 6px", padding: "0 4px", display: "flex", "align-items": "center", "justify-content": "space-between", color: "var(--v2-text-text-faint)", "font-size": "11px" }}>
          <span style={{ display: "flex", "align-items": "center", gap: "6px" }}>
            <HousePlug size={16} />
            {entityTotal()} entities
          </span>
          <button class="lcn-icon-btn" type="button" aria-label="Refresh entity inventory" onClick={() => void refreshEntities()}>
            <RefreshCw size={15} />
          </button>
        </div>
        <div class="lcn-search" data-entity-search="">
          <Search size={15} />
          <input
            ref={(el) => (entitySearchRef = el)}
            value={entityQuery()}
            onInput={(event) => setEntityQuery(event.currentTarget.value)}
            placeholder="Name, entity, area…"
          />
        </div>
        <div class="lcn-filter-strip">
          <For each={["all", "available", "unavailable"] as const}>
            {(filter) => (
              <button
                class="lcn-filter-chip"
                data-active={entityFilter() === filter ? "true" : "false"}
                type="button"
                onClick={() => setEntityFilter(filter)}
              >
                {filter}
              </button>
            )}
          </For>
        </div>
        <div class="lcn-entity-list">
          <Show
            when={visibleEntities().length > 0}
            fallback={
              <div class="lcn-empty" style={{ "text-align": "left" }}>
                <Network size={20} />
                <p>{health()?.homeAssistant === "unconfigured" ? "Entity index connects when installed as an add-on." : "No entities match this scope."}</p>
              </div>
            }
          >
            <For each={visibleEntities()}>
              {(entity) => (
                <EntityRow
                  entity={entity}
                  selected={selectedEntityIds().has(entity.entityId)}
                  onToggle={() =>
                    setSelectedEntityIds((current) => {
                      const next = new Set(current);
                      if (next.has(entity.entityId)) next.delete(entity.entityId);
                      else next.add(entity.entityId);
                      return next;
                    })
                  }
                />
              )}
            </For>
          </Show>
        </div>
      </div>

      {/* Toasts */}
      <div class="lcn-toasts">
        <For each={toasts()}>
          {(toast) => (
            <div class={`lcn-toast lcn-toast-${toast.type}`}>
              <span>{toast.message}</span>
              <button class="lcn-icon-btn" type="button" aria-label="Dismiss" onClick={() => setToasts((current) => current.filter((t) => t.id !== toast.id))}>
                <X size={14} />
              </button>
            </div>
          )}
        </For>
      </div>

      {/* Command palette */}
      <Show when={commandOpen()}>
        <CommandPalette items={commandItems} onClose={() => setCommandOpen(false)} />
      </Show>

      {/* Provider dialog */}
      <Show when={providerOpen()}>
        <ProviderDialog
          definitions={definitions()}
          providers={providers()}
          favoriteModels={favoriteModels()}
          onToggleFavorite={toggleFavorite}
          onClose={() => setProviderOpen(false)}
          onChanged={loadProviders}
        />
      </Show>

      {/* Thread history dialog */}
      <Show when={threadHistoryOpen()}>
        <ThreadHistoryDialog threads={threadHistory()} openIds={new Set(tabs().map((tab) => tab.id))} onOpen={(id) => void openStoredThread(id)} onClose={() => setThreadHistoryOpen(false)} />
      </Show>

      {/* Memory dialog */}
      <Show when={memoryOpen()}>
        <MemoryDialog memories={memories()} onReload={reloadMemories} onClose={() => setMemoryOpen(false)} />
      </Show>
    </div>
  );
}

/* ───────────────────────── Command palette ───────────────────────── */

interface CommandItem {
  id: string;
  label: string;
  description: string;
  shortcut?: string;
  action: () => void;
  disabled: boolean;
}

function CommandPalette(props: { items: CommandItem[]; onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  const filtered = createMemo(() => {
    const q = query().toLowerCase();
    return props.items.filter((item) => `${item.label} ${item.description} ${item.shortcut ?? ""}`.toLowerCase().includes(q));
  });

  createEffect(() => {
    if (filtered().length > 0 && selectedIndex() >= filtered().length) setSelectedIndex(0);
  });

  onMount(() => {
    inputRef?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered().length - 1));
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const item = filtered()[selectedIndex()];
        if (item && !item.disabled) {
          item.action();
          props.onClose();
        }
      }
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  return (
    <div
      class="lcn-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div class="lcn-dialog lcn-palette" role="dialog" aria-modal="true">
        <div class="lcn-dialog-head">
          <div>
            <div class="lcn-eyebrow">COMMAND PALETTE</div>
            <h2>Search commands</h2>
          </div>
          <kbd class="lcn-kbd">⌘K</kbd>
        </div>
        <div class="lcn-search" style={{ margin: "10px 12px" }}>
          <Command size={16} />
          <input
            ref={inputRef}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder="Type a command…"
            spellcheck={false}
          />
        </div>
        <div class="lcn-palette-list">
          <Show
            when={filtered().length > 0}
            fallback={<div class="lcn-dialog-empty">No matching commands</div>}
          >
            <For each={filtered()}>
              {(item, i) => (
                <button
                  class="lcn-command"
                  classList={{ "lcn-command-selected-border": false }}
                  data-selected={i() === selectedIndex() ? "true" : "false"}
                  type="button"
                  disabled={item.disabled}
                  onClick={() => {
                    if (!item.disabled) {
                      item.action();
                      props.onClose();
                    }
                  }}
                  onMouseEnter={() => setSelectedIndex(i())}
                >
                  {(() => {
                    if (item.id === "new-session") return <Plus size={15} />;
                    if (item.id === "manage-providers") return <Settings2 size={15} />;
                    if (item.id === "refresh-entities") return <RefreshCw size={15} />;
                    if (item.id === "compact-thread") return <Sparkles size={15} />;
                    if (item.id === "review-dashboard") return <Eye size={15} />;
                    if (item.id === "thread-history") return <Archive size={15} />;
                    if (item.id === "memory") return <Brain size={15} />;
                    if (item.id === "switch-mode") return <Workflow size={15} />;
                    return <Square size={15} />;
                  })()}
                  <div class="lcn-command-text">
                    <span class="lcn-command-label">{item.label}</span>
                    <span class="lcn-command-desc">{item.description}</span>
                  </div>
                  {item.shortcut && <kbd class="lcn-kbd">{item.shortcut}</kbd>}
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Provider dialog ───────────────────────── */

function ProviderDialog(props: {
  definitions: ProviderDefinition[];
  providers: ProviderSummary[];
  favoriteModels: Set<string>;
  onToggleFavorite: (providerId: string, modelId: string) => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [kind, setKind] = createSignal(props.definitions[0]?.kind ?? "openai");
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [label, setLabel] = createSignal(props.definitions[0]?.label ?? "OpenAI");
  const [models, setModels] = createSignal("");
  const [error, setError] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [busyProvider, setBusyProvider] = createSignal("");
  const [expandedProvider, setExpandedProvider] = createSignal("");
  const [modelQuery, setModelQuery] = createSignal("");

  const definition = createMemo(() => props.definitions.find((item) => item.kind === kind()));

  async function submit(event: Event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.saveProvider({
        kind: kind(),
        label: label(),
        enabled: true,
        config: values(),
        models: models()
          .split(/[\n,]/)
          .map((model) => model.trim())
          .filter(Boolean),
      });
      await props.onChanged();
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      class="lcn-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div class="lcn-dialog" role="dialog" aria-modal="true" style={{ width: "min(680px, 100%)" }}>
        <div class="lcn-dialog-head">
          <div>
            <div class="lcn-eyebrow">MODEL ROUTING</div>
            <h2>Providers</h2>
          </div>
          <button class="lcn-icon-btn" type="button" aria-label="Close" onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>
        <Show when={props.providers.length > 0}>
          <div style={{ "border-bottom": "0.5px solid var(--v2-border-border-muted)" }}>
            <For each={props.providers}>
              {(provider) => (
                <div style={{ "border-bottom": "0.5px solid var(--v2-border-border-muted)", padding: "7px 14px", display: "grid", gap: "6px" }}>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <div style={{ "min-width": "0", flex: "1", display: "grid", gap: "2px" }}>
                      <strong style={{ "font-size": "13px", "font-weight": "500" }}>{provider.label}</strong>
                      <span style={{ color: "var(--v2-text-text-faint)", "font-size": "10px" }}>
                        {provider.models.length} compatible ·{" "}
                        {provider.models.filter((model) => props.favoriteModels.has(`${provider.id}::${model.id}`)).length} favorites
                      </span>
                    </div>
                    <button
                      class="lcn-btn"
                      type="button"
                      onClick={() => {
                        setExpandedProvider((current) => (current === provider.id ? "" : provider.id));
                        setModelQuery("");
                      }}
                    >
                      <Star size={13} />
                      Favorites
                    </button>
                    <button
                      class="lcn-btn"
                      type="button"
                      disabled={busyProvider() === provider.id}
                      onClick={async () => {
                        setBusyProvider(provider.id);
                        setError("");
                        try {
                          await api.discoverModels(provider.id);
                          await props.onChanged();
                        } catch (cause) {
                          setError(cause instanceof Error ? cause.message : String(cause));
                        } finally {
                          setBusyProvider("");
                        }
                      }}
                    >
                      <RefreshCw size={13} />
                      Refresh
                    </button>
                    <button
                      class="lcn-btn"
                      type="button"
                      style={{ color: "var(--v2-state-fg-danger)" }}
                      disabled={busyProvider() === provider.id}
                      onClick={async () => {
                        if (!window.confirm(`Delete ${provider.label}? The stored credentials will be removed.`)) return;
                        setBusyProvider(provider.id);
                        setError("");
                        try {
                          await api.deleteProvider(provider.id);
                          await props.onChanged();
                        } catch (cause) {
                          setError(cause instanceof Error ? cause.message : String(cause));
                        } finally {
                          setBusyProvider("");
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                  <Show when={expandedProvider() === provider.id}>
                    <div style={{ padding: "8px 10px", background: "var(--v2-background-bg-deep)", "border-radius": "8px" }}>
                      <div class="lcn-search" style={{ margin: "0 0 7px" }}>
                        <Search size={14} />
                        <input
                          value={modelQuery()}
                          onInput={(event) => setModelQuery(event.currentTarget.value)}
                          placeholder="Search models…"
                        />
                      </div>
                      <div style={{ "max-height": "260px", "overflow-y": "auto", display: "grid", gap: "2px" }}>
                        <For each={provider.models.filter((model) => `${model.label} ${model.id}`.toLowerCase().includes(modelQuery().toLowerCase())).slice(0, 100)}>
                          {(model) => {
                            const favorite = props.favoriteModels.has(`${provider.id}::${model.id}`);
                            return (
                              <button
                                class="lcn-command"
                                style={favorite ? { background: "var(--v2-background-bg-layer-02)" } : undefined}
                                type="button"
                                aria-pressed={favorite}
                                onClick={() => props.onToggleFavorite(provider.id, model.id)}
                              >
                                <span class="lcn-command-icon">
                                  <Star size={14} fill={favorite ? "currentColor" : "none"} />
                                </span>
                                <div class="lcn-command-text">
                                  <span class="lcn-command-label">{model.label}</span>
                                  <span class="lcn-command-desc">{model.id}</span>
                                </div>
                                <span style={{ color: "var(--v2-text-text-faint)", "font-family": "ui-monospace, monospace", "font-size": "9px", "text-transform": "uppercase" }}>
                                  {model.capabilities.includes("vision") ? "vision" : "text"}
                                </span>
                              </button>
                            );
                          }}
                        </For>
                      </div>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
        <form onSubmit={submit}>
          <div style={{ "margin-bottom": "10px", color: "var(--v2-text-text-faint)", "font-size": "10px", "font-weight": "600", "letter-spacing": "0.08em", "text-transform": "uppercase" }}>
            Add provider
          </div>
          <label class="lcn-field">
            <span>Provider</span>
            <select
              value={kind()}
              onChange={(event) => {
                const next = event.currentTarget.value as ProviderSummary["kind"];
                setKind(next);
                setLabel(props.definitions.find((item) => item.kind === next)?.label ?? next);
                setValues({});
              }}
            >
              <For each={props.definitions}>
                {(item) => <option value={item.kind}>{item.label}</option>}
              </For>
            </select>
          </label>
          <label class="lcn-field">
            <span>Connection name</span>
            <input value={label()} onInput={(event) => setLabel(event.currentTarget.value)} required />
          </label>
          <div style={{ display: "grid", "grid-template-columns": "repeat(2, minmax(0, 1fr))", gap: "8px" }}>
            <For each={definition()?.fields ?? []}>
              {(field) => (
                <label class="lcn-field">
                  <span>{field.label}</span>
                  <input
                    type={field.secret ? "password" : "text"}
                    value={values()[field.key] ?? ""}
                    placeholder={field.placeholder}
                    required={field.required}
                    autocomplete={field.secret ? "new-password" : "off"}
                    onInput={(event) => setValues((current) => ({ ...current, [field.key]: event.currentTarget.value }))}
                  />
                </label>
              )}
            </For>
          </div>
          <label class="lcn-field">
            <span>Model IDs</span>
            <textarea rows={3} value={models()} onInput={(event) => setModels(event.currentTarget.value)} />
          </label>
          <Show when={error()}>
            <div class="error-banner" style={{ margin: "6px 0" }}>
              <CircleAlert size={15} />
              {error()}
            </div>
          </Show>
          <div class="lcn-dialog-actions">
            <button class="lcn-btn" type="button" onClick={props.onClose}>
              Close
            </button>
            <button class="lcn-btn lcn-btn-primary" type="submit" disabled={saving()}>
              {saving() ? "Saving…" : "Save provider"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ───────────────────────── Thread history dialog ───────────────────────── */

function ThreadHistoryDialog(props: {
  threads: ThreadSummary[];
  openIds: Set<string>;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      class="lcn-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div class="lcn-dialog" role="dialog" aria-modal="true" style={{ width: "min(620px, 100%)" }}>
        <div class="lcn-dialog-head">
          <div>
            <div class="lcn-eyebrow">HISTORY</div>
            <h2>Threads</h2>
          </div>
          <button class="lcn-icon-btn" type="button" onClick={props.onClose}>
            <X size={17} />
          </button>
        </div>
        <div class="lcn-list">
          <Show when={props.threads.length > 0} fallback={<div class="lcn-dialog-empty">No saved threads yet.</div>}>
            <For each={props.threads}>
              {(thread) => (
                <button class="lcn-list-item" style={{ "grid-template-columns": "24px minmax(0, 1fr) auto" }} type="button" onClick={() => props.onOpen(thread.id)}>
                  <Archive size={15} />
                  <span style={{ "min-width": "0", display: "grid", gap: "2px" }}>
                    <strong style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", color: "var(--v2-text-text-base)", "font-size": "13px", "font-weight": "500" }}>
                      {thread.title}
                    </strong>
                    <small style={{ color: "var(--v2-text-text-faint)", "font-size": "10px" }}>{new Date(thread.updatedAt).toLocaleString()}</small>
                  </span>
                  <em style={{ color: "var(--v2-text-text-faint)", "font-size": "9px", "font-style": "normal", "text-transform": "uppercase" }}>
                    {props.openIds.has(thread.id) ? "open" : thread.archived ? "archived" : "saved"}
                  </em>
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Memory dialog ───────────────────────── */

function MemoryDialog(props: { memories: MemoryRecord[]; onReload: () => Promise<void>; onClose: () => void }) {
  const [content, setContent] = createSignal("");
  const [tags, setTags] = createSignal("");
  const [error, setError] = createSignal("");

  async function submit(event: Event) {
    event.preventDefault();
    setError("");
    try {
      await api.saveMemory(
        content(),
        tags()
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      );
      setContent("");
      setTags("");
      await props.onReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div
      class="lcn-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div class="lcn-dialog" role="dialog" aria-modal="true" style={{ width: "min(620px, 100%)" }}>
        <div class="lcn-dialog-head">
          <div>
            <div class="lcn-eyebrow">PERSISTENT CONTEXT</div>
            <h2>Memory</h2>
          </div>
          <button class="lcn-icon-btn" type="button" onClick={props.onClose}>
            <X size={17} />
          </button>
        </div>
        <form onSubmit={submit} style={{ "border-bottom": "0.5px solid var(--v2-border-border-muted)" }}>
          <label class="lcn-field">
            <span>Durable fact or preference</span>
            <textarea rows={3} value={content()} onInput={(event) => setContent(event.currentTarget.value)} required />
          </label>
          <label class="lcn-field">
            <span>Tags (comma separated)</span>
            <input value={tags()} onInput={(event) => setTags(event.currentTarget.value)} />
          </label>
          <Show when={error()}>
            <div class="error-banner" style={{ margin: "4px 0" }}>
              <CircleAlert size={15} />
              {error()}
            </div>
          </Show>
          <div class="lcn-dialog-actions">
            <button class="lcn-btn lcn-btn-primary" type="submit">
              Remember
            </button>
          </div>
        </form>
        <div class="lcn-list">
          <Show when={props.memories.length > 0} fallback={<div class="lcn-dialog-empty">No persistent memories yet.</div>}>
            <For each={props.memories}>
              {(memory) => (
                <div class="lcn-list-item" style={{ "grid-template-columns": "minmax(0, 1fr) 28px" }}>
                  <div style={{ "min-width": "0", display: "grid", gap: "2px" }}>
                    <p style={{ margin: "0", color: "var(--v2-text-text-base)", "font-size": "12px", "line-height": "18px", overflow: "hidden", "text-overflow": "ellipsis" }}>
                      {memory.content}
                    </p>
                    <small style={{ color: "var(--v2-text-text-faint)", "font-size": "9px" }}>
                      {memory.tags.join(" · ") || "untagged"}
                    </small>
                  </div>
                  <button
                    class="lcn-icon-btn"
                    type="button"
                    aria-label="Delete memory"
                    onClick={async () => {
                      await api.deleteMemory(memory.id);
                      await props.onReload();
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}