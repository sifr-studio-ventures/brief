export type Env = {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  APP_PASSWORD?: string;
  SESSION_KEY?: string;
};

export type Platform = "x" | "linkedin";

export type AccountStatus = "ok" | "expired" | "missing";

export type PostStatus = "draft" | "scheduled" | "sending" | "posted" | "failed" | "held";

export type AccountRecord = {
  platform: Platform;
  status: AccountStatus;
  cookiesEnc: string | null;
  label: string | null;
  updatedAt: number;
};

export type PostRecord = {
  id: string;
  status: PostStatus;
  body: string;
  targets: string;
  heldPlatforms: string;
  scheduleAt: number | null;
  postedAt: number | null;
  xPostId: string | null;
  linkedinPostId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type MediaRecord = {
  id: string;
  postId: string | null;
  r2Key: string;
  contentType: string;
  byteSize: number;
  createdAt: number;
};

export type FeedItem = {
  id: string;
  platform: Platform;
  name: string;
  handle: string;
  avatar: string;
  text: string;
  time: string;
  counts: { likes: number; replies: number; reposts: number };
  images: string[];
  video: { url: string; poster: string; gif: boolean } | null;
  quote: { name: string; handle: string; text: string; images: string[] } | null;
  replyTo: string | null;
  repostedBy: string | null;
  article: { title: string; url: string; image: string } | null;
  reshare: { name: string; handle: string; text: string } | null;
  url: string;
  liked: boolean;
  reposted: boolean;
};

export type FeedPage = {
  items: FeedItem[];
  cursor: string | null;
  error: string | null;
};

export class AccountExpired extends Error {
  constructor() {
    super("Session expired. Scheduled posts are held.");
    this.name = "AccountExpired";
  }
}
