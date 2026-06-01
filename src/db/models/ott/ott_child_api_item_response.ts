import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { OttPlatform } from "./ott_platform";
import { OttApiNode } from "./ott_api_node";

@Table({
    tableName: "ott_child_api_item_responses",
    timestamps: true,
    indexes: [
        {
            name: "ott_child_api_item_v2_unique",
            unique: true,
            fields: ["child_api_id", "parent_api_id", "parent_item_key", "item_key"],
        },
    ],
})
export class OttChildApiItemResponse extends Model<OttChildApiItemResponse> {
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
    parent_api_id: string | undefined;

    @ForeignKey(() => OttApiNode)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    child_api_id: string | undefined;

    /** item_key of the parent card on whose response we resolved this child call. Empty for root parents. */
    @Column({ type: DataType.TEXT, allowNull: false, defaultValue: "" })
    parent_item_key: string | undefined;

    /** item_key of the parent's clicked card (e.g. show slug). */
    @Column({ type: DataType.TEXT, allowNull: false })
    item_key: string | undefined;

    @Column({ type: DataType.INTEGER, allowNull: true })
    card_index: number | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    resolved_endpoint: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: true })
    response: any;

    @Column({ type: DataType.INTEGER, allowNull: true })
    http_status: number | null | undefined;

    @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
    depth: number | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    breadcrumb: any[] | undefined;

    @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: "success" })
    status: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    error_message: string | null | undefined;

    @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
    called_at: Date | undefined;

    @BelongsTo(() => OttPlatform)
    ott: OttPlatform | undefined;

    @BelongsTo(() => OttApiNode, "parent_api_id")
    parent_api: OttApiNode | undefined;

    @BelongsTo(() => OttApiNode, "child_api_id")
    child_api: OttApiNode | undefined;
}
