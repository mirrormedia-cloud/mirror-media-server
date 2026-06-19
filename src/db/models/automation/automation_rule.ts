import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "../auth/user";

@Table({
    tableName: "automation_rules",
    timestamps: true,
    paranoid: false,
    indexes: [
        { name: "automation_rules_user_idx", fields: ["user_id"] },
        { name: "automation_rules_ig_account_idx", fields: ["ig_account_id"] },
    ],
})
export class AutomationRule extends Model<AutomationRule> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @ForeignKey(() => User)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    user_id: string | undefined;

    @BelongsTo(() => User)
    user: User | undefined;

    /** instagram | facebook */
    @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: "instagram" })
    platform: string | undefined;

    /** comment */
    @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: "comment" })
    type: string | undefined;

    /** Instagram Business Account ID (from SocialAccount.account_id) */
    @Column({ type: DataType.TEXT, allowNull: false })
    ig_account_id: string | undefined;

    /** Keywords that trigger this automation. Case-insensitive substring match on comment text. */
    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    trigger_keywords: string[] | undefined;

    /** Text to post as a public reply to the triggering comment */
    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: { text: "" } })
    comment_reply: { text: string } | undefined;

    /** Text + buttons for the private DM sent after the comment reply */
    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: { text: "", buttons: [] } })
    dm_message: { text: string; buttons: Array<{ title: string; action: string; url?: string }> } | undefined;

    /** active | inactive */
    @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: "active" })
    status: string | undefined;
}
