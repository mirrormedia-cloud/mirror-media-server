import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "../auth/user";
import { OttPlatform } from "../ott/ott_platform";
import { OttLibraryItem } from "../ott/ott_library_item";
import { UploadScheduleBatch } from "./upload_schedule_batch";

/**
 * One row per concrete upload (a single library item × scheduled_at). The
 * batch generator emits these from the recipe stored on UploadScheduleBatch.
 */
@Table({
    tableName: "upload_schedule_items",
    timestamps: true,
    paranoid: true,
    indexes: [
        { name: "upload_schedule_items_user_idx", fields: ["user_id"] },
        { name: "upload_schedule_items_batch_idx", fields: ["batch_id"] },
        { name: "upload_schedule_items_due_idx", fields: ["status", "scheduled_at"] },
        { name: "upload_schedule_items_library_idx", fields: ["library_item_id"] },
    ],
})
export class UploadScheduleItem extends Model<UploadScheduleItem> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @ForeignKey(() => User)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    user_id: string | undefined;

    @ForeignKey(() => UploadScheduleBatch)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    batch_id: string | undefined;

    @ForeignKey(() => OttPlatform)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    ott_id: string | undefined;

    @ForeignKey(() => OttLibraryItem)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    library_item_id: string | undefined;

    /** Filled after the calendar event is created in the same transaction. */
    @Column({ type: DataType.UUID, allowNull: true })
    calendar_event_id: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    title: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    description: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    platforms: string[] | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    scheduled_at: Date | null | undefined;

    @Column({ type: DataType.STRING(50), allowNull: true })
    color: string | null | undefined;

    /** draft | scheduled | uploaded | failed | cancelled */
    @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: "scheduled" })
    status: string | undefined;

    /**
     * Reserved for Scenario 2 (the cron uploader). Holds per-platform upload
     * outcome — left as an empty object until the cron writes to it.
     */
    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    upload_result: Record<string, any> | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    error_message: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    metadata: Record<string, any> | undefined;

    /**
     * When true, the cron / "Upload Now" path will fill any missing
     * per-platform field from a Gemini analysis at fire time.
     * Manually-filled fields here are preserved.
     */
    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
    auto_details: boolean | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    caption: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    tags: string[] | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    hashtags: string[] | undefined;

    /** Pointers to media_analysis_results rows used to compose this item. */
    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    analysis_result_ids: string[] | undefined;

    /**
     * Per-platform final details — exactly what the cron will pass to the
     * platform API. Shape: `{ youtube: { title, description, tags,
     * hashtags }, instagram: { caption, hashtags }, ... }`.
     */
    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    platform_details: Record<string, any> | undefined;

    @BelongsTo(() => User)
    user: User | undefined;

    @BelongsTo(() => UploadScheduleBatch)
    batch: UploadScheduleBatch | undefined;

    @BelongsTo(() => OttPlatform)
    ott: OttPlatform | undefined;

    @BelongsTo(() => OttLibraryItem)
    library_item: OttLibraryItem | undefined;
}
