import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { OttPlatform } from "./ott_platform";
import { OttApiNode } from "./ott_api_node";
import { OttVideoAsset } from "./ott_video_asset";

/**
 * Library row, post-R2 migration.
 *
 * The pre-R2 schema had a state machine (`status`, `progress`,
 * `failure_count`, `locked_at`, …), Drive identifiers
 * (`google_drive_*`), local-disk staging paths (`local_*_path`), and
 * an HLS package (`hls_*`). All of that was removed when the system
 * moved to direct R2 signed-URL uploads: a row exists if and only if
 * the R2 upload finished successfully — no in-between states.
 *
 * The cleanup runs in `db/index.ts` (`ALTER TABLE DROP COLUMN IF
 * EXISTS …`) so existing databases lose the legacy columns on first
 * boot of the new code.
 */
@Table({
    tableName: "ott_library_items",
    timestamps: true,
    paranoid: true,
    indexes: [
        { name: "ott_library_items_ott_url_unique", unique: true, fields: ["ott_id", "original_video_url"] },
    ],
})
export class OttLibraryItem extends Model<OttLibraryItem> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @Column({ type: DataType.UUID, allowNull: true })
    user_id: string | null | undefined;

    @ForeignKey(() => OttPlatform)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    ott_id: string | undefined;

    @ForeignKey(() => OttVideoAsset)
    @Column({ type: DataType.UUID, allowNull: true, onDelete: "SET NULL" })
    video_asset_id: string | null | undefined;

    @ForeignKey(() => OttApiNode)
    @Column({ type: DataType.UUID, allowNull: true, onDelete: "SET NULL" })
    api_node_id: string | null | undefined;

    @Column({ type: DataType.UUID, allowNull: true })
    source_response_id: string | null | undefined;

    @Column({ type: DataType.UUID, allowNull: true })
    parent_api_id: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    item_key: string | null | undefined;

    // ── Folder grouping ─────────────────────────────────────────────────
    @Column({ type: DataType.TEXT, allowNull: true })
    parent_item_key: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    parent_title: string | null | undefined;

    /** Nested-folder pointer (folder-placeholder rows only). NULL = root. */
    @Column({ type: DataType.TEXT, allowNull: true })
    parent_folder_key: string | null | undefined;

    // ── Media metadata ──────────────────────────────────────────────────
    @Column({ type: DataType.TEXT, allowNull: true })
    title: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    description: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    thumbnail_url: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    image_url: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    original_video_url: string | null | undefined;

    @Column({ type: DataType.STRING(50), allowNull: true })
    original_video_type: string | null | undefined;

    // ── File info ───────────────────────────────────────────────────────
    @Column({ type: DataType.TEXT, allowNull: true })
    file_name: string | null | undefined;

    @Column({ type: DataType.STRING(20), allowNull: true })
    file_ext: string | null | undefined;

    @Column({ type: DataType.STRING(100), allowNull: true })
    mime_type: string | null | undefined;

    @Column({ type: DataType.BIGINT, allowNull: true })
    file_size: number | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    duration: string | null | undefined;

    @Column({ type: DataType.STRING(50), allowNull: true })
    quality: string | null | undefined;

    @Column({ type: DataType.STRING(50), allowNull: true })
    language: string | null | undefined;

    @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: "video" })
    save_type: string | undefined;

    // ── Cloudflare R2 (Mirror Media Cloud) ──────────────────────────────
    /** Public CDN URL the frontend renders directly. */
    @Column({ type: DataType.TEXT, allowNull: true })
    file_url: string | null | undefined;

    /** 'video' | 'image' | 'thumbnail' | 'playlist' | 'audio' | null */
    @Column({ type: DataType.STRING(50), allowNull: true })
    file_type: string | null | undefined;

    // ── Misc ────────────────────────────────────────────────────────────
    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    metadata: Record<string, any> | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    saved_at: Date | null | undefined;

    @BelongsTo(() => OttPlatform)
    ott: OttPlatform | undefined;

    @BelongsTo(() => OttVideoAsset)
    video_asset: OttVideoAsset | undefined;

    @BelongsTo(() => OttApiNode)
    api_node: OttApiNode | undefined;
}
