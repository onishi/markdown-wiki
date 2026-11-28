/**
 * monitor-health — Monitor Health Check Protocol v1 のレスポンスを組み立てる小さなヘルパー。
 * 仕様: https://github.com/onishi/monitor/blob/main/SPEC.md#22
 *
 * このファイルは github.com/onishi/monitor の packages/health/monitor-health.ts から
 * コピーして使う（依存ゼロ・1ファイル完結）。更新するときは monitor リポジトリで
 *   npm --prefix backend run monitor -- init <このファイルのパス> --force
 * を実行して上書きする。直接編集しないこと。
 *
 * @version 1.0.0
 *
 * 使い方:
 *   import { alert, assetsFetch, d1Ping, defineHealth } from "./monitor-health";
 *
 *   export const health = defineHealth<Env>({
 *     service: { id: "myapp", name: "My App" },
 *     alertUrls: [alert.cfWorker("myapp"), alert.github("onishi/myapp")],
 *     checks: [d1Ping({ db: (env) => env.DB })],
 *   });
 *
 *   // 素のWorker:   const res = await health.handle(request, env); if (res) return res;
 *   // Hono:        app.get(HEALTH_PATH, (c) => health.respond(c.env));
 */

export const MONITOR_HEALTH_VERSION = "1.0.0";
export const HEALTH_PATH = "/_monitor/health";

export type HealthStatus = "ok" | "warning" | "critical";
export type CheckType = "web" | "batch" | "custom";

export interface AlertUrl {
  label: string;
  url: string;
}

/** 各チェックの run() が返す結果。throw した場合は critical として扱う。 */
export interface CheckOutcome {
  status: HealthStatus;
  message?: string;
  /** batch チェックの最終成功時刻（Monitor Core側のstaleness再判定に使われる） */
  last_success_at?: string | Date | null;
}

export interface CheckDefinition<E> {
  id: string;
  type: CheckType;
  name: string;
  /** batch チェックの想定実行間隔（秒）。last_success_at と合わせて Monitor Core が staleness を判定する */
  expected_interval_sec?: number;
  /** 1チェックあたりのタイムアウト（既定 5000ms）。超えたら critical */
  timeout_ms?: number;
  run(env: E): Promise<CheckOutcome> | CheckOutcome;
}

export interface HealthOptions<E> {
  service: { id: string; name: string; environment?: string };
  alertUrls?: AlertUrl[];
  checks: CheckDefinition<E>[];
}

export interface HealthCheckJson {
  id: string;
  type: CheckType;
  name: string;
  status: HealthStatus;
  message?: string;
  last_success_at?: string;
  expected_interval_sec?: number;
  checked_at: string;
}

export interface HealthReportJson {
  protocol_version: "1.0";
  service: { id: string; name: string; environment: string };
  generated_at: string;
  status: HealthStatus;
  checks: HealthCheckJson[];
  alert_urls: AlertUrl[];
}

const SEVERITY: Record<HealthStatus, number> = { ok: 0, warning: 1, critical: 2 };
const DEFAULT_CHECK_TIMEOUT_MS = 5_000;

export function worstStatus(statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst), "ok");
}

export function defineHealth<E>(options: HealthOptions<E>) {
  if (options.checks.length === 0) throw new Error("monitor-health: checks を1つ以上指定してください");

  async function report(env: E): Promise<HealthReportJson> {
    const checks = await Promise.all(options.checks.map((def) => runCheck(def, env)));
    return {
      protocol_version: "1.0",
      service: {
        id: options.service.id,
        name: options.service.name,
        environment: options.service.environment ?? "production",
      },
      generated_at: new Date().toISOString(),
      status: worstStatus(checks.map((c) => c.status)),
      checks,
      alert_urls: options.alertUrls ?? [],
    };
  }

  /** プロトコル準拠のJSONレスポンスを返す（チェック失敗時もHTTP 200で、statusに反映する）。 */
  async function respond(env: E): Promise<Response> {
    return new Response(JSON.stringify(await report(env)), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  /** リクエストが GET /_monitor/health ならレスポンスを、それ以外なら null を返す。 */
  async function handle(request: Request, env: E): Promise<Response | null> {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    if (new URL(request.url).pathname !== HEALTH_PATH) return null;
    return respond(env);
  }

  return { report, respond, handle };
}

async function runCheck<E>(def: CheckDefinition<E>, env: E): Promise<HealthCheckJson> {
  let outcome: CheckOutcome;
  try {
    outcome = await withTimeout(
      Promise.resolve().then(() => def.run(env)),
      def.timeout_ms ?? DEFAULT_CHECK_TIMEOUT_MS,
    );
  } catch (err) {
    outcome = { status: "critical", message: `チェック失敗: ${errorMessage(err)}` };
  }
  const lastSuccess = toIso(outcome.last_success_at);
  return {
    id: def.id,
    type: def.type,
    name: def.name,
    status: outcome.status,
    ...(outcome.message ? { message: outcome.message } : {}),
    ...(lastSuccess ? { last_success_at: lastSuccess } : {}),
    ...(def.expected_interval_sec ? { expected_interval_sec: def.expected_interval_sec } : {}),
    checked_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// よく使うチェック
// ---------------------------------------------------------------------------

/** D1Database の必要最小限の形（@cloudflare/workers-types に依存しないため） */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T = unknown>(): Promise<T | null> };
    first<T = unknown>(): Promise<T | null>;
  };
}

/** Fetcher（env.ASSETS や Service Binding）の必要最小限の形 */
export interface FetcherLike {
  fetch(input: Request | string): Promise<Response>;
}

/** D1に軽いクエリを投げて疎通を確認する web チェック */
export function d1Ping<E>(opts: {
  db: (env: E) => D1Like;
  id?: string;
  name?: string;
  sql?: string;
}): CheckDefinition<E> {
  return {
    id: opts.id ?? "web-root",
    type: "web",
    name: opts.name ?? "D1疎通確認",
    async run(env) {
      await opts.db(env).prepare(opts.sql ?? "SELECT 1").first();
      return { status: "ok", message: "D1への疎通に成功" };
    },
  };
}

/** 静的アセット（env.ASSETS）から指定パスを取得できるかを見る web チェック */
export function assetsFetch<E>(opts: {
  assets: (env: E) => FetcherLike;
  path?: string;
  id?: string;
  name?: string;
}): CheckDefinition<E> {
  const path = opts.path ?? "/";
  return {
    id: opts.id ?? "web-root",
    type: "web",
    name: opts.name ?? "静的アセット配信",
    async run(env) {
      const res = await opts.assets(env).fetch(new Request(new URL(path, "https://assets.local")));
      return res.ok
        ? { status: "ok", message: `${path} の取得に成功` }
        : { status: "critical", message: `${path} の取得に失敗: HTTP ${res.status}` };
    },
  };
}

/** 外部（または自分自身）のURLをGETする web チェック。依存先APIの死活確認などに */
export function httpGet<E>(opts: {
  url: string;
  id: string;
  name: string;
  expectText?: string;
  /** 失敗時の status（既定 critical。依存先の障害を warning に留めたいときなど） */
  failStatus?: HealthStatus;
  timeout_ms?: number;
}): CheckDefinition<E> {
  const failStatus = opts.failStatus ?? "critical";
  return {
    id: opts.id,
    type: "web",
    name: opts.name,
    timeout_ms: opts.timeout_ms,
    async run() {
      const startedAt = Date.now();
      const res = await fetch(opts.url);
      const elapsed = Date.now() - startedAt;
      if (!res.ok) return { status: failStatus, message: `HTTP ${res.status}` };
      if (opts.expectText && !(await res.text()).includes(opts.expectText)) {
        return { status: failStatus, message: `本文に「${opts.expectText}」が含まれていません` };
      }
      return { status: "ok", message: `HTTP ${res.status} (${elapsed}ms)` };
    },
  };
}

/** バッチの実行記録（run履歴テーブルの1行を正規化したもの） */
export interface BatchRun {
  status: "running" | "succeeded" | "failed";
  started_at: string;
  completed_at?: string | null;
  error_message?: string | null;
}

/**
 * バッチ（Cron Trigger等）の実行履歴から batch チェックを作る。
 * - 直近が成功 → ok
 * - 直近が失敗 → 過去に成功があれば warning、なければ critical
 * - 実行中のまま intervalSec 以上経過 → 同上
 * - 最終成功からの経過による staleness は Monitor Core 側でも再判定される
 */
export function batchRuns<E>(opts: {
  id: string;
  name: string;
  intervalSec: number;
  load: (env: E) => Promise<{ latest: BatchRun | null; lastSuccessAt: string | null }>;
}): CheckDefinition<E> {
  return {
    id: opts.id,
    type: "batch",
    name: opts.name,
    expected_interval_sec: opts.intervalSec,
    async run(env) {
      const { latest, lastSuccessAt } = await opts.load(env);
      const degraded: HealthStatus = lastSuccessAt ? "warning" : "critical";
      if (!latest) {
        return { status: "critical", message: "実行履歴が見つかりません", last_success_at: lastSuccessAt };
      }
      if (latest.status === "succeeded") {
        return {
          status: "ok",
          message: `直近実行は成功（${latest.completed_at ?? latest.started_at}）`,
          last_success_at: lastSuccessAt ?? latest.completed_at ?? latest.started_at,
        };
      }
      if (latest.status === "running") {
        const startedMs = Date.parse(latest.started_at);
        const tooLong = Number.isFinite(startedMs) && Date.now() - startedMs > opts.intervalSec * 1000;
        return tooLong
          ? { status: degraded, message: `実行中のまま想定間隔を超過（開始: ${latest.started_at}）`, last_success_at: lastSuccessAt }
          : { status: "ok", message: `実行中（開始: ${latest.started_at}）`, last_success_at: lastSuccessAt };
      }
      return {
        status: degraded,
        message: `直近実行が失敗: ${latest.error_message ?? "詳細不明"}`,
        last_success_at: lastSuccessAt,
      };
    },
  };
}

/**
 * D1上の実行履歴テーブルから batchRuns を作る。列名・状態値がアプリごとに違っても columns / values で合わせられる。
 * 例: d1BatchRuns({ id: "sync-batch", name: "同期ジョブ", intervalSec: 1800, db: (e) => e.DB,
 *                   table: "sync_runs", where: { job_type: "sync-owner" } })
 */
export function d1BatchRuns<E>(opts: {
  id: string;
  name: string;
  intervalSec: number;
  db: (env: E) => D1Like;
  table: string;
  where?: Record<string, string | number>;
  columns?: { status?: string; started_at?: string; completed_at?: string; error_message?: string };
  values?: { succeeded?: string; failed?: string; running?: string };
}): CheckDefinition<E> {
  const col = {
    status: opts.columns?.status ?? "status",
    started_at: opts.columns?.started_at ?? "started_at",
    completed_at: opts.columns?.completed_at ?? "completed_at",
    error_message: opts.columns?.error_message ?? "error_message",
  };
  const val = {
    succeeded: opts.values?.succeeded ?? "succeeded",
    failed: opts.values?.failed ?? "failed",
    running: opts.values?.running ?? "running",
  };
  const whereEntries = Object.entries(opts.where ?? {});
  for (const name of [opts.table, ...Object.values(col), ...whereEntries.map(([k]) => k)]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`monitor-health: 不正な識別子 ${name}`);
  }
  const whereSql = whereEntries.map(([k]) => `${k} = ?`);
  const whereBinds = whereEntries.map(([, v]) => v);
  const select = `SELECT ${col.status} AS status, ${col.started_at} AS started_at, ${col.completed_at} AS completed_at, ${col.error_message} AS error_message FROM ${opts.table}`;
  const latestSql = `${select}${whereSql.length ? ` WHERE ${whereSql.join(" AND ")}` : ""} ORDER BY ${col.started_at} DESC LIMIT 1`;
  const successSql = `SELECT ${col.completed_at} AS completed_at, ${col.started_at} AS started_at FROM ${opts.table} WHERE ${[...whereSql, `${col.status} = ?`].join(" AND ")} ORDER BY ${col.started_at} DESC LIMIT 1`;

  const normalize = (s: string): BatchRun["status"] =>
    s === val.succeeded ? "succeeded" : s === val.running ? "running" : "failed";

  return batchRuns<E>({
    id: opts.id,
    name: opts.name,
    intervalSec: opts.intervalSec,
    async load(env) {
      const db = opts.db(env);
      const [latest, success] = await Promise.all([
        db.prepare(latestSql).bind(...whereBinds).first<Record<string, string | null>>(),
        db
          .prepare(successSql)
          .bind(...whereBinds, val.succeeded)
          .first<{ completed_at: string | null; started_at: string }>(),
      ]);
      return {
        latest: latest
          ? {
              status: normalize(String(latest.status)),
              started_at: String(latest.started_at),
              completed_at: latest.completed_at,
              error_message: latest.error_message,
            }
          : null,
        lastSuccessAt: toIso(success ? success.completed_at ?? success.started_at : null) ?? null,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Alert URL ヘルパー
// ---------------------------------------------------------------------------

export const alert = {
  link: (label: string, url: string): AlertUrl => ({ label, url }),
  github: (repo: string): AlertUrl => ({ label: "GitHub リポジトリ", url: `https://github.com/${repo}` }),
  githubActions: (repo: string): AlertUrl => ({ label: "GitHub Actions", url: `https://github.com/${repo}/actions` }),
  cfWorker: (workerName: string): AlertUrl => ({
    label: "Cloudflare Workers ダッシュボード",
    url: `https://dash.cloudflare.com/?to=/:account/workers/services/view/${workerName}`,
  }),
};

// ---------------------------------------------------------------------------

function toIso(value: string | Date | null | undefined): string | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${ms}ms でタイムアウト`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
