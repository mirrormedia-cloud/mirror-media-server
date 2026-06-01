import { Table, Column, Model, DataType } from "sequelize-typescript";

@Table({ tableName: "otp_rate_limit", timestamps: true })
export class OtpRateLimit extends Model<OtpRateLimit> {
    // Defaults — used when creating a new row
    static readonly DEFAULT_MAX_SEND = 3;
    static readonly DEFAULT_MAX_VERIFY = 5;
    static readonly DEFAULT_COOLDOWN = 30;

    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @Column({ type: DataType.STRING(255), allowNull: false })
    email: string | undefined;

    @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
    send_count: number | undefined;

    @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
    verify_count: number | undefined;

    @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 3 })
    max_send_attempts: number | undefined;

    @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 5 })
    max_verify_attempts: number | undefined;

    @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 30 })
    cooldown_minutes: number | undefined;

    @Column({ type: DataType.DATE, allowNull: false })
    window_start: Date | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    blocked_until: Date | undefined;
}
