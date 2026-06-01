import { Table, Column, Model, DataType } from "sequelize-typescript";

@Table({ tableName: "authentication_otp", timestamps: true })
export class AuthenticationOtp extends Model<AuthenticationOtp> {
    static readonly otp_expiry_seconds = 300; // 5 minutes by default

    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @Column({ type: DataType.STRING(255), allowNull: false })
    email: string | undefined;

    @Column({ type: DataType.STRING(10), allowNull: false })
    otp: string | undefined;

    @Column({ type: DataType.STRING(255), allowNull: true })
    verification_id: string | undefined;

    @Column({ type: DataType.DATE, allowNull: false })
    expires_at: Date | undefined;
}
