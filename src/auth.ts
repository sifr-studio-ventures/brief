import { passwordOk, sha256Hex } from "./crypto";
import { createSession, deleteSession, getSession } from "./db";
import type { Env } from "./types";
import { now, readCookie, SESSION_DAYS } from "./util";

const COOKIE = "brief_session";

export function sessionCookie(id: string, secure: boolean): string {
  const parts = [
    `${COOKIE}=${id}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [`${COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function wantsSecure(url: string): boolean {
  return new URL(url).protocol === "https:";
}

export async function login(env: Env, password: string): Promise<string | null> {
  if (!(await passwordOk(env, password))) return null;
  const id = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const hash = await sha256Hex(id);
  const created = now();
  await createSession(env, hash, created + SESSION_DAYS * 86400, created);
  return id;
}

export async function readSession(env: Env, cookie: string | undefined): Promise<string | null> {
  const raw = readCookie(cookie, COOKIE);
  if (!raw || raw.length < 16) return null;
  const hash = await sha256Hex(raw);
  const row = await getSession(env, hash);
  if (!row || row.expires_at < now()) {
    if (row) await deleteSession(env, hash);
    return null;
  }
  return hash;
}

export async function logout(env: Env, hash: string): Promise<void> {
  await deleteSession(env, hash);
}
