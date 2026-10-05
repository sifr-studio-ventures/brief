import type { JarCookie } from "./cookies";
import { cookieHeader, cookieValue } from "./cookies";
import { AccountExpired, type FeedItem, type FeedPage } from "./types";
import { asObj, extFor, firstString } from "./util";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type MapUrn = Map<string, Record<string, unknown>>;

function csrf(cookies: JarCookie[]): string {
  return cookieValue(cookies, "JSESSIONID").replace(/^"|"$/g, "");
}

function headers(cookies: JarCookie[], json = false): Headers {
  const out = new Headers();
  out.set("cookie", cookieHeader(cookies, "linkedin"));
  out.set("csrf-token", csrf(cookies));
  out.set("x-restli-protocol-version", "2.0.0");
  out.set("x-li-lang", "en_US");
  out.set("accept", "application/vnd.linkedin.normalized+json+2.1");
  out.set("user-agent", UA);
  out.set("x-li-track", '{"clientVersion":"1.13.0","osName":"web"}');
  if (json) out.set("content-type", "application/json");
  return out;
}

async function li(
  cookies: JarCookie[],
  path: string,
  init?: { method?: string; json?: unknown },
): Promise<{ status: number; json: unknown }> {
  if (!cookieValue(cookies, "li_at") || !csrf(cookies)) throw new Error("LinkedIn session is missing li_at or JSESSIONID");
  const res = await fetch(`https://www.linkedin.com${path}`, {
    method: init?.method ?? "GET",
    headers: headers(cookies, init?.json !== undefined),
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
    redirect: "manual",
  });
  const location = res.headers.get("location") ?? "";
  if (res.status === 401 || res.status === 403) throw new AccountExpired();
  if ((res.status === 301 || res.status === 302 || res.status === 303) && /login|authwall|checkpoint/i.test(location)) {
    throw new AccountExpired();
  }
  const text = await res.text();
  if (/<html/i.test(text.slice(0, 200)) && /authwall|sign in to linkedin|uas\/login/i.test(text.slice(0, 1500))) {
    throw new AccountExpired();
  }
  try {
    return { status: res.status, json: JSON.parse(text) as unknown };
  } catch {
    return { status: res.status, json: null };
  }
}

function urnMap(json: unknown): MapUrn {
  const map: MapUrn = new Map();
  const included = asObj(json)?.included;
  if (!Array.isArray(included)) return map;
  for (const item of included) {
    const obj = asObj(item);
    if (!obj) continue;
    const urn = firstString(obj.entityUrn, obj.urn);
    if (urn) map.set(urn, obj);
  }
  return map;
}

function resolve(map: MapUrn, value: unknown): Record<string, unknown> | null {
  if (typeof value === "string" && value.startsWith("urn:")) return map.get(value) ?? null;
  return asObj(value);
}

function textOf(node: unknown, depth = 0): string {
  if (depth > 5 || node == null) return "";
  if (typeof node === "string") {
    if (node.startsWith("urn:") || node.startsWith("*")) return "";
    return node;
  }
  const obj = asObj(node);
  if (!obj) return "";
  if (typeof obj.text === "string") return obj.text;
  const nested = textOf(obj.text, depth + 1);
  if (nested) return nested;
  return "";
}

function sponsored(update: Record<string, unknown>, map: MapUrn): boolean {
  const header = resolve(map, update.header) ?? asObj(update.header);
  if (/^promoted$/i.test(textOf(header))) return true;
  const actor = resolve(map, update.actor) ?? resolve(map, update["*actor"]) ?? asObj(update.actor);
  if (/promoted/i.test(textOf(actor ? asObj(actor.subDescription) ?? actor.subDescription : null))) return true;
  const tracking = asObj(asObj(update.updateMetadata)?.trackingData);
  if (tracking?.sponsoredTracking) return true;
  const urn = firstString(update.entityUrn, asObj(update.updateMetadata)?.urn);
  return /sponsored/i.test(urn);
}

function imageUrls(node: unknown, out: string[], depth = 0): void {
  if (depth > 7 || out.length > 8 || node == null) return;
  if (typeof node === "string") {
    if (/^https:\/\/[^"']*(?:licdn\.com|linkedin\.com)\/[^"']+\.(?:jpg|jpeg|png|gif|webp)(?:\?|$)/i.test(node)) {
      out.push(node.split("?")[0] + (node.includes("?") ? "" : ""));
      if (/^https:\/\//.test(node)) out[out.length - 1] = node;
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) imageUrls(item, out, depth + 1);
    return;
  }
  const obj = asObj(node);
  if (!obj) return;
  const root = firstString(obj.rootUrl);
  if (root.startsWith("https://")) out.push(root);
  for (const value of Object.values(obj)) imageUrls(value, out, depth + 1);
}

function unique(urls: string[]): string[] {
  return [...new Set(urls.filter((url) => url.startsWith("https://")))].slice(0, 4);
}

function actorOf(update: Record<string, unknown>, map: MapUrn): { name: string; handle: string; avatar: string } {
  const actor = resolve(map, update.actor) ?? resolve(map, update["*actor"]) ?? asObj(update.actor);
  if (!actor) return { name: "", handle: "", avatar: "" };
  const mini = resolve(map, actor["*miniProfile"]) ?? asObj(actor.miniProfile);
  const name =
    textOf(actor.name) ||
    [firstString(mini?.firstName), firstString(mini?.lastName)].filter(Boolean).join(" ");
  const nav = asObj(actor.navigationContext);
  const target = firstString(nav?.actionTarget, actor.navigationUrl);
  const slug = target.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1] ?? firstString(mini?.publicIdentifier);
  const images: string[] = [];
  imageUrls(actor.image ?? mini?.picture, images);
  return { name, handle: decodeURIComponent(slug || ""), avatar: images[0] ?? "" };
}

function videoOf(update: Record<string, unknown>): FeedItem["video"] {
  const urls: string[] = [];
  const posters: string[] = [];
  const walk = (node: unknown, depth: number) => {
    if (depth > 7 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const obj = asObj(node);
    if (!obj) return;
    const url = firstString(obj.streamingUrl, obj.url);
    if (/\.mp4(\?|$)/i.test(url) || firstString(obj.contentType).includes("video")) {
      if (url.startsWith("https://")) urls.push(url);
    }
    const poster = firstString(obj.thumbnailUrl, obj.rootUrl);
    if (poster.startsWith("https://") && /image|media|licdn/i.test(poster)) posters.push(poster);
    for (const value of Object.values(obj)) walk(value, depth + 1);
  };
  walk(update.content ?? update, 0);
  if (!urls.length) return null;
  return { url: urls[0], poster: posters[0] ?? "", gif: false };
}

function articleOf(update: Record<string, unknown>, map: MapUrn): FeedItem["article"] {
  const content = resolve(map, update.content) ?? asObj(update.content);
  if (!content) return null;
  const article = resolve(map, content.article) ?? asObj(content.article) ?? content;
  const title = textOf(article.title) || textOf(article);
  const nav = asObj(article.navigationContext);
  const url = firstString(nav?.actionTarget, article.url, article.navigationUrl);
  if (!title || !url.startsWith("http")) return null;
  const images: string[] = [];
  imageUrls(article, images);
  return { title, url, image: images[0] ?? "" };
}

function itemFrom(update: Record<string, unknown>, map: MapUrn): FeedItem | null {
  if (sponsored(update, map)) return null;
  const actor = actorOf(update, map);
  const commentary = resolve(map, update.commentary) ?? asObj(update.commentary);
  const text = textOf(commentary) || textOf(update.commentary);
  const images: string[] = [];
  imageUrls(update.content, images);
  const reshared = resolve(map, update.resharedUpdate) ?? resolve(map, update["*resharedUpdate"]) ?? asObj(update.resharedUpdate);
  let reshare: FeedItem["reshare"] = null;
  if (reshared && !sponsored(reshared, map)) {
    const who = actorOf(reshared, map);
    const shareText = textOf(resolve(map, reshared.commentary) ?? reshared.commentary);
    if (who.name || shareText) reshare = { name: who.name, handle: who.handle, text: shareText };
    imageUrls(reshared.content, images);
  }
  const urn = firstString(update.entityUrn, asObj(update.updateMetadata)?.urn, update.urn);
  if (!text && !images.length && !reshare && !actor.name) return null;
  const social = resolve(map, update.socialDetail) ?? asObj(update.socialDetail);
  const counts = asObj(social?.totalSocialActivityCounts) ?? asObj(update.socialCounts);
  return {
    id: urn || text.slice(0, 40),
    platform: "linkedin",
    name: actor.name,
    handle: actor.handle,
    avatar: actor.avatar,
    text,
    time: "",
    counts: {
      likes: Number(counts?.numLikes ?? counts?.likes ?? 0) || 0,
      replies: Number(counts?.numComments ?? counts?.comments ?? 0) || 0,
      reposts: Number(counts?.numShares ?? 0) || 0,
    },
    images: unique(images),
    video: videoOf(update),
    quote: null,
    replyTo: null,
    repostedBy: null,
    article: articleOf(update, map),
    reshare,
    url: urn ? `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}` : "https://www.linkedin.com/feed/",
    liked: Boolean(counts?.liked),
    reposted: false,
  };
}

function updatesFrom(json: unknown): FeedItem[] {
  const map = urnMap(json);
  const root = asObj(json);
  const elements = Array.isArray(root?.elements) ? root.elements : [];
  const included = Array.isArray(root?.included) ? root.included : [];
  const pool = [...elements, ...included];
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  for (const entry of pool) {
    const obj = asObj(entry);
    if (!obj) continue;
    const type = firstString(obj.$type);
    const urn = firstString(obj.entityUrn);
    const looks =
      type.includes("Update") ||
      urn.includes("feedUpdate") ||
      urn.includes("activity") ||
      obj.commentary != null ||
      obj.actor != null;
    if (!looks) continue;
    const item = itemFrom(obj, map);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

export async function linkedinFeed(cookies: JarCookie[], cursor: string | null): Promise<FeedPage> {
  const start = Number(cursor ?? "0");
  const offset = Number.isFinite(start) && start >= 0 ? start : 0;
  const paths = [
    `/voyager/api/feed/updatesV2?count=20&start=${offset}&q=chronologicalFeed`,
    `/voyager/api/feed/updatesV2?count=20&start=${offset}&q=feed`,
    `/voyager/api/feed/updates?count=20&start=${offset}`,
  ];
  let lastStatus = 0;
  for (const path of paths) {
    const res = await li(cookies, path);
    lastStatus = res.status;
    if (res.status === 404 || res.status >= 500 || res.json == null) continue;
    const items = updatesFrom(res.json);
    if (!items.length && res.status >= 400) continue;
    return { items, cursor: String(offset + items.length), error: null };
  }
  return { items: [], cursor: null, error: `LinkedIn feed failed (${lastStatus || "no response"})` };
}

export async function linkedinThread(
  cookies: JarCookie[],
  urn: string,
): Promise<{ root: FeedItem | null; replies: FeedItem[]; commentsFailed: boolean }> {
  const encoded = encodeURIComponent(urn);
  const post = await li(cookies, `/voyager/api/feed/updatesV2?q=postSlug&urn=${encoded}`).catch(() => null);
  const items = post?.json ? updatesFrom(post.json) : [];
  const root = items.find((item) => item.id === urn) ?? items[0] ?? null;
  const comments = await li(
    cookies,
    `/voyager/api/voyagerSocialDashComments?count=20&q=comments&threadUrn=${encoded}`,
  );
  if (comments.status >= 400 || comments.json == null) {
    return { root, replies: [], commentsFailed: true };
  }
  const map = urnMap(comments.json);
  const replies: FeedItem[] = [];
  const included = Array.isArray(asObj(comments.json)?.included) ? (asObj(comments.json)?.included as unknown[]) : [];
  const elements = Array.isArray(asObj(comments.json)?.elements) ? (asObj(comments.json)?.elements as unknown[]) : [];
  for (const entry of [...elements, ...included]) {
    const obj = asObj(entry);
    if (!obj) continue;
    const type = firstString(obj.$type);
    if (!type.toLowerCase().includes("comment") && !obj.comment) continue;
    const comment = resolve(map, obj.comment) ?? obj;
    const text = textOf(comment.commentary) || textOf(comment.message) || textOf(comment);
    if (!text) continue;
    const who = actorOf(comment, map);
    replies.push({
      id: firstString(comment.entityUrn, comment.urn) || text.slice(0, 24),
      platform: "linkedin",
      name: who.name,
      handle: who.handle,
      avatar: who.avatar,
      text,
      time: "",
      counts: { likes: 0, replies: 0, reposts: 0 },
      images: [],
      video: null,
      quote: null,
      replyTo: null,
      repostedBy: null,
      article: null,
      reshare: null,
      url: root?.url ?? "https://www.linkedin.com/feed/",
      liked: false,
      reposted: false,
    });
  }
  return { root, replies, commentsFailed: false };
}

export async function linkedinProfile(cookies: JarCookie[], handle: string): Promise<{
  name: string;
  handle: string;
  bio: string;
  banner: string;
  avatar: string;
  counts: { posts: number; following: number; followers: number };
}> {
  const slug = handle.replace(/^@/, "");
  const dash = await li(cookies, `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(slug)}`);
  const legacy = dash.status >= 400 ? await li(cookies, `/voyager/api/identity/profiles/${encodeURIComponent(slug)}/profileView`) : dash;
  if (legacy.status >= 400 || legacy.json == null) throw new Error("LinkedIn profile failed");
  const map = urnMap(legacy.json);
  const blobs = [...map.values(), ...((Array.isArray(asObj(legacy.json)?.elements) ? asObj(legacy.json)!.elements : []) as unknown[])];
  let name = "";
  let bio = "";
  let avatar = "";
  let banner = "";
  let followers = 0;
  for (const entry of blobs) {
    const obj = asObj(entry);
    if (!obj) continue;
    const full = [firstString(obj.firstName), firstString(obj.lastName)].filter(Boolean).join(" ");
    if (full && !name) name = full;
    if (!bio) bio = firstString(obj.headline, textOf(obj.summary));
    const images: string[] = [];
    imageUrls(obj.profilePicture ?? obj.picture, images);
    if (images[0] && !avatar) avatar = images[0];
    imageUrls(obj.backgroundPicture, images);
    if (images[1] && !banner) banner = images[1];
    const count = Number(obj.followerCount ?? obj.numFollowers ?? 0);
    if (count) followers = count;
  }
  if (!name && !bio) throw new Error("LinkedIn profile failed");
  return {
    name,
    handle: slug,
    bio,
    banner,
    avatar,
    counts: { posts: 0, following: 0, followers },
  };
}

export async function linkedinLike(cookies: JarCookie[], urn: string): Promise<void> {
  const res = await li(cookies, `/voyager/api/voyagerSocialDashReactions?threadUrn=${encodeURIComponent(urn)}`, {
    method: "POST",
    json: { reactionType: "LIKE" },
  });
  if (res.status >= 400) throw new Error("LinkedIn like failed");
}

export async function linkedinComment(cookies: JarCookie[], urn: string, text: string): Promise<void> {
  if (!text.trim()) throw new Error("Write a comment first");
  const res = await li(cookies, "/voyager/api/voyagerSocialDashNormComments", {
    method: "POST",
    json: {
      commentary: { text: text.trim(), attributesV2: [] },
      threadUrn: urn,
    },
  });
  if (res.status >= 400) {
    const fallback = await li(cookies, "/voyager/api/voyagerSocialDashNormComments?decorationId=com.linkedin.voyager.dash.deco.social.NormComment-22", {
      method: "POST",
      json: { commentary: { text: text.trim(), attributesV2: [] }, threadUrn: urn },
    });
    if (fallback.status >= 400) throw new Error("LinkedIn comment failed");
  }
}

async function uploadImage(cookies: JarCookie[], bytes: Uint8Array, type: string): Promise<string> {
  const meta = await li(cookies, "/voyager/api/voyagerMediaUploadMetadata?action=upload", {
    method: "POST",
    json: { mediaUploadType: "IMAGE_SHARING", fileSize: bytes.byteLength, filename: `image${extFor(type)}` },
  });
  const obj = asObj(meta.json) ?? asObj(asObj(meta.json)?.value);
  const uploadUrl = firstString(obj?.singleUploadUrl, obj?.uploadUrl, asObj(obj?.value)?.singleUploadUrl);
  const urn = firstString(obj?.urn, asObj(obj?.value)?.urn);
  if (meta.status >= 400 || !uploadUrl.startsWith("https://") || !urn) throw new Error("LinkedIn image upload failed");
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": type },
    body: bytes,
  });
  if (!put.ok) throw new Error("LinkedIn image upload failed");
  return urn;
}

export async function postLinkedIn(cookies: JarCookie[], text: string, images: { bytes: Uint8Array; type: string }[]): Promise<string> {
  const media = [];
  for (const image of images) {
    const urn = await uploadImage(cookies, image.bytes, image.type);
    media.push({ category: "IMAGE", mediaUrn: urn, tapTargets: [] });
  }
  const body: Record<string, unknown> = {
    visibleToConnectionsOnly: false,
    externalAudienceProviders: [],
    commentaryV2: { text, attributes: [] },
    origin: "FEED",
    allowedCommentersScope: "ALL",
    postState: "PUBLISHED",
  };
  if (media.length) body.media = media;
  let res = await li(cookies, "/voyager/api/contentcreation/normShares", { method: "POST", json: body });
  if (res.status === 404) {
    res = await li(cookies, "/voyager/api/voyagerContentcreationDashShares", { method: "POST", json: body });
  }
  if (res.status >= 400 || res.json == null) throw new Error("LinkedIn post failed");
  const urn = findUrn(res.json);
  if (!urn) throw new Error("LinkedIn did not return a post id");
  return urn;
}

function findUrn(node: unknown, depth = 0): string {
  if (depth > 6 || node == null) return "";
  if (typeof node === "string" && node.includes("urn:li:activity")) return node;
  if (typeof node !== "object") return "";
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findUrn(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  const obj = asObj(node);
  if (!obj) return "";
  for (const value of Object.values(obj)) {
    const found = findUrn(value, depth + 1);
    if (found) return found;
  }
  return "";
}

export async function linkedinLabel(cookies: JarCookie[]): Promise<string | null> {
  const res = await li(cookies, "/voyager/api/me");
  if (res.status >= 400 || res.json == null) return null;
  const map = urnMap(res.json);
  for (const obj of map.values()) {
    const slug = firstString(obj.publicIdentifier);
    if (slug) return slug.slice(0, 60);
    const name = [firstString(obj.firstName), firstString(obj.lastName)].filter(Boolean).join(" ");
    if (name) return name.slice(0, 60);
  }
  const mini = asObj(asObj(res.json)?.miniProfile);
  const slug = firstString(mini?.publicIdentifier);
  return slug ? slug.slice(0, 60) : null;
}
