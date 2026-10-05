import type { JarCookie } from "./cookies";
import { cookieHeader, cookieValue } from "./cookies";
import { getQueryId, loadFeatures, saveFeatures, saveQueryIds } from "./db";
import { AccountExpired, type Env, type FeedItem, type FeedPage } from "./types";
import { asObj, firstString } from "./util";

const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BASE_FEATURES: Record<string, boolean> = {
  rweb_video_screen_enabled: false,
  responsive_web_graphql_exclude_directive_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  rweb_tipjar_consumption_enabled: false,
  articles_preview_enabled: true,
};

const FIELD_TOGGLES = {
  withArticleRichContentState: false,
  withArticlePlainText: false,
};

const MUTATIONS = new Set(["CreateTweet", "FavoriteTweet", "UnfavoriteTweet", "CreateRetweet", "DeleteRetweet"]);

function headers(cookies: JarCookie[], json = false): Headers {
  const out = new Headers();
  out.set("authorization", `Bearer ${BEARER}`);
  out.set("cookie", cookieHeader(cookies, "x"));
  out.set("x-csrf-token", cookieValue(cookies, "ct0"));
  out.set("x-twitter-auth-type", "OAuth2Session");
  out.set("x-twitter-active-user", "yes");
  out.set("x-twitter-client-language", "en");
  out.set("user-agent", UA);
  out.set("origin", "https://x.com");
  out.set("referer", "https://x.com/");
  if (json) out.set("content-type", "application/json");
  return out;
}

function messages(json: unknown): string[] {
  const errors = asObj(json)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((item) => firstString(asObj(item)?.message)).filter(Boolean);
}

function missingFeatures(json: unknown): string[] {
  const text = messages(json).join(" ");
  const match = text.match(/features?(?:[^:]{0,80}):\s*([a-z0-9_,\s]+)/i);
  if (!match) return [];
  return match[1]
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter((name) => /^[a-z][a-z0-9_]{2,}$/.test(name));
}

function authFailed(status: number, json: unknown): boolean {
  if (status === 401 || status === 403) return true;
  const errors = asObj(json)?.errors;
  if (!Array.isArray(errors)) return false;
  for (const item of errors) {
    const code = asObj(item)?.code;
    if (code === 32 || code === 89 || code === 215) return true;
    const message = firstString(asObj(item)?.message).toLowerCase();
    if (message.includes("could not authenticate") || message.includes("not authenticated")) return true;
  }
  return false;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (/\/i\/flow\/login|LoginForm/.test(text.slice(0, 800))) throw new AccountExpired();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { errors: [{ message: `X returned a non-JSON response (${res.status})` }] };
  }
}

export async function scanQueryIds(env: Env, cookies: JarCookie[]): Promise<number> {
  const home = await fetch("https://x.com/", { headers: headers(cookies), redirect: "follow" });
  const html = await home.text();
  if (home.status === 401 || home.status === 403) throw new AccountExpired();
  const srcs = new Set<string>();
  for (const match of html.matchAll(/(?:src|href)="([^"]+\.js)"/g)) {
    let url = match[1];
    if (url.startsWith("//")) url = `https:${url}`;
    else if (url.startsWith("/")) url = `https://x.com${url}`;
    if (url.includes("abs.twimg.com") || url.includes("client-web")) srcs.add(url);
  }
  const ranked = [...srcs]
    .sort((a, b) => Number(/main\.|bundle/.test(b)) - Number(/main\.|bundle/.test(a)))
    .slice(0, 5);
  if (!ranked.length) throw new Error("Could not read X's web client");
  const found: Record<string, string> = {};
  const patterns: [RegExp, boolean][] = [
    [/queryId:"([A-Za-z0-9_-]{8,})",operationName:"([A-Za-z0-9_]+)"/g, true],
    [/operationName:"([A-Za-z0-9_]+)",queryId:"([A-Za-z0-9_-]{8,})"/g, false],
    [/"queryId":"([A-Za-z0-9_-]{8,})","operationName":"([A-Za-z0-9_]+)"/g, true],
    [/"operationName":"([A-Za-z0-9_]+)","queryId":"([A-Za-z0-9_-]{8,})"/g, false],
  ];
  for (const url of ranked) {
    const res = await fetch(url, { headers: { "user-agent": UA } });
    if (!res.ok) continue;
    const js = (await res.text()).slice(0, 2_500_000);
    for (const [pattern, queryFirst] of patterns) {
      for (const match of js.matchAll(pattern)) {
        const queryId = queryFirst ? match[1] : match[2];
        const operation = queryFirst ? match[2] : match[1];
        if (/^[A-Za-z][A-Za-z0-9_]+$/.test(operation) && /^[A-Za-z0-9_-]{8,}$/.test(queryId)) {
          found[operation] = queryId;
        }
      }
    }
  }
  await saveQueryIds(env, found);
  return Object.keys(found).length;
}

async function featuresFor(env: Env): Promise<Record<string, boolean>> {
  return { ...BASE_FEATURES, ...(await loadFeatures(env)) };
}

async function callOp(
  env: Env,
  cookies: JarCookie[],
  operation: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  if (!cookieValue(cookies, "ct0") || !cookieValue(cookies, "auth_token")) {
    throw new Error("X session is missing auth_token or ct0");
  }
  let features = await featuresFor(env);
  let rescanned = false;
  let queryId = await getQueryId(env, operation);
  if (!queryId) {
    await scanQueryIds(env, cookies);
    rescanned = true;
    queryId = await getQueryId(env, operation);
  }
  if (!queryId) throw new Error(`X has no query id for ${operation}`);

  for (let attempt = 0; attempt < 4; attempt++) {
    const method = MUTATIONS.has(operation) ? "POST" : "GET";
    const endpoint = `https://x.com/i/api/graphql/${queryId}/${operation}`;
    let res: Response;
    if (method === "POST") {
      res = await fetch(endpoint, {
        method: "POST",
        headers: headers(cookies, true),
        body: JSON.stringify({ variables, features, fieldToggles: FIELD_TOGGLES, queryId }),
      });
    } else {
      const url = new URL(endpoint);
      url.searchParams.set("variables", JSON.stringify(variables));
      url.searchParams.set("features", JSON.stringify(features));
      url.searchParams.set("fieldToggles", JSON.stringify(FIELD_TOGGLES));
      res = await fetch(url, { headers: headers(cookies) });
    }
    const json = await readBody(res);
    if (authFailed(res.status, json)) throw new AccountExpired();
    if (res.status === 404 && !rescanned) {
      await scanQueryIds(env, cookies);
      rescanned = true;
      queryId = (await getQueryId(env, operation)) ?? queryId;
      continue;
    }
    const missing = missingFeatures(json).filter((name) => !(name in features));
    if (missing.length) {
      for (const name of missing) features[name] = false;
      await saveFeatures(env, missing, false);
      continue;
    }
    const errs = messages(json);
    if (errs.length && !asObj(json)?.data) throw new Error(errs[0] || "X rejected the request");
    return json;
  }
  throw new Error(`X rejected ${operation}`);
}

function unwrapTweet(result: unknown): Record<string, unknown> | null {
  let node = asObj(result);
  if (!node) return null;
  const typename = firstString(node.__typename);
  if (typename === "TweetWithVisibilityResults" || (asObj(node.tweet) && !asObj(node.legacy))) {
    node = asObj(node.tweet);
  }
  if (!node) return null;
  if (!asObj(node.legacy) && !node.rest_id) return null;
  return node;
}

function userOf(tweet: Record<string, unknown>): { name: string; handle: string; avatar: string } {
  const user = asObj(dig(tweet, ["core", "user_results", "result"]));
  const legacy = asObj(user?.legacy);
  const core = asObj(user?.core);
  const avatar = asObj(user?.avatar);
  return {
    name: firstString(legacy?.name, core?.name, user?.name),
    handle: firstString(legacy?.screen_name, core?.screen_name),
    avatar: firstString(legacy?.profile_image_url_https, avatar?.image_url).replace("_normal", "_bigger"),
  };
}

function dig(root: unknown, path: string[]): unknown {
  let cur = root;
  for (const key of path) {
    const obj = asObj(cur);
    if (!obj) return undefined;
    cur = obj[key];
  }
  return cur;
}

function textOf(tweet: Record<string, unknown>): string {
  const note = dig(tweet, ["note_tweet", "note_tweet_results", "result", "text"]);
  if (typeof note === "string" && note) return note;
  return firstString(asObj(tweet.legacy)?.full_text);
}

function mediaOf(tweet: Record<string, unknown>): { images: string[]; video: FeedItem["video"] } {
  const legacy = asObj(tweet.legacy);
  const extended = asObj(legacy?.extended_entities);
  const entities = asObj(legacy?.entities);
  const list = Array.isArray(extended?.media) ? extended.media : Array.isArray(entities?.media) ? entities.media : [];
  const images: string[] = [];
  let video: FeedItem["video"] = null;
  for (const item of list) {
    const media = asObj(item);
    if (!media) continue;
    const type = firstString(media.type);
    const url = firstString(media.media_url_https);
    if (type === "photo" && url) images.push(url);
    if ((type === "video" || type === "animated_gif") && !video) {
      const info = asObj(media.video_info);
      const variants = Array.isArray(info?.variants) ? info.variants : [];
      let best = "";
      let bitrate = -1;
      for (const variant of variants) {
        const row = asObj(variant);
        if (!row || firstString(row.content_type) !== "video/mp4") continue;
        const rate = typeof row.bitrate === "number" ? row.bitrate : 0;
        if (rate >= bitrate && typeof row.url === "string") {
          bitrate = rate;
          best = row.url;
        }
      }
      if (best) video = { url: best, poster: url, gif: type === "animated_gif" };
    }
  }
  return { images, video };
}

function quoteOf(tweet: Record<string, unknown>): FeedItem["quote"] {
  const quoted = unwrapTweet(dig(tweet, ["quoted_status_result", "result"]) ?? dig(tweet, ["legacy", "quoted_status_result", "result"]));
  if (!quoted) return null;
  const user = userOf(quoted);
  const media = mediaOf(quoted);
  return { name: user.name, handle: user.handle, text: textOf(quoted), images: media.images.slice(0, 4) };
}

export function toFeedItem(tweet: Record<string, unknown>, repostedBy: string | null = null): FeedItem | null {
  const legacy = asObj(tweet.legacy);
  const retweet = unwrapTweet(legacy?.retweeted_status_result && dig(legacy.retweeted_status_result, ["result"]));
  if (retweet) {
    const by = userOf(tweet);
    return toFeedItem(retweet, by.name || by.handle || "Someone");
  }
  const user = userOf(tweet);
  const id = firstString(tweet.rest_id, legacy?.id_str);
  if (!id) return null;
  const media = mediaOf(tweet);
  return {
    id,
    platform: "x",
    name: user.name,
    handle: user.handle,
    avatar: user.avatar,
    text: textOf(tweet),
    time: firstString(legacy?.created_at),
    counts: {
      likes: Number(legacy?.favorite_count ?? 0) || 0,
      replies: Number(legacy?.reply_count ?? 0) || 0,
      reposts: Number(legacy?.retweet_count ?? 0) || 0,
    },
    images: media.images,
    video: media.video,
    quote: quoteOf(tweet),
    replyTo: firstString(legacy?.in_reply_to_screen_name) || null,
    repostedBy,
    article: null,
    reshare: null,
    url: `https://x.com/${user.handle || "i"}/status/${id}`,
    liked: Boolean(legacy?.favorited),
    reposted: Boolean(legacy?.retweeted),
  };
}

function walkInstructions(root: unknown): { tweets: Record<string, unknown>[]; cursor: string | null } {
  const tweets: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 9 || node == null || seen.has(node)) return;
    if (typeof node !== "object") return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const obj = asObj(node);
    if (!obj) return;
    if (obj.cursorType === "Bottom" && typeof obj.value === "string") cursor = obj.value;
    const entryId = firstString(obj.entryId, obj.entryId);
    if (entryId.toLowerCase().includes("promoted") || obj.promotedMetadata) return;
    if (obj.itemContent) {
      const tweet = unwrapTweet(dig(obj, ["itemContent", "tweet_results", "result"]));
      if (tweet) tweets.push(tweet);
    }
    for (const value of Object.values(obj)) walk(value, depth + 1);
  };
  walk(root, 0);
  return { tweets, cursor };
}

function pageFrom(json: unknown): FeedPage {
  const { tweets, cursor } = walkInstructions(json);
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  for (const tweet of tweets) {
    const item = toFeedItem(tweet);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return { items, cursor, error: items.length ? null : null };
}

function withCursor(base: Record<string, unknown>, cursor: string | null): Record<string, unknown> {
  if (!cursor) return base;
  return { ...base, cursor };
}

export async function xFeed(
  env: Env,
  cookies: JarCookie[],
  tab: "for-you" | "following" | "lists",
  cursor: string | null,
  listId: string | null,
): Promise<FeedPage> {
  if (tab === "lists") {
    if (!listId) return { items: [], cursor: null, error: "Pick a list." };
    const json = await callOp(env, cookies, "ListLatestTweetsTimeline", withCursor({ listId, count: 20 }, cursor));
    return pageFrom(json);
  }
  const operation = tab === "following" ? "HomeLatestTimeline" : "HomeTimeline";
  const json = await callOp(
    env,
    cookies,
    operation,
    withCursor(
      { count: 20, includePromotedContent: false, latestControlAvailable: true, requestContext: "launch", withCommunity: false },
      cursor,
    ),
  );
  return pageFrom(json);
}

export async function xLists(env: Env, cookies: JarCookie[]): Promise<{ id: string; name: string }[]> {
  const res = await fetch("https://x.com/i/api/1.1/lists/list.json?reverse=true", { headers: headers(cookies) });
  const json = await readBody(res);
  if (authFailed(res.status, json)) throw new AccountExpired();
  const rows = Array.isArray(json) ? json : Array.isArray(asObj(json)?.lists) ? (asObj(json)?.lists as unknown[]) : [];
  const out: { id: string; name: string }[] = [];
  for (const row of rows) {
    const item = asObj(row);
    if (!item) continue;
    const id = firstString(item.id_str, typeof item.id === "number" ? String(item.id) : item.id);
    const name = firstString(item.name);
    if (id && name) out.push({ id, name });
  }
  return out;
}

export async function xThread(env: Env, cookies: JarCookie[], id: string): Promise<{ root: FeedItem | null; replies: FeedItem[] }> {
  const json = await callOp(env, cookies, "TweetDetail", {
    focalTweetId: id,
    referrer: "profile",
    with_rux_injections: false,
    rankingMode: "Relevance",
    includePromotedContent: false,
    withCommunity: false,
    withVoice: false,
  });
  const page = pageFrom(json);
  const root = page.items.find((item) => item.id === id) ?? page.items[0] ?? null;
  return { root, replies: page.items.filter((item) => item.id !== root?.id) };
}

async function userId(env: Env, cookies: JarCookie[], handle: string): Promise<{ id: string; profile: Record<string, unknown> }> {
  const json = await callOp(env, cookies, "UserByScreenName", { screen_name: handle, withSafetyModeUserFields: true });
  const result = asObj(dig(json, ["data", "user", "result"]));
  const id = firstString(result?.rest_id);
  if (!result || !id) throw new Error("X profile was not found");
  return { id, profile: result };
}

export async function xProfile(
  env: Env,
  cookies: JarCookie[],
  handle: string,
  tab: "posts" | "replies" | "media",
  cursor: string | null,
): Promise<{
  name: string;
  handle: string;
  bio: string;
  banner: string;
  avatar: string;
  counts: { posts: number; following: number; followers: number };
  items: FeedItem[];
  cursor: string | null;
}> {
  const user = await userId(env, cookies, handle.replace(/^@/, ""));
  const legacy = asObj(user.profile.legacy);
  const operation = tab === "replies" ? "UserTweetsAndReplies" : tab === "media" ? "UserMedia" : "UserTweets";
  const json = await callOp(
    env,
    cookies,
    operation,
    withCursor(
      {
        userId: user.id,
        count: 20,
        includePromotedContent: false,
        withVoice: false,
        withV2Timeline: true,
      },
      cursor,
    ),
  );
  const page = pageFrom(json);
  return {
    name: firstString(legacy?.name),
    handle: firstString(legacy?.screen_name, handle),
    bio: firstString(legacy?.description),
    banner: firstString(legacy?.profile_banner_url),
    avatar: firstString(legacy?.profile_image_url_https).replace("_normal", "_bigger"),
    counts: {
      posts: Number(legacy?.statuses_count ?? 0) || 0,
      following: Number(legacy?.friends_count ?? 0) || 0,
      followers: Number(legacy?.followers_count ?? 0) || 0,
    },
    items: page.items,
    cursor: page.cursor,
  };
}

export async function xStats(env: Env, cookies: JarCookie[], id: string): Promise<{ likes: number; replies: number }> {
  const json = await callOp(env, cookies, "TweetResultByRestId", {
    tweetId: id,
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false,
  });
  const tweet = unwrapTweet(dig(json, ["data", "tweetResult", "result"])) ?? unwrapTweet(dig(json, ["data", "tweet_result", "result"]));
  const item = tweet ? toFeedItem(tweet) : null;
  if (!item) throw new Error("X did not return stats");
  return { likes: item.counts.likes, replies: item.counts.replies };
}

export async function xAct(
  env: Env,
  cookies: JarCookie[],
  action: "like" | "unlike" | "repost" | "unrepost" | "reply" | "quote",
  id: string,
  text = "",
): Promise<void> {
  if (action === "like") await callOp(env, cookies, "FavoriteTweet", { tweet_id: id });
  else if (action === "unlike") await callOp(env, cookies, "UnfavoriteTweet", { tweet_id: id });
  else if (action === "repost") await callOp(env, cookies, "CreateRetweet", { tweet_id: id, dark_request: false });
  else if (action === "unrepost") await callOp(env, cookies, "DeleteRetweet", { source_tweet_id: id, tweet_id: id });
  else if (action === "reply" || action === "quote") {
    if (!text.trim()) throw new Error("Write a reply first");
    await postX(env, cookies, text.trim(), [], action === "reply" ? id : undefined, action === "quote" ? id : undefined);
  }
}

export async function uploadX(cookies: JarCookie[], bytes: Uint8Array, type: string): Promise<string> {
  const form = new FormData();
  form.set("media", new Blob([bytes], { type }), `image${type === "image/png" ? ".png" : type === "image/gif" ? ".gif" : type === "image/webp" ? ".webp" : ".jpg"}`);
  const res = await fetch("https://upload.twitter.com/1.1/media/upload.json", {
    method: "POST",
    headers: headers(cookies),
    body: form,
  });
  const json = await readBody(res);
  if (authFailed(res.status, json)) throw new AccountExpired();
  const id = firstString(asObj(json)?.media_id_string);
  if (!res.ok || !id) throw new Error("X image upload failed");
  return id;
}

export async function postX(
  env: Env,
  cookies: JarCookie[],
  text: string,
  mediaIds: string[],
  replyTo?: string,
  quoteId?: string,
): Promise<string> {
  const variables: Record<string, unknown> = {
    tweet_text: text,
    dark_request: false,
    media: {
      media_entities: mediaIds.map((mediaId) => ({ media_id: mediaId, tagged_users: [] })),
      possibly_sensitive: false,
    },
    semantic_annotation_ids: [],
  };
  if (replyTo) variables.reply = { in_reply_to_tweet_id: replyTo, exclude_reply_user_ids: [] };
  if (quoteId) variables.attachment_url = `https://x.com/i/status/${quoteId}`;
  const json = await callOp(env, cookies, "CreateTweet", variables);
  const id = findRestId(dig(json, ["data", "create_tweet"])) || findRestId(json);
  if (!id) throw new Error("X did not return a post id");
  return id;
}

function findRestId(node: unknown, depth = 0): string {
  if (depth > 8 || !node || typeof node !== "object") return "";
  const obj = asObj(node);
  if (!obj) return "";
  const type = firstString(obj.__typename);
  const id = firstString(obj.rest_id);
  if (type === "TweetWithVisibilityResults") {
    const inner = findRestId(obj.tweet, depth + 1);
    if (inner) return inner;
  }
  if (id && (type === "Tweet" || typeof asObj(obj.legacy)?.full_text === "string")) return id;
  for (const value of Object.values(obj)) {
    const found = findRestId(value, depth + 1);
    if (found) return found;
  }
  return "";
}

export async function xLabel(cookies: JarCookie[]): Promise<string | null> {
  const res = await fetch("https://x.com/i/api/1.1/account/verify_credentials.json", { headers: headers(cookies) });
  const json = await readBody(res);
  if (authFailed(res.status, json)) throw new AccountExpired();
  const name = firstString(asObj(json)?.screen_name);
  return name ? `@${name.slice(0, 40)}` : null;
}
