import type { FastifyRequest } from "fastify";
import { AutomationRule } from "../../db/models/automation/automation_rule";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import type { CreateAutomationInput, UpdateAutomationInput } from "./automation.dto";

function rule_dto(r: AutomationRule) {
    return {
        id: r.id,
        platform: r.platform,
        type: r.type,
        ig_account_id: r.ig_account_id,
        trigger_keywords: r.trigger_keywords ?? [],
        comment_reply: r.comment_reply ?? { text: "" },
        dm_message: r.dm_message ?? { text: "", buttons: [] },
        status: r.status,
        createdAt: (r as any).createdAt,
        updatedAt: (r as any).updatedAt,
    };
}

export async function list_automation_rules(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");

    const rows = await AutomationRule.findAll({
        where: { user_id },
        order: [["createdAt", "DESC"]],
    });
    return success("Automation rules fetched", rows.map(rule_dto));
}

export async function get_automation_rule(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");

    const { id } = req.params as { id: string };
    const row = await AutomationRule.findOne({ where: { id, user_id } });
    if (!row) return error(HttpStatus.NOT_FOUND, "Automation rule not found");
    return success("Automation rule fetched", rule_dto(row));
}

export async function create_automation_rule(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");

    const body = req.body as CreateAutomationInput;
    const row = await AutomationRule.create({
        user_id,
        platform: body.platform ?? "instagram",
        type: body.type ?? "comment",
        ig_account_id: body.ig_account_id,
        trigger_keywords: body.trigger_keywords,
        comment_reply: body.comment_reply,
        dm_message: body.dm_message,
        status: body.status ?? "active",
    } as any);
    return success("Automation rule created", rule_dto(row), HttpStatus.CREATED);
}

export async function update_automation_rule(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");

    const { id } = req.params as { id: string };
    const row = await AutomationRule.findOne({ where: { id, user_id } });
    if (!row) return error(HttpStatus.NOT_FOUND, "Automation rule not found");

    const body = req.body as UpdateAutomationInput;
    await row.update({
        ...(body.platform !== undefined && { platform: body.platform }),
        ...(body.type !== undefined && { type: body.type }),
        ...(body.trigger_keywords !== undefined && { trigger_keywords: body.trigger_keywords }),
        ...(body.comment_reply !== undefined && { comment_reply: body.comment_reply }),
        ...(body.dm_message !== undefined && { dm_message: body.dm_message as any }),
        ...(body.status !== undefined && { status: body.status }),
    });
    return success("Automation rule updated", rule_dto(row));
}

export async function delete_automation_rule(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");

    const { id } = req.params as { id: string };
    const row = await AutomationRule.findOne({ where: { id, user_id } });
    if (!row) return error(HttpStatus.NOT_FOUND, "Automation rule not found");
    await row.destroy();
    return success("Automation rule deleted", { id });
}

/**
 * Find the first active automation rule for an IG account whose trigger
 * keywords match the given comment text (case-insensitive substring).
 * Used by the webhook handler.
 */
export async function find_matching_rule(
    ig_account_id: string,
    comment_text: string,
): Promise<AutomationRule | null> {
    const rules = await AutomationRule.findAll({
        where: { ig_account_id, status: "active", type: "comment" },
    });
    if (!rules.length) return null;

    const lower_text = comment_text.toLowerCase();
    return (
        rules.find((rule) => {
            const keywords = rule.trigger_keywords ?? [];
            if (keywords.length === 0) return false;
            return keywords.some((kw) => lower_text.includes(kw.toLowerCase()));
        }) ?? null
    );
}
