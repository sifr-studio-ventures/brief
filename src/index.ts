import { Hono } from "hono";
import { assetResponse } from "./assets";
import { runCron } from "./cron";
import { register } from "./routes";
import type { Env } from "./types";
import { pathname } from "./util";
import { readSession } from "./auth";

const CSP = [
  "default-src 'self'",
  "style-src 'self'",
  "script-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: https://video.twimg.com https://*.twimg.com https://*.licdn.com",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const app = new Hono<{ Bindings: Env; Variables: { sessionHash: string } }>();

app.onError((err, c) => {
  console.error(c.req.method, pathname(c.req.url), err.name);
  return c.json({ error: "Something went wrong" }, 500);
});

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  const type = c.res.headers.get("content-type") ?? "";
  if (type.includes("text/html")) {
    c.header("Content-Security-Policy", CSP);
    c.header("Cache-Control", "no-store");
  }
  if (pathname(c.req.url).startsWith("/api/")) c.header("Cache-Control", "no-store");
});

function isPublic(method: string, path: string): boolean {
  const read = method === "GET" || method === "HEAD";
  if (read && (path === "/" || path === "/app.css" || path === "/app.js" || path === "/logo.svg" || path === "/favicon.svg" || path === "/favicon.ico" || path === "/favicon.png" || path.startsWith("/fonts/"))) {
    return true;
  }
  if (method === "POST" && (path === "/login" || path === "/api/accounts/import")) return true;
  return false;
}

app.use("*", async (c, next) => {
  const path = pathname(c.req.url);
  const asset = assetResponse(path);
  if (asset) return asset;
  if (path === "/app.css" || path === "/app.js" || path === "/logo.svg" || path === "/favicon.svg" || path.startsWith("/fonts/")) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  if (!isPublic(c.req.method, path)) {
    const session = await readSession(c.env, c.req.header("cookie"));
    if (!session) {
      if (path.startsWith("/api/") || path.startsWith("/media/")) return c.json({ error: "Sign in" }, 401);
      return c.redirect("/");
    }
    c.set("sessionHash", session);
  }
  return next();
});

register(app);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env));
  },
};
