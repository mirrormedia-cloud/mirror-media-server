import { Table, Column, Model, DataType, ForeignKey, BelongsTo } from "sequelize-typescript";
import { OttPlatform } from "./ott_platform";
import { OttApiNode } from "./ott_api_node";

@Table({ tableName: "ott_api_logs", timestamps: true, updatedAt: false })
export class OttApiLog extends Model<OttApiLog> {
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
    parent_api_id: string | null | undefined;

    @Column({ type: DataType.UUID, allowNull: true })
    child_api_id: string | null | undefined;

    @Column({ type: DataType.STRING(150), allowNull: true })
    api_name: string | null | undefined;

    @Column({ type: DataType.STRING(150), allowNull: true })
    parent_api_name: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    original_endpoint: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    resolved_endpoint: string | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    request_url: string | null | undefined;

    @Column({ type: DataType.STRING(10), allowNull: true })
    method: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    request_headers: Record<string, any> | undefined;

    @Column({ type: DataType.STRING(50), allowNull: true })
    cookie_status: string | null | undefined;

    @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
    cookie_length: number | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    cookie_names: string[] | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    dynamic_params_used: Record<string, any> | undefined;

    @Column({ type: DataType.JSONB, allowNull: true })
    request_body: Record<string, any> | null | undefined;

    @Column({ type: DataType.STRING(50), allowNull: false })
    status: string | undefined;

    @Column({ type: DataType.INTEGER, allowNull: true })
    http_status: number | null | undefined;

    @Column({ type: DataType.INTEGER, allowNull: true })
    duration_ms: number | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    response_preview: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: true })
    response: any;

    @Column({ type: DataType.TEXT, allowNull: true })
    error_message: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: true })
    error_details: Record<string, any> | null | undefined;

    @Column({ type: DataType.INTEGER, allowNull: true })
    card_index: number | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    item_key: string | null | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    started_at: Date | null | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    ended_at: Date | null | undefined;

    @BelongsTo(() => OttPlatform)
    ott: OttPlatform | undefined;

    @BelongsTo(() => OttApiNode)
    api_node: OttApiNode | undefined;
}
