/**
 * temp_storage.ts
 *
 * Utility for managing temporary files used during download/convert/upload
 * to Google Drive. All temp files live under:
 *
 *   <cwd>/storage/temp/ott_library/:ott_id/:job_id/
 *
 * After a successful Drive upload the caller should delete the temp dir.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const TEMP_BASE = path.join(process.cwd(), "storage", "temp", "ott_library");

/**
 * Allocate a temp directory for one job. Creates the directory and returns
 * both the absolute path and a unique job_id.
 */
export function alloc_temp_dir(ott_id: string, job_id?: string): { dir: string; job_id: string } {
    const id = job_id ?? crypto.randomUUID();
    const dir = path.join(TEMP_BASE, ott_id, id);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, job_id: id };
}

/**
 * Build an absolute temp file path inside a previously alloc'd directory.
 */
export function temp_file_path(dir: string, file_name: string): string {
    return path.join(dir, file_name);
}

/**
 * Delete a temp file if it exists. Non-fatal.
 */
export function delete_temp_file(abs: string): void {
    try {
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch { /* ignore */ }
}

/**
 * Recursively delete a temp directory and all its contents. Non-fatal.
 */
export function delete_temp_dir(dir: string): void {
    try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
}

