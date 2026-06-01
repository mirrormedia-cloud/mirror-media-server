/**
 * Persisted Gemini analysis result, one row per (library_item × platform).
 *
 * Stored separately from the library item's `metadata.last_analysis` blob
 * so we can list, filter, paginate, regenerate, and surface analyses
 * independently of the item — and keep prior results around when a user
 * regenerates rather than overwriting them silently.
 *
 * status:
 *   - pending   — analysis kicked off, Gemini still processing
 *   - completed — JSON parsed, fields populated
 *   - failed    — Gemini errored or returned unparseable output;
 *                 error_message contains the reason
 */

import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "../auth/user";
import { OttPlatform } from "../ott/ott_platform";
import { OttLibraryItem } from "../ott/ott_library_item";

export type MediaAnalysisStatus = "pending" | "completed" | "failed";

@Table({
    tableName: "media_analysis_results",
    timestamps: true,
    paranoid: true,
    indexes: [
        { name: "media_analysis_user_idx", fields: ["user_id"] },
        { name: "media_analysis_library_item_idx", fields: ["library_item_id"] },
        { name: "media_analysis_user_lib_platform_idx", fields: ["user_id", "library_item_id", "platform"] },
    ],
})
export class MediaAnalysisResult extends Model<MediaAnalysisResult> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @ForeignKey(() => User)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    user_id: string | undefined;

    @BelongsTo(() => User)
    user: User | undefined;

    @ForeignKey(() => OttPlatform)
    @Column({ type: DataType.UUID, allowNull: true, onDelete: "CASCADE" })
    ott_id: string | null | undefined;

    @ForeignKey(() => OttLibraryItem)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    library_item_id: string | undefined;

    @BelongsTo(() => OttLibraryItem)
    library_item: OttLibraryItem | undefined;

    @Column({ type: DataType.STRING(50), allowNull: false })
    platform: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    title: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    description: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    caption: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    tags: string[] | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    hashtags: string[] | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    keywords: string[] | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    category: string | null | undefined;

    @Column({ type: DataType.STRING(50), allowNull: true })
    language: string | null | undefined;

    @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: "google" })
    analysis_provider: string | undefined;

    @Column({ type: DataType.STRING(100), allowNull: true })
    prompt_type: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    raw_analysis: Record<string, any> | undefined;

    @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: "completed" })
    status: MediaAnalysisStatus | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    error_message: string | null | undefined;
}
