import { createHash, randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { DB } from './db.js'

export const SESSION_COOKIE = 'mw_session'
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000

export interface User {
  id: string
  email: string
  name: string
  picture: string
  settings: string
}

export const b64url = (buf: Buffer) => buf.toString('base64url')
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
export const randomToken = (n = 32) => b64url(randomBytes(n))

export function createSession(db: DB, c: Context, userId: string, secure: boolean) {
  const token = randomToken()
  db.prepare('INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, Date.now() + SESSION_TTL_MS)
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: SESSION_TTL_MS / 1000 })
}

export function sessionUser(db: DB, c: Context): User | null {
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return null
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.picture, u.settings, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
    )
    .get(sha256(token)) as (User & { expires_at: number }) | undefined
  if (!row || row.expires_at < Date.now()) return null
  return { id: row.id, email: row.email, name: row.name, picture: row.picture, settings: row.settings }
}

export function destroySession(db: DB, c: Context) {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(token))
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

export function upsertGoogleUser(db: DB, p: { sub: string; email: string; name: string; picture: string }): string {
  const existing = db.prepare('SELECT id FROM users WHERE google_sub = ?').get(p.sub) as { id: string } | undefined
  const email = p.email.toLowerCase()
  if (existing) {
    db.prepare('UPDATE users SET email = ?, name = ?, picture = ? WHERE id = ?').run(email, p.name, p.picture, existing.id)
    return existing.id
  }
  const id = crypto.randomUUID()
  db.prepare('INSERT INTO users (id, google_sub, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, p.sub, email, p.name, p.picture, Date.now())
  return id
}

// ---------------------------------------------------------------- Google OIDC

export interface GoogleConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export function googleAuthUrl(cfg: GoogleConfig, state: string, nonce: string, codeChallenge: string) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  u.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString()
  return u.toString()
}

export interface IdClaims {
  sub: string
  email: string
  email_verified: boolean
  name?: string
  picture?: string
  aud: string
  iss: string
  exp: number
  nonce?: string
}

/**
 * Exchange the authorization code at Google's token endpoint.  The ID token is
 * received directly from Google over TLS with our client secret, so per OIDC Core
 * §3.1.3.7 its signature check may be replaced by TLS server validation; we still
 * validate iss / aud / exp / nonce / email_verified.
 */
export async function exchangeCode(cfg: GoogleConfig, code: string, verifier: string, nonce: string, fetchImpl: typeof fetch = fetch): Promise<IdClaims> {
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  })
  if (!res.ok) throw new Error(`token endpoint ${res.status}`)
  const body = (await res.json()) as { id_token?: string }
  if (!body.id_token) throw new Error('no id_token')
  const claims = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64url').toString('utf8')) as IdClaims
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') throw new Error('bad iss')
  if (claims.aud !== cfg.clientId) throw new Error('bad aud')
  if (claims.exp * 1000 < Date.now()) throw new Error('expired')
  if (claims.nonce !== nonce) throw new Error('bad nonce')
  if (!claims.email_verified) throw new Error('email not verified')
  return claims
}

export function pkceChallenge(verifier: string) {
  return b64url(createHash('sha256').update(verifier).digest())
}
