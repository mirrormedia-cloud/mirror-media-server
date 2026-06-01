import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "../auth/user";
import { CalendarEvent } from "../calendar/calendar_event";

/**
 * One pre-computed reminder per (calendar_event, reminder_type). The reminder
 * cron polls this table — generation happens when an event is created/updated,
 * never inside the cron itself. The (calendar_event_id, reminder_type) unique
 * constraint is what prevents duplicate pushes.
 */
@Table({
    tableName: "calendar_event_reminders",
    timestamps: false,
    indexes: [
        { name: "cal_rem_user_idx", fields: ["user_id"] },
        { name: "cal_rem_event_idx", fields: ["calendar_event_id"] },
        { name: "cal_rem_time_idx", fields: ["reminder_time"] },
        { name: "cal_rem_status_idx", fields: ["status"] },
        // The cron's hot query: pending rows whose time has passed.
        { name: "cal_rem_due_idx", fields: ["status", "reminder_time"] },
        { name: "cal_rem_unique", fields: ["calendar_event_id", "reminder_type"], unique: true },
    ],
})
export class CalendarEventReminder extends Model<CalendarEventReminder> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @ForeignKey(() => User)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    user_id: string | undefined;

    @ForeignKey(() => CalendarEvent)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    calendar_event_id: string | undefined;

    /** before_2_days | before_1_day | before_5_hours | before_1_hour */
    @Column({ type: DataType.STRING(50), allowNull: false })
    reminder_type: string | undefined;

    @Column({ type: DataType.DATE, allowNull: false })
    reminder_time: Date | undefined;

    /** pending | sent | failed | skipped */
    @Column({ type: DataType.STRING(30), allowNull: false, defaultValue: "pending" })
    status: string | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    sent_at: Date | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    error_message: string | null | undefined;

    @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
    created_at: Date | undefined;

    @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
    updated_at: Date | undefined;

    @BelongsTo(() => User)
    user: User | undefined;

    @BelongsTo(() => CalendarEvent)
    calendar_event: CalendarEvent | undefined;
}
