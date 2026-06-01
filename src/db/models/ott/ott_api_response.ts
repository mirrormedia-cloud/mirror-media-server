import { Table, Column, Model, DataType, ForeignKey, BelongsTo, Index } from "sequelize-typescript";
import { OttPlatform } from "./ott_platform";
import { OttApiNode } from "./ott_api_node";

@Table({ tableName: "ott_api_responses", timestamps: true })
export class OttApiResponse extends Model<OttApiResponse> {
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

    @Index({ name: "ott_api_responses_api_node_id_unique", unique: true })
    @ForeignKey(() => OttApiNode)
    @Column({ type: DataType.UUID, allowNull: false, onDelete: "CASCADE" })
    api_node_id: string | undefined;

    @Column({ type: DataType.JSONB, allowNull: false })
    response: any;

    @Column({ type: DataType.TEXT, allowNull: true })
    response_preview: string | null | undefined;

    @Column({ type: DataType.INTEGER, allowNull: true })
    http_status: number | null | undefined;

    @Column({ type: DataType.INTEGER, allowNull: true })
    duration_ms: number | null | undefined;

    @BelongsTo(() => OttPlatform)
    ott: OttPlatform | undefined;

    @BelongsTo(() => OttApiNode)
    api_node: OttApiNode | undefined;
}
