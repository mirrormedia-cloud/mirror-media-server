import type { FastifyRequest } from "fastify";
import { OttApiNode, OttCardAction } from "../../db/models";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import type { CreateCardActionInput, UpdateCardActionInput } from "./ott_card_actions.dto";

function ts(value: any): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function card_action_dto(a: OttCardAction) {
    return {
        id: a.id,
        ott_id: a.ott_id,
        api_node_id: a.api_node_id,
        label: a.label,
        action_type: a.action_type,
        child_api_id: a.child_api_id ?? null,
        value_path: a.value_path ?? null,
        button_style: a.button_style ?? "primary",
        icon: a.icon ?? null,
        open_type: a.open_type ?? "drawer",
        sort_order: a.sort_order ?? 0,
        config: a.config ?? {},
        is_active: a.is_active,
        createdAt: ts((a as any).createdAt),
        updatedAt: ts((a as any).updatedAt),
    };
}

async function load_node(ott_id: string, api_id: string) {
    return OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
}

async function set_default_card_click(node: OttApiNode, action_id: string | null) {
    const card_config = { ...(node.card_config || {}) };
    if (action_id) card_config.default_card_click_action_id = action_id;
    else delete card_config.default_card_click_action_id;
    await node.update({ card_config });
}

export async function get_card_actions(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const node = await load_node(ott_id, api_id);
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    const actions = await OttCardAction.findAll({
        where: { ott_id, api_node_id: api_id, is_active: true } as any,
        order: [["sort_order", "ASC"], ["createdAt", "ASC"]],
    });

    const default_id = (node.card_config as any)?.default_card_click_action_id ?? null;

    return success("card actions fetched successfully", {
        api_id,
        default_card_click_action_id: default_id,
        actions: actions.map(card_action_dto),
    });
}

export async function create_card_action(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const body = req.body as CreateCardActionInput;
    const node = await load_node(ott_id, api_id);
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    if (body.action_type === "call_child_api" && body.child_api_id) {
        const child = await OttApiNode.findOne({ where: { id: body.child_api_id, ott_id } as any });
        if (!child) return error(HttpStatus.BAD_REQUEST, "child_api_id does not belong to this OTT", "child_api_id");
        if (child.parent_id !== api_id) {
            return error(HttpStatus.BAD_REQUEST, "child API must be a direct child of this API", "child_api_id");
        }
    }

    const created = await OttCardAction.create({
        ott_id,
        api_node_id: api_id,
        label: body.label,
        action_type: body.action_type,
        child_api_id: body.child_api_id ?? null,
        value_path: body.value_path ?? null,
        button_style: body.button_style ?? "primary",
        icon: body.icon ?? null,
        open_type: body.open_type ?? "drawer",
        sort_order: body.sort_order ?? 0,
        config: body.config ?? {},
        is_active: true,
    } as any);

    if (body.is_default_card_click) {
        await set_default_card_click(node, created.id);
    }

    return success("card action created successfully", card_action_dto(created), HttpStatus.CREATED);
}

export async function update_card_action(req: FastifyRequest) {
    const { ott_id, api_id, action_id } = req.params as { ott_id: string; api_id: string; action_id: string };
    const body = req.body as UpdateCardActionInput;

    const node = await load_node(ott_id, api_id);
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    const action = await OttCardAction.findOne({
        where: { id: action_id, ott_id, api_node_id: api_id } as any,
    });
    if (!action) return error(HttpStatus.NOT_FOUND, "Card action not found");

    if (body.action_type === "call_child_api" || (body.child_api_id && action.action_type === "call_child_api")) {
        const target = body.child_api_id ?? action.child_api_id;
        if (target) {
            const child = await OttApiNode.findOne({ where: { id: target, ott_id } as any });
            if (!child) return error(HttpStatus.BAD_REQUEST, "child_api_id does not belong to this OTT", "child_api_id");
            if (child.parent_id !== api_id) {
                return error(HttpStatus.BAD_REQUEST, "child API must be a direct child of this API", "child_api_id");
            }
        }
    }

    const patch: Record<string, any> = {};
    if (body.label !== undefined) patch.label = body.label;
    if (body.action_type !== undefined) patch.action_type = body.action_type;
    if (body.child_api_id !== undefined) patch.child_api_id = body.child_api_id;
    if (body.value_path !== undefined) patch.value_path = body.value_path;
    if (body.button_style !== undefined) patch.button_style = body.button_style;
    if (body.icon !== undefined) patch.icon = body.icon;
    if (body.open_type !== undefined) patch.open_type = body.open_type;
    if (body.sort_order !== undefined) patch.sort_order = body.sort_order;
    if (body.config !== undefined) patch.config = body.config;
    if (body.is_active !== undefined) patch.is_active = body.is_active;

    await action.update(patch);

    if (body.is_default_card_click === true) {
        await set_default_card_click(node, action.id);
    } else if (body.is_default_card_click === false) {
        const current = (node.card_config as any)?.default_card_click_action_id ?? null;
        if (current === action.id) await set_default_card_click(node, null);
    }

    return success("card action updated successfully", card_action_dto(action));
}

export async function delete_card_action(req: FastifyRequest) {
    const { ott_id, api_id, action_id } = req.params as { ott_id: string; api_id: string; action_id: string };

    const node = await load_node(ott_id, api_id);
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    const action = await OttCardAction.findOne({
        where: { id: action_id, ott_id, api_node_id: api_id } as any,
    });
    if (!action) return error(HttpStatus.NOT_FOUND, "Card action not found");

    await action.destroy();

    const default_id = (node.card_config as any)?.default_card_click_action_id ?? null;
    if (default_id === action_id) await set_default_card_click(node, null);

    return success("card action deleted successfully", { id: action_id });
}
