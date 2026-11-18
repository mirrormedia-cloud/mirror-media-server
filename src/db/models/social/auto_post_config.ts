/**
 * Auto Post settings — one row per user.
 *
 * When `enabled` is true the `auto-post-facebook` cron generates an AI
 * "thought" (text + emoji + hashtags, no media) at each configured slot
 * and publishes it to the linked Facebook Page's feed.
 *
 * Schedule shape mirrors the upload-schedule wizard:
 *   frequency  every_day | every_week | every_month
 *   post_times ["09:00", "18:30"]   — HH:MM in `timezone` (wall clock)
 *   weekdays   [1,3,5]              — 0=Sun..6=Sat, only for every_week
 *   month_days [1,15]               — 1..31, only for every_month
 *
 * `auto_generate` is always true (content is always AI-generated); it is
 * stored so the UI can display it read-only and so a manual-content mode
 * could be added later without a migration.
 */

import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "../auth/user";

export type AutoPostFrequency = "every_day" | "every_week" | "every_month";

@Table({
    tableName: "auto_post_configs",
    timestamps: true,
    paranoid: false,
    indexes: [
        { name: "auto_post_configs_user_uidx", unique: true, fields: ["user_id"] },
        { name: "auto_post_configs_enabled_idx", fields: ["enabled"] },
    ],
})
export class AutoPostConfig extends Model<AutoPostConfig> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @ForeignKey(() => User)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    user_id: string | undefined;

    @BelongsTo(() => User)
    user: User | undefined;

    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
    enabled: boolean | undefined;

    /** Target Facebook Page (SocialAccount.id). Null = first connected FB page. */
    @Column({ type: DataType.UUID, allowNull: true })
    social_account_id: string | null | undefined;

    @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: "every_day" })
    frequency: AutoPostFrequency | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: ["10:00"] })
    post_times: string[] | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    weekdays: number[] | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    month_days: number[] | undefined;

    /** IANA zone the post_times are expressed in, e.g. "Asia/Kolkata". */
    @Column({ type: DataType.STRING(64), allowNull: false, defaultValue: "UTC" })
    timezone: string | undefined;

    /** Always true — read-only in the UI. */
    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
    auto_generate: boolean | undefined;

    /** When the switch was last turned on. Slots before this never fire, so
     *  enabling at 14:00 doesn't back-fill the 10:00 slot. */
    @Column({ type: DataType.DATE, allowNull: true })
    enabled_at: Date | null | undefined;
}
