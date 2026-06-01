import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "../auth/user";

@Table({
    tableName: "user_notification_settings",
    timestamps: true,
    indexes: [
        { name: "user_notif_settings_user_idx", fields: ["user_id"], unique: true },
    ],
})
export class UserNotificationSettings extends Model<UserNotificationSettings> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @ForeignKey(() => User)
    @Column({ type: DataType.UUID, allowNull: false, unique: true, onDelete: "CASCADE" })
    user_id: string | undefined;

    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
    whatsapp_enabled: boolean | undefined;

    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
    app_notification_enabled: boolean | undefined;

    @BelongsTo(() => User)
    user: User | undefined;
}
