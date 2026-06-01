import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "./user";

@Table({
    tableName: "login_sessions",
    timestamps: false,
    indexes: [
        { name: "login_sessions_user_idx", fields: ["user_id"] },
        { name: "login_sessions_jwt_idx", fields: ["jwt"] },
        { name: "login_sessions_fcm_idx", fields: ["fcm_token"] },
        { name: "login_sessions_active_idx", fields: ["is_active"] },
        { name: "login_sessions_last_seen_idx", fields: ["last_seen_at"] },
    ],
})
export class Session extends Model<Session> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @ForeignKey(() => User)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    user_id: string | undefined;

    @Column({ type: DataType.STRING(255), allowNull: false })
    email: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    fcm_token: string | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    fcm_token_updated_at: Date | null | undefined;

    /**
     * Browser permission state for THIS session. Distinct from whether we have
     * an fcm_token: a user can revoke at the OS level without us being told,
     * so we re-check on each register-token call and update this column.
     * Values: default | granted | denied.
     */
    @Column({ type: DataType.STRING(30), allowNull: false, defaultValue: "default" })
    notification_permission: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    jwt: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    refresh_token: string | null | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    login_time: Date | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    logout_time: Date | undefined;

    /** Touched on every authenticated request (auth.middleware). */
    @Column({ type: DataType.DATE, allowNull: true })
    last_seen_at: Date | null | undefined;

    /** False after logout or admin revoke. authenticate() rejects inactive sessions. */
    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
    is_active: boolean | undefined;

    @Column({ type: DataType.STRING(100), allowNull: true })
    country: string | undefined;

    @Column({ type: DataType.STRING(255), allowNull: true })
    device: string | undefined;

    /** web | android | ios — for filtering "which devices is this user on?". */
    @Column({ type: DataType.STRING(30), allowNull: false, defaultValue: "web" })
    device_type: string | undefined;

    /** Free-form label like "Chrome on Windows" for the active-sessions UI. */
    @Column({ type: DataType.STRING(150), allowNull: true })
    device_name: string | null | undefined;

    @Column({ type: DataType.STRING(100), allowNull: true })
    os: string | undefined;

    @Column({ type: DataType.STRING(50), allowNull: true })
    app_version: string | undefined;

    @Column({ type: DataType.STRING(100), allowNull: true })
    browser: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    user_agent: string | null | undefined;

    @Column({ type: DataType.STRING(100), allowNull: true })
    ip_address: string | null | undefined;

    @Column({
        type: DataType.ENUM("google", "manually"),
        allowNull: true
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

    @BelongsTo(() => User)
    user: User | undefined;
}
