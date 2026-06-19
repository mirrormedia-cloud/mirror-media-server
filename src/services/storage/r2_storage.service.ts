/**
 * Cloudflare R2 storage adapter.
 *
 * R2 is S3-compatible, so this module is a thin wrapper around the
 * AWS SDK v3 (`@aws-sdk/client-s3`) pointed at the R2 endpoint.
 *
 * Configuration (all from env via `config.r2`):
 *   R2_ACCOUNT_ID         — Cloudflare account id (only used for default endpoint formatting).
 *   R2_ENDPOINT           — Full S3 endpoint, e.g. https://<account_id>.r2.cloudflarestorage.com.
 *   R2_ACCESS_KEY_ID      — R2 API key id.
 *   R2_SECRET_ACCESS_KEY  — R2 API secret. NEVER expose to the frontend.
 *   R2_BUCKET_NAME        — bucket the library reads/writes.
 *   R2_PUBLIC_BASE_URL    — custom-domain CDN base (e.g. https://cdn.example.com).
 *                           When set, `get_public_url(key)` returns a permanent URL the
 *                           browser can read directly. When empty, callers should fall
 *                           back to `generate_read_signed_url`.
 *   R2_REGION             — usually 'auto'.
 *
 * Logging never includes credentials or the full signed URL query (the
 * signature is sensitive). Log the bare key, content type, and size
 * only.
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import fs from "fs";
import path from "path";
import { config } from "../../config";

function rlog(step: string, data?: Record<string, any>) {
    const safe = data ? Object.fromEntries(
        Object.entries(data).map(([k, v]) =>
            /secret|access_key|signature|x-amz/i.test(k)
                ? [k, "<redacted>"]
                : [k, v],
        ),
    ) : undefined;
    console.log(`[R2] ${step}${safe ? " " + JSON.stringify(safe) : ""}`);
}

export function is_r2_configured(): boolean {
    return !!(
        config.r2?.endpoint
        && config.r2?.access_key_id
        && config.r2?.secret_access_key
        && config.r2?.bucket_name
    );
}

let _client: S3Client | null = null;

export function create_r2_client(): S3Client {
    if (_client) return _client;
    if (!is_r2_configured()) {
        throw new Error(
            "R2 is not configured. Set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME in .env.",
        );
    }
    _client = new S3Client({
        region: config.r2.region || "auto",
        endpoint: config.r2.endpoint,
        credentials: {
            accessKeyId: config.r2.access_key_id,
            secretAccessKey: config.r2.secret_access_key,
        },
        // R2 supports both styles; virtual-host is the default in v3.
        forcePathStyle: false,
    });
    rlog("client initialized", { endpoint: config.r2.endpoint, bucket: config.r2.bucket_name });
    return _client;
}

const SAFE_FILE_NAME_RE = /[^a-zA-Z0-9._-]+/g;

/** Filesystem-safe basename for object keys. Keeps the extension. */
export function sanitize_object_name(name: string, fallback = "file"): string {
    const timestamp = Date.now();

    if (!name) return `${fallback}-${timestamp}`;

    const originalExt = path.extname(name);
    const ext = originalExt.toLowerCase().replace(SAFE_FILE_NAME_RE, "");
    const base = path
        .basename(name, originalExt)
        .replace(SAFE_FILE_NAME_RE, "_")
        .slice(0, 120);

    const safeBase = base || fallback;

    return `${safeBase}-${timestamp}${ext}`;
}

/**
 * Build a stable per-user / per-OTT / per-item object key. Callers should
 * always go through this helper instead of joining path segments
 * manually — it enforces the user_id prefix that the upload route uses
 * for authorization checks.
 */
export function build_library_key(args: {
    user_id: string;
    ott_id: string;
    library_item_id: string;
    folder: "videos" | "images" | "thumbnails" | "playlists" | "hls";
    file_name: string;
}): string {
    const safe = sanitize_object_name(args.file_name, "file");
    return `users/${args.user_id}/library/${args.ott_id}/${args.folder}/${args.library_item_id}/${safe}`;
}

/**
 * Permanent public URL — only valid when a public custom domain is
 * configured (`R2_PUBLIC_BASE_URL`). Callers that want a guaranteed-
 * fresh URL even on private buckets should call
 * `generate_read_signed_url` instead.
 */
export function get_public_url(key: string): string | null {
    const base = (config.r2?.public_base_url || "").replace(/\/+$/, "");
    if (!base) return null;
    return `${base}/${key}`;
}

export interface PresignedPutResult {
    upload_url: string;
    key: string;
    expires_in: number;
}

/**
 * Generate a short-lived presigned PUT URL. Used both by the backend
 * (when it has a local file ready to push) and by the frontend
 * direct-upload flow (`POST /api/storage/r2/signed-upload-url`).
 *
 * NOTE: the returned URL embeds the AWS SigV4 signature in the query
 * string — never log it in full.
 */
export async function generate_upload_signed_url(args: {
    key: string;
    content_type: string;
    expires_in?: number;
}): Promise<PresignedPutResult> {
    const client = create_r2_client();
    const expires_in = args.expires_in ?? 15 * 60;
    const cmd = new PutObjectCommand({
        Bucket: config.r2.bucket_name,
        Key: args.key,
        ContentType: args.content_type,
    });
    const upload_url = await getSignedUrl(client, cmd, { expiresIn: expires_in });
    rlog("signed upload url generated", { key: args.key, content_type: args.content_type, expires_in });
    return { upload_url, key: args.key, expires_in };
}

/**
 * Generate a short-lived presigned GET URL. Used for previewing
 * objects on a private bucket. Public-CDN buckets should not need
 * this — call `get_public_url` instead.
 */
export async function generate_read_signed_url(args: {
    key: string;
    expires_in?: number;
}): Promise<string> {
    const client = create_r2_client();
    const expires_in = args.expires_in ?? 60 * 60;
    const cmd = new GetObjectCommand({
        Bucket: config.r2.bucket_name,
        Key: args.key,
    });
    return getSignedUrl(client, cmd, { expiresIn: expires_in });
}

export interface UploadResult {
    key: string;
    /** Permanent public URL when R2_PUBLIC_BASE_URL is set, else null. */
    public_url: string | null;
    size: number;
}

/**
 * Multipart-aware upload of a local file. Uses `@aws-sdk/lib-storage`'s
 * `Upload` so big videos (≫5 MB) don't try to ship in a single PUT.
 *
 * Server-side flow: ffmpeg / downloader writes to local temp →
 * `upload_file_to_r2` pushes it → DB stamps `file_url` + `file_type`.
 *
 * Note: this is the *direct* multipart variant. The presigned-PUT
 * variant is `generate_upload_signed_url` + an HTTPS PUT from the
 * client. Both are supported; library workers prefer the multipart
 * path because it auto-retries and parallelizes parts.
 */
export async function upload_file_to_r2(args: {
    local_file_path: string;
    key: string;
    content_type: string;
}): Promise<UploadResult> {
    if (!fs.existsSync(args.local_file_path)) {
        throw new Error(`R2 upload aborted: source file does not exist (${args.local_file_path})`);
    }
    const stat = fs.statSync(args.local_file_path);
    if (stat.size <= 0) {
        throw new Error(`R2 upload aborted: source file is empty (${args.local_file_path})`);
    }
    rlog("upload started", { key: args.key, size: stat.size, content_type: args.content_type });
    const client = create_r2_client();
    const uploader = new Upload({
        client,
        params: {
            Bucket: config.r2.bucket_name,
            Key: args.key,
            Body: fs.createReadStream(args.local_file_path),
            ContentType: args.content_type,
        },
        queueSize: 4,
        partSize: 8 * 1024 * 1024,
    });
    try {
        await uploader.done();
    } catch (err: any) {
        rlog("upload failed", { key: args.key, error: err?.message ?? String(err) });
        throw err;
    }
    rlog("upload completed", { key: args.key, size: stat.size });
    return {
        key: args.key,
        public_url: get_public_url(args.key),
        size: stat.size,
    };
}

/**
 * Buffer variant — handy for small text files (m3u8 etc.) where
 * spinning up a stream is overkill.
 */
export async function upload_buffer_to_r2(args: {
    buffer: Buffer;
    key: string;
    content_type: string;
}): Promise<UploadResult> {
    if (!args.buffer || args.buffer.length === 0) {
        throw new Error("R2 upload aborted: empty buffer");
    }
    rlog("upload started (buffer)", { key: args.key, size: args.buffer.length, content_type: args.content_type });
    const client = create_r2_client();
    await client.send(new PutObjectCommand({
        Bucket: config.r2.bucket_name,
        Key: args.key,
        Body: args.buffer,
        ContentType: args.content_type,
    }));
    rlog("upload completed (buffer)", { key: args.key, size: args.buffer.length });
    return {
        key: args.key,
        public_url: get_public_url(args.key),
        size: args.buffer.length,
    };
}

export async function delete_r2_object(key: string): Promise<void> {
    try {
        const client = create_r2_client();
        await client.send(new DeleteObjectCommand({
            Bucket: config.r2.bucket_name,
            Key: key,
        }));
        rlog("delete completed", { key });
    } catch (err: any) {
        // Non-fatal: log and continue, matching the Drive equivalent's
        // behaviour. Callers shouldn't strand a DB row because R2
        // couldn't be reached.
        rlog("delete failed", { key, error: err?.message ?? String(err) });
    }
}

export async function object_exists(key: string): Promise<boolean> {
    try {
        const client = create_r2_client();
        await client.send(new HeadObjectCommand({
            Bucket: config.r2.bucket_name,
            Key: key,
        }));
        return true;
    } catch {
        return false;
    }
}
