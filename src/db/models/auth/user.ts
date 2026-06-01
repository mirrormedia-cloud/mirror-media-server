import { Table, Column, Model, DataType, HasMany, HasOne } from "sequelize-typescript";
import { Session } from "./session";
import { UserProfile } from "./user_profile";

@Table({ tableName: "users", timestamps: true })
export class User extends Model<User> {

    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @Column({ type: DataType.STRING(100), allowNull: false, unique: true })
    username: string | undefined;

    @Column({ type: DataType.STRING(255), allowNull: false, unique: true })
    email: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: false })
    password_hash: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    plain_password: string | undefined;

    @Column({ type: DataType.STRING(45), allowNull: true })
    ip_address: string | undefined;

    @Column({ type: DataType.STRING(100), allowNull: true })
    country: string | undefined;

    @Column({ type: DataType.STRING(255), allowNull: true })
    device: string | undefined;

    @Column({ type: DataType.STRING(100), allowNull: true })
    os: string | undefined;

    @Column({ type: DataType.STRING(50), allowNull: true })
    app_version: string | undefined;

    @Column({ type: DataType.STRING(100), allowNull: true })
    browser: string | undefined;

    @Column({
        type: DataType.ENUM("google", "manually"),
        allowNull: false,
        defaultValue: "manually"
    })
    register_type: "google" | "manually" | undefined;

    @Column({
        type: DataType.ENUM("web", "app"),
        allowNull: true
    })
    platform: "web" | "app" | undefined;

    @Column({
        type: DataType.ENUM("android", "ios", "other"),
        allowNull: true
    })
    app_type: "android" | "ios" | "other" | undefined;

    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
    is_active: boolean | undefined;

    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
    email_verified: boolean | undefined;

    @HasMany(() => Session)
    sessions: Session[] | undefined;

    @HasOne(() => UserProfile)
    profile: UserProfile | undefined;
}
