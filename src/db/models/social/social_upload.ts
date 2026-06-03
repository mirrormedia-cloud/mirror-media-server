/**
 * One row per (library_item × platform) upload attempt. Holds enough
 * state to be queryable independently of the platform — title, tags,
 * scheduled time, status, the platform-side ids returned by the SDK,
 * and the raw upload_result JSON so debugging doesn't require hitting
 * the platform's API again.
 */

import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "../auth/user";
import { SocialAccount, SocialPlatform } from "./social_account";
import { OttPlatform } from "../ott/ott_platform";
import { OttLibraryItem } from "../ott/ott_library_item";
import { UploadScheduleItem } from "../calendar/upload_schedule_item";

export type SocialUploadStatus =
    | "draft"
    | "scheduled"
    | "uploading"
    | "uploaded"
    | "failed"
    | "cancelled";

@Table({
    tableName: "social_uploads",
    timestamps: true,
    indexes: [
        { name: "social_uploads_user_status_idx", fields: ["user_id", "status"] },
        { name: "social_uploads_library_item_idx", fields: ["library_item_id"] },
        { name: "social_uploads_schedule_item_idx", fields: ["schedule_item_id"] },
    ],
})
export class SocialUpload extends Model<SocialUpload> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @ForeignKey(() => User)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    user_id: string | undefined;

    @BelongsTo(() => User)
    user: User | undefined;

    @ForeignKey(() => OttPlatform)
    @Column({ type: DataType.UUID, allowNull: true, onDelete: "SET NULL" })
    ott_id: string | null | undefined;

    @ForeignKey(() => OttLibraryItem)
    @Column({ type: DataType.UUID, allowNull: true, onDelete: "SET NULL" })
    library_item_id: string | null | undefined;

    @BelongsTo(() => OttLibraryItem)
    library_item: OttLibraryItem | undefined;

    @ForeignKey(() => UploadScheduleItem)
    @Column({ type: DataType.UUID, allowNull: true, onDelete: "SET NULL" })
    schedule_item_id: string | null | undefined;

    @ForeignKey(() => SocialAccount)
    @Column({ type: DataType.UUID, allowNull: true, onDelete: "SET NULL" })
    social_account_id: string | null | undefined;

    @Column({ type: DataType.STRING(50), allowNull: false })
    platform: SocialPlatform | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    title: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    description: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    tags: string[] | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    hashtags: string[] | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    media_url: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    local_file_path: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    platform_media_id: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    platform_post_id: string | null | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    scheduled_at: Date | null | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    published_at: Date | null | undefined;

    @Column({ type: DataType.STRING(50), allowNull: true })
    visibility: string | null | undefined;

    @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: "draft" })
    status: SocialUploadStatus | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    upload_result: Record<string, any> | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    error_message: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    metadata: Record<string, any> | undefined;

    /**
     * True when this row's title/description/caption/tags were sourced
     * from a Gemini analysis (with optional manual overrides). Surfaced
     * as a "Generated" / "Mixed" / "Manual" badge on the Social Uploads
     * page.
     */
    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
    auto_details: boolean | undefined;

    /** FK to media_analysis_results — the row used for auto-fill, if any. */
    @Column({ type: DataType.UUID, allowNull: true })
    analysis_result_id: string | null | undefined;

    @Column({ type: DataType.DATE, allowNull: true, defaultValue: DataType.NOW })
    updated_at?: Date;

    /**
     * Platform-shaped details object — the exact values sent to the
     * platform API. Keeps a per-platform record for debugging when one
     * row covers a multi-platform upload that's been split.
     *
     * Shape: `{ youtube: { title, description, tags, hashtags }, ... }`.
     */
    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    platform_details: Record<string, any> | undefined;
}
