import type { Context } from "hono";
import { clearSessionCookie, login, logout, sessionCookie, wantsSecure } from "./auth";
import { cookieHeader, cookieValue, normalizeImport } from "./cookies";
import { passwordOk } from "./crypto";
import {
  attachMedia,
  deleteMediaRow,
  deletePost,
  getMedia,
  getPost,
  insertMedia,
  insertPost,
  listAccounts,
  listMedia,
  listMediaByIds,
  listPosts,
  loadJar,
  markExpired,
  markReady,
  saveAccount,
  timeSummary,
  updatePostContent,
  addTime,
} from "./db";
import { linkedinComment, linkedinFeed, linkedinLabel, linkedinLike, linkedinProfile, linkedinThread } from "./linkedin";
import { accountsPage, appPage, landingPage } from "./pages";
import { publishPost } from "./publish";
import { AccountExpired, type Env, type Platform, type PostStatus } from "./types";
import {
  asObj,
  isDay,
  isLocalUrl,
  isUuid,
  LINKEDIN_LIMIT,
  MAX_IMAGE_BYTES,
  now,
  parseStringArray,
  readCookie,
  safeError,
  sniffImage,
  X_LIMIT,
} from "./util";
import { xAct, xFeed, xLabel, xLists, xProfile, xStats, xThread } from "./x";
import type { Hono } from "hono";

type App = Hono<{ Bindings: Env; Variables: { sessionHash: string } }>;
type Ctx = Context<{ Bindings: Env; Variables: { sessionHash: string } }>;

let loginFails = 0;
let loginLockedUntil = 0;

function themeOf(c: Ctx): "dark" | "light" {
  return readCookie(c.req.header("cookie"), "brief_theme") === "light" ? "light" : "dark";
}

function isPlatform(value: string): value is Platform {
  return value === "x" || value === "linkedin";
}

function targetsFrom(value: unknown): Platform[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out: Platform[] = [];
  for (const item of list) {
    if (item === "x" || item === "linkedin") out.push(item);
  }
  return [...new Set(out)];
}

function parseWhen(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

async function readInput(c: Ctx): Promise<{
  body: string;
  targets: Platform[];
  scheduleAt: number | null;
  action: string;
  mediaIds: string[];
}> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) {
    const data = asObj(await c.req.json().catch(() => null));
    if (!data) throw new Error("Bad request");
    const media = Array.isArray(data.mediaIds) ? data.mediaIds.filter((id): id is string => typeof id === "string") : [];
    return {
      body: typeof data.body === "string" ? data.body : "",
      targets: targetsFrom(data.targets),
      scheduleAt: parseWhen(data.scheduleAt),
      action: typeof data.action === "string" ? data.action : "draft",
      mediaIds: media.slice(0, 4),
    };
  }
  const form = await c.req.parseBody();
  const target = form.target;
  const media = form.mediaIds;
  const mediaIds = (Array.isArray(media) ? media : typeof media === "string" ? [media] : []).filter(
    (id): id is string => typeof id === "string",
  );
  return {
    body: typeof form.body === "string" ? form.body : "",
    targets: targetsFrom(Array.isArray(target) ? target : target),
    scheduleAt: parseWhen(form.scheduleAt),
    action: typeof form.action === "string" ? form.action : "draft",
    mediaIds: mediaIds.slice(0, 4),
  };
}

function validate(
  input: { body: string; targets: Platform[]; scheduleAt: number | null; action: string; mediaIds: string[] },
): { status: PostStatus; error?: string } {
  if (input.body.length > 10_000) return { status: "draft", error: "That is too long" };
  if (!["draft", "schedule", "now"].includes(input.action)) return { status: "draft", error: "Unknown action" };
  if (input.action === "draft") return { status: "draft" };
  if (!input.targets.length) return { status: "draft", error: "Pick X or LinkedIn" };
  if (!input.body.trim() && !input.mediaIds.length) return { status: "draft", error: "Write something or add an image" };
  if (input.targets.includes("x") && input.body.length > X_LIMIT) return { status: "draft", error: "X stops at 280 characters" };
  if (input.targets.includes("linkedin") && input.body.length > LINKEDIN_LIMIT) {
    return { status: "draft", error: "LinkedIn stops at 3000 characters" };
  }
  if (input.action === "schedule") {
    if (!input.scheduleAt) return { status: "draft", error: "Pick a time" };
    if (input.scheduleAt <= now()) return { status: "draft", error: "That time is in the past" };
    return { status: "scheduled" };
  }
  return { status: "draft" };
}

async function ownMedia(env: Env, ids: string[], postId: string | null): Promise<string | null> {
  const rows = await listMediaByIds(env, ids);
  if (rows.length !== ids.length) return "Unknown image";
  for (const row of rows) {
    if (row.postId && row.postId !== postId) return "Unknown image";
  }
  return null;
}

function publicPost(
  post: Awaited<ReturnType<typeof getPost>> extends infer T ? Exclude<T, null> : never,
  media: { id: string; contentType: string }[],
) {
  return {
    id: post.id,
    status: post.status,
    body: post.body,
    targets: parseStringArray(post.targets).filter(isPlatform),
    heldPlatforms: parseStringArray(post.heldPlatforms),
    scheduleAt: post.scheduleAt,
    postedAt: post.postedAt,
    xPostId: post.xPostId,
    linkedinPostId: post.linkedinPostId,
    error: post.error,
    media,
  };
}

async function withMedia(env: Env, post: NonNullable<Awaited<ReturnType<typeof getPost>>>) {
  const media = await listMedia(env, post.id);
  return publicPost(
    post,
    media.map((item) => ({ id: item.id, contentType: item.contentType })),
  );
}

function allowedHost(host: string): boolean {
  return host === "pbs.twimg.com" || host === "video.twimg.com" || host === "licdn.com" || host.endsWith(".licdn.com");
}

async function expire(c: Ctx, platform: Platform, err: unknown) {
  if (err instanceof AccountExpired) await markExpired(c.env, platform);
  return c.json({ error: safeError(err) });
}

export function register(app: App): void {
  app.get("/", (c) => c.html(landingPage(themeOf(c))));

  app.post("/login", async (c) => {
    if (loginLockedUntil > Date.now()) return c.html(landingPage(themeOf(c), "Too many tries. Wait a minute."), 429);
    const form = await c.req.parseBody();
    const password = typeof form.password === "string" ? form.password : "";
    const id = await login(c.env, password);
    if (!id) {
      loginFails += 1;
      if (loginFails >= 8) {
        loginLockedUntil = Date.now() + 60_000;
        loginFails = 0;
      }
      return c.html(landingPage(themeOf(c), "Wrong password"), 401);
    }
    loginFails = 0;
    c.header("Set-Cookie", sessionCookie(id, wantsSecure(c.req.url)));
    return c.redirect("/app", 303);
  });

  app.post("/logout", async (c) => {
    await logout(c.env, c.get("sessionHash"));
    c.header("Set-Cookie", clearSessionCookie(wantsSecure(c.req.url)));
    return c.redirect("/", 303);
  });

  app.get("/app", (c) => c.html(appPage(themeOf(c))));
  app.get("/accounts", async (c) => c.html(accountsPage(themeOf(c), await listAccounts(c.env))));

  app.get("/api/accounts", async (c) => {
    const accounts = await listAccounts(c.env);
    return c.json({
      accounts: accounts.map((account) => ({
        platform: account.platform,
        status: account.status,
        label: account.label,
        updatedAt: account.updatedAt,
      })),
    });
  });

  app.post("/api/accounts/import", async (c) => {
    if (new URL(c.req.url).protocol !== "https:" && !isLocalUrl(c.req.url)) {
      return c.json({ error: "Send cookies over HTTPS" }, 400);
    }
    const length = Number(c.req.header("content-length") || 0);
    if (length > 200_000) return c.json({ error: "Too large" }, 413);
    const data = asObj(await c.req.json().catch(() => null));
    if (!data) return c.json({ error: "Bad request" }, 400);
    const password = typeof data.password === "string" ? data.password : "";
    if (!(await passwordOk(c.env, password))) return c.json({ error: "Wrong password" }, 401);
    const platform = data.platform === "x" || data.platform === "linkedin" ? data.platform : null;
    if (!platform) return c.json({ error: "Platform must be x or linkedin" }, 400);
    const cookies = normalizeImport(data.cookies, platform);
    if (!cookies) return c.json({ error: "Those cookies are missing the session" }, 400);
    if (platform === "x" && (!cookieValue(cookies, "auth_token") || !cookieValue(cookies, "ct0"))) {
      return c.json({ error: "Those cookies are missing the session" }, 400);
    }
    let label: string | null = null;
    let warning: string | null = null;
    try {
      label = platform === "x" ? await xLabel(cookies) : await linkedinLabel(cookies);
    } catch (err) {
      if (err instanceof AccountExpired) {
        try {
          await saveAccount(c.env, platform, "expired", cookies, null);
        } catch (saveErr) {
          return c.json({ error: safeError(saveErr) }, 500);
        }
        return c.json({ error: "The site rejected that session" }, 400);
      }
      warning = "Saved, but the profile check did not answer.";
    }
    try {
      await saveAccount(c.env, platform, "ok", cookies, label);
      await markReady(c.env, platform);
    } catch (err) {
      return c.json({ error: safeError(err) }, 500);
    }
    return c.json({ ok: true, platform, label, warning });
  });

  app.get("/api/posts", async (c) => {
    const posts = await listPosts(c.env);
    const out = [];
    for (const post of posts) out.push(await withMedia(c.env, post));
    return c.json({ posts: out });
  });

  app.post("/api/posts", async (c) => {
    let input: Awaited<ReturnType<typeof readInput>>;
    try {
      input = await readInput(c);
    } catch (err) {
      return c.json({ error: safeError(err) }, 400);
    }
    const check = validate(input);
    if (check.error) return c.json({ error: check.error }, 400);
    const mediaError = await ownMedia(c.env, input.mediaIds, null);
    if (mediaError) return c.json({ error: mediaError }, 400);
    const id = crypto.randomUUID();
    await insertPost(c.env, {
      id,
      status: check.status,
      body: input.body,
      targets: input.targets,
      scheduleAt: check.status === "scheduled" ? input.scheduleAt : null,
    });
    await attachMedia(c.env, id, input.mediaIds);
    if (input.action === "now") {
      const result = await publishPost(c.env, id);
      const saved = await getPost(c.env, id);
      return c.json({ post: saved ? await withMedia(c.env, saved) : null, error: result.error ?? null }, result.ok ? 200 : 502);
    }
    const saved = await getPost(c.env, id);
    return c.json({ post: saved ? await withMedia(c.env, saved) : null });
  });

  app.put("/api/posts/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await getPost(c.env, id);
    if (!existing) return c.json({ error: "Not found" }, 404);
    let input: Awaited<ReturnType<typeof readInput>>;
    try {
      input = await readInput(c);
    } catch (err) {
      return c.json({ error: safeError(err) }, 400);
    }
    const check = validate(input);
    if (check.error) return c.json({ error: check.error }, 400);
    const mediaError = await ownMedia(c.env, input.mediaIds, id);
    if (mediaError) return c.json({ error: mediaError }, 400);
    const previous = await listMedia(c.env, id);
    const updated = await updatePostContent(c.env, id, {
      body: input.body,
      targets: input.targets,
      scheduleAt: check.status === "scheduled" ? input.scheduleAt : null,
      status: check.status,
    });
    if (!updated) return c.json({ error: "That post can no longer be edited" }, 409);
    await attachMedia(c.env, id, input.mediaIds);
    const keep = new Set(input.mediaIds);
    for (const media of previous) {
      if (keep.has(media.id)) continue;
      await c.env.MEDIA.delete(media.r2Key);
      await deleteMediaRow(c.env, media.id);
    }
    if (input.action === "now") await publishPost(c.env, id);
    const saved = await getPost(c.env, id);
    return c.json({ post: saved ? await withMedia(c.env, saved) : null });
  });

  app.post("/api/posts/:id/send", async (c) => {
    const id = c.req.param("id");
    if (!(await getPost(c.env, id))) return c.json({ error: "Not found" }, 404);
    const result = await publishPost(c.env, id);
    const saved = await getPost(c.env, id);
    return c.json({ ok: result.ok, error: result.error ?? null, post: saved ? await withMedia(c.env, saved) : null });
  });

  app.delete("/api/posts/:id", async (c) => {
    const id = c.req.param("id");
    const media = await deletePost(c.env, id);
    for (const item of media) await c.env.MEDIA.delete(item.r2Key);
    return c.json({ ok: true });
  });

  app.get("/api/posts/:id/stats", async (c) => {
    const post = await getPost(c.env, c.req.param("id"));
    if (!post) return c.json({ error: "Not found" }, 404);
    if (!post.xPostId) return c.json({ likes: null, replies: null, error: "X stats are likes and replies. This post has no X id." });
    try {
      const cookies = await loadJar(c.env, "x");
      const stats = await xStats(c.env, cookies, post.xPostId);
      return c.json({ likes: stats.likes, replies: stats.replies, error: null });
    } catch (err) {
      if (err instanceof AccountExpired) await markExpired(c.env, "x");
      return c.json({ likes: null, replies: null, error: safeError(err) });
    }
  });

  app.post("/api/upload", async (c) => {
    const length = Number(c.req.header("content-length") || 0);
    if (length > 6 * 1024 * 1024) return c.json({ error: "Images must be 5MB or smaller" }, 413);
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "Choose an image" }, 400);
    if (file.size > MAX_IMAGE_BYTES) return c.json({ error: "Images must be 5MB or smaller" }, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffImage(bytes);
    if (!type) return c.json({ error: "Use jpeg, png, gif, or webp" }, 400);
    const id = crypto.randomUUID();
    await c.env.MEDIA.put(`img/${id}`, bytes, { httpMetadata: { contentType: type } });
    await insertMedia(c.env, {
      id,
      postId: null,
      r2Key: `img/${id}`,
      contentType: type,
      byteSize: bytes.byteLength,
      createdAt: now(),
    });
    return c.json({ id, contentType: type, byteSize: bytes.byteLength });
  });

  app.get("/media/:id", async (c) => {
    const media = await getMedia(c.env, c.req.param("id"));
    if (!media) return c.text("Not found", 404);
    const object = await c.env.MEDIA.get(media.r2Key);
    if (!object) return c.text("Not found", 404);
    const headers = new Headers();
    headers.set("content-type", media.contentType);
    headers.set("cache-control", "private, max-age=300");
    headers.set("x-content-type-options", "nosniff");
    headers.set("content-security-policy", "default-src 'none'; sandbox");
    return new Response(object.body, { headers });
  });

  app.get("/api/media/remote", async (c) => {
    let url: URL;
    try {
      url = new URL(c.req.query("u") ?? "");
    } catch {
      return c.text("Bad url", 400);
    }
    if (url.protocol !== "https:" || !allowedHost(url.hostname)) return c.text("Bad url", 400);
    const headers = new Headers();
    headers.set("user-agent", "Brief");
    if (url.hostname.endsWith("licdn.com")) {
      try {
        const cookies = await loadJar(c.env, "linkedin");
        headers.set("cookie", cookieHeader(cookies, "linkedin"));
      } catch {
        // Public LinkedIn images still load without a session.
      }
    }
    const res = await fetch(url, { headers, redirect: "manual" });
    if (!res.ok || !res.body) return c.text("Media unavailable", 502);
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/") && !type.startsWith("video/")) return c.text("Media unavailable", 502);
    const size = Number(res.headers.get("content-length") || 0);
    if (size > 20 * 1024 * 1024) return c.text("Too large", 413);
    return new Response(res.body, {
      headers: {
        "content-type": type,
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });

  app.get("/api/feed", async (c) => {
    const tab = c.req.query("tab") ?? "for-you";
    const cursor = c.req.query("cursor") || null;
    try {
      if (tab === "linkedin") {
        return c.json(await linkedinFeed(await loadJar(c.env, "linkedin"), cursor));
      }
      if (tab !== "for-you" && tab !== "following" && tab !== "lists") {
        return c.json({ items: [], cursor: null, error: "Unknown tab" }, 400);
      }
      return c.json(await xFeed(c.env, await loadJar(c.env, "x"), tab, cursor, c.req.query("listId") || null));
    } catch (err) {
      if (err instanceof AccountExpired) await markExpired(c.env, tab === "linkedin" ? "linkedin" : "x");
      return c.json({ items: [], cursor: null, error: safeError(err) });
    }
  });

  app.get("/api/lists", async (c) => {
    try {
      const lists = await xLists(c.env, await loadJar(c.env, "x"));
      return c.json({ lists, error: null });
    } catch (err) {
      if (err instanceof AccountExpired) await markExpired(c.env, "x");
      return c.json({ lists: [], error: safeError(err) });
    }
  });

  app.get("/api/thread", async (c) => {
    const platform = c.req.query("platform");
    const id = c.req.query("id") ?? "";
    if (!id || (platform !== "x" && platform !== "linkedin")) return c.json({ error: "Bad request" }, 400);
    try {
      if (platform === "x") {
        const thread = await xThread(c.env, await loadJar(c.env, "x"), id);
        return c.json({ ...thread, error: null });
      }
      const thread = await linkedinThread(await loadJar(c.env, "linkedin"), id);
      return c.json({
        root: thread.root,
        replies: thread.replies,
        error: thread.commentsFailed
          ? "LinkedIn comments need a real account to verify, and this call failed."
          : thread.root
            ? null
            : "Could not load this post",
      });
    } catch (err) {
      return expire(c, platform, err);
    }
  });

  app.get("/api/profile", async (c) => {
    const platform = c.req.query("platform");
    const handle = (c.req.query("handle") ?? "").replace(/^@/, "");
    const tabQuery = c.req.query("tab");
    const tab = tabQuery === "replies" || tabQuery === "media" ? tabQuery : "posts";
    if (!handle || (platform !== "x" && platform !== "linkedin")) return c.json({ error: "Bad request" }, 400);
    try {
      if (platform === "x") {
        const profile = await xProfile(c.env, await loadJar(c.env, "x"), handle, tab, c.req.query("cursor") || null);
        return c.json({ ...profile, error: null });
      }
      const profile = await linkedinProfile(await loadJar(c.env, "linkedin"), handle);
      return c.json({ ...profile, items: [], cursor: null, error: null });
    } catch (err) {
      if (err instanceof AccountExpired) await markExpired(c.env, platform);
      return c.json({ error: safeError(err) });
    }
  });

  app.post("/api/act", async (c) => {
    const data = asObj(await c.req.json().catch(() => null));
    if (!data) return c.json({ error: "Bad request" }, 400);
    const platform = data.platform === "x" || data.platform === "linkedin" ? data.platform : null;
    const action = typeof data.action === "string" ? data.action : "";
    const id = typeof data.id === "string" ? data.id : "";
    const text = typeof data.text === "string" ? data.text.slice(0, 3000) : "";
    if (!platform || !id) return c.json({ error: "Bad request" }, 400);
    if (platform === "linkedin" && (action === "repost" || action === "quote")) {
      return c.json({ error: "Open the post on LinkedIn" }, 400);
    }
    try {
      if (platform === "x") {
        if (!["like", "unlike", "repost", "unrepost", "reply", "quote"].includes(action)) {
          return c.json({ error: "Unknown action" }, 400);
        }
        await xAct(
          c.env,
          await loadJar(c.env, "x"),
          action as "like" | "unlike" | "repost" | "unrepost" | "reply" | "quote",
          id,
          text,
        );
      } else if (action === "like") await linkedinLike(await loadJar(c.env, "linkedin"), id);
      else if (action === "comment") await linkedinComment(await loadJar(c.env, "linkedin"), id, text);
      else return c.json({ error: "Unknown action" }, 400);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AccountExpired) await markExpired(c.env, platform);
      return c.json({ error: safeError(err) }, 502);
    }
  });

  app.get("/api/time", async (c) => {
    const id = c.req.query("id") ?? "";
    const day = c.req.query("day") ?? "";
    if (!isUuid(id) || !isDay(day)) return c.json({ error: "Bad request" }, 400);
    return c.json(await timeSummary(c.env, id, day));
  });

  app.post("/api/time", async (c) => {
    const data = asObj(await c.req.json().catch(() => null));
    if (!data) return c.json({ error: "Bad request" }, 400);
    const id = typeof data.id === "string" ? data.id : "";
    const day = typeof data.day === "string" ? data.day : "";
    const seconds = typeof data.seconds === "number" ? Math.floor(data.seconds) : 0;
    if (!isUuid(id) || !isDay(day) || seconds < 0 || seconds > 30) return c.json({ error: "Bad request" }, 400);
    if (seconds > 0) await addTime(c.env, id, seconds, day);
    return c.json(await timeSummary(c.env, id, day));
  });
}
