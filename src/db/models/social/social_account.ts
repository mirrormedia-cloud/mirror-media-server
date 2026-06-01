/**
 * Single table that holds connected social-media accounts for every
 * supported platform (youtube / facebook / instagram). Mirrors the
 * `social_accounts` schema in the spec — fields not relevant to a given
 * platform stay null.
 *
 * One row per (user_id + platform + account/page/channel id). We allow
 * multiple rows per user/platform so a user can connect more than one
 * YouTube channel or Facebook Page.
 */

import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "../auth/user";

export type SocialPlatform = "youtube" | "facebook" | "instagram";

@Table({
    tableName: "social_accounts",
    timestamps: true,
    paranoid: true,
    indexes: [
        { name: "social_accounts_user_platform_idx", fields: ["user_id", "platform"] },
    ],
})
export class SocialAccount extends Model<SocialAccount> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @ForeignKey(() => User)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    user_id: string | undefined;

    @BelongsTo(() => User)
    user: User | undefined;

    @Column({ type: DataType.STRING(50), allowNull: false })
    platform: SocialPlatform | undefined;

    // Generic identifiers — platform-specific aliases below for clarity.
    @Column({ type: DataType.TEXT, allowNull: true })
    account_id: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    account_name: string | null | undefined;

    // Facebook
    @Column({ type: DataType.TEXT, allowNull: true })
    page_id: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    page_name: string | null | undefined;

    // YouTube
    @Column({ type: DataType.TEXT, allowNull: true })
    channel_id: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    channel_name: string | null | undefined;

    // Tokens — never returned to the frontend in raw form.
    @Column({ type: DataType.TEXT, allowNull: true })
    access_token: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    refresh_token: string | null | undefined;

    @Column({ type: DataType.STRING(50), allowNull: true })
    token_type: string | null | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    expires_at: Date | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    scopes: string[] | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    metadata: Record<string, any> | undefined;

    /** connected | disconnected | expired */
    @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: "connected" })
    status: string | undefined;

    /**
     * When to fire the proactive "reconnect required" reminder push. Set to
     * `connected_at + 6 days` on every successful connect/refresh — so every
     * successful refresh rolls the deadline forward and the reminder only
     * fires once the refresh chain has been silent for 6 days (i.e. 1 day
     * before Google's 7-day refresh-token expiry for unverified apps).
     * Cleared after the reminder fires so it doesn't repeat.
     *
     * Only used for `platform = 'youtube'` today; the column is generic
     * so we can extend to FB/IG later without a migration.
     */
    @Column({ type: DataType.DATE, allowNull: true })
    reconnect_reminder_at: Date | null | undefined;
}
