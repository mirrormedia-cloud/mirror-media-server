/**
 * Live social analytics — fetched directly from YouTube / Facebook Page /
 * Instagram Graph APIs every call. NOTHING in this module persists to
 * Postgres beyond what's already in `social_accounts` (tokens). Spec rule:
 * analytics numbers must be live-only.
 *
 * Resilience model:
 *   - Each platform fetcher is wrapped in try/catch.
 *   - A failing fetcher returns { items: [], errors: [{...}] }.
 *   - The orchestrator combines the partial results so a single failing
 *     platform never crashes the dashboard.
 *
 * Concurrency:
 *   - YOUTUBE_ANALYTICS_CONCURRENCY    (default 3)
 *   - FACEBOOK_ANALYTICS_CONCURRENCY   (default 3)
 *   - INSTAGRAM_ANALYTICS_CONCURRENCY  (default 3)
 */

import type { FastifyRequest } from "fastify";
import axios from "axios";
import { google } from "googleapis";
import { SocialAccount } from "../../db/models";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import type { AnalyticsQueryInput, AnalyticsPlatform, AnalyticsStatus } from "./analytics.dto";

const YT_CONCURRENCY = Number(process.env.YOUTUBE_ANALYTICS_CONCURRENCY ?? 3);
const FB_CONCURRENCY = Number(process.env.FACEBOOK_ANALYTICS_CONCURRENCY ?? 3);
const IG_CONCURRENCY = Number(process.env.INSTAGRAM_ANALYTICS_CONCURRENCY ?? 3);
const CACHE_TTL_MS = Number(process.env.ANALYTICS_CACHE_TTL_MS ?? 2 * 60 * 1000);

/**
 * Tiny in-memory result cache. Keyed by user_id + serialised filters.
 * Lives in the Node process — not Redis, not Postgres — per the spec
 * rule that analytics metrics are NEVER persisted. Cleared after
 * `CACHE_TTL_MS` (default 2 minutes) so a "Refresh Analytics" click
 * re-hits the platforms; a force_refresh=true skips the cache entirely.
 *
 * The point of this cache is solely to make the page feel fast on
 * repeat renders within the same 2-minute window — flipping between
 * platform tabs doesn't re-burn API quota.
 */
type CacheEntry = { at: number; data: any };
const _cache = new Map<string, CacheEntry>();
function cache_key(user_id: string, q: any): string {
    // include_items is part of the key so toggling it doesn't return a
    // cached entry with the wrong shape. Bumped to v2 to invalidate
    // every entry stored before the items-omission change.
    return `v6|${user_id}|${q.platform}|${q.status}|${q.date_range ?? ""}|${q.start_date ?? ""}|${q.end_date ?? ""}|${q.search ?? ""}|${q.limit_per_platform}|items=${q.include_items ? "1" : "0"}|counts_only=${q.counts_only ? "1" : "0"}`;
}

const GRAPH_VERSION = "v18.0";
const GRAPH_URL = process.env.GRAPH_URL || `https://graph.facebook.com/${GRAPH_VERSION}`;

function alog(step: string, data?: Record<string, any>) {
    const safe = data ? Object.fromEntries(
        Object.entries(data).map(([k, v]) =>
            /access_token|refresh_token|secret|password|cookie|authorization/i.test(k)
                ? [k, typeof v === "string" ? `<redacted:${v.length}>` : "<redacted>"]
                : [k, v],
        ),
    ) : undefined;
    console.log(`[analytics] ${step}${safe ? " " + JSON.stringify(safe) : ""}`);
}

// ── Shared types ───────────────────────────────────────────────────────

export interface AnalyticsItem {
    platform: "youtube" | "facebook" | "instagram";
    platform_id: string;
    platform_video_id: string | null;
    platform_media_id: string | null;
    platform_post_id: string | null;
    title: string | null;
    caption: string | null;
    thumbnail: string | null;
    platform_url: string | null;
    status: "published" | "scheduled" | "failed" | "processing" | "draft";
    published_at: string | null;
    metrics: {
        views: number;
        plays: number;
        likes: number;
        reactions: number;
        comments_count: number;
        shares: number;
        reach: number;
        impressions: number;
        saves: number;
        engagement: number;
    };
    raw_response: any;
    platform_error: string | null;
}

export interface PlatformError {
    platform: "youtube" | "facebook" | "instagram";
    api_name: string;
    error_message: string;
    /** When set, the UI's Errors tab can show the right CTA — "Reconnect", "Wait", etc. */
    error_kind: "token_expired" | "permission" | "rate_limit" | "not_found" | "unknown";
}

interface PlatformFetchResult {
    items: AnalyticsItem[];
    errors: PlatformError[];
}

const empty_metrics = (): AnalyticsItem["metrics"] => ({
    views: 0, plays: 0, likes: 0, reactions: 0,
    comments_count: 0, shares: 0, reach: 0, impressions: 0,
    saves: 0, engagement: 0,
});

// ── Date / status filtering ────────────────────────────────────────────

function compute_date_window(q: AnalyticsQueryInput): { start: Date | null; end: Date | null } {
    if (!q.date_range) return { start: null, end: null };
    const now = new Date();
    if (q.date_range === "today") {
        const s = new Date(now); s.setHours(0, 0, 0, 0);
        return { start: s, end: now };
    }
    if (q.date_range === "last_7_days") {
        const s = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        return { start: s, end: now };
    }
    if (q.date_range === "last_30_days") {
        const s = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        return { start: s, end: now };
    }
    if (q.date_range === "custom") {
        return {
            start: q.start_date ? new Date(q.start_date + "T00:00:00") : null,
            end:   q.end_date   ? new Date(q.end_date + "T23:59:59")   : null,
        };
    }
    return { start: null, end: null };
}

function passes_filters(item: AnalyticsItem, q: AnalyticsQueryInput, win: { start: Date | null; end: Date | null }): boolean {
    if (q.status && q.status !== "all" && item.status !== q.status) return false;
    if (q.search && q.search.trim()) {
        const needle = q.search.trim().toLowerCase();
        const haystack = [
            item.title, item.caption,
            item.platform_video_id, item.platform_media_id, item.platform_post_id,
        ].filter(Boolean).join(" | ").toLowerCase();
        if (!haystack.includes(needle)) return false;
    }
    if (item.published_at) {
        const ts = new Date(item.published_at).getTime();
        if (win.start && ts < win.start.getTime()) return false;
        if (win.end && ts > win.end.getTime()) return false;
    }
    return true;
}

// ── Concurrency helper ────────────────────────────────────────────────

/**
 * Walk a Graph API cursor-paginated edge until we've collected
 * `max_items` rows or there's no `paging.next` link to follow. Both
 * Facebook and Instagram return the same envelope shape:
 *   { data: [...], paging: { next: 'https://…?after=…' } }
 *
 * Each call costs one quota unit; per page we get up to 100 items, so
 * a 200-item channel fetches via ~2 round-trips before insights run.
 */
async function paginate_graph(opts: {
    url: string;
    params: Record<string, any>;
    max_items: number;
}): Promise<any[]> {
    const { url, params, max_items } = opts;
    const out: any[] = [];
    let next_url: string | null = url;
    let next_params: Record<string, any> | null = { ...params, limit: Math.min(100, max_items) };
    // Hard cap: 20 pages at 100 each = 2000 items, safety net against
    // a runaway loop if the API keeps returning a `next` cursor.
    for (let page = 0; page < 20 && out.length < max_items && next_url; page += 1) {
        const cfg: any = next_params ? { params: next_params } : {};
        const resp: any = await axios.get(next_url as string, cfg);
        const rows: any[] = resp?.data?.data ?? [];
        out.push(...rows);
        const paging_next = resp?.data?.paging?.next ?? null;
        // Per-page log so we can see when pagination stalls. If
        // paging_next is null on a sub-25 page, the platform really
        // has no more rows. If it's null on a full page, it's a
        // permission / cursor weirdness on Graph's side.
        alog("paginate_graph_page", {
            page,
            rows: rows.length,
            running_total: out.length,
            has_next: !!paging_next,
            limit_reached: out.length >= max_items,
        });
        // After the first page, follow the absolute `paging.next` URL —
        // it already carries `after`/`access_token`/etc. Don't pass
        // params again or axios appends them and the cursor breaks.
        next_url = paging_next;
        next_params = null;
    }
    return out.slice(0, max_items);
}

async function with_concurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    if (items.length === 0) return [];
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const runners = Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
        while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            results[i] = await worker(items[i]!);
        }
    });
    await Promise.all(runners);
    return results;
}

// ── YouTube ───────────────────────────────────────────────────────────

export async function fetch_youtube_analytics_from_api(opts: {
    user_id: string;
    filters: AnalyticsQueryInput;
}): Promise<PlatformFetchResult> {
    const { user_id, filters } = opts;
    const errors: PlatformError[] = [];

    const account = await SocialAccount.findOne({
        where: { user_id, platform: "youtube", status: "connected" } as any,
        order: [["createdAt", "DESC"]],
    });
    if (!account || !account.access_token) {
        return { items: [], errors: [] }; // No connected YT — silent.
    }

    const oauth2 = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.SECRET_KEY,
        process.env.YOUTUBE_REDIRECT_URI ?? process.env.GOOGLE_REDIRECT_URI,
    );
    const credentials: { access_token: string; refresh_token?: string; expiry_date?: number } = {
        access_token: account.access_token,
    };
    if (account.refresh_token) credentials.refresh_token = account.refresh_token;
    if ((account as any).expires_at) credentials.expiry_date = new Date((account as any).expires_at).getTime();
    oauth2.setCredentials(credentials);

    const youtube = google.youtube({ version: "v3", auth: oauth2 });

    // Counts-only fast path. Walks the uploads playlist for ids +
    // publish dates, THEN does a chunked `videos.list?part=statistics`
    // — that's ONE call per 50 ids (max ~4 calls for 200 videos) and
    // gives us views/likes/comments per video for free. Skips the
    // slow per-video insights endpoints used by the full path.
    if (filters.counts_only) {
        try {
            const channels = await youtube.channels.list({ part: ["contentDetails"], mine: true });
            const uploads_playlist = channels.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
            if (!uploads_playlist) return { items: [], errors };

            const synthesised: AnalyticsItem[] = [];
            let next_token: string | undefined = undefined;
            for (let page = 0; page < 20 && synthesised.length < filters.limit_per_platform; page += 1) {
                const remaining = filters.limit_per_platform - synthesised.length;
                const page_size = Math.max(1, Math.min(50, remaining));
                const playlist_items: any = await youtube.playlistItems.list({
                    part: ["snippet", "contentDetails"],
                    playlistId: uploads_playlist,
                    maxResults: page_size,
                    ...(next_token ? { pageToken: next_token } : {}),
                });
                const items_data = playlist_items.data?.items ?? [];
                for (const it of items_data) {
                    const vid_id: string = it.contentDetails?.videoId ?? `__count_${synthesised.length}`;
                    synthesised.push({
                        platform: "youtube",
                        platform_id: vid_id,
                        platform_video_id: vid_id,
                        platform_media_id: null,
                        platform_post_id: null,
                        title: it.snippet?.title ?? null,
                        caption: null,
                        thumbnail: null,
                        platform_url: null,
                        status: "published",
                        published_at: it.snippet?.publishedAt ?? null,
                        metrics: empty_metrics(),
                        raw_response: null,
                        platform_error: null,
                    });
                }
                next_token = playlist_items.data?.nextPageToken ?? undefined;
                if (!next_token) break;
            }

            // Now batch-fetch per-video stats. videos.list takes up to
            // 50 ids per call; we group and stitch results back into the
            // synthesised items by platform_video_id.
            try {
                const ids = synthesised.map(it => it.platform_video_id).filter((v): v is string => !!v);
                const id_chunks: string[][] = [];
                for (let i = 0; i < ids.length; i += 50) id_chunks.push(ids.slice(i, i + 50));
                const stats_by_id = new Map<string, { views: number; likes: number; comments: number }>();
                for (const chunk of id_chunks) {
                    const videos: any = await youtube.videos.list({ part: ["statistics"], id: chunk });
                    for (const v of (videos.data?.items ?? [])) {
                        if (!v?.id) continue;
                        const st = v.statistics ?? {};
                        stats_by_id.set(v.id, {
                            views: Number(st.viewCount ?? 0),
                            likes: Number(st.likeCount ?? 0),
                            comments: Number(st.commentCount ?? 0),
                        });
                    }
                }
                for (const it of synthesised) {
                    if (!it.platform_video_id) continue;
                    const m = stats_by_id.get(it.platform_video_id);
                    if (!m) continue;
                    it.metrics.views = m.views;
                    it.metrics.plays = m.views;
                    it.metrics.likes = m.likes;
                    it.metrics.reactions = m.likes;
                    it.metrics.comments_count = m.comments;
                    it.metrics.engagement = m.likes + m.comments;
                }
            } catch { /* per-video stats are best-effort in counts-only */ }

            alog("youtube_count_only", { count: synthesised.length });
            return { items: synthesised, errors };
        } catch (err: any) {
            const status = err?.code ?? err?.response?.status;
            const kind: PlatformError["error_kind"] = status === 401 ? "token_expired"
                : status === 403 ? "permission"
                : status === 429 ? "rate_limit"
                : "unknown";
            errors.push({ platform: "youtube", api_name: "playlistItems.list", error_message: err?.message ?? String(err), error_kind: kind });
            return { items: [], errors };
        }
    }

    let video_ids: string[] = [];
    try {
        // List the user's own uploads via the channel's "uploads" playlist.
        const channels = await youtube.channels.list({ part: ["contentDetails"], mine: true });
        const uploads_playlist = channels.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (uploads_playlist) {
            // Walk pageToken until we have enough video ids. YouTube
            // returns max 50 per page, so a 200-cap fetch needs 4 pages.
            let next_token: string | undefined = undefined;
            for (let page = 0; page < 20 && video_ids.length < filters.limit_per_platform; page += 1) {
                const remaining = filters.limit_per_platform - video_ids.length;
                const page_size = Math.max(1, Math.min(50, remaining));
                const playlist_items: any = await youtube.playlistItems.list({
                    part: ["contentDetails"],
                    playlistId: uploads_playlist,
                    maxResults: page_size,
                    ...(next_token ? { pageToken: next_token } : {}),
                });
                const ids = (playlist_items.data?.items ?? [])
                    .map((it: any) => it.contentDetails?.videoId)
                    .filter((v: any): v is string => typeof v === "string" && v.length > 0);
                video_ids.push(...ids);
                next_token = playlist_items.data?.nextPageToken ?? undefined;
                if (!next_token) break;
            }
        }
        alog("youtube_list_done", { count: video_ids.length });
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        const status = err?.code ?? err?.response?.status;
        const kind: PlatformError["error_kind"] = status === 401 ? "token_expired"
            : status === 403 ? "permission"
            : status === 429 ? "rate_limit"
            : "unknown";
        errors.push({ platform: "youtube", api_name: "channels.list/playlistItems.list", error_message: msg, error_kind: kind });
        alog("youtube_list_failed", { error: msg, kind });
        return { items: [], errors };
    }

    if (video_ids.length === 0) return { items: [], errors };

    let items: AnalyticsItem[] = [];
    try {
        // videos.list caps at 50 ids per call. Chunk and concat.
        const chunks: string[][] = [];
        for (let i = 0; i < video_ids.length; i += 50) chunks.push(video_ids.slice(i, i + 50));
        const all_video_data: any[] = [];
        for (const chunk of chunks) {
            const videos = await youtube.videos.list({
                part: ["snippet", "statistics", "status", "contentDetails"],
                id: chunk,
            });
            all_video_data.push(...(videos.data.items ?? []));
        }
        items = all_video_data.map(v => {
            const sn = v.snippet ?? {};
            const st = (v.statistics ?? {}) as any;
            const status_block = v.status ?? {};
            const views = Number(st.viewCount ?? 0);
            const likes = Number(st.likeCount ?? 0);
            const comments = Number(st.commentCount ?? 0);
            const status: AnalyticsItem["status"] =
                status_block.uploadStatus === "rejected" ? "failed"
                : status_block.uploadStatus === "uploaded" || status_block.privacyStatus === "private" ? "processing"
                : status_block.privacyStatus === "public" || status_block.privacyStatus === "unlisted" ? "published"
                : "draft";
            const thumb = sn.thumbnails?.medium?.url ?? sn.thumbnails?.default?.url ?? null;
            return {
                platform: "youtube",
                platform_id: v.id ?? "",
                platform_video_id: v.id ?? null,
                platform_media_id: null,
                platform_post_id: null,
                title: sn.title ?? null,
                caption: null,
                thumbnail: thumb,
                platform_url: v.id ? `https://www.youtube.com/watch?v=${v.id}` : null,
                status,
                published_at: sn.publishedAt ?? null,
                metrics: {
                    ...empty_metrics(),
                    views, plays: views,
                    likes, reactions: likes,
                    comments_count: comments,
                    engagement: likes + comments,
                },
                raw_response: v,
                platform_error: null,
            } as AnalyticsItem;
        });
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        const status = err?.code ?? err?.response?.status;
        const kind: PlatformError["error_kind"] = status === 401 ? "token_expired"
            : status === 403 ? "permission"
            : status === 429 ? "rate_limit"
            : "unknown";
        errors.push({ platform: "youtube", api_name: "videos.list", error_message: msg, error_kind: kind });
        alog("youtube_videos_failed", { error: msg, kind });
    }

    return { items, errors };
}

// ── Facebook Page ─────────────────────────────────────────────────────

export async function fetch_facebook_analytics_from_api(opts: {
    user_id: string;
    filters: AnalyticsQueryInput;
}): Promise<PlatformFetchResult> {
    const { user_id, filters } = opts;
    const errors: PlatformError[] = [];

    const account = await SocialAccount.findOne({
        where: { user_id, platform: "facebook", status: "connected" } as any,
        order: [["createdAt", "DESC"]],
    });
    if (!account || !account.access_token || !account.page_id) {
        return { items: [], errors: [] };
    }

    let video_rows: any[] = [];
    try {
        // Reverted from inline `likes.summary(true).limit(0)` — that
        // syntax doesn't reliably return engagement counts on the
        // /page/videos edge for many Page tokens (silently returns
        // empty edges). Back to the two-step pattern:
        //   1. Cheap list call here (no engagement)
        //   2. Per-chunk multi-id engagement call below
        // This gives correct data; trade-off is 1 extra round-trip per
        // 30 videos which is acceptable.
        video_rows = await paginate_graph({
            url: `${GRAPH_URL}/${account.page_id}/videos`,
            params: {
                access_token: account.access_token,
                fields: "id,title,description,permalink_url,created_time,thumbnails{uri,is_preferred},from,length,published",
            },
            max_items: filters.limit_per_platform,
        });
    } catch (err: any) {
        const status = err?.response?.status;
        const kind: PlatformError["error_kind"] = status === 401 ? "token_expired"
            : status === 403 ? "permission"
            : status === 429 ? "rate_limit"
            : "unknown";
        const msg = err?.response?.data?.error?.message ?? err?.message ?? String(err);
        errors.push({ platform: "facebook", api_name: "page.videos", error_message: msg, error_kind: kind });
        alog("facebook_list_failed", { error: msg, kind });
        return { items: [], errors };
    }
    alog("facebook_list_done", { count: video_rows.length });

    // Counts-only fast path. We keep per-video INSIGHTS calls skipped
    // (those are the slow ones — views/reach/impressions), but DO run
    // the batched engagement-summary call to get likes / comments /
    // shares. Each chunk is a single multi-id Graph call:
    //   GET /?ids=v1,v2,…&fields=likes.summary(true).limit(0),…
    // ~1 round-trip per 30 ids, runs in parallel under FB_CONCURRENCY.
    if (filters.counts_only) {
        const id_chunks: string[][] = [];
        for (let i = 0; i < video_rows.length; i += 30) {
            id_chunks.push(video_rows.slice(i, i + 30).map(v => v.id));
        }
        const engagement_by_id = new Map<string, { reactions: number; comments: number; shares: number }>();
        await with_concurrency(id_chunks, FB_CONCURRENCY, async chunk => {
            try {
                const { data } = await axios.get(`${GRAPH_URL}/`, {
                    params: {
                        access_token: account.access_token,
                        ids: chunk.join(","),
                        fields: "likes.summary(true).limit(0),comments.summary(true).limit(0),shares",
                    },
                });
                for (const id of chunk) {
                    const node = (data ?? {})[id] ?? {};
                    engagement_by_id.set(id, {
                        reactions: node?.likes?.summary?.total_count ?? 0,
                        comments: node?.comments?.summary?.total_count ?? 0,
                        shares: node?.shares?.count ?? 0,
                    });
                }
            } catch (err: any) {
                // Per-chunk failure is non-fatal — leaves entries
                // unset (default 0). Log so the user can see what
                // platform error caused the engagement to be missing.
                alog("facebook_engagement_chunk_failed", {
                    chunk_size: chunk.length,
                    error: err?.response?.data?.error?.message ?? err?.message ?? String(err),
                });
            }
        });

        const items: AnalyticsItem[] = video_rows.map(v => {
            const m = engagement_by_id.get(v.id) ?? { reactions: 0, comments: 0, shares: 0 };
            return {
                platform: "facebook",
                platform_id: v.id,
                platform_video_id: v.id,
                platform_media_id: null,
                platform_post_id: v.id,
                title: v.title ?? null,
                caption: v.description ?? null,
                thumbnail: null,
                platform_url: v.permalink_url ?? `https://www.facebook.com/${v.id}`,
                status: v.published === false ? "scheduled" : "published",
                published_at: v.created_time ?? null,
                metrics: {
                    ...empty_metrics(),
                    reactions: m.reactions, likes: m.reactions,
                    comments_count: m.comments,
                    shares: m.shares,
                    engagement: m.reactions + m.comments + m.shares,
                },
                raw_response: null,
                platform_error: null,
            } as AnalyticsItem;
        });
        return { items, errors };
    }

    // BATCH the per-video data via the Graph API multi-id endpoint
    // (`GET /?ids=v1,v2,v3&fields=…`). One round-trip replaces N×2 calls
    // and is the single biggest perf win on this page.
    //
    // We chunk into batches of 30 ids (Graph caps at 50 but 30 keeps URL
    // length sane) and run those chunks concurrently up to FB_CONCURRENCY.
    const id_chunks: string[][] = [];
    for (let i = 0; i < video_rows.length; i += 30) {
        id_chunks.push(video_rows.slice(i, i + 30).map(v => v.id));
    }

    const insights_by_id = new Map<string, { reactions: number; comments: number; shares: number; views: number; impressions: number }>();

    await with_concurrency(id_chunks, FB_CONCURRENCY, async chunk => {
        // Engagement edges — reactions/comments/shares come from the
        // top-level node fields, video_views is best fetched separately
        // via the dedicated insights edge (only some accounts can read it).
        try {
            const { data } = await axios.get(`${GRAPH_URL}/`, {
                params: {
                    access_token: account.access_token,
                    ids: chunk.join(","),
                    fields: "likes.summary(true).limit(0),comments.summary(true).limit(0),shares",
                },
            });
            for (const id of chunk) {
                const node = (data ?? {})[id] ?? {};
                insights_by_id.set(id, {
                    reactions: node?.likes?.summary?.total_count ?? 0,
                    comments: node?.comments?.summary?.total_count ?? 0,
                    shares: node?.shares?.count ?? 0,
                    views: 0,
                    impressions: 0,
                });
            }
        } catch { /* best-effort — leaves entries un-set, defaulted to 0 below */ }

        // Insights are still per-video on the FB API (no batch). But
        // we run them per chunk concurrently.
        await with_concurrency(chunk, FB_CONCURRENCY, async vid => {
            try {
                const { data } = await axios.get(`${GRAPH_URL}/${vid}/video_insights`, {
                    params: {
                        access_token: account.access_token,
                        metric: "total_video_views,total_video_impressions",
                    },
                });
                const map = (data?.data ?? []).reduce((acc: any, m: any) => {
                    acc[m.name] = m.values?.[0]?.value ?? 0;
                    return acc;
                }, {});
                const entry = insights_by_id.get(vid) ?? { reactions: 0, comments: 0, shares: 0, views: 0, impressions: 0 };
                entry.views = Number(map.total_video_views ?? 0);
                entry.impressions = Number(map.total_video_impressions ?? 0);
                insights_by_id.set(vid, entry);
            } catch { /* best-effort */ }
        });
    });

    const items: AnalyticsItem[] = video_rows.map(v => {
        const m = insights_by_id.get(v.id) ?? { reactions: 0, comments: 0, shares: 0, views: 0, impressions: 0 };
        const status: AnalyticsItem["status"] = v.published === false ? "scheduled" : "published";
        const thumb = (v.thumbnails?.data?.find((t: any) => t.is_preferred) ?? v.thumbnails?.data?.[0])?.uri ?? null;
        return {
            platform: "facebook",
            platform_id: v.id,
            platform_video_id: v.id,
            platform_media_id: null,
            platform_post_id: v.id,
            title: v.title ?? null,
            caption: v.description ?? null,
            thumbnail: thumb,
            platform_url: v.permalink_url ?? `https://www.facebook.com/${v.id}`,
            status,
            published_at: v.created_time ?? null,
            metrics: {
                ...empty_metrics(),
                views: m.views, plays: m.views,
                reactions: m.reactions, likes: m.reactions,
                comments_count: m.comments,
                shares: m.shares,
                impressions: m.impressions,
                engagement: m.reactions + m.comments + m.shares,
            },
            raw_response: { video: v, ...m },
            platform_error: null,
        } as AnalyticsItem;
    });

    return { items, errors };
}

// ── Instagram ─────────────────────────────────────────────────────────

export async function fetch_instagram_analytics_from_api(opts: {
    user_id: string;
    filters: AnalyticsQueryInput;
}): Promise<PlatformFetchResult> {
    const { user_id, filters } = opts;
    const errors: PlatformError[] = [];

    const account = await SocialAccount.findOne({
        where: { user_id, platform: "instagram", status: "connected" } as any,
        order: [["createdAt", "DESC"]],
    });
    if (!account || !account.access_token || !account.account_id) {
        return { items: [], errors: [] };
    }

    let media_rows: any[] = [];
    try {
        // Same pagination story as Facebook — IG /<biz>/media also caps
        // at ~25-50 per page and exposes `paging.next`. Without this
        // walk a 166-post account showed the first 50 only.
        // counts_only: drop heavy fields (caption / media_url / etc.)
        // but KEEP like_count + comments_count — those are returned
        // for free in the list response, no insights call needed.
        const fields = filters.counts_only
            ? "id,timestamp,media_type,like_count,comments_count"
            : "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";
        media_rows = await paginate_graph({
            url: `${GRAPH_URL}/${account.account_id}/media`,
            params: {
                access_token: account.access_token,
                fields,
            },
            max_items: filters.limit_per_platform,
        });
    } catch (err: any) {
        const status = err?.response?.status;
        const kind: PlatformError["error_kind"] = status === 401 ? "token_expired"
            : status === 403 ? "permission"
            : status === 429 ? "rate_limit"
            : "unknown";
        const msg = err?.response?.data?.error?.message ?? err?.message ?? String(err);
        errors.push({ platform: "instagram", api_name: "media.list", error_message: msg, error_kind: kind });
        alog("instagram_list_failed", { error: msg, kind });
        return { items: [], errors };
    }
    alog("instagram_list_done", { count: media_rows.length });

    // Counts-only fast path — skip per-media /insights calls (those
    // are the slow path that gives plays/reach/impressions/saves).
    // BUT use like_count + comments_count from the list response,
    // which are returned for free per IG media object.
    if (filters.counts_only) {
        const items: AnalyticsItem[] = media_rows.map(m => {
            const likes = Number(m.like_count ?? 0);
            const comments = Number(m.comments_count ?? 0);
            return {
                platform: "instagram",
                platform_id: m.id,
                platform_video_id: null,
                platform_media_id: m.id,
                platform_post_id: null,
                title: null,
                caption: null,
                thumbnail: null,
                platform_url: null,
                status: "published",
                published_at: m.timestamp ?? null,
                metrics: {
                    ...empty_metrics(),
                    likes, reactions: likes,
                    comments_count: comments,
                    engagement: likes + comments,
                },
                raw_response: null,
                platform_error: null,
            } as AnalyticsItem;
        });
        return { items, errors };
    }

    const items: AnalyticsItem[] = await with_concurrency(media_rows, IG_CONCURRENCY, async m => {
        let insights: any = {};
        try {
            // IG metrics differ for REELS / VIDEO / IMAGE / CAROUSEL_ALBUM.
            const metric_set = m.media_type === "VIDEO" || m.media_type === "REELS"
                ? "plays,reach,impressions,saved,shares,total_interactions"
                : "reach,impressions,saved,shares,total_interactions";
            const { data } = await axios.get(`${GRAPH_URL}/${m.id}/insights`, {
                params: { access_token: account.access_token, metric: metric_set },
            });
            insights = (data?.data ?? []).reduce((acc: any, x: any) => {
                acc[x.name] = x.values?.[0]?.value ?? 0;
                return acc;
            }, {});
        } catch { /* metrics are best-effort */ }

        const plays = Number(insights.plays ?? 0);
        const likes = Number(m.like_count ?? 0);
        const comments = Number(m.comments_count ?? 0);
        const saves = Number(insights.saved ?? 0);
        const shares = Number(insights.shares ?? 0);
        const reach = Number(insights.reach ?? 0);
        const impressions = Number(insights.impressions ?? 0);
        return {
            platform: "instagram",
            platform_id: m.id,
            platform_video_id: null,
            platform_media_id: m.id,
            platform_post_id: null,
            title: null,
            caption: m.caption ?? null,
            thumbnail: m.thumbnail_url ?? m.media_url ?? null,
            platform_url: m.permalink ?? null,
            status: "published",
            published_at: m.timestamp ?? null,
            metrics: {
                ...empty_metrics(),
                views: plays, plays,
                likes, reactions: likes,
                comments_count: comments,
                shares,
                reach, impressions,
                saves,
                engagement: likes + comments + shares + saves,
            },
            raw_response: { media: m, insights },
            platform_error: null,
        } as AnalyticsItem;
    });

    return { items, errors };
}

// ── Orchestrator + handler ────────────────────────────────────────────

function build_summary(items: AnalyticsItem[]) {
    const s = {
        total_platform_videos: items.length,
        youtube_videos: 0,
        facebook_videos: 0,
        instagram_videos: 0,
        published: 0,
        scheduled: 0,
        failed: 0,
        processing: 0,
        draft: 0,
        total_views: 0,
        total_likes: 0,
        total_comments: 0,
        total_shares: 0,
        total_reach: 0,
        total_impressions: 0,
        total_saves: 0,
        total_engagement: 0,
    };
    for (const it of items) {
        if (it.platform === "youtube") s.youtube_videos += 1;
        else if (it.platform === "facebook") s.facebook_videos += 1;
        else if (it.platform === "instagram") s.instagram_videos += 1;
        if (it.status === "published") s.published += 1;
        else if (it.status === "scheduled") s.scheduled += 1;
        else if (it.status === "failed") s.failed += 1;
        else if (it.status === "processing") s.processing += 1;
        else if (it.status === "draft") s.draft += 1;
        s.total_views += it.metrics.views;
        s.total_likes += it.metrics.likes;
        s.total_comments += it.metrics.comments_count;
        s.total_shares += it.metrics.shares;
        s.total_reach += it.metrics.reach;
        s.total_impressions += it.metrics.impressions;
        s.total_saves += it.metrics.saves;
        s.total_engagement += it.metrics.engagement;
    }
    return s;
}

function build_platform_summary(items: AnalyticsItem[]) {
    const yt = items.filter(i => i.platform === "youtube");
    const fb = items.filter(i => i.platform === "facebook");
    const ig = items.filter(i => i.platform === "instagram");
    const sum = (arr: AnalyticsItem[], k: keyof AnalyticsItem["metrics"]) => arr.reduce((a, x) => a + x.metrics[k], 0);
    return {
        youtube: {
            videos: yt.length,
            views: sum(yt, "views"),
            likes: sum(yt, "likes"),
            comments_count: sum(yt, "comments_count"),
            errors: [],
        },
        facebook: {
            videos: fb.length,
            views: sum(fb, "views"),
            reactions: sum(fb, "reactions"),
            comments_count: sum(fb, "comments_count"),
            shares: sum(fb, "shares"),
            reach: sum(fb, "reach"),
            impressions: sum(fb, "impressions"),
            errors: [],
        },
        instagram: {
            videos: ig.length,
            plays: sum(ig, "plays"),
            likes: sum(ig, "likes"),
            comments_count: sum(ig, "comments_count"),
            shares: sum(ig, "shares"),
            saves: sum(ig, "saves"),
            reach: sum(ig, "reach"),
            impressions: sum(ig, "impressions"),
            errors: [],
        },
    };
}

export async function get_social_analytics(req: FastifyRequest) {
    const user_id = (req as any).userId as string | undefined;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const filters = (req.query ?? {}) as AnalyticsQueryInput;
    const platform: AnalyticsPlatform = (filters.platform ?? "all") as AnalyticsPlatform;

    // Memory cache — 2-minute TTL, keyed per-user + filter-set. Bypassed
    // when the UI sends `force_refresh=true` (the Refresh button does
    // this). Spec rule: nothing persists; this lives in Node memory.
    const ck = cache_key(user_id, filters);
    if (!filters.force_refresh) {
        const hit = _cache.get(ck);
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
            alog("cache_hit", { user_id, platform, age_ms: Date.now() - hit.at });
            // Defensive: never ship items[] when the caller didn't ask
            // for them, even if a legacy cached entry still has them.
            const out = { ...hit.data, cached: true };
            if (!filters.include_items && "items" in out) delete out.items;
            return success("live platform analytics fetched (cached)", out);
        }
    }

    alog("fetch_start", { user_id, platform, status: filters.status, date_range: filters.date_range });

    const tasks: Array<Promise<PlatformFetchResult>> = [];
    if (platform === "all" || platform === "youtube")   tasks.push(fetch_youtube_analytics_from_api({ user_id, filters }));
    if (platform === "all" || platform === "facebook")  tasks.push(fetch_facebook_analytics_from_api({ user_id, filters }));
    if (platform === "all" || platform === "instagram") tasks.push(fetch_instagram_analytics_from_api({ user_id, filters }));

    const results = await Promise.allSettled(tasks);
    const platform_errors: PlatformError[] = [];
    let all_items: AnalyticsItem[] = [];
    for (const r of results) {
        if (r.status === "fulfilled") {
            all_items = all_items.concat(r.value.items);
            platform_errors.push(...r.value.errors);
        } else {
            platform_errors.push({
                platform: "youtube", // unknown — will be replaced if reason carries it
                api_name: "fetch",
                error_message: (r.reason as any)?.message ?? String(r.reason),
                error_kind: "unknown",
            });
        }
    }

    // Apply post-fetch filters (status, search, date-range) once. Lets each
    // platform fetcher stay simple — it just enumerates.
    const win = compute_date_window(filters);
    const filtered = all_items.filter(it => passes_filters(it, filters, win));

    // Apply platform_errors to platform_summary blocks for the UI.
    const platform_summary: any = build_platform_summary(filtered);
    for (const e of platform_errors) {
        if (platform_summary[e.platform]) platform_summary[e.platform].errors.push(e);
    }

    // Today's slice — items whose published_at falls within the current
    // local day boundary. Computed server-side so the UI doesn't have
    // to re-walk all rows on every render. Spec: "show today analytics
    // separately".
    const today_start = new Date(); today_start.setHours(0, 0, 0, 0);
    const today_end = new Date(); today_end.setHours(23, 59, 59, 999);
    const today_items = filtered.filter(it => {
        if (!it.published_at) return false;
        const ts = new Date(it.published_at).getTime();
        return ts >= today_start.getTime() && ts <= today_end.getTime();
    });

    const fetched_at = new Date().toISOString();
    const payload: any = {
        fetched_at,
        platform,
        summary: build_summary(filtered),
        today_summary: build_summary(today_items),
        platform_summary,
        errors: platform_errors,
    };
    // Only ship the heavy items[] when explicitly asked — saves
    // bandwidth on the donut/cards-only dashboard. The summary blocks
    // already carry all the numbers we render.
    if (filters.include_items) {
        payload.items = filtered;
    }

    // Stash in the memory cache. Bounded by manual eviction on TTL
    // expiry below — we don't grow beyond the working set.
    _cache.set(ck, { at: Date.now(), data: payload });
    // Lazy GC: every set, drop entries older than 2× TTL so stale
    // user/filter combos don't leak.
    if (_cache.size > 100) {
        const cutoff = Date.now() - 2 * CACHE_TTL_MS;
        for (const [k, v] of _cache.entries()) if (v.at < cutoff) _cache.delete(k);
    }

    return success("live platform analytics fetched", payload);
}

// Exported aliases that match the spec wording — useful if external
// modules want to call platform fetchers directly later.
export const get_analytics = get_social_analytics;

/**
 * Today-only analytics. Lightweight wrapper that reuses the platform
 * fetchers in counts-only mode (so no per-video insights calls), then
 * filters to the local-today window. Independent endpoint so the
 * frontend's Today card can refresh on its own cadence without paying
 * the full all-time analytics roundtrip.
 *
 *   GET /api/analytics/social/today
 *
 * Response shape (no `items[]`, no all-time `summary`):
 *   {
 *     fetched_at,
 *     today_summary,
 *     platform_summary,        // restricted to today
 *     errors,
 *     cached?
 *   }
 *
 * Has its own cache key (suffix `today=1`) so it doesn't collide with
 * the main analytics cache entry.
 */
export async function get_today_analytics(req: FastifyRequest) {
    const user_id = (req as any).userId as string | undefined;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const q = (req.query ?? {}) as Partial<AnalyticsQueryInput>;
    const platform: AnalyticsPlatform = (q.platform ?? "all") as AnalyticsPlatform;

    // Cache (separate namespace from the all-time endpoint).
    const ck = `today|v1|${user_id}|${platform}|force=${q.force_refresh ? "1" : "0"}`;
    if (!q.force_refresh) {
        const hit = _cache.get(ck);
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
            alog("today_cache_hit", { user_id, platform, age_ms: Date.now() - hit.at });
            return success("today analytics fetched (cached)", { ...hit.data, cached: true });
        }
    }

    alog("today_fetch_start", { user_id, platform });

    // Force counts-only mode and a generous limit so we capture
    // anything that landed today — most channels post < 200 items in
    // 24h, but the limit_per_platform cap keeps us bounded.
    const filters: AnalyticsQueryInput = {
        platform,
        status: (q.status ?? "all") as AnalyticsStatus,
        date_range: "today",
        search: "",
        limit_per_platform: 200,
        counts_only: true,
        include_items: false,
    };

    const tasks: Array<Promise<PlatformFetchResult>> = [];
    if (platform === "all" || platform === "youtube")   tasks.push(fetch_youtube_analytics_from_api({ user_id, filters }));
    if (platform === "all" || platform === "facebook")  tasks.push(fetch_facebook_analytics_from_api({ user_id, filters }));
    if (platform === "all" || platform === "instagram") tasks.push(fetch_instagram_analytics_from_api({ user_id, filters }));

    const results = await Promise.allSettled(tasks);
    const platform_errors: PlatformError[] = [];
    let all_items: AnalyticsItem[] = [];
    for (const r of results) {
        if (r.status === "fulfilled") {
            all_items = all_items.concat(r.value.items);
            platform_errors.push(...r.value.errors);
        }
    }

    // Local-day window — same logic the all-time endpoint uses.
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const today_items = all_items.filter(it => {
        if (!it.published_at) return false;
        const ts = new Date(it.published_at).getTime();
        return ts >= start.getTime() && ts <= end.getTime();
    });

    const platform_summary = build_platform_summary(today_items);
    for (const e of platform_errors) {
        if ((platform_summary as any)[e.platform]) (platform_summary as any)[e.platform].errors.push(e);
    }

    const payload = {
        fetched_at: new Date().toISOString(),
        platform,
        today_summary: build_summary(today_items),
        platform_summary,
        errors: platform_errors,
    };
    _cache.set(ck, { at: Date.now(), data: payload });
    return success("today analytics fetched", payload);
}
