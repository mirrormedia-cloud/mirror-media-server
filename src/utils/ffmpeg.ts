import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import axios from "axios";
import { config } from "../config";

/**
 * Process-wide ffmpeg semaphore. Each conversion takes 200-500 MB and is
 * CPU-heavy; spawning 5+ at once on a typical dev machine OOMs / crashes
 * with abnormal-termination codes (we saw "exit 3199971767" =
 * 0xBEBAFEB7 on Windows, which is a memory / OS-level abort).
 *
 * Drive uploads (I/O-bound) keep their per-user cap of 5; ffmpeg gets
 * its own much smaller limit. Override via `FFMPEG_MAX_CONCURRENCY`.
 */
const FFMPEG_MAX_CONCURRENCY = Math.max(1, Number(process.env.FFMPEG_MAX_CONCURRENCY ?? 2));
let _ffmpeg_in_flight = 0;
const _ffmpeg_waiters: Array<() => void> = [];

function acquire_ffmpeg_slot(): Promise<() => void> {
    return new Promise((resolve) => {
        const grant = () => {
            _ffmpeg_in_flight += 1;
            resolve(() => {
                _ffmpeg_in_flight -= 1;
                const next = _ffmpeg_waiters.shift();
                if (next) next();
            });
        };
        if (_ffmpeg_in_flight < FFMPEG_MAX_CONCURRENCY) grant();
        else _ffmpeg_waiters.push(grant);
    });
}

/**
 * Resolve the ffmpeg binary at call time. Two ways to configure:
 *   1. Set `FFMPEG_PATH` in backend/.env to the binary or to the folder that contains it.
 *      Example (Windows): FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe
 *      Example (folder):  FFMPEG_PATH=C:\ffmpeg\bin
 *   2. Or leave it empty and have ffmpeg on PATH — we'll spawn the bare "ffmpeg" command.
 *
 * If neither works the spawn throws ENOENT and we surface a `FfmpegMissingError`.
 */
function resolve_ffmpeg_bin(): string {
    const configured = (config.ffmpeg?.path || "").trim();
    if (!configured) return "ffmpeg";

    // Trim trailing slashes for consistency.
    const normalized = configured.replace(/[\\/]+$/, "");

    try {
        const stat = fs.statSync(normalized);
        if (stat.isDirectory()) {
            const win = path.join(normalized, "ffmpeg.exe");
            if (fs.existsSync(win)) return win;
            const nix = path.join(normalized, "ffmpeg");
            if (fs.existsSync(nix)) return nix;
        }
        // Either a file path that exists, or stat failed silently — let spawn try it.
        return normalized;
    } catch {
        // Path doesn't exist locally; still try spawn (e.g. it might be a docker volume not yet mounted).
        return normalized;
    }
}

// ── HLS master-playlist resolver ─────────────────────────────────────────
// HLS master playlists list multiple variants (e.g. 360p/720p/1080p/4K). When
// you hand ffmpeg a master URL, it picks the FIRST variant in the file —
// often the lowest quality, since CDNs commonly order low-to-high. To honour
// the "high quality always" rule, we fetch the master, parse the variants,
// and rewrite the URL to point at the highest-bandwidth media playlist.
//
// Safe no-op when the URL is already a media playlist (no #EXT-X-STREAM-INF
// lines) or anything else (mp4, mpd, etc.) — returns the original URL.

interface HlsVariant {
    bandwidth: number;
    resolution_pixels: number;  // width * height; 0 if unknown
    url: string;
}

const STREAM_INF_RE = /^#EXT-X-STREAM-INF:(.*)$/i;
const ATTR_BANDWIDTH_RE = /BANDWIDTH=(\d+)/i;
const ATTR_RESOLUTION_RE = /RESOLUTION=(\d+)x(\d+)/i;

function parse_hls_master(playlist: string, base_url: string): HlsVariant[] {
    const lines = playlist.split(/\r?\n/);
    const out: HlsVariant[] = [];
    let pending: { bandwidth: number; resolution_pixels: number } | null = null;
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const m = line.match(STREAM_INF_RE);
        if (m) {
            const attrs = m[1] ?? "";
            const bw = attrs.match(ATTR_BANDWIDTH_RE);
            const res = attrs.match(ATTR_RESOLUTION_RE);
            pending = {
                bandwidth: bw ? parseInt(bw[1]!, 10) : 0,
                resolution_pixels: res ? parseInt(res[1]!, 10) * parseInt(res[2]!, 10) : 0,
            };
            continue;
        }
        if (line.startsWith("#")) continue;
        if (pending) {
            // The URI line right after #EXT-X-STREAM-INF — may be relative.
            let resolved: string;
            try {
                resolved = new URL(line, base_url).toString();
            } catch {
                resolved = line;
            }
            out.push({ ...pending, url: resolved });
            pending = null;
        }
    }
    return out;
}

/**
 * Given an HLS URL, return the highest-quality variant URL. Performs a single
 * GET to fetch the playlist text. Returns the original URL on any failure or
 * when the playlist is not a master (just media), so callers can use the
 * return value unconditionally.
 */
export async function resolve_hls_highest_variant(args: {
    url: string;
    headers?: Record<string, string>;
}): Promise<string> {
    const { url, headers } = args;
    if (!url || !/\.m3u8(\?|$)/i.test(url)) return url;
    try {
        const res = await axios.get<string>(url, {
            headers: headers ?? {},
            // No timeout — HLS master playlist fetch must complete even on
            // slow upstreams.
            timeout: 0,
            responseType: "text",
            validateStatus: () => true,
            transformResponse: [(d) => d],
        });
        if (res.status >= 400 || typeof res.data !== "string") return url;
        const text = res.data;
        if (!text.includes("#EXT-X-STREAM-INF")) return url; // media playlist
        const variants = parse_hls_master(text, url);
        if (variants.length === 0) return url;
        // Sort by resolution first (when known), then bandwidth — beats picking
        // bandwidth alone in cases where two variants have similar bitrates but
        // one is genuinely higher resolution.
        variants.sort((a, b) => {
            if (b.resolution_pixels !== a.resolution_pixels) return b.resolution_pixels - a.resolution_pixels;
            return b.bandwidth - a.bandwidth;
        });
        return variants[0]!.url;
    } catch {
        return url;
    }
}

export class FfmpegMissingError extends Error {
    constructor(resolved_path?: string) {
        const detail = resolved_path && resolved_path !== "ffmpeg"
            ? ` (looked at "${resolved_path}")`
            : "";
        super(
            `ffmpeg not found${detail}. Either install ffmpeg and put it on PATH, `
            + `or set FFMPEG_PATH in backend/.env to the full path of the binary `
            + `(e.g. FFMPEG_PATH="C:\\\\ffmpeg\\\\bin\\\\ffmpeg.exe").`,
        );
        this.name = "FfmpegMissingError";
    }
}

export interface FfmpegConvertOptions {
    input_url: string;
    output_path: string;
    /** Headers map (e.g. Cookie, User-Agent). Joined with \r\n for ffmpeg's -headers flag. */
    headers?: Record<string, string>;
    /** Extra args inserted before the input. */
    extra_args?: string[];
    /** Called as the conversion progresses (parsed from stderr "time=..." lines). */
    on_progress?: (info: { progress_percent: number | null; raw_line: string }) => void;
    /** Re-encode (slower) instead of -c copy. Used as a fallback when stream copy can't merge codecs. */
    reencode?: boolean;
    /** Hard timeout in ms (default 30 minutes). */
    timeout_ms?: number;
}

function format_headers_for_ffmpeg(headers: Record<string, string>): string {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(headers)) {
        if (!k || v === undefined || v === null) continue;
        const safe_value = String(v).replace(/\r?\n/g, "");
        lines.push(`${k}: ${safe_value}`);
    }
    return lines.length ? `${lines.join("\r\n")}\r\n` : "";
}

const DURATION_RE = /Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d+)/;
const TIME_RE = /time=\s*(\d{2}):(\d{2}):(\d{2})\.(\d+)/;

function hms_to_seconds(h: string, m: string, s: string, frac: string): number {
    return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${frac}`);
}

/**
 * Run ffmpeg to convert an http(s)/m3u8/mpd input into an mp4 file.
 *
 * Wrapped in a semaphore (`acquire_ffmpeg_slot`) so at most
 * FFMPEG_MAX_CONCURRENCY processes ever run concurrently. Without this,
 * a batch of 5+ Drive uploads each hitting `convert_to_mp4` at once
 * would spawn 5+ ffmpeg processes — each 200-500 MB — and routinely
 * OOM-crash on dev boxes (Windows abnormal-termination code 0xBEBAFEB7).
 */
export async function convert_to_mp4(opts: FfmpegConvertOptions): Promise<{ stderr: string }> {
    const release = await acquire_ffmpeg_slot();
    try {
        return await run_ffmpeg(opts);
    } finally {
        release();
    }
}

function run_ffmpeg(opts: FfmpegConvertOptions): Promise<{ stderr: string }> {
    return new Promise((resolve, reject) => {
        const args: string[] = ["-y"];

        const header_string = format_headers_for_ffmpeg(opts.headers ?? {});
        if (header_string) {
            args.push("-headers", header_string);
        }

        if (opts.extra_args) args.push(...opts.extra_args);

        args.push("-i", opts.input_url);

        // Default: stream-copy. Lossless — codec data is remuxed into MP4 with
        // zero quality loss. This is what runs for the vast majority of HLS
        // streams (h264 video + aac audio already, just needs container swap).
        //
        // Fallback: re-encode. Only triggered when stream-copy fails (codec
        // incompatibilities, mixed codecs across segments, etc.). Tuned for
        // HIGH QUALITY rather than speed:
        //   -preset slow      — better compression efficiency than veryfast
        //   -crf 18           — visually lossless h264 (CRF 17–18 is the
        //                       perceptual-transparency threshold; 23 is the
        //                       libx264 default and noticeably worse).
        //   -pix_fmt yuv420p  — broad player compatibility.
        //   -c:a aac -b:a 192k — keeps audio quality high (jump from 128k).
        // Re-encoding with these settings is slower but the user asked for
        // "high quality always" — speed is secondary.
        if (opts.reencode) {
            args.push(
                "-c:v", "libx264",
                "-preset", "slow",
                "-crf", "18",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac",
                "-b:a", "192k",
            );
        } else {
            args.push("-c", "copy");
        }
        args.push("-bsf:a", "aac_adtstoasc"); // safe for HLS audio
        args.push("-movflags", "+faststart");
        args.push(opts.output_path);

        // Defensive: ensure the output directory exists. We've seen
        // ffmpeg fail with `Error opening output ... : No such file or
        // directory` when the job's temp folder was cleaned up between
        // `alloc_temp_dir` and the actual spawn (race with a sibling
        // retry). mkdirSync recursive is idempotent — cheaper than the
        // ffmpeg crash + Windows abnormal-exit-code interpretation.
        try {
            const out_dir = path.dirname(opts.output_path);
            if (out_dir) fs.mkdirSync(out_dir, { recursive: true });
        } catch { /* ignore — ffmpeg will report its own error if it really can't write */ }

        let stderr_buf = "";
        let total_seconds: number | null = null;
        let killed_for_timeout = false;

        const bin = resolve_ffmpeg_bin();
        let child;
        try {
            child = spawn(bin, args, { windowsHide: true });
        } catch (err: any) {
            if (err?.code === "ENOENT") {
                reject(new FfmpegMissingError(bin));
                return;
            }
            reject(err);
            return;
        }

        const timeout = setTimeout(() => {
            killed_for_timeout = true;
            try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }, opts.timeout_ms ?? 30 * 60 * 1000);

        child.on("error", (err: NodeJS.ErrnoException) => {
            clearTimeout(timeout);
            if (err.code === "ENOENT") {
                reject(new FfmpegMissingError(bin));
                return;
            }
            reject(err);
        });

        child.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stderr_buf += text;
            if (stderr_buf.length > 200_000) {
                stderr_buf = stderr_buf.slice(-100_000);
            }
            if (!total_seconds) {
                const dur = text.match(DURATION_RE) || stderr_buf.match(DURATION_RE);
                if (dur) total_seconds = hms_to_seconds(dur[1]!, dur[2]!, dur[3]!, dur[4]!);
            }
            if (opts.on_progress) {
                for (const line of text.split(/\r?\n|\r/)) {
                    const m = line.match(TIME_RE);
                    if (m) {
                        const elapsed = hms_to_seconds(m[1]!, m[2]!, m[3]!, m[4]!);
                        const percent = total_seconds ? Math.min(99, Math.round((elapsed / total_seconds) * 100)) : null;
                        opts.on_progress({ progress_percent: percent, raw_line: line });
                    }
                }
            }
        });

        child.on("close", (code) => {
            clearTimeout(timeout);
            if (killed_for_timeout) {
                reject(new Error(`ffmpeg killed after timeout`));
                return;
            }
            if (code === 0) {
                resolve({ stderr: stderr_buf });
            } else {
                // Abnormal Windows exit codes are huge unsigned ints
                // (e.g. 0xBEBAFEB7, 0xFFFFFFFE). They CAN mean OOM /
                // SEH abort, but more often they're benign Win32
                // errors that ffmpeg returned via the C runtime
                // (-1 = 0xFFFFFFFF, -2 = 0xFFFFFFFE, etc.). Inspect
                // the stderr tail before guessing — many failures
                // have a clear message we can surface directly.
                const code_hex = typeof code === "number" ? `0x${(code >>> 0).toString(16).toUpperCase()}` : "?";
                const abnormal = typeof code === "number" && code > 0x80000000;
                const tail = stderr_buf.split(/\r?\n/).slice(-20).join("\n");
                let hint = "";
                if (/No such file or directory/i.test(stderr_buf)) {
                    hint = " (output path's parent directory was missing — likely a temp-dir race; the queue will retry)";
                } else if (/Server returned 4\d\d|HTTP error 4\d\d/i.test(stderr_buf)) {
                    hint = " (upstream returned 4xx — source URL expired or auth required)";
                } else if (/Server returned 5\d\d|HTTP error 5\d\d/i.test(stderr_buf)) {
                    hint = " (upstream 5xx — try again later)";
                } else if (/Invalid data found when processing input/i.test(stderr_buf)) {
                    hint = " (corrupt source — segments could not be parsed)";
                } else if (abnormal) {
                    hint = " (abnormal termination — possibly OOM or external kill; check FFMPEG_MAX_CONCURRENCY and free RAM)";
                }
                reject(new Error(`ffmpeg exited with code ${code} (${code_hex})${hint}: ${tail}`));
            }
        });
    });
}

/**
 * Wraps a still image in a short MP4 (H.264 + silent AAC audio) so it
 * can be uploaded to a video-only platform like YouTube. Output is
 * yuv420p H.264 in MP4 with `+faststart`, matching what every social
 * platform accepts. A silent stereo audio track is always added —
 * YouTube rejects video uploads with no audio stream.
 *
 * The semaphore from `convert_to_mp4` is shared so a batch of image
 * conversions can't OOM the host any more than video conversions do.
 */
export async function image_to_video_mp4(opts: {
    image_path: string;
    output_path: string;
    /** Seconds the still frame should display. Default 5. */
    duration_sec?: number;
    /** Output frame rate. Default 30. */
    fps?: number;
}): Promise<{ stderr: string }> {
    const duration = Math.max(1, Math.min(60, opts.duration_sec ?? 5));
    const fps = Math.max(1, Math.min(60, opts.fps ?? 30));

    const release = await acquire_ffmpeg_slot();
    try {
        return await new Promise<{ stderr: string }>((resolve, reject) => {
            const args = [
                "-y",
                // Loop the single image for the requested duration.
                "-loop", "1",
                "-framerate", String(fps),
                "-i", opts.image_path,
                // Silent stereo audio track — YouTube requires an audio
                // stream and rejects uploads that have none.
                "-f", "lavfi",
                "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
                "-t", String(duration),
                "-c:v", "libx264",
                // even dimensions are required by yuv420p; ceil to nearest 2.
                "-vf", "scale='trunc(iw/2)*2':'trunc(ih/2)*2'",
                "-pix_fmt", "yuv420p",
                "-preset", "fast",
                "-crf", "20",
                "-c:a", "aac",
                "-b:a", "128k",
                "-shortest",
                "-movflags", "+faststart",
                opts.output_path,
            ];

            try {
                const out_dir = path.dirname(opts.output_path);
                if (out_dir) fs.mkdirSync(out_dir, { recursive: true });
            } catch { /* ffmpeg will complain itself if it really can't write */ }

            let stderr_buf = "";
            const bin = resolve_ffmpeg_bin();
            let child;
            try {
                child = spawn(bin, args, { windowsHide: true });
            } catch (err: any) {
                if (err?.code === "ENOENT") {
                    reject(new FfmpegMissingError(bin));
                    return;
                }
                reject(err);
                return;
            }
            child.stderr?.on("data", (chunk) => { stderr_buf += chunk.toString(); });
            child.on("error", (err) => reject(err));
            child.on("close", (code) => {
                if (code === 0) {
                    resolve({ stderr: stderr_buf });
                } else {
                    const tail = stderr_buf.split(/\r?\n/).slice(-15).join("\n");
                    reject(new Error(`ffmpeg image-to-video failed with code ${code}: ${tail}`));
                }
            });
        });
    } finally {
        release();
    }
}
