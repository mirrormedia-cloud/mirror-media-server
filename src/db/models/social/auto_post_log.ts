/**
 * One row per Auto Post slot attempt.
 *
 * `slot_key` ("2026-11-18 09:00" in the config's timezone, or
 * "manual:<uuid>" for Post-now) is unique per user — the cron inserts the
 * row BEFORE generating/posting, so a second tick (or an overlapping run)
 * hits the unique index and skips instead of double-posting.
 */

import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "../auth/user";

export type AutoPostStatus = "pending" | "posted" | "failed";

@Table({
    tableName: "auto_post_logs",
    timestamps: true,
    paranoid: false,
    indexes: [
        { name: "auto_post_logs_user_slot_uidx", unique: true, fields: ["user_id", "slot_key"] },
        { name: "auto_post_logs_user_created_idx", fields: ["user_id", "createdAt"] },
    ],
})
export class AutoPostLog extends Model<AutoPostLog> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @ForeignKey(() => User)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    user_id: string | undefined;

    @BelongsTo(() => User)
    user: User | undefined;

    @Column({ type: DataType.UUID, allowNull: true })
    social_account_id: string | null | undefined;

    @Column({ type: DataType.STRING(80), allowNull: false })
    slot_key: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    content: string | null | undefined;

    @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: "pending" })
    status: AutoPostStatus | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    platform_post_id: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    error_message: string | null | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    posted_at: Date | null | undefined;
}
