import type { FastifyRequest } from "fastify";
import { Op } from "sequelize";
import { OttPlatform, OttApiLog } from "../../db/models";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import type { ListLogsQueryInput } from "./ott_logs.dto";

function ts(value: any): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function log_summary_dto(l: OttApiLog) {
    return {
        id: l.id,
        ott_id: l.ott_id,
        api_node_id: l.api_node_id ?? null,
        parent_api_id: l.parent_api_id ?? null,
        child_api_id: l.child_api_id ?? null,
        api_name: l.api_name ?? null,
        parent_api_name: l.parent_api_name ?? null,
        original_endpoint: l.original_endpoint ?? null,
        resolved_endpoint: l.resolved_endpoint ?? null,
        request_url: l.request_url ?? null,
        method: l.method ?? null,
        cookie_status: l.cookie_status ?? null,
        cookie_length: l.cookie_length ?? 0,
        cookie_names: l.cookie_names ?? [],
        dynamic_params_used: l.dynamic_params_used ?? {},
        status: l.status,
        http_status: l.http_status ?? null,
        duration_ms: l.duration_ms ?? null,
        response_preview: l.response_preview ?? null,
        error_message: l.error_message ?? null,
        card_index: l.card_index ?? null,
        item_key: l.item_key ?? null,
        startedAt: ts(l.started_at),
        endedAt: ts(l.ended_at),
        createdAt: ts((l as any).createdAt),
    };
}

function log_detail_dto(l: OttApiLog) {
    return {
        ...log_summary_dto(l),
        request_headers: l.request_headers ?? {},
        request_body: l.request_body ?? null,
        response: l.response ?? null,
        error_details: l.error_details ?? null,
    };
}

async function ensure_ott(ott_id: string, req: FastifyRequest) {
    const user_id = (req as any).userId;
    const ott = await OttPlatform.findOne({ where: { id: ott_id, user_id } as any });
    return ott;
}

export async function get_logs(req: FastifyRequest) {
    const { ott_id } = req.params as { ott_id: string };
    const ott = await ensure_ott(ott_id, req);
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const query = (req.query || {}) as ListLogsQueryInput;
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;

    const where: any = { ott_id };
    if (query.status) where.status = query.status;
    if (query.api_id) where.api_node_id = query.api_id;
    if (query.search) {
        const like = `%${query.search}%`;
        where[Op.or] = [
            { api_name: { [Op.iLike]: like } },
            { resolved_endpoint: { [Op.iLike]: like } },
            { request_url: { [Op.iLike]: like } },
            { error_message: { [Op.iLike]: like } },
        ];
    }

    const { rows, count } = await OttApiLog.findAndCountAll({
        where,
        order: [["createdAt", "DESC"]],
        limit,
        offset: (page - 1) * limit,
    });

    return success("logs fetched successfully", {
        ott_id,
        total: count,
        page,
        limit,
        items: rows.map(log_summary_dto),
    });
}

export async function get_log_by_id(req: FastifyRequest) {
    const { ott_id, log_id } = req.params as { ott_id: string; log_id: string };
    const log = await OttApiLog.findOne({ where: { id: log_id, ott_id } as any });
    if (!log) return error(HttpStatus.NOT_FOUND, "Log not found");
    return success("log fetched successfully", log_detail_dto(log));
}

export async function clear_logs(req: FastifyRequest) {
    const { ott_id } = req.params as { ott_id: string };
    const ott = await ensure_ott(ott_id, req);
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const removed = await OttApiLog.destroy({ where: { ott_id } as any });
    return success("logs cleared successfully", { ott_id, removed });
}
