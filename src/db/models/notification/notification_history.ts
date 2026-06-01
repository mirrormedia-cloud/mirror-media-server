import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "../auth/user";
import { Session } from "../auth/session";

/**
 * Every push attempt logs one row here, regardless of whether the push
 * actually reached a device (sent_push = false when we had nothing to send to).
 * This is the source-of-truth for the in-app notification bell and history page.
 */
@Table({
    tableName: "notification_history",
    timestamps: false,
    indexes: [
        { name: "notif_hist_user_idx", fields: ["user_id"] },
        { name: "notif_hist_type_idx", fields: ["type"] },
        { name: "notif_hist_module_idx", fields: ["module"] },
        { name: "notif_hist_event_type_idx", fields: ["event_type"] },
        { name: "notif_hist_user_read_idx", fields: ["user_id", "is_read"] },
        { name: "notif_hist_created_idx", fields: ["created_at"] },
        // Used by the 30-minute dedup window in firebase-notification.service.
        { name: "notif_hist_dedup_idx", fields: ["user_id", "event_type", "related_id", "created_at"] },
    ],
})
export class NotificationHistory extends Model<NotificationHistory> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @ForeignKey(() => User)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    user_id: string | undefined;

    /**
     * Optional: the session that *triggered* the notification (e.g. a token
     * register event). Push fanout writes nothing here since it goes to many
     * sessions at once.
     */
    @ForeignKey(() => Session)
    @Column({ type: DataType.UUID, allowNull: true, onDelete: "SET NULL" })
    session_id: string | null | undefined;

    /** error | warning | reminder | info */
    @Column({ type: DataType.STRING(30), allowNull: false })
    type: string | undefined;

    /** schedule | calendar | drive | youtube | facebook | instagram | platform | system */
    @Column({ type: DataType.STRING(50), allowNull: false })
    module: string | undefined;

    @Column({ type: DataType.STRING(255), allowNull: false })
    title: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: false })
    message: string | undefined;

    /**
     * Stable machine id for the kind of event — used for dedup + UI filtering.
     * e.g. calendar_reminder_1_hour, platform_upload_failed, platform_token_error.
     */
    @Column({ type: DataType.STRING(100), allowNull: true })
    event_type: string | null | undefined;

    /**
     * Free-form id of the underlying object (upload_id, schedule_id,
     * calendar_event_id, platform_account_id, ...). Stored as a string so we
     * don't need to know the type at write time.
     */
    @Column({ type: DataType.STRING(100), allowNull: true })
    related_id: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    redirect_url: string | null | undefined;

    /**
     * True if Firebase accepted at least one token. False means we recorded
     * the notification for in-app display but had no active tokens to push to.
     */
    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
    sent_push: boolean | undefined;

    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
    is_read: boolean | undefined;

    /** low | normal | high | critical */
    @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: "normal" })
    priority: string | undefined;

    /** app | whatsapp | both */
    @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: "app" })
    channel: string | undefined;

    /** Label for the action button, e.g. "View Upload", "View Schedule" */
    @Column({ type: DataType.STRING(100), allowNull: true })
    action_label: string | null | undefined;

    /** Full payload for the detail view (JSON) */
    @Column({ type: DataType.JSONB, allowNull: true })
    payload: Record<string, any> | null | undefined;

    /** Error details — set when the underlying operation failed */
    @Column({ type: DataType.TEXT, allowNull: true })
    error_message: string | null | undefined;

    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
    whatsapp_sent: boolean | undefined;

    /** sent | failed | skipped */
    @Column({ type: DataType.STRING(50), allowNull: true })
    whatsapp_status: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    whatsapp_error: string | null | undefined;

    /** Timestamp when is_read was flipped to true */
    @Column({ type: DataType.DATE, allowNull: true })
    read_at: Date | null | undefined;

    @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
    created_at: Date | undefined;

    @BelongsTo(() => User)
    user: User | undefined;
}
