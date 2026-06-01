import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "./user";

@Table({ tableName: "user_profiles", timestamps: true })
export class UserProfile extends Model<UserProfile> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @ForeignKey(() => User)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    user_id: string | undefined;

    @Column({ type: DataType.STRING(255), allowNull: true, defaultValue: '' })
    first_name: string | undefined;

    @Column({ type: DataType.STRING(255), allowNull: true, defaultValue: '' })
    last_name: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    profile_picture: string | undefined;

    @Column({ type: DataType.STRING(20), allowNull: true })
    gender: string | undefined;

    @Column({ type: DataType.DATEONLY, allowNull: true })
    dob: string | undefined;

    @Column({ type: DataType.STRING(10), allowNull: true })
    mobile_country_code: string | null | undefined;

    @Column({ type: DataType.STRING(20), allowNull: true })
    mobile_no: string | null | undefined;

    @Column({ type: DataType.STRING(10), allowNull: true })
    whatsapp_country_code: string | null | undefined;

    @Column({ type: DataType.STRING(20), allowNull: true })
    whatsapp_no: string | null | undefined;

    @BelongsTo(() => User)
    user: User | undefined;
}
