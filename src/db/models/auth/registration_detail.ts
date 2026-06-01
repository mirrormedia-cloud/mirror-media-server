import { Table, Column, Model, DataType } from "sequelize-typescript";

@Table({ tableName: "registration_details", timestamps: true })
export class RegistrationDetail extends Model<RegistrationDetail> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @Column({ type: DataType.STRING(255), allowNull: false })
    email: string | undefined;

    @Column({ type: DataType.STRING(100), allowNull: false })
    username: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: false })
    password_hash: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: false })
    plain_password: string | undefined;

    @Column({ type: DataType.STRING(255), allowNull: false })
    first_name: string | undefined;

    @Column({ type: DataType.STRING(255), allowNull: false })
    last_name: string | undefined;

    @Column({ type: DataType.UUID, allowNull: false })
    verification_id: string | undefined;
}
