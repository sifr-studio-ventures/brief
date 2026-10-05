import type { AccountRecord } from "./types";
import { escapeHtml } from "./util";

const LIMITS =
  "Internals change and can break. Cookie sessions break the sites’ terms, so an account can be flagged. X posting, liking, and reposting need a real account to verify. LinkedIn comments, profile view, and likes need a real account to verify. Scheduled sends run once a minute.";

function shell(title: string, theme: "dark" | "light", body: string): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex">
  <title>${title}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="stylesheet" href="/app.css">
</head>
${body}
</html>`;
}

export function landingPage(theme: "dark" | "light", error = ""): string {
  return shell(
    "Brief",
    theme,
    `<body class="landing">
  <img class="logo-lg" src="/logo.svg" alt="">
  <p class="wordmark">Brief</p>
  <h1>Read and schedule X and LinkedIn from your own Worker.</h1>
  <p class="muted">One password. Sessions stay on this install.</p>
  <form class="panel" method="post" action="/login">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
    <button class="primary" type="submit">Enter</button>
  </form>
  <p class="muted limits">${LIMITS}</p>
</body>`,
  );
}

export function appPage(theme: "dark" | "light"): string {
  return shell(
    "Brief",
    theme,
    `<body class="app">
  <header class="top">
    <a class="brand" href="/app"><img src="/logo.svg" alt="" width="28" height="28"> Brief</a>
    <span class="spacer"></span>
    <span id="dot" class="dot on" title="Session timer"></span>
    <details id="timer">
      <summary id="clock">0:00</summary>
      <div class="timer-menu">
        <p>This session <b id="t-session">0:00</b></p>
        <p>Today <b id="t-today">0:00</b></p>
        <p>Last 7 days <b id="t-week">0:00</b></p>
        <p>Last 5 sessions</p>
        <ul id="t-recent"></ul>
      </div>
    </details>
    <button type="button" id="theme">Light</button>
    <a href="/accounts">Accounts</a>
  </header>
  <div class="shell">
    <aside>
      <button type="button" class="primary" id="new-post">New post</button>
      <section>
        <h2>Scheduled</h2>
        <div id="list-scheduled"></div>
      </section>
      <section>
        <h2>Drafts</h2>
        <div id="list-draft"></div>
      </section>
      <section>
        <h2>Posted</h2>
        <div id="list-posted"></div>
      </section>
      <p class="muted limits">${LIMITS}</p>
    </aside>
    <main id="main">
      <div class="tabs" role="tablist">
        <button type="button" role="tab" id="tab-for-you" data-tab="for-you" aria-selected="true">X For you</button>
        <button type="button" role="tab" id="tab-following" data-tab="following" aria-selected="false">X Following</button>
        <button type="button" role="tab" id="tab-lists" data-tab="lists" aria-selected="false">X Lists</button>
        <button type="button" role="tab" id="tab-linkedin" data-tab="linkedin" aria-selected="false">LinkedIn</button>
      </div>
      <label id="list-picker-wrap" hidden>List <select id="list-picker"></select></label>
      <p id="feed-error" class="err" hidden></p>
      <div id="feed"></div>
      <div id="sentinel"></div>
      <section id="thread" hidden></section>
      <section id="profile" hidden></section>
    </main>
  </div>
  <dialog id="composer">
    <form id="composer-form">
      <h2 id="composer-title">New post</h2>
      <textarea id="composer-body" name="body" maxlength="10000" placeholder="Write"></textarea>
      <p class="muted"><span id="count">0 / 280</span></p>
      <div class="row">
        <label><input type="checkbox" name="target" value="x" checked> X</label>
        <label><input type="checkbox" name="target" value="linkedin"> LinkedIn</label>
      </div>
      <input id="composer-files" type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple>
      <div id="composer-previews" class="row"></div>
      <label>Schedule <input id="composer-when" type="datetime-local"></label>
      <div class="row">
        <button type="button" data-action="draft">Save draft</button>
        <button type="button" data-action="schedule">Schedule</button>
        <button type="button" class="primary" data-action="now">Post now</button>
        <button type="button" id="composer-close">Close</button>
      </div>
      <p id="composer-error" class="err"></p>
    </form>
  </dialog>
  <div id="viewer" class="viewer" hidden></div>
  <script src="/app.js"></script>
</body>`,
  );
}

export function accountsPage(theme: "dark" | "light", accounts: AccountRecord[]): string {
  const cards = accounts
    .map((account) => {
      const name = account.platform === "x" ? "X" : "LinkedIn";
      const command = account.platform === "x" ? "npm run login -- x" : "npm run login -- linkedin";
      const label = account.label ? escapeHtml(account.label) : "No profile label yet";
      return `<section class="panel">
        <h2>${name}</h2>
        <p><span class="dot ${account.status === "ok" ? "on" : ""}"></span> ${escapeHtml(account.status)}</p>
        <p class="muted">${label}</p>
        <p>This Worker cannot open Chrome. On your machine, from the Brief repo:</p>
        <pre>${command}</pre>
        <p class="muted">The script opens the installed Chrome, waits while you sign in (including 2FA), then sends the cookies here over HTTPS. It writes nothing into the repo. Profiles stay in the gitignored <span class="code">.profiles</span> folder.</p>
      </section>`;
    })
    .join("");
  return shell(
    "Accounts · Brief",
    theme,
    `<body class="landing accounts">
  <header class="top">
    <a class="brand" href="/app"><img src="/logo.svg" alt="" width="28" height="28"> Brief</a>
    <span class="spacer"></span>
    <a href="/app">Feed</a>
  </header>
  <h1>Accounts</h1>
  <p class="muted">Sign in once in your own browser. After an account shows Expired, its scheduled posts wait until you sign in again.</p>
  ${cards}
  <form method="post" action="/logout"><button type="submit">Log out</button></form>
  <p class="muted limits">${LIMITS}</p>
</body>`,
  );
}
