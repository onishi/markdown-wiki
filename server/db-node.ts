import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { initSchema, type DB, type SqlParam } from './db.js'

/** node:sqlite backend (local server and tests). */
export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const raw = new DatabaseSync(path)
  raw.exec('PRAGMA journal_mode = WAL;')
  raw.exec('PRAGMA foreign_keys = ON;')
  const db: DB = {
    prepare(sql) {
      const st = raw.prepare(sql)
      return {
        get: (...p: SqlParam[]) => st.get(...p),
        all: (...p: SqlParam[]) => st.all(...p),
        run: (...p: SqlParam[]) => ({ changes: Number(st.run(...p).changes) }),
      }
    },
    exec: (sql) => raw.exec(sql),
    transaction(fn) {
      raw.exec('BEGIN IMMEDIATE')
      try {
        const r = fn()
        raw.exec('COMMIT')
        return r
      } catch (e) {
        raw.exec('ROLLBACK')
        throw e
      }
    },
  }
  initSchema(db)
  return db
}
