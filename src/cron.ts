import { deleteMediaRow, duePosts, orphanMedia, reclaimStuck, sweepSessions } from "./db";
import type { Env } from "./types";
import { publishPost } from "./publish";

export async function runCron(env: Env): Promise<void> {
  await sweepSessions(env);
  await reclaimStuck(env);
  for (const media of await orphanMedia(env)) {
    await env.MEDIA.delete(media.r2Key);
    await deleteMediaRow(env, media.id);
  }
  for (const post of await duePosts(env)) {
    await publishPost(env, post.id);
  }
}
