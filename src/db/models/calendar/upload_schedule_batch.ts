import { Table, Column, Model, DataType, ForeignKey, BelongsTo, HasMany } from "sequelize-typescript";
import { User } from "../auth/user";
import { OttPlatform } from "../ott/ott_platform";

/**
 * Batch = one user-submitted "schedule plan" covering N library items across
 * one OTT and 1+ platforms. The batch holds the schedule recipe (frequency,
 * release_count, upload_times, etc.); one row per generated upload lives in
 * upload_schedule_items.
 */
@Table({
    tableName: "upload_schedule_batches",
    timestamps: true,
    paranoid: true,
    indexes: [
        { name: "upload_schedule_batches_user_idx", fields: ["user_id"] },
        { name: "upload_schedule_batches_user_status_idx", fields: ["user_id", "status"] },
    ],
})
export class UploadScheduleBatch extends Model<UploadScheduleBatch> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @ForeignKey(() => User)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    user_id: string | undefined;

    @ForeignKey(() => OttPlatform)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    ott_id: string | undefined;

    @Column({ type: DataType.STRING(255), allowNull: true })
    name: string | null | undefined;

    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
    scheduled: boolean | undefined;

    /** ["facebook", "youtube", "instagram"] */
    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    platforms: string[] | undefined;

    /** every_day | every_week | every_month | custom_range | null when scheduled=false */
    @Column({ type: DataType.STRING(50), allowNull: true })
    frequency: string | null | undefined;

    @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
    release_count: number | undefined;

    /** ["10:00", "18:00"] — HH:MM strings, length normally === release_count */
    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    upload_times: string[] | undefined;

    @Column({ type: DataType.DATEONLY, allowNull: true })
    start_date: string | Date | null | undefined;

    @Column({ type: DataType.DATEONLY, allowNull: true })
    end_date: string | Date | null | undefined;

    /** [0..6] — Sunday=0 (matches JS Date.getDay) */
    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    weekdays: number[] | undefined;

    /** [1..31] */
    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    month_days: number[] | undefined;

    @Column({ type: DataType.STRING(50), allowNull: true })
    color: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    title_prefix: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    description: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    tags: string[] | undefined;

    /** draft | scheduled | completed | cancelled */
    @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: "draft" })
    status: string | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    metadata: Record<string, any> | undefined;

    @BelongsTo(() => User)
    user: User | undefined;

    @BelongsTo(() => OttPlatform)
    ott: OttPlatform | undefined;
}
