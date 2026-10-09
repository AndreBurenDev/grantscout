// Local document store on SQLite. Replaces Firestore: one table of JSON documents keyed by (collection, id).
// It exposes the small Firestore-shaped surface the pipeline was written against (doc().set/get, add, get,
// batch) plus synchronous helpers for the admin API. Opened lazily, so importing a module never creates a file.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

export type DocData = Record<string, any>;
export interface Row<T = DocData> { id: string; data: T }
export interface DocSnapshot { id: string; exists: boolean; data(): any }

let handle: Database.Database | null = null;

function db(): Database.Database {
  if (handle) return handle;
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
  const d = new Database(config.dbPath);
  d.pragma('journal_mode = WAL');
  d.pragma('busy_timeout = 5000');
  d.exec(`CREATE TABLE IF NOT EXISTS docs (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (collection, id)
  ) WITHOUT ROWID`);
  handle = d;
  return d;
}

/** Close the database (graceful shutdown, tests). The next call reopens it. */
export function closeStore(): void {
  handle?.close();
  handle = null;
}

const isPlain = (v: unknown): v is DocData =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Firestore `merge: true` semantics: maps merge recursively, everything else (arrays included) is replaced. */
export function deepMerge(base: DocData, patch: DocData): DocData {
  const out: DocData = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

const FIELD = /^[A-Za-z_][A-Za-z0-9_.]*$/;
function jsonPath(field: string): string {
  if (!FIELD.test(field)) throw new Error(`invalid field name: ${field}`);
  return `$.${field}`;
}

export class DocRef {
  constructor(readonly collection: string, readonly id: string) {}

  read(): DocData | undefined {
    const r = db().prepare('SELECT data FROM docs WHERE collection = ? AND id = ?').get(this.collection, this.id) as
      | { data: string }
      | undefined;
    return r ? (JSON.parse(r.data) as DocData) : undefined;
  }

  write(data: DocData, merge = false): void {
    const next = merge ? deepMerge(this.read() ?? {}, data) : data;
    db()
      .prepare(
        `INSERT INTO docs (collection, id, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(this.collection, this.id, JSON.stringify(next), new Date().toISOString());
  }

  remove(): void {
    db().prepare('DELETE FROM docs WHERE collection = ? AND id = ?').run(this.collection, this.id);
  }

  // Firestore-shaped async surface.
  async set(data: DocData, opts?: { merge?: boolean }): Promise<void> { this.write(data, !!opts?.merge); }
  async update(data: DocData): Promise<void> { this.write(data, true); }
  async get(): Promise<DocSnapshot> {
    const data = this.read();
    return { id: this.id, exists: data !== undefined, data: () => data };
  }
}

export class WriteBatch {
  private ops: Array<() => void> = [];
  set(ref: DocRef, data: DocData, opts?: { merge?: boolean }): this {
    this.ops.push(() => ref.write(data, !!opts?.merge));
    return this;
  }
  update(ref: DocRef, data: DocData): this {
    this.ops.push(() => ref.write(data, true));
    return this;
  }
  /** All writes land in one transaction, or none do. */
  async commit(): Promise<void> {
    const ops = this.ops;
    this.ops = [];
    db().transaction(() => { for (const op of ops) op(); })();
  }
}

export class Collection {
  /** Mirrors `collection.firestore.batch()`. */
  readonly firestore = { batch: (): WriteBatch => new WriteBatch() };
  constructor(readonly name: string) {}

  doc(id: string): DocRef { return new DocRef(this.name, id); }

  async add(data: DocData): Promise<DocRef> {
    const ref = this.doc(randomUUID());
    ref.write(data);
    return ref;
  }

  async get(): Promise<{ size: number; docs: DocSnapshot[] }> {
    const docs = this.all().map((r) => ({ id: r.id, exists: true, data: () => r.data }));
    return { size: docs.length, docs };
  }

  /** Every document, optionally filtered on one field and ordered by another. */
  all(opts: { where?: [string, unknown]; orderBy?: [string, 'asc' | 'desc']; limit?: number } = {}): Row[] {
    const args: unknown[] = [this.name];
    let sql = 'SELECT id, data FROM docs WHERE collection = ?';
    if (opts.where) {
      const [field, value] = opts.where;
      sql += ` AND json_extract(data, '${jsonPath(field)}') = ?`;
      args.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    if (opts.orderBy) {
      const [field, dir] = opts.orderBy;
      sql += ` ORDER BY json_extract(data, '${jsonPath(field)}') ${dir === 'desc' ? 'DESC' : 'ASC'}`;
    }
    if (opts.limit) { sql += ' LIMIT ?'; args.push(Math.floor(opts.limit)); }
    const rows = db().prepare(sql).all(...args) as { id: string; data: string }[];
    return rows.map((r) => ({ id: r.id, data: JSON.parse(r.data) as DocData }));
  }

  count(where?: [string, unknown]): number {
    const args: unknown[] = [this.name];
    let sql = 'SELECT COUNT(*) AS n FROM docs WHERE collection = ?';
    if (where) {
      sql += ` AND json_extract(data, '${jsonPath(where[0])}') = ?`;
      args.push(typeof where[1] === 'boolean' ? (where[1] ? 1 : 0) : where[1]);
    }
    return (db().prepare(sql).get(...args) as { n: number }).n;
  }
}

export const collections = {
  sources: new Collection('sources'),
  organizations: new Collection('organizations'),
  signals: new Collection('signals'),
  accountScores: new Collection('accountScores'),
  reviewQueue: new Collection('reviewQueue'),
  syncLogs: new Collection('syncLogs'),
  grants: new Collection('grants'),
  settings: new Collection('settings'),
  scheduleState: new Collection('scheduleState'),
};

/** `PRAGMA integrity_check` — used by the health endpoint and the backup. */
export function integrityCheck(): string {
  return (db().prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
}
