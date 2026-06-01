import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { OttPlatform } from "./ott_platform";
import { OttApiNode } from "./ott_api_node";

@Table({ tableName: "ott_selected_fields", timestamps: true })
export class OttSelectedField extends Model<OttSelectedField> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    // Owner — backfilled to default user on boot for legacy rows.
    // Filtered on every query in Phase 2; for now allowNull stays true so
    // alter sync can add the column to populated tables without failing.
    @Column({ type: DataType.UUID, allowNull: true })
    user_id: string | null | undefined;

    @ForeignKey(() => OttPlatform)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    ott_id: string | undefined;

    @ForeignKey(() => OttApiNode)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    api_node_id: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: false })
    path: string | undefined;

    @Column({ type: DataType.STRING(150), allowNull: true })
    label: string | null | undefined;

    @Column({ type: DataType.STRING(50), allowNull: false })
    display_type: string | undefined;

    @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
    sort_order: number | undefined;

    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
    is_visible: boolean | undefined;

    @BelongsTo(() => OttPlatform)
    ott: OttPlatform | undefined;

    @BelongsTo(() => OttApiNode)
    api_node: OttApiNode | undefined;
}
