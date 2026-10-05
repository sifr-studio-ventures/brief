export type JarCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
};

function domainOk(domain: string, site: "x" | "linkedin"): boolean {
  const host = domain.toLowerCase().replace(/^\./, "");
  if (site === "x") {
    return host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com");
  }
  return host === "linkedin.com" || host.endsWith(".linkedin.com");
}

export function parseJar(raw: string): JarCookie[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: JarCookie[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string" || typeof rec.value !== "string" || typeof rec.domain !== "string") continue;
    if (!/^[A-Za-z0-9_-]+$/.test(rec.name)) continue;
    out.push({
      name: rec.name,
      value: rec.value.replace(/[\r\n;]/g, ""),
      domain: rec.domain,
      path: typeof rec.path === "string" ? rec.path : "/",
    });
  }
  return out;
}

export function cookieHeader(cookies: JarCookie[], site: "x" | "linkedin"): string {
  return cookies
    .filter((cookie) => domainOk(cookie.domain, site))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export function cookieValue(cookies: JarCookie[], name: string): string {
  return cookies.find((cookie) => cookie.name === name)?.value ?? "";
}

export function normalizeImport(value: unknown, site: "x" | "linkedin"): JarCookie[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 80) return null;
  const cookies = parseJar(JSON.stringify(value)).filter((cookie) => domainOk(cookie.domain, site));
  if (!cookies.length) return null;
  const names = new Set(cookies.map((cookie) => cookie.name));
  if (site === "x" && (!names.has("auth_token") || !names.has("ct0"))) return null;
  if (site === "linkedin" && (!names.has("li_at") || !names.has("JSESSIONID"))) return null;
  const size = cookies.reduce((sum, cookie) => sum + cookie.value.length, 0);
  if (size > 80_000) return null;
  return cookies;
}
