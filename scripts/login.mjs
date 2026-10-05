import { chromium } from "playwright-core";
import readline from "node:readline";
import path from "node:path";

const platform = process.argv[2];
if (platform !== "x" && platform !== "linkedin") {
  console.error("Usage: npm run login -- x");
  console.error("       npm run login -- linkedin");
  process.exit(1);
}

const base = process.env.BRIEF_URL || "http://127.0.0.1:8787";
let target;
try {
  target = new URL(base);
} catch {
  console.error("BRIEF_URL is not a URL");
  process.exit(1);
}
const local = target.hostname === "127.0.0.1" || target.hostname === "localhost";
if (target.protocol !== "https:" && !local) {
  console.error("BRIEF_URL must be https, except for http://127.0.0.1");
  process.exit(1);
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

let password = process.env.APP_PASSWORD || "";
if (!password) {
  console.error("APP_PASSWORD is not set. It will be visible as you type.");
  password = await ask("App password: ");
}
if (!password) {
  console.error("Missing password");
  process.exit(1);
}

const profileDir = path.join(process.cwd(), ".profiles", platform);
const start = platform === "x" ? "https://x.com/i/flow/login" : "https://www.linkedin.com/login";
let context;
try {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    viewport: null,
  });
} catch (err) {
  console.error("Could not open the installed Chrome. The Worker cannot launch it for you.");
  console.error(err instanceof Error ? err.message : "launch failed");
  process.exit(1);
}

try {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(start, { waitUntil: "domcontentloaded" });
  console.log("Sign in in the Chrome window, including 2FA. Then press Enter here.");
  await ask("");
  const all = await context.cookies();
  const cookies = all
    .filter((cookie) => {
      const domain = cookie.domain.toLowerCase();
      if (platform === "x") return domain.includes("x.com") || domain.includes("twitter.com");
      return domain.includes("linkedin.com");
    })
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || "/",
    }));
  console.log(`Sending ${cookies.length} cookies to ${target.origin}`);
  const res = await fetch(new URL("/api/accounts/import", target), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, platform, cookies }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(typeof data.error === "string" ? data.error : `Import failed (${res.status})`);
    process.exitCode = 1;
  } else {
    if (data.warning) console.log(data.warning);
    console.log(data.label ? `Saved ${platform} as ${data.label}` : `Saved ${platform}`);
  }
} finally {
  await context.close();
}
