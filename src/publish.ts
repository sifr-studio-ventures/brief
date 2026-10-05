import { finishPost, getPost, listMedia, loadJar, lockPost, markExpired } from "./db";
import { postLinkedIn } from "./linkedin";
import type { Env, Platform, PostStatus } from "./types";
import { AccountExpired } from "./types";
import { now, parseStringArray, safeError } from "./util";
import { postX, uploadX } from "./x";

function isPlatform(value: string): value is Platform {
  return value === "x" || value === "linkedin";
}

export async function publishPost(env: Env, id: string): Promise<{ ok: boolean; error?: string }> {
  const post = await getPost(env, id);
  if (!post) return { ok: false, error: "Not found" };
  if (post.status === "posted") return { ok: true };
  if (!(await lockPost(env, id))) return { ok: false, error: "Already sending" };

  const targets = parseStringArray(post.targets).filter(isPlatform);
  const held = new Set(parseStringArray(post.heldPlatforms));
  let xId = post.xPostId;
  let linkedinId = post.linkedinPostId;
  const errors: string[] = [];
  const files: { bytes: Uint8Array; type: string }[] = [];

  for (const media of await listMedia(env, id)) {
    const object = await env.MEDIA.get(media.r2Key);
    if (!object) {
      errors.push("Missing image");
      continue;
    }
    files.push({ bytes: new Uint8Array(await object.arrayBuffer()), type: media.contentType });
  }

  for (const platform of targets) {
    if (platform === "x" && xId) continue;
    if (platform === "linkedin" && linkedinId) continue;
    try {
      const cookies = await loadJar(env, platform);
      if (platform === "x") {
        const mediaIds: string[] = [];
        for (const file of files) mediaIds.push(await uploadX(cookies, file.bytes, file.type));
        xId = await postX(env, cookies, post.body, mediaIds);
      } else {
        linkedinId = await postLinkedIn(cookies, post.body, files);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      const missing = /not signed in/i.test(message);
      const expired = err instanceof AccountExpired || missing || /expired/i.test(message);
      if (expired) {
        if (err instanceof AccountExpired) await markExpired(env, platform);
        held.add(platform);
        errors.push(
          missing
            ? platform === "x"
              ? "X is not signed in"
              : "LinkedIn is not signed in"
            : platform === "x"
              ? "X session expired"
              : "LinkedIn session expired",
        );
      } else {
        errors.push(safeError(err));
      }
    }
  }

  const pending = targets.filter((platform) => (platform === "x" ? !xId : !linkedinId));
  const pendingFailed = pending.filter((platform) => !held.has(platform));
  let status: PostStatus = "posted";
  if (pending.length && pendingFailed.length === 0) status = "held";
  else if (pending.length) status = "failed";

  await finishPost(env, id, {
    status,
    heldPlatforms: [...held],
    xPostId: xId,
    linkedinPostId: linkedinId,
    error: errors.length ? errors.join("; ").slice(0, 240) : null,
    postedAt: status === "posted" ? now() : post.postedAt,
  });
  return { ok: status === "posted", error: errors[0] };
}
