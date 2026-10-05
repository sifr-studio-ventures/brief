const state = {
  tab: "for-you",
  listId: "",
  items: [],
  cursor: null,
  loading: false,
  done: false,
  view: "feed",
  editing: null,
  media: [],
};

const feedEl = document.getElementById("feed");
const threadEl = document.getElementById("thread");
const profileEl = document.getElementById("profile");
const errorEl = document.getElementById("feed-error");
const main = document.getElementById("main");
const composer = document.getElementById("composer");
const viewer = document.getElementById("viewer");

function el(tag, attrs, kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.className = value;
    else if (value != null) node.setAttribute(key, value);
  }
  for (const kid of kids || []) node.append(kid && kid.nodeType ? kid : document.createTextNode(kid ?? ""));
  return node;
}

async function api(path, opts) {
  const res = await fetch(path, { credentials: "same-origin", ...opts });
  if (res.status === 401) {
    location.href = "/";
    throw new Error("Sign in");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.error) throw new Error("Request failed");
  return data;
}

function proxy(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return "";
    return "/api/media/remote?u=" + encodeURIComponent(parsed.toString());
  } catch {
    return "";
  }
}

function fmt(total) {
  const s = Math.max(0, Math.floor(total || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? h + ":" + pad(m) + ":" + pad(sec) : m + ":" + pad(sec);
}

function dayStamp(date) {
  const z = (n) => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + z(date.getMonth() + 1) + "-" + z(date.getDate());
}

const timer = {
  id: sessionStorage.getItem("brief-time") || crypto.randomUUID(),
  unsent: 0,
  shown: 0,
  idle: false,
  last: performance.now(),
};
sessionStorage.setItem("brief-time", timer.id);

function modalOpen() {
  return composer.open || !viewer.hidden;
}

function timerRunning() {
  return !document.hidden && !timer.idle && !modalOpen();
}

function paintClock() {
  document.getElementById("clock").textContent = fmt(timer.shown);
  document.getElementById("dot").classList.toggle("on", timerRunning());
}

async function flushTime() {
  const delta = Math.floor(timer.unsent);
  if (delta <= 0) {
    paintClock();
    return;
  }
  timer.unsent -= delta;
  try {
    const data = await api("/api/time?id=" + timer.id + "&day=" + dayStamp(new Date()), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: timer.id, seconds: delta, day: dayStamp(new Date()) }),
    });
    paintTotals(data);
  } catch {
    timer.unsent += delta;
  }
}

function paintTotals(data) {
  document.getElementById("t-session").textContent = fmt(data.session);
  document.getElementById("t-today").textContent = fmt(data.today);
  document.getElementById("t-week").textContent = fmt(data.week);
  const list = document.getElementById("t-recent");
  list.replaceChildren();
  for (const row of data.recent || []) {
    list.append(el("li", {}, [fmt(row.seconds)]));
  }
  timer.shown = (data.session || 0) + timer.unsent;
  paintClock();
}

setInterval(() => {
  const now = performance.now();
  const dt = Math.min(2, (now - timer.last) / 1000);
  timer.last = now;
  if (timerRunning()) {
    timer.unsent += dt;
    timer.shown += dt;
  }
  paintClock();
}, 1000);
setInterval(() => flushTime(), 10000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushTime();
});
function wake() {
  timer.idle = false;
  clearTimeout(wake.t);
  wake.t = setTimeout(() => {
    timer.idle = true;
    paintClock();
  }, 60000);
}
["pointerdown", "keydown", "scroll"].forEach((name) => document.addEventListener(name, wake, { passive: true }));
wake();
api("/api/time?id=" + timer.id + "&day=" + dayStamp(new Date())).then(paintTotals).catch(() => {});

const themeBtn = document.getElementById("theme");
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeBtn.textContent = theme === "light" ? "Dark" : "Light";
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = "brief_theme=" + theme + "; Path=/; Max-Age=31536000; SameSite=Lax" + secure;
  localStorage.setItem("brief-theme", theme);
}
themeBtn.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
});
applyTheme(document.documentElement.dataset.theme || "dark");

function showError(message) {
  errorEl.hidden = !message;
  errorEl.textContent = message || "";
  const status = !message || /not signed in|pick a list/i.test(message);
  errorEl.className = status ? "status" : "err";
}

function imageGrid(urls) {
  const clean = urls.map(proxy).filter(Boolean);
  if (!clean.length) return null;
  const grid = el("div", { class: "grid n" + Math.min(clean.length, 4) });
  for (const src of clean.slice(0, 4)) {
    const img = el("img", { src, alt: "" });
    img.addEventListener("click", () => openViewer(src));
    grid.append(img);
  }
  return grid;
}

function openViewer(src) {
  viewer.hidden = false;
  viewer.replaceChildren(el("img", { src, alt: "" }));
  paintClock();
}
viewer.addEventListener("click", () => {
  viewer.hidden = true;
  viewer.replaceChildren();
  paintClock();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    viewer.hidden = true;
    if (composer.open) composer.close();
    paintClock();
  }
});

function card(item) {
  const root = el("article", { class: "card" });
  if (item.repostedBy) root.append(el("p", { class: "meta" }, [item.repostedBy + " reposted"]));
  const who = el("div", { class: "who" });
  if (item.avatar && proxy(item.avatar)) who.append(el("img", { src: proxy(item.avatar), alt: "" }));
  const name = el("button", { class: "link", type: "button" }, [item.name || "Unknown"]);
  name.addEventListener("click", () => openProfile(item));
  who.append(name);
  if (item.handle) who.append(el("span", { class: "muted" }, ["@" + item.handle]));
  root.append(who);
  if (item.replyTo) root.append(el("p", { class: "meta" }, ["Replying to @" + item.replyTo]));
  const text = el("p", { class: "body" }, [item.text || ""]);
  text.addEventListener("click", () => openThread(item));
  root.append(text);
  const grid = imageGrid(item.images || []);
  if (grid) root.append(grid);
  if (item.video && item.video.url) {
    const video = el("video", {
      src: proxy(item.video.url) || item.video.url,
      poster: item.video.poster ? proxy(item.video.poster) : "",
      controls: item.video.gif ? null : "",
      playsinline: "",
    });
    if (item.video.gif) {
      video.autoplay = true;
      video.muted = true;
      video.loop = true;
    }
    root.append(video);
  }
  if (item.quote) {
    const quote = el("div", { class: "quote" });
    quote.append(el("strong", {}, [item.quote.name || item.quote.handle || "Quote"]));
    quote.append(el("p", {}, [item.quote.text || ""]));
    const qGrid = imageGrid(item.quote.images || []);
    if (qGrid) quote.append(qGrid);
    root.append(quote);
  }
  if (item.article) {
    const article = el("a", { class: "article", href: item.article.url, target: "_blank", rel: "noreferrer" });
    if (item.article.image && proxy(item.article.image)) article.append(el("img", { src: proxy(item.article.image), alt: "" }));
    article.append(el("p", {}, [item.article.title]));
    root.append(article);
  }
  if (item.reshare) {
    const share = el("div", { class: "reshare" });
    share.append(el("strong", {}, [item.reshare.name || "Reshare"]));
    share.append(el("p", {}, [item.reshare.text || ""]));
    root.append(share);
  }
  const counts = item.counts || {};
  root.append(el("p", { class: "meta" }, [`${counts.likes || 0} likes · ${counts.replies || 0} replies · ${counts.reposts || 0} reposts`]));
  root.append(actions(item));
  return root;
}

function actions(item) {
  const row = el("div", { class: "row" });
  if (item.platform === "x") {
    const like = el("button", { type: "button" }, [item.liked ? "Unlike" : "Like"]);
    like.addEventListener("click", () => act(item, item.liked ? "unlike" : "like", like));
    const repost = el("button", { type: "button" }, [item.reposted ? "Undo repost" : "Repost"]);
    repost.addEventListener("click", () => act(item, item.reposted ? "unrepost" : "repost", repost));
    const reply = el("button", { type: "button" }, ["Reply"]);
    reply.addEventListener("click", () => openThread(item));
    const quote = el("button", { type: "button" }, ["Quote"]);
    quote.addEventListener("click", () => quoteBox(item, row));
    row.append(like, repost, reply, quote);
  } else {
    const like = el("button", { type: "button" }, ["Like"]);
    like.addEventListener("click", () => act(item, "like", like));
    const comment = el("button", { type: "button" }, ["Comment"]);
    comment.addEventListener("click", () => openThread(item));
    row.append(
      like,
      comment,
      el("a", { href: item.url, target: "_blank", rel: "noreferrer" }, ["Repost"]),
      el("a", { href: item.url, target: "_blank", rel: "noreferrer" }, ["Quote"]),
    );
  }
  return row;
}

async function act(item, action, button, text) {
  const before = { liked: item.liked, reposted: item.reposted, likes: item.counts.likes, replies: item.counts.replies, reposts: item.counts.reposts };
  if (action === "like") {
    item.liked = true;
    item.counts.likes += 1;
  } else if (action === "unlike") {
    item.liked = false;
    item.counts.likes = Math.max(0, item.counts.likes - 1);
  } else if (action === "repost") {
    item.reposted = true;
    item.counts.reposts += 1;
  } else if (action === "unrepost") {
    item.reposted = false;
    item.counts.reposts = Math.max(0, item.counts.reposts - 1);
  } else if (action === "reply" || action === "comment") {
    item.counts.replies += 1;
  }
  if (state.view === "feed") renderFeed();
  try {
    const data = await api("/api/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: item.platform, action, id: item.id, text: text || "" }),
    });
    if (data.error) throw new Error(data.error);
  } catch (err) {
    item.liked = before.liked;
    item.reposted = before.reposted;
    item.counts.likes = before.likes;
    item.counts.replies = before.replies;
    item.counts.reposts = before.reposts;
    if (state.view === "feed") renderFeed();
    showError(err.message);
    if (button) button.disabled = false;
  }
}

function quoteBox(item, row) {
  if (row.querySelector("textarea")) return;
  const box = el("textarea", { maxlength: "280" });
  const send = el("button", { type: "button", class: "primary" }, ["Quote"]);
  send.addEventListener("click", () => act(item, "quote", send, box.value));
  row.append(box, send);
}

function renderFeed() {
  feedEl.hidden = false;
  threadEl.hidden = true;
  profileEl.hidden = true;
  state.view = "feed";
  feedEl.replaceChildren();
  if (!state.items.length && !state.loading) feedEl.append(el("p", { class: "muted" }, ["Nothing here yet."]));
  for (const item of state.items) feedEl.append(card(item));
}

async function loadFeed(reset) {
  if (state.loading || (state.done && !reset) || state.view !== "feed") return;
  state.loading = true;
  if (reset) {
    state.items = [];
    state.cursor = null;
    state.done = false;
    showError("");
  }
  const params = new URLSearchParams({ tab: state.tab });
  if (state.cursor) params.set("cursor", state.cursor);
  if (state.tab === "lists" && state.listId) params.set("listId", state.listId);
  try {
    const data = await api("/api/feed?" + params.toString());
    if (data.error) showError(data.error);
    const seen = new Set(state.items.map((item) => item.id));
    const before = state.items.length;
    for (const item of data.items || []) {
      if (!seen.has(item.id)) state.items.push(item);
    }
    state.cursor = data.cursor || null;
    if (!data.items || !data.items.length || !data.cursor || state.items.length === before) state.done = true;
  } catch (err) {
    showError(err.message);
    state.done = true;
  } finally {
    state.loading = false;
    if (state.view === "feed") renderFeed();
  }
}

function selectTab(tab) {
  state.tab = tab;
  state.view = "feed";
  for (const button of document.querySelectorAll(".tabs button")) {
    button.setAttribute("aria-selected", button.dataset.tab === tab ? "true" : "false");
  }
  const picker = document.getElementById("list-picker-wrap");
  picker.hidden = tab !== "lists";
  if (tab === "lists") {
    loadLists();
    return;
  }
  loadFeed(true);
}

for (const button of document.querySelectorAll(".tabs button")) {
  button.addEventListener("click", () => selectTab(button.dataset.tab));
}

async function loadLists() {
  const select = document.getElementById("list-picker");
  const data = await api("/api/lists").catch((err) => ({ lists: [], error: err.message }));
  select.replaceChildren();
  if (data.error) showError(data.error);
  for (const list of data.lists || []) {
    select.append(el("option", { value: list.id }, [list.name]));
  }
  state.listId = select.value || "";
  if (state.tab !== "lists") return;
  if (!state.listId) {
    state.items = [];
    state.done = true;
    state.loading = false;
    showError(data.error || "Pick a list.");
    renderFeed();
    return;
  }
  loadFeed(true);
}

document.getElementById("list-picker").addEventListener("change", (event) => {
  state.listId = event.target.value;
  state.view = "feed";
  loadFeed(true);
});

new IntersectionObserver(
  (entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadFeed(false);
  },
  { root: main },
).observe(document.getElementById("sentinel"));

async function openThread(item) {
  state.view = "thread";
  feedEl.hidden = true;
  profileEl.hidden = true;
  threadEl.hidden = false;
  threadEl.replaceChildren(el("p", { class: "muted" }, ["Loading"]));
  const data = await api("/api/thread?platform=" + item.platform + "&id=" + encodeURIComponent(item.id)).catch((err) => ({
    error: err.message,
  }));
  threadEl.replaceChildren();
  const back = el("button", { type: "button" }, ["Back"]);
  back.addEventListener("click", () => {
    state.view = "feed";
    renderFeed();
  });
  threadEl.append(back);
  if (data.error) threadEl.append(el("p", { class: "err" }, [data.error]));
  if (data.root) threadEl.append(card(data.root));
  const box = el("textarea", { maxlength: item.platform === "x" ? "280" : "3000" });
  const send = el("button", { type: "button", class: "primary" }, [item.platform === "x" ? "Reply" : "Comment"]);
  send.addEventListener("click", () => act(data.root || item, item.platform === "x" ? "reply" : "comment", send, box.value));
  threadEl.append(box, send);
  for (const reply of data.replies || []) threadEl.append(card(reply));
}

async function openProfile(item) {
  if (!item.handle) return;
  state.view = "profile";
  feedEl.hidden = true;
  threadEl.hidden = true;
  profileEl.hidden = false;
  profileEl.replaceChildren(el("p", { class: "muted" }, ["Loading"]));
  const tab = "posts";
  await renderProfile(item.platform, item.handle, tab);
}

async function renderProfile(platform, handle, tab) {
  const data = await api(
    "/api/profile?platform=" + platform + "&handle=" + encodeURIComponent(handle) + "&tab=" + tab,
  ).catch((err) => ({ error: err.message }));
  profileEl.replaceChildren();
  const back = el("button", { type: "button" }, ["Back"]);
  back.addEventListener("click", () => {
    state.view = "feed";
    renderFeed();
  });
  profileEl.append(back);
  if (data.error) {
    profileEl.append(el("p", { class: "err" }, [data.error]));
    return;
  }
  if (data.banner && proxy(data.banner)) profileEl.append(el("img", { class: "banner", src: proxy(data.banner), alt: "" }));
  const who = el("div", { class: "who" });
  if (data.avatar && proxy(data.avatar)) who.append(el("img", { src: proxy(data.avatar), alt: "" }));
  who.append(el("strong", {}, [data.name || handle]));
  profileEl.append(who);
  if (data.bio) profileEl.append(el("p", {}, [data.bio]));
  const counts = data.counts || {};
  profileEl.append(el("p", { class: "meta" }, [`${counts.posts || 0} posts · ${counts.following || 0} following · ${counts.followers || 0} followers`]));
  if (platform === "x") {
    const row = el("div", { class: "row" });
    for (const name of ["posts", "replies", "media"]) {
      const button = el("button", { type: "button" }, [name]);
      if (name === tab) button.setAttribute("aria-selected", "true");
      button.addEventListener("click", () => renderProfile(platform, handle, name));
      row.append(button);
    }
    profileEl.append(row);
  } else {
    profileEl.append(el("p", { class: "muted" }, ["LinkedIn profile view needs a real account to verify."]));
  }
  for (const post of data.items || []) profileEl.append(card(post));
}

function groupOf(post) {
  if (post.status === "draft") return "draft";
  if (post.status === "posted") return "posted";
  return "scheduled";
}

function renderPosts(posts) {
  for (const id of ["list-scheduled", "list-draft", "list-posted"]) document.getElementById(id).replaceChildren();
  const buckets = { scheduled: [], draft: [], posted: [] };
  for (const post of posts || []) buckets[groupOf(post)].push(post);
  for (const [name, list] of Object.entries(buckets)) {
    const box = document.getElementById("list-" + name);
    if (!list.length) box.append(el("p", { class: "muted" }, ["None"]));
    for (const post of list) box.append(sideItem(post));
  }
}

function sideItem(post) {
  const node = el("article", { class: "side-item" });
  const preview = (post.body || "Image").slice(0, 140);
  node.append(el("p", {}, [preview]));
  const when = post.scheduleAt ? " · " + new Date(post.scheduleAt * 1000).toLocaleString() : "";
  node.append(el("p", { class: "meta" }, [(post.targets || []).join(", ") + " · " + post.status + when]));
  if (post.error) node.append(el("p", { class: "err" }, [post.error]));
  const row = el("div", { class: "row" });
  const send = el("button", { type: "button" }, [post.status === "failed" || post.status === "held" ? "Retry" : "Send now"]);
  if (post.status === "sending" || post.status === "posted") send.disabled = true;
  send.addEventListener("click", async () => {
    send.disabled = true;
    const data = await api("/api/posts/" + post.id + "/send", { method: "POST" }).catch((err) => ({ error: err.message }));
    if (data.error) showError(data.error);
    loadPosts();
  });
  const stats = el("button", { type: "button" }, ["Stats"]);
  const statLine = el("p", { class: "meta" }, [""]);
  stats.addEventListener("click", async () => {
    const data = await api("/api/posts/" + post.id + "/stats");
    statLine.textContent = data.error ? data.error : `X likes ${data.likes} · replies ${data.replies}`;
  });
  const del = el("button", { type: "button" }, ["Delete"]);
  del.addEventListener("click", async () => {
    if (!confirm("Delete this post?")) return;
    await api("/api/posts/" + post.id, { method: "DELETE" });
    loadPosts();
  });
  if (post.status === "draft" || post.status === "scheduled" || post.status === "failed" || post.status === "held") {
    const edit = el("button", { type: "button" }, ["Edit"]);
    edit.addEventListener("click", () => openComposer(post));
    row.append(edit);
  }
  row.append(send, stats, del);
  node.append(row, statLine);
  return node;
}

async function loadPosts() {
  const data = await api("/api/posts").catch(() => ({ posts: [] }));
  renderPosts(data.posts || []);
}

const bodyEl = document.getElementById("composer-body");
const countEl = document.getElementById("count");
const fileEl = document.getElementById("composer-files");
const previewEl = document.getElementById("composer-previews");
const whenEl = document.getElementById("composer-when");
const composerError = document.getElementById("composer-error");

function selectedTargets() {
  return [...document.querySelectorAll('#composer-form input[name="target"]:checked')].map((node) => node.value);
}

function paintCount() {
  const targets = selectedTargets();
  const limit = targets.includes("x") || !targets.length ? 280 : 3000;
  countEl.textContent = bodyEl.value.length + " / " + limit;
  countEl.style.color = bodyEl.value.length > limit ? "var(--warn)" : "";
}
bodyEl.addEventListener("input", paintCount);
document.querySelectorAll('#composer-form input[name="target"]').forEach((node) => node.addEventListener("change", paintCount));

function openComposer(post) {
  state.editing = post ? post.id : null;
  state.media = post ? (post.media || []).map((item) => item.id) : [];
  document.getElementById("composer-title").textContent = post ? "Edit post" : "New post";
  bodyEl.value = post ? post.body : "";
  for (const box of document.querySelectorAll('#composer-form input[name="target"]')) {
    box.checked = post ? (post.targets || []).includes(box.value) : box.value === "x";
  }
  whenEl.value = post && post.scheduleAt ? toLocal(post.scheduleAt) : "";
  fileEl.value = "";
  previewEl.replaceChildren();
  for (const id of state.media) {
    const img = el("img", { src: "/media/" + id, alt: "" });
    img.style.width = "72px";
    previewEl.append(img);
  }
  composerError.textContent = "";
  paintCount();
  composer.showModal();
  paintClock();
}

function toLocal(seconds) {
  const date = new Date(seconds * 1000);
  const z = (n) => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + z(date.getMonth() + 1) + "-" + z(date.getDate()) + "T" + z(date.getHours()) + ":" + z(date.getMinutes());
}

document.getElementById("new-post").addEventListener("click", () => openComposer(null));
document.getElementById("composer-close").addEventListener("click", () => {
  composer.close();
  paintClock();
});
composer.addEventListener("close", paintClock);

async function uploadFiles() {
  const files = [...fileEl.files].slice(0, 4);
  for (const file of files) {
    if (file.size > 5 * 1024 * 1024) throw new Error("Images must be 5MB or smaller");
    const form = new FormData();
    form.set("file", file);
    const data = await api("/api/upload", { method: "POST", body: form });
    if (data.error) throw new Error(data.error);
    state.media.push(data.id);
    if (state.media.length > 4) state.media = state.media.slice(0, 4);
  }
  fileEl.value = "";
}

async function save(action) {
  composerError.textContent = "";
  try {
    await uploadFiles();
    const payload = {
      body: bodyEl.value,
      targets: selectedTargets(),
      action,
      mediaIds: state.media,
      scheduleAt: whenEl.value ? Math.floor(new Date(whenEl.value).getTime() / 1000) : null,
    };
    const path = state.editing ? "/api/posts/" + state.editing : "/api/posts";
    const data = await api(path, {
      method: state.editing ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (data.error) throw new Error(data.error);
    composer.close();
    paintClock();
    loadPosts();
  } catch (err) {
    composerError.textContent = err.message;
  }
}

for (const button of document.querySelectorAll("#composer-form [data-action]")) {
  button.addEventListener("click", () => save(button.dataset.action));
}

loadPosts();
loadFeed(true);
