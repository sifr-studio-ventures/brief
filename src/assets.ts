import { ico, latin400, latin500, latinExt400, latinExt500, png } from "./asset-b64";

const files: Record<string, { type: string; base64: string }> = {
  "/favicon.png": { type: "image/png", base64: png },
  "/favicon.ico": { type: "image/vnd.microsoft.icon", base64: ico },
  "/fonts/outfit-latin-400-normal.woff2": { type: "font/woff2", base64: latin400 },
  "/fonts/outfit-latin-500-normal.woff2": { type: "font/woff2", base64: latin500 },
  "/fonts/outfit-latin-ext-400-normal.woff2": { type: "font/woff2", base64: latinExt400 },
  "/fonts/outfit-latin-ext-500-normal.woff2": { type: "font/woff2", base64: latinExt500 },
};

export function assetResponse(path: string): Response | null {
  const file = files[path];
  if (!file) return null;
  const binary = atob(file.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      "content-type": file.type,
      "cache-control": "public, max-age=86400",
    },
  });
}
