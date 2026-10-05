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
