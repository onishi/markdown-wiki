/**
 * Minimal synchronous SQLite interface shared by the Node server (node:sqlite, db-node.ts)
 * and the Cloudflare Durable Object (storage.sql, worker/index.ts).
 */
export type SqlParam = string | number | null
export interface Stmt {
  get(...params: SqlParam[]): unknown
  all(...params: SqlParam[]): unknown[]
  run(...params: SqlParam[]): { changes: number }
}
export interface DB {
  prepare(sql: string): Stmt
  exec(sql: string): void
  transaction<T>(fn: () => T): T
}

/** Foreign keys must be enforced (ON DELETE CASCADE / SET NULL); the backend turns them on. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  picture TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_email ON users(email);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wikis (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  wiki_id TEXT NOT NULL REFERENCES wikis(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (wiki_id, user_id)
);
CREATE TABLE IF NOT EXISTS invitations (
  wiki_id TEXT NOT NULL REFERENCES wikis(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  invited_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (wiki_id, email)
);
CREATE INDEX IF NOT EXISTS invitations_email ON invitations(email);
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  wiki_id TEXT NOT NULL REFERENCES wikis(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id),
  UNIQUE (wiki_id, name)
);
CREATE TABLE IF NOT EXISTS wiki_slug_aliases (
  slug TEXT PRIMARY KEY,
  wiki_id TEXT NOT NULL REFERENCES wikis(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS page_aliases (
  wiki_id TEXT NOT NULL REFERENCES wikis(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  PRIMARY KEY (wiki_id, name)
);
CREATE TABLE IF NOT EXISTS page_revisions (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id),
  PRIMARY KEY (page_id, version)
);
`

export function initSchema(db: DB) {
  for (const stmt of SCHEMA.split(';').map((x) => x.trim()).filter(Boolean)) db.exec(stmt)
  migrate(db)
}

function migrate(db: DB) {
  const cols = (db.prepare('PRAGMA table_info(wikis)').all() as { name: string }[]).map((c) => c.name)
  // The wiki's top page: /w/:wid redirects there. Stored by id so renames keep it.
  if (!cols.includes('top_page_id')) db.exec('ALTER TABLE wikis ADD COLUMN top_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL')
  // URL identifier: /w/<slug>. Old slugs stay in wiki_slug_aliases so links keep working.
  if (!cols.includes('slug')) db.exec('ALTER TABLE wikis ADD COLUMN slug TEXT')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS wikis_slug ON wikis(slug)')
  for (const w of db.prepare('SELECT id FROM wikis WHERE slug IS NULL').all() as { id: string }[]) {
    db.prepare('UPDATE wikis SET slug = ? WHERE id = ?').run(`w-${w.id.replace(/-/g, '').slice(0, 8)}`, w.id)
  }
}

export function tx<T>(db: DB, fn: () => T): T {
  return db.transaction(fn)
}
