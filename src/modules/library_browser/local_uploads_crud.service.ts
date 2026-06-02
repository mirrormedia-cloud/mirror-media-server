/**
 * "Local Uploads" CRUD — Windows-Explorer-style file management for the
 * per-user "Local Uploads" pseudo-OTT.
 *
 * Folders are tracked via placeholder rows on `ott_library_items`:
 *   save_type = 'folder_placeholder'
 *   metadata.is_folder_placeholder = true
 *
 * The listing endpoints in ott_library.service.ts filter these out so
 * they never appear in the file grid, but `get_library_folders` still
 * picks them up so empty folders are visible. When a real file is
 * uploaded into a folder, the placeholder + the file share the same
 * `parent_item_key`, and `get_library_folders`'s item_count reflects
 * only the real files.
 *
 * File uploads PUT directly to R2 via signed URLs (see storage.routes);
 * this module only owns the metadata CRUD (folders, renames, deletes,
 * cut/copy/paste).
 */

import type { FastifyRequest } from "fastify";
import fs from "fs";
import path from "path";
import { Op, literal } from "sequelize";
import { OttPlatform, OttLibraryItem } from "../../db/models";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import {
    sanitize_file_name,
    ext_from_content_type,
} from "../../utils/library_storage";
import { library_item_dto } from "../ott_library/ott_library.service";
import { upload_library_item_to_r2, is_r2_configured, delete_item_r2_object } from "../ott_library/ott_library_r2.service";
import { alloc_temp_dir, delete_temp_dir } from "../../utils/temp_storage";

const LOCAL_UPLOADS_OTT_NAME = "Local Uploads";

/** Marker save_type for empty-folder placeholder rows. */
export const FOLDER_PLACEHOLDER_TYPE = "folder_placeholder";

async function ensure_local_uploads_ott(user_id: string): Promise<OttPlatform> {
    let ott = await OttPlatform.findOne({ where: { user_id, name: LOCAL_UPLOADS_OTT_NAME } as any });
    if (!ott) {
        ott = await OttPlatform.create({
            user_id,
            name: LOCAL_UPLOADS_OTT_NAME,
            description: "Files uploaded directly from the user's device",
            base_url: "local://",
            headers: {},
            status: "active",
        } as any);
    }
    return ott;
}

async function require_local_uploads_ott(user_id: string, ott_id: string): Promise<OttPlatform | null> {
    const ott = await OttPlatform.findOne({ where: { id: ott_id, user_id, name: LOCAL_UPLOADS_OTT_NAME } as any });
    return ott ?? null;
}

function new_folder_key(): string {
    return `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Walks the parent_folder_key chain for a folder placeholder and
 * returns the library_path FROM ROOT down to (but excluding) the
 * folder identified by `folder_key`. Pair with the folder's own title
 * to get its full path.
 */
async function build_path_for_parent_key(
    ott_id: string,
    user_id: string,
    parent_folder_key: string | null,
): Promise<string[]> {
    const chain: string[] = [];
    let current: string | null = parent_folder_key;
    for (let i = 0; i < 50 && current; i++) {
        const ph: any = await OttLibraryItem.findOne({
            where: {
                ott_id,
                user_id,
                parent_item_key: current,
                save_type: FOLDER_PLACEHOLDER_TYPE,
            } as any,
        });
        if (!ph) break;
        chain.unshift(ph.parent_title || ph.title || "Folder");
        current = (ph.parent_folder_key as string | null) || null;
    }
    return chain;
}

/**
 * Picks a name that doesn't collide (case-insensitive) with anything in
 * `taken`. Mirrors Windows-Explorer's dedupe but uses the user's preferred
 * " copy" / " copy 2" suffix instead of the OS " - Copy" / " - Copy (2)"
 * pattern. The caller is responsible for inserting the returned name back
 * into `taken` when chaining multiple resolves in the same batch (e.g.
 * pasting three "video" files at once should yield video / video copy /
 * video copy 2).
 */
function pick_unique_name(taken: Set<string>, desired: string): string {
    const key = desired.trim().toLowerCase();
    if (!key) return desired;
    if (!taken.has(key)) return desired;
    let candidate = `${desired} copy`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
    for (let i = 2; i < 10000; i++) {
        candidate = `${desired} copy ${i}`;
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    // Fallback — should never hit; 10k siblings with the same name is
    // already pathological.
    return `${desired} copy ${Date.now()}`;
}

/**
 * Resolves a folder name that doesn't collide (case-insensitive) with any
 * existing sibling under the given parent. Pass `exclude_key` when
 * renaming so the folder doesn't collide with itself.
 */
async function unique_folder_name(
    ott_id: string,
    user_id: string,
    parent_folder_key: string | null,
    desired: string,
    exclude_key?: string,
): Promise<string> {
    const taken = await load_folder_titles_set(ott_id, user_id, parent_folder_key, exclude_key);
    return pick_unique_name(taken, desired);
}

/**
 * Returns the lowercased titles of every folder placeholder directly under
 * `parent_folder_key` (or root when null). Used by paste/move/copy to
 * dedupe pasted folder names against destination siblings.
 */
async function load_folder_titles_set(
    ott_id: string,
    user_id: string,
    parent_folder_key: string | null,
    exclude_key?: string,
): Promise<Set<string>> {
    const where: any = {
        ott_id,
        user_id,
        save_type: FOLDER_PLACEHOLDER_TYPE,
    };
    if (parent_folder_key) where.parent_folder_key = parent_folder_key;
    else where.parent_folder_key = { [Op.is]: null };
    const siblings = await OttLibraryItem.findAll({
        where,
        attributes: ["parent_item_key", "title", "parent_title"],
        raw: true,
    }) as unknown as Array<{ parent_item_key: string; title: string | null; parent_title: string | null }>;
    return new Set(
        siblings
            .filter(s => !exclude_key || s.parent_item_key !== exclude_key)
            .map(s => ((s.parent_title || s.title) || "").trim().toLowerCase())
            .filter(s => s.length > 0),
    );
}

/**
 * Returns the lowercased titles of every NON-placeholder item directly
 * under `parent_item_key` (or root when null). Used by paste/move/copy to
 * dedupe pasted file names against destination siblings.
 */
async function load_file_titles_set(
    ott_id: string,
    user_id: string,
    parent_item_key: string | null,
    exclude_ids?: string[],
): Promise<Set<string>> {
    const where: any = {
        ott_id,
        user_id,
        save_type: { [Op.ne]: FOLDER_PLACEHOLDER_TYPE },
    };
    if (parent_item_key) where.parent_item_key = parent_item_key;
    else where.parent_item_key = { [Op.is]: null };
    if (exclude_ids && exclude_ids.length > 0) {
        where.id = { [Op.notIn]: exclude_ids };
    }
    const siblings = await OttLibraryItem.findAll({
        where,
        attributes: ["id", "title", "file_name"],
        raw: true,
    }) as unknown as Array<{ id: string; title: string | null; file_name: string | null }>;
    return new Set(
        siblings
            .map(s => ((s.title || s.file_name) || "").trim().toLowerCase())
            .filter(s => s.length > 0),
    );
}

// Drive file deletion was removed when the system migrated to R2. R2
// objects are NOT auto-deleted from the bucket when a row is dropped —
// that matches the user's spec ("delete from DB only, leave the object
// in storage"). If a future feature wants storage-level delete, add a
// helper that calls `delete_r2_object(storage_key)` here.

/**
 * Called at login time to eagerly set up the per-user Local Uploads OTT
 * and its default "media" folder placeholder so the library grid is
 * never empty on first visit. Idempotent — safe to call on every login.
 */
export async function ensure_default_library_folders(user_id: string): Promise<void> {
    const ott = await ensure_local_uploads_ott(user_id);
    const existing = await OttLibraryItem.findOne({
        where: {
            ott_id: ott.id,
            user_id,
            save_type: FOLDER_PLACEHOLDER_TYPE,
            parent_folder_key: null as any,
        } as any,
    });
    if (existing) return;
    const default_key = new_folder_key();
    const default_name = await unique_folder_name(ott.id as string, user_id, null, "media");
    await OttLibraryItem.create({
        user_id,
        ott_id: ott.id,
        parent_item_key: default_key,
        parent_folder_key: null,
        parent_title: default_name,
        title: default_name,
        save_type: FOLDER_PLACEHOLDER_TYPE,
        metadata: { is_folder_placeholder: true, source: "local_upload", is_default: true },
        saved_at: new Date(),
    } as any);
}

// ── GET /api/library/local-uploads/init ──────────────────────────────
// Returns (creating if needed) the per-user Local Uploads OTT id.
export async function init_local_uploads(req: FastifyRequest) {
    const user_id = (req as any).userId as string | undefined;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const ott = await ensure_local_uploads_ott(user_id);
    return success("Local Uploads OTT ready", {
        ott_id: ott.id,
        ott_name: ott.name,
    });
}

// ── POST /api/library/local-uploads/:ott_id/folders ──────────────────
// Body: { name: string, parent_folder_key?: string | null }
export async function create_folder(req: FastifyRequest) {
    const user_id = (req as any).userId as string | undefined;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id } = req.params as { ott_id: string };
    const body = (req.body ?? {}) as { name?: unknown; parent_folder_key?: unknown };
    const raw_name = typeof body.name === "string" ? body.name.trim() : "";
    if (!raw_name) return error(HttpStatus.BAD_REQUEST, "name is required");
    const name = raw_name.slice(0, 200);
    const parent_folder_key = (typeof body.parent_folder_key === "string" && body.parent_folder_key.trim())
        ? body.parent_folder_key.trim()
        : null;

    const ott = await require_local_uploads_ott(user_id, ott_id);
    if (!ott) return error(HttpStatus.NOT_FOUND, "Local Uploads OTT not found");

    // If a parent was supplied, defend in depth: it must be one of THIS
    // user's folder placeholders inside this OTT.
    if (parent_folder_key) {
        const parent = await OttLibraryItem.findOne({
            where: {
                ott_id: ott.id,
                user_id,
                parent_item_key: parent_folder_key,
                save_type: FOLDER_PLACEHOLDER_TYPE,
            } as any,
        });
        if (!parent) return error(HttpStatus.NOT_FOUND, "Parent folder not found");
    }

    // Case-insensitive dedupe against siblings — "ug" collides with
    // "UG" / "Ug". On collision we suffix " copy", then " copy 2", etc.
    const final_name = await unique_folder_name(ott.id, user_id, parent_folder_key, name);

    const folder_key = new_folder_key();
    await OttLibraryItem.create({
        user_id,
        ott_id: ott.id,
        parent_item_key: folder_key,
        parent_folder_key,
        parent_title: final_name,
        title: final_name,
        save_type: FOLDER_PLACEHOLDER_TYPE,
        metadata: { is_folder_placeholder: true, source: "local_upload" },
        saved_at: new Date(),
    } as any);

    // R2 has no folder objects — paths are inferred from object keys.
    // No remote-side folder creation is required.

    return success("Folder created", {
        parent_item_key: folder_key,
        parent_title: final_name,
        parent_folder_key,
    }, HttpStatus.CREATED);
}

// ── GET /api/library/local-uploads/:ott_id/folders?parent_folder_key=... ─
// List folders DIRECTLY inside the given parent (or root if omitted /
// "__root__"). Each folder includes a live item_count and a recursive
// "deep" item count is omitted to keep the query cheap — the file grid
// shows the direct count which matches Windows Explorer's behaviour.
export async function list_folders(req: FastifyRequest) {
    const user_id = (req as any).userId as string | undefined;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id } = req.params as { ott_id: string };
    const ott = await require_local_uploads_ott(user_id, ott_id);
    if (!ott) return error(HttpStatus.NOT_FOUND, "Local Uploads OTT not found");

    const q = (req.query ?? {}) as { parent_folder_key?: unknown; include_ungrouped?: unknown };
    const raw_parent = typeof q.parent_folder_key === "string" ? q.parent_folder_key.trim() : "";
    const at_root = !raw_parent || raw_parent === "__root__";
    // Callers that render inline file lists at the current level (the
    // calendar picker) don't want the synthetic "Ungrouped" tile —
    // they already surface root files separately. Only opt in from the
    // main library page where StoryGridView is folder-only.
    const include_ungrouped = q.include_ungrouped === "true" || q.include_ungrouped === true;

    // Placeholders directly under the requested parent.
    const where: any = {
        ott_id: ott.id,
        user_id,
        save_type: FOLDER_PLACEHOLDER_TYPE,
    };
    if (at_root) where.parent_folder_key = { [Op.is]: null };
    else where.parent_folder_key = raw_parent;

    let placeholders = await OttLibraryItem.findAll({
        where,
        order: [["createdAt", "DESC"]],
    });

    // Bootstrap: when the user lands on Local Uploads root and has no
    // folders yet, auto-create a protected "media" placeholder so the
    // grid is never empty. The `is_default` flag in metadata tells the
    // delete handler + frontend UI to treat the row as non-deletable
    // (contents inside can still be removed). This is idempotent — once
    // any folder exists at root the bootstrap is skipped, so users who
    // create + delete their own folders don't get a re-spawn.
    if (at_root && placeholders.length === 0) {
        const default_key = new_folder_key();
        const default_name = await unique_folder_name(ott.id as string, user_id, null, "media");
        const created = await OttLibraryItem.create({
            user_id,
            ott_id: ott.id,
            parent_item_key: default_key,
            parent_folder_key: null,
            parent_title: default_name,
            title: default_name,
            save_type: FOLDER_PLACEHOLDER_TYPE,
            metadata: { is_folder_placeholder: true, source: "local_upload", is_default: true },
            saved_at: new Date(),
        } as any);
        placeholders = [created];
    }

    // One COUNT(*) per folder — only count NON-placeholder children (real
    // files) so empty folders show "0".
    const folder_keys = placeholders
        .map(p => p.parent_item_key)
        .filter((k): k is string => !!k);

    let count_map = new Map<string, { items: number; subfolders: number }>();
    if (folder_keys.length > 0) {
        const item_rows = await OttLibraryItem.findAll({
            where: {
                ott_id: ott.id,
                user_id,
                parent_item_key: { [Op.in]: folder_keys },
                save_type: { [Op.ne]: FOLDER_PLACEHOLDER_TYPE },
            } as any,
            attributes: ["parent_item_key", [literal("COUNT(*)"), "cnt"]],
            group: ["parent_item_key"],
            raw: true,
        }) as unknown as Array<{ parent_item_key: string; cnt: string }>;
        const sub_rows = await OttLibraryItem.findAll({
            where: {
                ott_id: ott.id,
                user_id,
                parent_folder_key: { [Op.in]: folder_keys },
                save_type: FOLDER_PLACEHOLDER_TYPE,
            } as any,
            attributes: ["parent_folder_key", [literal("COUNT(*)"), "cnt"]],
            group: ["parent_folder_key"],
            raw: true,
        }) as unknown as Array<{ parent_folder_key: string; cnt: string }>;

        for (const k of folder_keys) count_map.set(k, { items: 0, subfolders: 0 });
        for (const r of item_rows) {
            const m = count_map.get(r.parent_item_key);
            if (m) m.items = Number(r.cnt) || 0;
        }
        for (const r of sub_rows) {
            const m = count_map.get(r.parent_folder_key);
            if (m) m.subfolders = Number(r.cnt) || 0;
        }
    }

    const folders = placeholders.map(p => {
        const counts = count_map.get(p.parent_item_key as string) ?? { items: 0, subfolders: 0 };
        const meta = (p.metadata ?? {}) as Record<string, any>;
        return {
            parent_item_key: p.parent_item_key as string | null,
            parent_folder_key: (p as any).parent_folder_key ?? null,
            title: p.parent_title || p.title || "Folder",
            item_count: counts.items + counts.subfolders,
            subfolder_count: counts.subfolders,
            file_count: counts.items,
            created_at: (p as any).createdAt instanceof Date
                ? (p as any).createdAt.toISOString()
                : null,
            is_default: meta.is_default === true,
        };
    });

    // Ungrouped pseudo-folder at the OTT root: files uploaded directly
    // (no `parent_item_key`) would otherwise be invisible because the
    // root view only renders placeholder rows. Surface them as a single
    // synthetic tile so the user can drill in via FileListView's
    // `__ungrouped__` route. Only emitted at root and only when
    // ungrouped files actually exist — empty buckets shouldn't render.
    if (at_root && include_ungrouped) {
        const ungrouped_count = await OttLibraryItem.count({
            where: {
                ott_id: ott.id,
                user_id,
                parent_item_key: { [Op.is]: null } as any,
                save_type: { [Op.ne]: FOLDER_PLACEHOLDER_TYPE },
                file_url: { [Op.not]: null } as any,
            } as any,
        });
        if (ungrouped_count > 0) {
            folders.unshift({
                parent_item_key: null,
                parent_folder_key: null,
                title: "Ungrouped",
                item_count: ungrouped_count,
                subfolder_count: 0,
                file_count: ungrouped_count,
                created_at: null,
                is_default: false,
            });
        }
    }

    return success("Folders fetched", {
        parent_folder_key: at_root ? null : raw_parent,
        folders,
    });
}

// ── GET /api/library/local-uploads/:ott_id/folders/:key/breadcrumbs ──
// Walk the parent chain from `:key` back up to root and return each
// hop. Used by the FileListView to render the path.
export async function folder_breadcrumbs(req: FastifyRequest) {
    const user_id = (req as any).userId as string | undefined;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id, key } = req.params as { ott_id: string; key: string };
    const ott = await require_local_uploads_ott(user_id, ott_id);
    if (!ott) return error(HttpStatus.NOT_FOUND, "Local Uploads OTT not found");

    const trail: Array<{ key: string; title: string }> = [];
    // Bound the walk so a malformed loop can't hang the request.
    let current: string | null = key;
    for (let i = 0; i < 50 && current; i++) {
        const ph: any = await OttLibraryItem.findOne({
            where: {
                ott_id: ott.id,
                user_id,
                parent_item_key: current,
                save_type: FOLDER_PLACEHOLDER_TYPE,
            } as any,
        });
        if (!ph) break;
        trail.unshift({ key: current, title: ph.parent_title || ph.title || "Folder" });
        current = (ph.parent_folder_key as string | null) || null;
    }
    return success("Breadcrumbs", { breadcrumbs: trail });
}

// ── PATCH /api/library/local-uploads/:ott_id/folders/:key ────────────
// Body: { name: string }
export async function rename_folder(req: FastifyRequest) {
    const user_id = (req as any).userId as string | undefined;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id, key } = req.params as { ott_id: string; key: string };
    const body = (req.body ?? {}) as { name?: unknown };
    const raw_name = typeof body.name === "string" ? body.name.trim() : "";
    if (!raw_name) return error(HttpStatus.BAD_REQUEST, "name is required");
    const name = raw_name.slice(0, 200);

    const ott = await require_local_uploads_ott(user_id, ott_id);
    if (!ott) return error(HttpStatus.NOT_FOUND, "Local Uploads OTT not found");

    // Look up the folder's parent first so the dedupe runs against
    // siblings only (not the entire OTT tree). Excluding the folder
    // itself lets a no-op rename keep the same name.
    const placeholder = await OttLibraryItem.findOne({
        where: {
            ott_id: ott.id,
            user_id,
            parent_item_key: key,
            save_type: FOLDER_PLACEHOLDER_TYPE,
        } as any,
        attributes: ["parent_item_key", "parent_folder_key"],
        raw: true,
    }) as unknown as { parent_item_key: string; parent_folder_key: string | null } | null;
    if (!placeholder) return error(HttpStatus.NOT_FOUND, "Folder not found");

    const final_name = await unique_folder_name(
        ott.id,
        user_id,
        placeholder.parent_folder_key,
        name,
        key,
    );

    const [updated] = await OttLibraryItem.update(
        { parent_title: final_name } as any,
        { where: { ott_id: ott.id, user_id, parent_item_key: key } as any },
    );

    // Also update the placeholder's title so the folder badge text matches.
    await OttLibraryItem.update(
        { title: final_name } as any,
        {
            where: {
                ott_id: ott.id,
                user_id,
                parent_item_key: key,
                save_type: FOLDER_PLACEHOLDER_TYPE,
            } as any,
        },
    );

    if (updated === 0) return error(HttpStatus.NOT_FOUND, "Folder not found");
    return success("Folder renamed", { parent_item_key: key, parent_title: final_name });
}

// ── DELETE /api/library/local-uploads/:ott_id/folders/:key ───────────
// Hard-delete a folder and EVERYTHING inside it — direct files, all
// nested subfolders, and the files inside those subfolders. Walked
// breadth-first via parent_folder_key so we don't recurse forever on
// a (theoretical) cycle. Local files on disk are best-effort cleaned.
// Drive files are NOT touched (matches the existing folder-delete
// contract).
export async function delete_folder(req: FastifyRequest) {
    const user_id = (req as any).userId as string | undefined;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id, key } = req.params as { ott_id: string; key: string };

    const ott = await require_local_uploads_ott(user_id, ott_id);
    if (!ott) return error(HttpStatus.NOT_FOUND, "Local Uploads OTT not found");

    // Protected default folder ("media") — created by the bootstrap in
    // list_folders so the grid is never empty. The folder placeholder
    // itself can't be deleted; the user must clear its contents one by
    // one via the file grid instead.
    const target = await OttLibraryItem.findOne({
        where: {
            ott_id: ott.id,
            user_id,
            parent_item_key: key,
            save_type: FOLDER_PLACEHOLDER_TYPE,
        } as any,
        attributes: ["metadata"],
        raw: true,
    }) as unknown as { metadata: Record<string, any> | null } | null;
    if (target && (target.metadata ?? {}).is_default === true) {
        return error(HttpStatus.BAD_REQUEST, "Default folder cannot be deleted — remove its files instead");
    }

    // Collect every folder_key in the subtree (including the root itself).
    const all_keys: string[] = [key];
    let frontier: string[] = [key];
    while (frontier.length > 0) {
        const subs = await OttLibraryItem.findAll({
            where: {
                ott_id: ott.id,
                user_id,
                parent_folder_key: { [Op.in]: frontier },
                save_type: FOLDER_PLACEHOLDER_TYPE,
            } as any,
            attributes: ["parent_item_key"],
            raw: true,
        }) as unknown as Array<{ parent_item_key: string }>;
        const next: string[] = [];
        for (const s of subs) {
            if (s.parent_item_key && !all_keys.includes(s.parent_item_key)) {
                all_keys.push(s.parent_item_key);
                next.push(s.parent_item_key);
            }
        }
        frontier = next;
    }

    // Now grab every row whose parent_item_key matches any of those —
    // that pulls in the placeholders themselves AND every direct file.
    const items = await OttLibraryItem.findAll({
        where: {
            ott_id: ott.id,
            user_id,
            parent_item_key: { [Op.in]: all_keys },
        } as any,
        paranoid: false,
    });
    let deleted = 0;
    let failed = 0;
    for (const item of items) {
        try {
            await delete_item_r2_object(item);
            await item.destroy({ force: true });
            deleted += 1;
        } catch {
            failed += 1;
        }
    }
    return success("Folder deleted", {
        deleted,
        failed,
        folders_removed: all_keys.length,
    });
}

// ── PATCH /api/library/local-uploads/:ott_id/items/:item_id ──────────
// Body: { name: string }  — renames the title field. Does NOT rename
// the file on disk or in Drive (just the user-visible label).
export async function rename_item(req: FastifyRequest) {
    const user_id = (req as any).userId as string | undefined;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id, item_id } = req.params as { ott_id: string; item_id: string };
    const body = (req.body ?? {}) as { name?: unknown };
    const raw_name = typeof body.name === "string" ? body.name.trim() : "";
    if (!raw_name) return error(HttpStatus.BAD_REQUEST, "name is required");
    const name = raw_name.slice(0, 200);

    const ott = await require_local_uploads_ott(user_id, ott_id);
    if (!ott) return error(HttpStatus.NOT_FOUND, "Local Uploads OTT not found");

    const item = await OttLibraryItem.findOne({
        where: { id: item_id, ott_id: ott.id, user_id } as any,
    });
    if (!item) return error(HttpStatus.NOT_FOUND, "Item not found");
    item.title = name;
    await item.save();

    return success("Item renamed", library_item_dto(item));
}

// ── DELETE /api/library/local-uploads/:ott_id/items/:item_id ─────────
export async function delete_item(req: FastifyRequest) {
    const user_id = (req as any).userId as string | undefined;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id, item_id } = req.params as { ott_id: string; item_id: string };

    const ott = await require_local_uploads_ott(user_id, ott_id);
    if (!ott) return error(HttpStatus.NOT_FOUND, "Local Uploads OTT not found");

    const item = await OttLibraryItem.findOne({
        where: { id: item_id, ott_id: ott.id, user_id } as any,
        paranoid: false,
    });
    if (!item) return error(HttpStatus.NOT_FOUND, "Item not found");
    await delete_item_r2_object(item);
    await item.destroy({ force: true });
    return success("Item deleted", { id: item_id });
}

// `upload_files` (multipart backend-staging endpoint) was removed
// when the system moved to direct R2 signed-URL uploads. New uploads
// go through:
//   POST /api/storage/r2/signed-upload-url
//   PUT  <r2 url>
//   POST /api/storage/r2/complete-upload
// See `frontend/src/services/local_uploads_service.ts#upload_files`.
//
// The function below is kept commented-out under a single un-exported
// scope so the surrounding helpers (`ensure_folder_chain`,
// `placeholder_filter_where`, `paste`, etc.) keep compiling. If you
// ever want the multipart path back, add the `export` keyword again.
async function _disabled_legacy_upload_files(req: FastifyRequest) {
    const user_id = (req as any).userId as string | undefined;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id } = req.params as { ott_id: string };

    const ott = await require_local_uploads_ott(user_id, ott_id);
    if (!ott) return error(HttpStatus.NOT_FOUND, "Local Uploads OTT not found");

    interface CollectedFile {
        filename: string;
        mimetype: string;
        relative_path: string | null;
        buffer: Buffer;
    }

    let target_parent_key: string | null = null;
    let target_parent_title: string | null = null;
    const files: CollectedFile[] = [];
    // Buffer for the most recent `relative_path` field — multipart parts
    // arrive in document order so a `relative_path` field immediately
    // before its file applies to that file.
    let pending_relative: string | null = null;

    try {
        // Override the global 50 MB multipart cap for this endpoint —
        // Local Uploads is meant for full videos which can easily run
        // multi-gigabyte. Setting Infinity disables the per-file limit;
        // disk space + the user's network are the practical ceilings.
        for await (const part of req.parts({ limits: { fileSize: Infinity } })) {
            if (part.type === "field") {
                const v = String(part.value ?? "").trim();
                if (part.fieldname === "parent_item_key") {
                    target_parent_key = v && v !== "__root__" ? v : null;
                } else if (part.fieldname === "parent_title") {
                    target_parent_title = v ? v.slice(0, 200) : null;
                } else if (part.fieldname === "relative_path") {
                    pending_relative = v || null;
                }
                continue;
            }
            if (part.type === "file") {
                const chunks: Buffer[] = [];
                for await (const chunk of part.file) chunks.push(chunk);
                if (chunks.length === 0) {
                    pending_relative = null;
                    continue;
                }
                files.push({
                    filename: part.filename || "upload.bin",
                    mimetype: part.mimetype || "application/octet-stream",
                    relative_path: pending_relative,
                    buffer: Buffer.concat(chunks),
                });
                pending_relative = null;
            }
        }
    } catch (err: any) {
        console.log("Error:- upload_files multipart", err);
        return error(HttpStatus.BAD_REQUEST, err?.message || "Failed to read upload");
    }

    if (files.length === 0) return error(HttpStatus.BAD_REQUEST, "No files received");

    // Validation — Local Uploads accepts only image/* and video/* MIME
    // types. Defence in depth: the FE already filters by `accept` and
    // discards bad drops, but a hand-crafted multipart could still
    // bypass the UI.
    const invalid = files.filter(f => {
        const m = (f.mimetype || "").toLowerCase();
        if (m.startsWith("image/") || m.startsWith("video/")) return false;
        // Some browsers send a generic "application/octet-stream" for
        // dragged files — fall back to the extension when the mime is
        // unhelpful.
        if (m === "application/octet-stream" || m === "") {
            const ext = (/\.([a-zA-Z0-9]{1,8})$/.exec(f.filename)?.[1] ?? "").toLowerCase();
            const allowed_ext = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "avif", "tiff", "tif",
                                  "mp4", "webm", "mov", "mkv", "avi", "m3u8", "mpd", "flv", "wmv", "3gp", "m4v"];
            return !allowed_ext.includes(ext);
        }
        return true;
    });
    if (invalid.length > 0) {
        return error(
            HttpStatus.BAD_REQUEST,
            `Only images and videos are allowed. Rejected: ${invalid.slice(0, 3).map(f => f.filename).join(", ")}${invalid.length > 3 ? ` (+${invalid.length - 3} more)` : ""}`,
        );
    }

    // Resolve each file's destination folder. Files without a relative
    // path land in the requested `parent_item_key`. Files WITH a path
    // (e.g. dropping a folder "MyShow/Season 1/ep1.mp4" via webkitdirectory)
    // walk each directory segment and create a placeholder per level
    // under the correct parent, so the folder structure is faithfully
    // recreated INSIDE the current folder — not flattened onto the
    // OTT root.
    //
    // Cache: full directory chain ("MyShow/Season 1") → resolved key,
    // so two files in the same dir don't trigger duplicate lookups.
    const folder_cache = new Map<string, { key: string; title: string }>();

    /**
     * Walk `dir_segments` from the root of the upload (which lives
     * under `target_parent_key`) creating one folder per missing
     * level. Each new placeholder gets `parent_folder_key = <previous
     * level>` so the nested-folder browser sees the right tree.
     */
    async function ensure_folder_chain(dir_segments: string[]): Promise<{ key: string | null; title: string | null }> {
        let current_key: string | null = target_parent_key;
        let current_title: string | null = target_parent_title;
        const chain_so_far: string[] = [];
        for (const raw_seg of dir_segments) {
            const seg = raw_seg.slice(0, 200);
            chain_so_far.push(seg);
            const cache_key = `${current_key ?? "__root__"}::${chain_so_far.join("/")}`;
            const cached = folder_cache.get(cache_key);
            if (cached) {
                current_key = cached.key;
                current_title = cached.title;
                continue;
            }
            // Look for an EXISTING placeholder with this title under
            // current_key — case-sensitive, scoped properly so a
            // same-named folder elsewhere doesn't get reused.
            const where: any = {
                ott_id: ott!.id,
                user_id,
                save_type: FOLDER_PLACEHOLDER_TYPE,
                parent_title: seg,
            };
            if (current_key === null) where.parent_folder_key = { [Op.is]: null };
            else where.parent_folder_key = current_key;
            const existing = await OttLibraryItem.findOne({ where });
            let next_key: string;
            if (existing && existing.parent_item_key) {
                next_key = existing.parent_item_key;
            } else {
                next_key = new_folder_key();
                await OttLibraryItem.create({
                    user_id,
                    ott_id: ott!.id,
                    parent_item_key: next_key,
                    parent_folder_key: current_key,
                    parent_title: seg,
                    title: seg,
                    save_type: FOLDER_PLACEHOLDER_TYPE,
                    status: "completed",
                    progress: 100,
                    metadata: { is_folder_placeholder: true, source: "local_upload" },
                    saved_at: new Date(),
                } as any);
            }
            folder_cache.set(cache_key, { key: next_key, title: seg });
            current_key = next_key;
            current_title = seg;
        }
        return { key: current_key, title: current_title };
    }

    async function resolve_target_for_file(rel: string | null): Promise<{ key: string | null; title: string | null }> {
        if (!rel) {
            return { key: target_parent_key, title: target_parent_title };
        }
        const segments = rel.split(/[\\/]/).filter(Boolean);
        // Last segment is the filename — strip it.
        if (segments.length <= 1) {
            return { key: target_parent_key, title: target_parent_title };
        }
        const dir_segments = segments.slice(0, -1);
        return ensure_folder_chain(dir_segments);
    }

    if (!is_r2_configured()) {
        return error(HttpStatus.BAD_REQUEST, "Cloudflare R2 is not configured on this server");
    }

    // Each file is uploaded to R2 inline. A library row is created
    // ONLY when the R2 upload succeeds — failed uploads leave no
    // trace in the DB (the post-status-flow contract).
    const created: OttLibraryItem[] = [];
    const failures: Array<{ filename: string; error: string }> = [];
    for (const f of files) {
        const dest = await resolve_target_for_file(f.relative_path);

        const is_video = f.mimetype.startsWith("video/");
        const is_image = f.mimetype.startsWith("image/");
        const is_audio = f.mimetype.startsWith("audio/");
        const save_type = is_video ? "video" : is_image ? "image" : is_audio ? "audio" : "file";
        const ext_guess = ext_from_content_type(f.mimetype, "");
        const original_match = /\.([a-zA-Z0-9]{1,8})$/.exec(f.filename);
        const ext = (ext_guess || (original_match?.[1] ?? "bin")).toLowerCase();
        const base = sanitize_file_name(f.filename.replace(/\.[^.]+$/, ""), "file");
        const safe_file_name = `${base}.${ext}`;
        const r2_folder = is_video ? "videos" : is_image ? "images" : "videos";
        const file_type_for_row = is_video ? "video" : is_image ? "image" : is_audio ? "audio" : "video";

        // Stage the upload to a per-file temp dir so the R2 multipart
        // streamer can read it without buffering into RAM. The temp
        // dir is removed in the finally regardless of outcome.
        const { dir: temp_dir } = alloc_temp_dir(`r2-local-${user_id}`);
        const temp_file = path.join(temp_dir, safe_file_name);
        try {
            fs.writeFileSync(temp_file, f.buffer);
            const r2 = await upload_library_item_to_r2({
                ott_id: ott.id,
                user_id,
                library_item_id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                file_path: temp_file,
                file_name: safe_file_name,
                mime_type: f.mimetype,
                folder: r2_folder as any,
            });

            // R2 succeeded → create the library row.
            const item = await OttLibraryItem.create({
                user_id,
                ott_id: ott.id,
                parent_item_key: dest.key,
                parent_title: dest.title,
                title: f.filename.replace(/\.[^.]+$/, ""),
                file_name: safe_file_name,
                file_ext: ext,
                mime_type: f.mimetype,
                file_size: r2.main.size ?? f.buffer.length,
                save_type,
                file_url: r2.main.file_url,
                file_type: file_type_for_row,
                metadata: {
                    source: "local_upload",
                    original_name: f.filename,
                    original_relative_path: f.relative_path ?? null,
                    r2_key: r2.main.key,
                },
                saved_at: new Date(),
            } as any);
            created.push(item);
        } catch (err: any) {
            console.log("Error:- R2 upload for local upload file", err?.message ?? err);
            failures.push({ filename: f.filename, error: err?.message ?? "R2 upload failed" });
        } finally {
            try { delete_temp_dir(temp_dir); } catch { /* noop */ }
        }
    }

    const status_code = created.length > 0
        ? HttpStatus.CREATED
        : (failures.length > 0 ? HttpStatus.INTERNAL_SERVER_ERROR : HttpStatus.BAD_REQUEST);
    return success(
        created.length > 0
            ? `Uploaded ${created.length} file${created.length === 1 ? "" : "s"}`
            : "No files uploaded",
        {
            ott_id: ott.id,
            ott_name: ott.name,
            count: created.length,
            failed: failures.length,
            failures,
            items: created.map(item => library_item_dto(item)),
        },
        status_code,
    );
}

// ── Helper used by ott_library.service queries to filter placeholders ─
// Exposed so the existing list/folder helpers can apply the same WHERE
// fragment without re-implementing the literal.
export function placeholder_filter_where() {
    return {
        save_type: { [Op.ne]: FOLDER_PLACEHOLDER_TYPE } as any,
    };
}

/**
 * Walk the descendant subtree of a folder and return every nested
 * folder_key (NOT including the root). Used by paste operations to
 * detect cycles ("don't move a folder INTO itself or one of its
 * children") and by recursive copy.
 */
async function collect_descendant_folder_keys(
    ott_id: string,
    user_id: string,
    root_key: string,
): Promise<string[]> {
    const out: string[] = [];
    let frontier: string[] = [root_key];
    while (frontier.length > 0) {
        const subs = await OttLibraryItem.findAll({
            where: {
                ott_id,
                user_id,
                parent_folder_key: { [Op.in]: frontier },
                save_type: FOLDER_PLACEHOLDER_TYPE,
            } as any,
            attributes: ["parent_item_key"],
            raw: true,
        }) as unknown as Array<{ parent_item_key: string }>;
        const next: string[] = [];
        for (const s of subs) {
            if (s.parent_item_key && !out.includes(s.parent_item_key)) {
                out.push(s.parent_item_key);
                next.push(s.parent_item_key);
            }
        }
        frontier = next;
    }
    return out;
}

// ── POST /api/library/local-uploads/:ott_id/paste ────────────────────
// Body: {
//   operation: 'move' | 'copy',
//   item_ids?:    string[],          // file row ids
//   folder_keys?: string[],          // subfolder placeholder keys
//   target_folder_key?: string|null  // null/'__root__' = OTT root
// }
//
// Move semantics:
//   - Files: parent_item_key ← target (parent_title also updated)
//   - Folders: parent_folder_key ← target (the placeholder row moves;
//             every file inside still references the placeholder's
//             parent_item_key, so they "move with" the folder).
//
// Copy semantics:
//   - Files: a NEW row is inserted with the same Drive id / local
//     paths (so the duplicate references the same Drive file —
//     equivalent to a Drive "shortcut").
//   - Folders: recursive — a new placeholder is created at the
//     target with a fresh key, every file is copied (new rows), and
//     every nested folder is recursively copied.
//
// Cycle defence: cannot move/copy a folder INTO itself or one of its
// own descendants. Returns 400 if requested.
export async function paste(req: FastifyRequest) {
    const user_id = (req as any).userId as string | undefined;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id } = req.params as { ott_id: string };
    const body = (req.body ?? {}) as {
        operation?: unknown;
        item_ids?: unknown;
        folder_keys?: unknown;
        target_folder_key?: unknown;
    };

    const operation = body.operation === "copy" ? "copy"
        : body.operation === "move" ? "move"
            : null;
    if (!operation) return error(HttpStatus.BAD_REQUEST, "operation must be 'move' or 'copy'");

    const item_ids = Array.isArray(body.item_ids)
        ? body.item_ids.filter((v): v is string => typeof v === "string" && v.length > 0)
        : [];
    const folder_keys = Array.isArray(body.folder_keys)
        ? body.folder_keys.filter((v): v is string => typeof v === "string" && v.length > 0)
        : [];
    if (item_ids.length === 0 && folder_keys.length === 0) {
        return error(HttpStatus.BAD_REQUEST, "Nothing to paste");
    }

    const raw_target = typeof body.target_folder_key === "string" ? body.target_folder_key.trim() : "";
    const target_folder_key: string | null = (!raw_target || raw_target === "__root__")
        ? null
        : raw_target;

    const ott = await require_local_uploads_ott(user_id, ott_id);
    if (!ott) return error(HttpStatus.NOT_FOUND, "Local Uploads OTT not found");

    // Resolve target folder (if any) for parent_title bookkeeping +
    // existence check. Root is always valid.
    let target_title: string | null = null;
    if (target_folder_key) {
        const target = await OttLibraryItem.findOne({
            where: {
                ott_id: ott.id,
                user_id,
                parent_item_key: target_folder_key,
                save_type: FOLDER_PLACEHOLDER_TYPE,
            } as any,
        });
        if (!target) return error(HttpStatus.NOT_FOUND, "Target folder not found");
        target_title = target.parent_title || target.title || null;
    }

    // Cycle defence — if any folder being pasted contains the target
    // (directly or transitively), the operation would create a cycle.
    if (target_folder_key) {
        for (const k of folder_keys) {
            if (k === target_folder_key) {
                return error(HttpStatus.BAD_REQUEST, "Cannot paste a folder into itself");
            }
            const descendants = await collect_descendant_folder_keys(ott.id, user_id, k);
            if (descendants.includes(target_folder_key)) {
                return error(HttpStatus.BAD_REQUEST, "Cannot paste a folder into one of its own subfolders");
            }
        }
    }

    let moved_files = 0;
    let copied_files = 0;
    let moved_folders = 0;
    let copied_folders = 0;
    const created_item_ids: string[] = [];
    const created_folder_keys: string[] = [];

    if (operation === "move") {
        // DB-only move. R2 keys are not renamed — the object stays at
        // its original key in the bucket and `file_url` keeps working.
        // The library row's folder pointers are what users see.
        //
        // Per-row loop (instead of a bulk UPDATE) so we can rename on
        // collision: a sibling with the same title at the destination
        // gets " copy" / " copy 2" appended, matching the create_folder
        // and rename behavior. For sources already in the destination
        // (same-folder paste), their own row is excluded from the taken
        // set so a no-op move doesn't trigger a self-rename.
        if (item_ids.length > 0) {
            const sources = await OttLibraryItem.findAll({
                where: {
                    ott_id: ott.id,
                    user_id,
                    id: { [Op.in]: item_ids },
                    save_type: { [Op.ne]: FOLDER_PLACEHOLDER_TYPE },
                } as any,
            });
            const same_folder_source_ids = sources
                .filter(s => (s.parent_item_key ?? null) === target_folder_key)
                .map(s => s.id);
            const taken_file_names = await load_file_titles_set(
                ott.id, user_id, target_folder_key, same_folder_source_ids,
            );
            for (const src of sources) {
                const desired = ((src.title || src.file_name) || "").trim() || "file";
                const final_title = pick_unique_name(taken_file_names, desired);
                taken_file_names.add(final_title.toLowerCase());
                const patch: any = { parent_item_key: target_folder_key, parent_title: target_title };
                if (final_title !== (src.title || "")) patch.title = final_title;
                await OttLibraryItem.update(patch, { where: { id: src.id } as any });
                moved_files += 1;
            }
        }
        if (folder_keys.length > 0) {
            const placeholders = await OttLibraryItem.findAll({
                where: {
                    ott_id: ott.id,
                    user_id,
                    parent_item_key: { [Op.in]: folder_keys },
                    save_type: FOLDER_PLACEHOLDER_TYPE,
                } as any,
            });
            const taken_folder_names = await load_folder_titles_set(
                ott.id, user_id, target_folder_key,
            );
            // For same-folder moves, the placeholder is itself in the taken
            // set — drop its title so the no-op move doesn't self-collide.
            // Cross-folder moves leave the destination set intact so a real
            // collision still triggers the " copy" suffix.
            for (const ph of placeholders) {
                if ((ph.parent_folder_key ?? null) === target_folder_key) {
                    const t = ((ph.parent_title || ph.title) || "").trim().toLowerCase();
                    if (t) taken_folder_names.delete(t);
                }
            }
            for (const ph of placeholders) {
                const desired = ((ph.parent_title || ph.title) || "").trim() || "Folder";
                const final_title = pick_unique_name(taken_folder_names, desired);
                taken_folder_names.add(final_title.toLowerCase());
                const patch: any = { parent_folder_key: target_folder_key };
                if (final_title !== (ph.parent_title || "") || final_title !== (ph.title || "")) {
                    patch.parent_title = final_title;
                    patch.title = final_title;
                }
                await OttLibraryItem.update(patch, {
                    where: {
                        ott_id: ott.id,
                        user_id,
                        parent_item_key: ph.parent_item_key,
                        save_type: FOLDER_PLACEHOLDER_TYPE,
                    } as any,
                });
                moved_folders += 1;
            }
        }
    } else {
        // ── copy ──
        // Files: duplicate the row pointing at the SAME R2 file_url —
        // the binary on R2 is not duplicated. Equivalent to a
        // "shortcut" in the user's filesystem. Copy ALWAYS produces a new
        // row in the destination, so the taken set is just the destination's
        // current contents (no source-exclusion needed).
        if (item_ids.length > 0) {
            const sources = await OttLibraryItem.findAll({
                where: {
                    ott_id: ott.id,
                    user_id,
                    id: { [Op.in]: item_ids },
                    save_type: { [Op.ne]: FOLDER_PLACEHOLDER_TYPE },
                } as any,
            });
            const taken_file_names = await load_file_titles_set(ott.id, user_id, target_folder_key);
            for (const src of sources) {
                const json = (src as any).get({ plain: true }) as any;
                delete json.id;
                delete json.createdAt;
                delete json.updatedAt;
                delete json.deletedAt;
                json.parent_item_key = target_folder_key;
                json.parent_title = target_title;
                const desired = ((src.title || src.file_name) || "").trim() || "file";
                const final_title = pick_unique_name(taken_file_names, desired);
                taken_file_names.add(final_title.toLowerCase());
                json.title = final_title;
                const created = await OttLibraryItem.create(json);
                created_item_ids.push(created.id);
                copied_files += 1;
            }
        }
        // Folders: recursive deep-copy. Walk the source subtree, then
        // recreate each folder under the target with a fresh key, then
        // duplicate every file under the new key. Only the root folder
        // being pasted needs collision-renaming — descendants live under
        // the freshly-keyed root and can't collide with anything.
        if (folder_keys.length > 0) {
            const taken_folder_names = await load_folder_titles_set(ott.id, user_id, target_folder_key);
            for (const root_key of folder_keys) {
                const result = await deep_copy_folder({
                    ott_id: ott.id,
                    user_id,
                    source_key: root_key,
                    new_parent_folder_key: target_folder_key,
                    taken_root_names: taken_folder_names,
                });
                copied_files += result.files;
                copied_folders += result.folders;
                created_folder_keys.push(...result.created_folder_keys);
            }
        }
    }

    return success(`${operation} complete`, {
        operation,
        moved_files,
        moved_folders,
        copied_files,
        copied_folders,
        created_item_ids,
        created_folder_keys,
    });
}

/**
 * Deep-copy a folder + every descendant (folders and files). Files
 * are duplicated as new rows pointing to the same Drive id (so the
 * destination is essentially a "shortcut" — the binary on Drive is
 * not duplicated). Returns counts and the keys of every newly
 * created folder placeholder so the FE can refresh its grid.
 */
async function deep_copy_folder(args: {
    ott_id: string;
    user_id: string;
    source_key: string;
    new_parent_folder_key: string | null;
    /** Only set on the OUTER call — the root folder being pasted gets
     *  collision-renamed against destination siblings. Nested recursive
     *  calls don't pass this because their parent is the freshly-created
     *  key and can't collide with anything. */
    taken_root_names?: Set<string>;
}): Promise<{ folders: number; files: number; created_folder_keys: string[] }> {
    const { ott_id, user_id, source_key, new_parent_folder_key, taken_root_names } = args;
    const out = { folders: 0, files: 0, created_folder_keys: [] as string[] };

    // Source placeholder (for title).
    const src_placeholder = await OttLibraryItem.findOne({
        where: {
            ott_id,
            user_id,
            parent_item_key: source_key,
            save_type: FOLDER_PLACEHOLDER_TYPE,
        } as any,
    });
    if (!src_placeholder) return out;

    const new_key = new_folder_key();
    const src_title = src_placeholder.parent_title || src_placeholder.title || "Folder";
    const new_title = taken_root_names
        ? (() => {
            const t = pick_unique_name(taken_root_names, src_title);
            taken_root_names.add(t.toLowerCase());
            return t;
        })()
        : src_title;
    await OttLibraryItem.create({
        user_id,
        ott_id,
        parent_item_key: new_key,
        parent_folder_key: new_parent_folder_key,
        parent_title: new_title,
        title: new_title,
        save_type: FOLDER_PLACEHOLDER_TYPE,
        metadata: { is_folder_placeholder: true, source: "local_upload_copy" },
        saved_at: new Date(),
    } as any);
    out.folders += 1;
    out.created_folder_keys.push(new_key);

    // Direct files.
    const files = await OttLibraryItem.findAll({
        where: {
            ott_id,
            user_id,
            parent_item_key: source_key,
            save_type: { [Op.ne]: FOLDER_PLACEHOLDER_TYPE },
        } as any,
    });
    for (const f of files) {
        const json = (f as any).get({ plain: true }) as any;
        delete json.id;
        delete json.createdAt;
        delete json.updatedAt;
        delete json.deletedAt;
        json.parent_item_key = new_key;
        // Reflect the (possibly renamed) destination folder name, so a
        // root-level " copy" suffix propagates to child rows' parent_title.
        json.parent_title = new_title;
        await OttLibraryItem.create(json);
        out.files += 1;
    }

    // Nested folders.
    const subs = await OttLibraryItem.findAll({
        where: {
            ott_id,
            user_id,
            parent_folder_key: source_key,
            save_type: FOLDER_PLACEHOLDER_TYPE,
        } as any,
        attributes: ["parent_item_key"],
        raw: true,
    }) as unknown as Array<{ parent_item_key: string }>;
    for (const s of subs) {
        if (!s.parent_item_key) continue;
        const sub = await deep_copy_folder({
            ott_id,
            user_id,
            source_key: s.parent_item_key,
            new_parent_folder_key: new_key,
        });
        out.folders += sub.folders;
        out.files += sub.files;
        out.created_folder_keys.push(...sub.created_folder_keys);
    }
    return out;
}
