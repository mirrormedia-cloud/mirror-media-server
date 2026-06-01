import { Table, Column, Model, DataType, HasMany } from "sequelize-typescript";
import { OttApiNode } from "./ott_api_node";
import { OttApiResponse } from "./ott_api_response";
import { OttSelectedField } from "./ott_selected_field";
import { OttApiLog } from "./ott_api_log";
import { OttChildApiItemResponse } from "./ott_child_api_item_response";

@Table({ tableName: "ott_platforms", timestamps: true, paranoid: true })
export class OttPlatform extends Model<OttPlatform> {
    @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
    declare id: string;

    @Column({ type: DataType.UUID, allowNull: true })
    user_id: string | undefined;

    @Column({ type: DataType.STRING(150), allowNull: false })
    name: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    description: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: false })
    base_url: string | undefined;

    @Column({ type: DataType.STRING(255), allowNull: true })
    cookie_file_name: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    cookie_raw_content: string | undefined;

    @Column({ type: DataType.TEXT, allowNull: true })
    cookie_string: string | undefined;

    @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
    headers: Record<string, any> | undefined;

    // Optional favicon — either an external URL pasted by the user (most
    // common; e.g. https://kukutv.app/favicon.ico) or a local /uploads/...
    // path if a future upload endpoint stores the binary on the server.
    // The frontend uses this in the sidebar / manage page header next to
    // the OTT name.
    @Column({ type: DataType.TEXT, allowNull: true })
    favicon_url: string | null | undefined;

    @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: "active" })
    status: string | undefined;

    @Column({ type: DataType.DATE, allowNull: true })
    last_synced_at: Date | undefined;

    @HasMany(() => OttApiNode)
    api_nodes: OttApiNode[] | undefined;

    @HasMany(() => OttApiResponse)
    api_responses: OttApiResponse[] | undefined;

    @HasMany(() => OttSelectedField)
    selected_fields: OttSelectedField[] | undefined;

    @HasMany(() => OttApiLog)
    logs: OttApiLog[] | undefined;

    @HasMany(() => OttChildApiItemResponse)
    child_responses: OttChildApiItemResponse[] | undefined;
}
