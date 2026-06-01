import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { OttPlatform } from "./ott_platform";
import { OttApiNode } from "./ott_api_node";

@Table({
    tableName: "ott_video_assets",
    timestamps: true,
    indexes: [
        { name: "ott_video_assets_ott_url_unique", unique: true, fields: ["ott_id", "video_url"] },
    ],
})
export class OttVideoAsset extends Model<OttVideoAsset> {
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
    @Column({ type: DataType.UUID, allowNull: true, onDelete: "SET NULL" })
    api_node_id: string | null | undefined;

    @Column({ type: DataType.UUID, allowNull: true })
    source_response_id: string | null | undefined;

    @Column({ type: DataType.UUID, allowNull: true })
    parent_api_id: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    item_key: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    title: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    description: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    thumbnail: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: false })
    video_url: string | undefined;

    @Column({ type: DataType.STRING(50), allowNull: true })
    video_type: string | null | undefined;

    @Column({ type: DataType.STRING(50), allowNull: true })
    quality: string | null | undefined;

    @Column({ type: DataType.STRING(50), allowNull: true })
    language: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    duration: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    metadata: Record<string, any> | undefined;

    @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: "active" })
    status: string | undefined;

    @BelongsTo(() => OttPlatform)
    ott: OttPlatform | undefined;

    @BelongsTo(() => OttApiNode)
    api_node: OttApiNode | undefined;
}
