import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "../auth/user";
import { OttPlatform } from "../ott/ott_platform";
import { OttLibraryItem } from "../ott/ott_library_item";

@Table({
    tableName: "calendar_events",
    timestamps: true,
    paranoid: true,
    indexes: [
        { name: "calendar_events_user_idx", fields: ["user_id"] },
        { name: "calendar_events_user_start_idx", fields: ["user_id", "start_at"] },
        { name: "calendar_events_user_type_idx", fields: ["user_id", "event_type"] },
        { name: "calendar_events_upload_item_idx", fields: ["upload_schedule_item_id"] },
    ],
})
export class CalendarEvent extends Model<CalendarEvent> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @ForeignKey(() => User)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    user_id: string | undefined;

    @Column({ type: DataType.STRING(255), allowNull: false })
    title: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    description: string | null | undefined;

    @Column({ type: DataType.DATE, allowNull: false })
    start_at: Date | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    end_at: Date | null | undefined;

    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
    all_day: boolean | undefined;

    /**
     * One of: content_release | reminder | meeting | task | campaign |
     * maintenance | custom | upload_schedule.
     * Stored as a free string so new types don't require migrations.
     */
    @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: "custom" })
    event_type: string | undefined;

    @Column({ type: DataType.STRING(50), allowNull: true })
    color: string | null | undefined;

    /** scheduled | completed | cancelled | uploaded | failed */
    @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: "scheduled" })
    status: string | undefined;

    /**
     * Upload-schedule linkage — populated when this event was generated from
     * an upload_schedule_items row. Kept as plain UUID columns (not FK) since
     * the schedule tables live in a different module file and adding a FK
     * relationship here would create import cycles.
     */
    @Column({ type: DataType.UUID, allowNull: true })
    upload_schedule_item_id: string | null | undefined;

    @ForeignKey(() => OttLibraryItem)
    @Column({ type: DataType.UUID, allowNull: true, onDelete: "SET NULL" })
    library_item_id: string | null | undefined;

    @ForeignKey(() => OttPlatform)
    @Column({ type: DataType.UUID, allowNull: true, onDelete: "SET NULL" })
    ott_id: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    metadata: Record<string, any> | undefined;

    @BelongsTo(() => User)
    user: User | undefined;

    @BelongsTo(() => OttPlatform)
    ott: OttPlatform | undefined;

    @BelongsTo(() => OttLibraryItem)
    library_item: OttLibraryItem | undefined;
}
