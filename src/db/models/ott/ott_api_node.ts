import { Table, Column, Model, DataType, ForeignKey, BelongsTo, HasMany, HasOne } from "sequelize-typescript";
import { OttPlatform } from "./ott_platform";
import { OttApiResponse } from "./ott_api_response";
import { OttSelectedField } from "./ott_selected_field";

@Table({ tableName: "ott_api_nodes", timestamps: true, paranoid: true })
export class OttApiNode extends Model<OttApiNode> {
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
    @Column({ type: DataType.UUID, allowNull: true, onDelete: "CASCADE" })
    parent_id: string | null | undefined;

    @Column({ type: DataType.STRING(150), allowNull: false })
    name: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: false })
    endpoint: string | undefined;

    @Column({ type: DataType.STRING(10), allowNull: false })
    method: string | undefined;

    @Column({ type: DataType.JSONB, allowNull: true })
    request_body: Record<string, any> | null | undefined;

    // ── Dynamic request-body builder ────────────────────────────────────
    // body_mode controls how request_body is built at call time:
    //   - "raw"        — use `request_body` as-is (legacy / JSON pasted by user)
    //   - "key_value"  — interpret `request_body_config` as an array of
    //                    {key, value_type, static_value, variable_path,
    //                     data_type, required} entries and resolve them.
    //   - null/missing — same as "raw" for backward compatibility.
    @Column({ type: DataType.STRING(50), allowNull: true })
    body_mode: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
    request_body_config: any[] | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    param_mappings: Record<string, string> | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    list_path: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    card_config: Record<string, any> | undefined;

    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
    card_enabled: boolean | undefined;

    // ── Pagination configuration ────────────────────────────────────────
    // Three-column pattern (instead of cramming everything into one JSONB)
    // so a quick "where pagination_enabled=true" query stays cheap and the
    // type is easy to filter on without unpacking JSON.
    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
    pagination_enabled: boolean | undefined;

    @Column({ type: DataType.STRING(50), allowNull: true })
    pagination_type: string | null | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    pagination_config: Record<string, any> | undefined;

    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
    quick_run: boolean | undefined;

    @Column({ type: DataType.UUID, allowNull: true })
    default_child_api_id: string | null | undefined;

    @Column({ type: DataType.UUID, allowNull: true })
    default_card_action_id: string | null | undefined;

    @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
    skip_action_modal: boolean | undefined;

    @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: "inline" })
    open_type: string | undefined;

    @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
    sort_order: number | undefined;

    @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: "not_called" })
    status: string | undefined;

    @Column({ type: DataType.INTEGER, allowNull: true })
    last_http_status: number | null | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    last_error: string | null | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    last_called_at: Date | null | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    last_synced_at: Date | null | undefined;

    @BelongsTo(() => OttPlatform)
    ott: OttPlatform | undefined;

    @BelongsTo(() => OttApiNode, "parent_id")
    parent: OttApiNode | undefined;

    @HasMany(() => OttApiNode, "parent_id")
    children: OttApiNode[] | undefined;

    @HasOne(() => OttApiResponse)
    latest_response: OttApiResponse | undefined;

    @HasMany(() => OttSelectedField)
    fields: OttSelectedField[] | undefined;
}
