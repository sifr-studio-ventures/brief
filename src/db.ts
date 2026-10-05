import { decryptString, encryptString } from "./crypto";
import { parseJar, type JarCookie } from "./cookies";
import type { AccountRecord, AccountStatus, Env, MediaRecord, Platform, PostRecord, PostStatus } from "./types";
import { now, parseStringArray } from "./util";

type SessionRow = { id_hash: string; expires_at: number; created_at: number };

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function mapPost(row: Record<string, unknown>): PostRecord {
  return {
    id: String(row.id),
    status: String(row.status) as PostStatus,
    body: String(row.body ?? ""),
    targets: String(row.targets ?? "[]"),
    heldPlatforms: String(row.held_platforms ?? "[]"),
    scheduleAt: num(row.schedule_at),
    postedAt: num(row.posted_at),
    xPostId: str(row.x_post_id),
    linkedinPostId: str(row.linkedin_post_id),
    error: str(row.error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapMedia(row: Record<string, unknown>): MediaRecord {
  return {
    id: String(row.id),
    postId: str(row.post_id),
    r2Key: String(row.r2_key),
    contentType: String(row.content_type),
    byteSize: Number(row.byte_size),
    createdAt: Number(row.created_at),
  };
}

export async function createSession(env: Env, hash: string, expiresAt: number, createdAt: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO sessions (id_hash, expires_at, created_at) VALUES (?, ?, ?)",
  )
    .bind(hash, expiresAt, createdAt)
    .run();
}

export async function getSession(env: Env, hash: string): Promise<SessionRow | null> {
  return env.DB.prepare("SELECT id_hash, expires_at, created_at FROM sessions WHERE id_hash = ?")
    .bind(hash)
    .first<SessionRow>();
}

export async function deleteSession(env: Env, hash: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(hash).run();
}

export async function sweepSessions(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()).run();
}

export async function listAccounts(env: Env): Promise<AccountRecord[]> {
  const rows = await env.DB.prepare(
    "SELECT platform, status, cookies_enc, label, updated_at FROM accounts",
  ).all<Record<string, unknown>>();
  const byPlatform = new Map<string, AccountRecord>();
  for (const row of rows.results) {
    const platform = String(row.platform) as Platform;
    byPlatform.set(platform, {
      platform,
      status: String(row.status) as AccountStatus,
      cookiesEnc: str(row.cookies_enc),
      label: str(row.label),
      updatedAt: Number(row.updated_at),
    });
  }
  return (["x", "linkedin"] as Platform[]).map(
    (platform) =>
      byPlatform.get(platform) ?? {
        platform,
        status: "missing" as const,
        cookiesEnc: null,
        label: null,
        updatedAt: 0,
      },
  );
}

export async function getAccount(env: Env, platform: Platform): Promise<AccountRecord | null> {
  const row = await env.DB.prepare(
    "SELECT platform, status, cookies_enc, label, updated_at FROM accounts WHERE platform = ?",
  )
    .bind(platform)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    platform,
    status: String(row.status) as AccountStatus,
    cookiesEnc: str(row.cookies_enc),
    label: str(row.label),
    updatedAt: Number(row.updated_at),
  };
}

export async function saveAccount(
  env: Env,
  platform: Platform,
  status: AccountStatus,
  cookies: JarCookie[] | null,
  label: string | null,
): Promise<void> {
  const enc = cookies ? await encryptString(env, JSON.stringify(cookies)) : null;
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO accounts (platform, status, cookies_enc, label, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(platform) DO UPDATE SET
       status = excluded.status,
       cookies_enc = COALESCE(excluded.cookies_enc, accounts.cookies_enc),
       label = excluded.label,
       updated_at = excluded.updated_at`,
  )
    .bind(platform, status, enc, label, ts)
    .run();
}

export async function loadJar(env: Env, platform: Platform): Promise<JarCookie[]> {
  const account = await getAccount(env, platform);
  if (!account || account.status === "missing" || !account.cookiesEnc) {
    throw new Error(platform === "x" ? "X is not signed in" : "LinkedIn is not signed in");
  }
  if (account.status === "expired") throw new Error(platform === "x" ? "X session expired" : "LinkedIn session expired");
  return parseJar(await decryptString(env, account.cookiesEnc));
}

export async function markExpired(env: Env, platform: Platform): Promise<void> {
  const ts = now();
  await env.DB.prepare("UPDATE accounts SET status = 'expired', updated_at = ? WHERE platform = ?")
    .bind(ts, platform)
    .run();
  const rows = await env.DB.prepare(
    "SELECT id, targets, held_platforms FROM posts WHERE status = 'scheduled'",
  ).all<Record<string, unknown>>();
  for (const row of rows.results) {
    const targets = parseStringArray(String(row.targets ?? "[]"));
    if (!targets.includes(platform)) continue;
    const held = new Set(parseStringArray(String(row.held_platforms ?? "[]")));
    held.add(platform);
    await env.DB.prepare(
      "UPDATE posts SET status = 'held', held_platforms = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'",
    )
      .bind(JSON.stringify([...held]), ts, String(row.id))
      .run();
  }
}

export async function markReady(env: Env, platform: Platform): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id, targets, held_platforms FROM posts WHERE status = 'held'",
  ).all<Record<string, unknown>>();
  const ts = now();
  for (const row of rows.results) {
    const targets = parseStringArray(String(row.targets ?? "[]"));
    const held = parseStringArray(String(row.held_platforms ?? "[]")).filter((item) => item !== platform);
    const stillHeld = targets.some((target) => held.includes(target));
    await env.DB.prepare("UPDATE posts SET status = ?, held_platforms = ?, updated_at = ? WHERE id = ?")
      .bind(stillHeld ? "held" : "scheduled", JSON.stringify(held), ts, String(row.id))
      .run();
  }
}

export async function listPosts(env: Env): Promise<PostRecord[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM posts ORDER BY updated_at DESC LIMIT 200",
  ).all<Record<string, unknown>>();
  return rows.results.map(mapPost);
}

export async function getPost(env: Env, id: string): Promise<PostRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return row ? mapPost(row) : null;
}

export async function insertPost(
  env: Env,
  post: {
    id: string;
    status: PostStatus;
    body: string;
    targets: string[];
    scheduleAt: number | null;
  },
): Promise<void> {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO posts (
      id, status, body, targets, held_platforms, schedule_at, posted_at, x_post_id, linkedin_post_id, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '[]', ?, NULL, NULL, NULL, NULL, ?, ?)`,
  )
    .bind(post.id, post.status, post.body, JSON.stringify(post.targets), post.scheduleAt, ts, ts)
    .run();
}

export async function updatePostContent(
  env: Env,
  id: string,
  fields: { body: string; targets: string[]; scheduleAt: number | null; status: PostStatus },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE posts SET body = ?, targets = ?, schedule_at = ?, status = ?, error = NULL, updated_at = ?
     WHERE id = ? AND status IN ('draft', 'scheduled', 'failed', 'held')`,
  )
    .bind(fields.body, JSON.stringify(fields.targets), fields.scheduleAt, fields.status, now(), id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function lockPost(env: Env, id: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE posts SET status = 'sending', updated_at = ? WHERE id = ? AND status IN ('draft', 'scheduled', 'failed', 'held')",
  )
    .bind(now(), id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function finishPost(
  env: Env,
  id: string,
  fields: {
    status: PostStatus;
    heldPlatforms: string[];
    xPostId: string | null;
    linkedinPostId: string | null;
    error: string | null;
    postedAt: number | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE posts SET status = ?, held_platforms = ?, x_post_id = ?, linkedin_post_id = ?, error = ?, posted_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      fields.status,
      JSON.stringify(fields.heldPlatforms),
      fields.xPostId,
      fields.linkedinPostId,
      fields.error,
      fields.postedAt,
      now(),
      id,
    )
    .run();
}

export async function reclaimStuck(env: Env): Promise<void> {
  const ts = now();
  await env.DB.prepare(
    "UPDATE posts SET status = 'failed', error = 'Send was interrupted', updated_at = ? WHERE status = 'sending' AND updated_at < ?",
  )
    .bind(ts, ts - 120)
    .run();
}

export async function duePosts(env: Env): Promise<PostRecord[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM posts WHERE status = 'scheduled' AND schedule_at IS NOT NULL AND schedule_at <= ? ORDER BY schedule_at ASC LIMIT 20",
  )
    .bind(now())
    .all<Record<string, unknown>>();
  return rows.results.map(mapPost);
}

export async function deletePost(env: Env, id: string): Promise<MediaRecord[]> {
  const media = await listMedia(env, id);
  await env.DB.prepare("DELETE FROM post_media WHERE post_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
  return media;
}

export async function insertMedia(env: Env, media: MediaRecord): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO post_media (id, post_id, r2_key, content_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(media.id, media.postId, media.r2Key, media.contentType, media.byteSize, media.createdAt)
    .run();
}

export async function getMedia(env: Env, id: string): Promise<MediaRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM post_media WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return row ? mapMedia(row) : null;
}

export async function listMedia(env: Env, postId: string): Promise<MediaRecord[]> {
  const rows = await env.DB.prepare("SELECT * FROM post_media WHERE post_id = ? ORDER BY created_at ASC")
    .bind(postId)
    .all<Record<string, unknown>>();
  return rows.results.map(mapMedia);
}

export async function listMediaByIds(env: Env, ids: string[]): Promise<MediaRecord[]> {
  const out: MediaRecord[] = [];
  for (const id of ids) {
    const media = await getMedia(env, id);
    if (media) out.push(media);
  }
  return out;
}

export async function attachMedia(env: Env, postId: string, ids: string[]): Promise<void> {
  await env.DB.prepare("UPDATE post_media SET post_id = NULL WHERE post_id = ?").bind(postId).run();
  for (const id of ids) {
    await env.DB.prepare("UPDATE post_media SET post_id = ? WHERE id = ? AND post_id IS NULL").bind(postId, id).run();
  }
}

export async function orphanMedia(env: Env): Promise<MediaRecord[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM post_media WHERE post_id IS NULL AND created_at < ?",
  )
    .bind(now() - 86400)
    .all<Record<string, unknown>>();
  return rows.results.map(mapMedia);
}

export async function deleteMediaRow(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM post_media WHERE id = ?").bind(id).run();
}

export async function addTime(env: Env, id: string, seconds: number, day: string): Promise<number> {
  const ts = now();
  const existing = await env.DB.prepare("SELECT seconds FROM session_time WHERE id = ?").bind(id).first<{ seconds: number }>();
  if (!existing) {
    await env.DB.prepare(
      "INSERT INTO session_time (id, started_at, seconds, day, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(id, ts, seconds, day, ts)
      .run();
    return seconds;
  }
  const total = existing.seconds + seconds;
  await env.DB.prepare("UPDATE session_time SET seconds = ?, updated_at = ? WHERE id = ?").bind(total, ts, id).run();
  return total;
}

export async function timeSummary(env: Env, id: string, day: string): Promise<{
  session: number;
  today: number;
  week: number;
  recent: { id: string; seconds: number; startedAt: number }[];
}> {
  const start = shiftStart(day);
  const session = await env.DB.prepare("SELECT seconds FROM session_time WHERE id = ?")
    .bind(id)
    .first<{ seconds: number }>();
  const today = await env.DB.prepare("SELECT COALESCE(SUM(seconds), 0) AS n FROM session_time WHERE day = ?")
    .bind(day)
    .first<{ n: number }>();
  const week = await env.DB.prepare("SELECT COALESCE(SUM(seconds), 0) AS n FROM session_time WHERE day >= ?")
    .bind(start)
    .first<{ n: number }>();
  const recent = await env.DB.prepare(
    "SELECT id, seconds, started_at FROM session_time ORDER BY started_at DESC LIMIT 5",
  ).all<{ id: string; seconds: number; started_at: number }>();
  return {
    session: session?.seconds ?? 0,
    today: today?.n ?? 0,
    week: week?.n ?? 0,
    recent: recent.results.map((row) => ({ id: row.id, seconds: row.seconds, startedAt: row.started_at })),
  };
}

function shiftStart(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(year, (month || 1) - 1, date || 1));
  dt.setUTCDate(dt.getUTCDate() - 6);
  return dt.toISOString().slice(0, 10);
}

export async function getQueryId(env: Env, operation: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT query_id FROM x_query_ids WHERE operation = ?")
    .bind(operation)
    .first<{ query_id: string }>();
  return row?.query_id ?? null;
}

export async function saveQueryIds(env: Env, found: Record<string, string>): Promise<void> {
  const ts = now();
  for (const [operation, queryId] of Object.entries(found)) {
    if (!/^[A-Za-z0-9_]+$/.test(operation) || !/^[A-Za-z0-9_-]+$/.test(queryId)) continue;
    await env.DB.prepare(
      `INSERT INTO x_query_ids (operation, query_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(operation) DO UPDATE SET query_id = excluded.query_id, updated_at = excluded.updated_at`,
    )
      .bind(operation, queryId, ts)
      .run();
  }
}

export async function loadFeatures(env: Env): Promise<Record<string, boolean>> {
  const rows = await env.DB.prepare("SELECT name, enabled FROM x_features").all<{ name: string; enabled: number }>();
  const out: Record<string, boolean> = {};
  for (const row of rows.results) out[row.name] = row.enabled !== 0;
  return out;
}

export async function saveFeatures(env: Env, names: string[], enabled: boolean): Promise<void> {
  const ts = now();
  for (const name of names) {
    if (!/^[a-z][a-z0-9_]{2,}$/.test(name)) continue;
    await env.DB.prepare(
      `INSERT INTO x_features (name, enabled, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    )
      .bind(name, enabled ? 1 : 0, ts)
      .run();
  }
}
