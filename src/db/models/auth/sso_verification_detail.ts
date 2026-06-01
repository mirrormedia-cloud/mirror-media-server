import { Table, Column, Model, DataType } from "sequelize-typescript";

@Table({ tableName: "sso_verification_details", timestamps: true })
export class SsoVerificationDetail extends Model<SsoVerificationDetail> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @Column({ type: DataType.STRING(255), allowNull: false })
    email: string | undefined;

    @Column({ type: DataType.STRING(255), allowNull: true })
    username: string | undefined;

    @Column({ type: DataType.STRING(255), allowNull: true })
    first_name: string | undefined;

    @Column({ type: DataType.STRING(255), allowNull: true })
    last_name: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    profile_picture: string | undefined;

    @Column({ type: DataType.UUID, allowNull: true })
    verification_id: string | undefined;
}
