import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderKind } from "@loom/shared";
import type { Proposal } from "@loom/shared";

export interface StoredProvider {
  id: string;
  kind: ProviderKind;
  label: string;
  enabled: boolean;
  config: Record<string, unknown>;
  models: string[];
}

export interface StoredThread {
  id: string;
  title: string;
  state: Record<string, unknown>;
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

export class Database {
  readonly sqlite: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const filename = path.join(dataDir, "loom.db");
    this.sqlite = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.sqlite.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL,
        models_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS revisions (
        id TEXT PRIMARY KEY,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        title TEXT NOT NULL,
        explanation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        validation_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        state_json TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  listProviders(): StoredProvider[] {
    const rows = this.sqlite.prepare("SELECT * FROM providers ORDER BY label").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      kind: String(row.kind) as ProviderKind,
      label: String(row.label),
      enabled: Boolean(row.enabled),
      config: JSON.parse(String(row.config_json)) as Record<string, unknown>,
      models: JSON.parse(String(row.models_json)) as string[],
    }));
  }

  getProvider(id: string): StoredProvider | undefined {
    return this.listProviders().find((provider) => provider.id === id);
  }

  saveProvider(provider: StoredProvider): void {
    this.sqlite.prepare(`
      INSERT INTO providers (id, kind, label, enabled, config_json, models_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        label = excluded.label,
        enabled = excluded.enabled,
        config_json = excluded.config_json,
        models_json = excluded.models_json,
        updated_at = excluded.updated_at
    `).run(
      provider.id,
      provider.kind,
      provider.label,
      provider.enabled ? 1 : 0,
      JSON.stringify(provider.config),
      JSON.stringify(provider.models),
      new Date().toISOString(),
    );
  }

  deleteProvider(id: string): void {
    this.sqlite.prepare("DELETE FROM providers WHERE id = ?").run(id);
  }

  saveProposal(proposal: Proposal): void {
    this.sqlite.prepare(`
      INSERT INTO proposals (id, type, resource_id, title, explanation, payload_json, status, validation_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, validation_json = excluded.validation_json, payload_json = excluded.payload_json
    `).run(
      proposal.id, proposal.type, proposal.resourceId, proposal.title, proposal.explanation,
      JSON.stringify(proposal.payload), proposal.status, JSON.stringify(proposal.validation), proposal.createdAt,
    );
  }

  listProposals(): Proposal[] {
    const rows = this.sqlite.prepare("SELECT * FROM proposals ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      type: String(row.type) as Proposal["type"],
      resourceId: String(row.resource_id),
      title: String(row.title),
      explanation: String(row.explanation),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      status: String(row.status) as Proposal["status"],
      validation: JSON.parse(String(row.validation_json)) as Proposal["validation"],
      createdAt: String(row.created_at),
    }));
  }

  getProposal(id: string): Proposal | undefined {
    return this.listProposals().find((proposal) => proposal.id === id);
  }

  deleteProposal(id: string): void {
    this.sqlite.prepare("DELETE FROM proposals WHERE id = ?").run(id);
  }

  saveRevision(resourceType: string, resourceId: string, before: unknown, after: unknown): string {
    const id = crypto.randomUUID();
    this.sqlite.prepare("INSERT INTO revisions (id, resource_type, resource_id, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, resourceType, resourceId, before == null ? null : JSON.stringify(before), JSON.stringify(after), new Date().toISOString());
    return id;
  }

  saveThread(id: string, title: string, state: Record<string, unknown>, archived = false): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO threads (id, title, state_json, archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, state_json = excluded.state_json, archived = excluded.archived, updated_at = excluded.updated_at
    `).run(id, title, JSON.stringify(state), archived ? 1 : 0, now, now);
  }

  listThreads(): StoredThread[] {
    const rows = this.sqlite.prepare("SELECT * FROM threads ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), title: String(row.title), state: JSON.parse(String(row.state_json)) as Record<string, unknown>,
      archived: Boolean(row.archived), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  getThread(id: string): StoredThread | undefined {
    return this.listThreads().find((thread) => thread.id === id);
  }

  archiveThread(id: string): void {
    this.sqlite.prepare("UPDATE threads SET archived = 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  listMemories(query = ""): MemoryRecord[] {
    const rows = (query
      ? this.sqlite.prepare("SELECT * FROM memories WHERE content LIKE ? OR tags_json LIKE ? ORDER BY updated_at DESC LIMIT 50").all(`%${query}%`, `%${query}%`)
      : this.sqlite.prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT 100").all()) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), content: String(row.content), tags: JSON.parse(String(row.tags_json)) as string[],
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  saveMemory(content: string, tags: string[]): MemoryRecord {
    const existing = this.listMemories().find((memory) => memory.content.toLowerCase() === content.toLowerCase());
    const id = existing?.id ?? crypto.randomUUID();
    const createdAt = existing?.createdAt ?? new Date().toISOString();
    const updatedAt = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO memories (id, content, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET content = excluded.content, tags_json = excluded.tags_json, updated_at = excluded.updated_at
    `).run(id, content, JSON.stringify([...new Set(tags)]), createdAt, updatedAt);
    return { id, content, tags: [...new Set(tags)], createdAt, updatedAt };
  }

  deleteMemory(id: string): void {
    this.sqlite.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }
}
