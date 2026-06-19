import { Table, Column, Model, DataType } from "sequelize-typescript";

/**
 * Per-Instagram-account bot configuration.
 * `ig_account_id` matches `SocialAccount.account_id` for platform='instagram'.
 * When a webhook event arrives, the service looks up this row to get
 * the reply text and dynamic buttons to send back as a DM.
 */
@Table({
    tableName: "instagram_bot_configs",
    timestamps: true,
    paranoid: false,
    indexes: [
        { name: "instagram_bot_configs_ig_account_id_idx", fields: ["ig_account_id"], unique: true },
    ],
})
export class InstagramBotConfig extends Model<InstagramBotConfig> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    /** Instagram Business Account ID — must match SocialAccount.account_id. */
    @Column({ type: DataType.TEXT, allowNull: false, unique: true })
    ig_account_id: string | undefined;

    /** Text displayed above the buttons in the button-template DM. */
    @Column({ type: DataType.TEXT, allowNull: false, defaultValue: "Thanks for contacting us 👇" })
    reply_text: string | undefined;

    /** Dynamic list of CTA buttons. Each entry: { title: string; url: string }. */
    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    buttons: Array<{ title: string; url: string }> | undefined;

    /** When false, the bot is silenced for this account without deleting the config. */
    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
    is_active: boolean | undefined;
}
