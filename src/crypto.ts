import type { Env } from "./types";

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

export async function passwordOk(env: Env, given: string): Promise<boolean> {
  const secret = env.APP_PASSWORD?.trim() ?? "";
  if (!secret || !given) return false;
  const [a, b] = await Promise.all([sha256Hex(secret), sha256Hex(given)]);
  return timingSafeEqual(a, b);
}

function bytesToB64(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}

function b64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function sessionKey(env: Env): Promise<CryptoKey> {
  const trimmed = env.SESSION_KEY?.trim() ?? "";
  if (!trimmed) throw new Error("SESSION_KEY is not set");
  let bytes: Uint8Array;
  try {
    bytes = b64ToBytes(trimmed);
  } catch {
    throw new Error("SESSION_KEY must decode to 32 bytes");
  }
  if (bytes.byteLength !== 32) throw new Error("SESSION_KEY must decode to 32 bytes");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptString(env: Env, plain: string): Promise<string> {
  const key = await sessionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)),
  );
  const packed = new Uint8Array(iv.byteLength + cipher.byteLength);
  packed.set(iv, 0);
  packed.set(cipher, iv.byteLength);
  return bytesToB64(packed);
}

export async function decryptString(env: Env, packed: string): Promise<string> {
  const key = await sessionKey(env);
  const bytes = b64ToBytes(packed);
  if (bytes.byteLength < 13) throw new Error("Could not decrypt");
  const iv = bytes.slice(0, 12);
  const cipher = bytes.slice(12);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("Could not decrypt");
  }
}
