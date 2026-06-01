import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "./user";

@Table({ tableName: "user_settings", timestamps: true })
export class UserSetting extends Model<UserSetting> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @ForeignKey(() => User)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    user_id: string | undefined;

    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
    two_step_verification: boolean | undefined;

    // Free-form per-user UI preferences. Stored as JSONB so the frontend
    // can ship new prefs without a migration. Currently used for:
    //   - ott_library_view_mode: 'cards' | 'files'
    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    preferences: Record<string, any> | undefined;

    @BelongsTo(() => User)
    user: User | undefined;
}
