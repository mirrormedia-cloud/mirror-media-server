import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { Op } from "sequelize";
import axios from "axios";
import { config } from "../../config";
import { send_ig_dm, handle_comment_event, send_ig_dm_from_comment } from "./service"; // send_ig_dm kept for /test-dm endpoint
import { InstagramBotConfig } from "../../db/models/instagram/instagram_bot_config";
import { SocialAccount } from "../../db/models/social/social_account";

// ─── Dedup cache ─────────────────────────────────────────────────────────────
// Meta often delivers the same webhook event 2-3 times. Track recently
// processed comment/message IDs for 5 minutes to skip duplicates.

const processed = new Map<string, number>();
const DEDUP_TTL_MS = 5 * 60 * 1000;

function is_duplicate(id: string): boolean {
    const now = Date.now();
    // Evict expired entries
    for (const [key, ts] of processed) {
        if (now - ts > DEDUP_TTL_MS) processed.delete(key);
    }
    if (processed.has(id)) return true;
    processed.set(id, now);
    return false;
}

// ─── Public routes (no JWT) ──────────────────────────────────────────────────

export const instagramWebhookPublicRoutes: FastifyPluginAsync = async (app) => {
    app.get("/webhook", async (req: FastifyRequest, res: FastifyReply) => {
        const q = req.query as Record<string, string>;
        if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === config.instagram.verify_token) {
            return res.status(200).send(q["hub.challenge"]);
        }
        return res.status(403).send({ error: "Forbidden" });
    });

    app.post("/webhook", async (req: FastifyRequest, res: FastifyReply) => {
        res.status(200).send("EVENT_RECEIVED");

        try {
            const body = req.body as any;
            if (body?.object !== "instagram") return;

            for (const entry of body.entry ?? []) {
                const ig_account_id: string = entry.id;

                // ── Direct Messages — auto-reply disabled (comment flow only) ──

                // ── Comments ────────────────────────────────────────────────
                for (const change of entry.changes ?? []) {
                    if (change.field !== "comments" || !change.value?.from?.id) continue;

                    const sender_id: string = change.value.from.id;
                    const comment_id: string = change.value.id;
                    const comment_text: string = change.value.text ?? "";
                    const username: string = change.value.from.username ?? sender_id;

                    if (sender_id === ig_account_id) continue; // own reply — skip loop
                    if (is_duplicate(comment_id)) continue;    // Meta duplicate delivery

                    console.log(`[ig] 💬 Comment received  from=@${username}  text="${comment_text}"  comment_id=${comment_id}`);

                    await handle_comment_event(ig_account_id, comment_id, comment_text).catch((err) =>
                        console.error(`[ig] ❌ Comment handler failed:`, err?.response?.data?.error ?? err?.message),
                    );
                }
            }
        } catch (err: any) {
            console.error("[ig] ❌ Webhook error:", err?.response?.data?.error ?? err?.message);
        }
    });
};

// ─── Protected routes (JWT required) ─────────────────────────────────────────

export const instagramWebhookRoutes: FastifyPluginAsync = async (app) => {
    // Debug: inspect account + bot config + token validity
    app.get("/debug/:ig_account_id", async (req: FastifyRequest, res: FastifyReply) => {
        const { ig_account_id } = req.params as any;

        const account = await SocialAccount.findOne({
            where: {
                platform: "instagram",
                [Op.or]: [{ account_id: ig_account_id }, { page_id: ig_account_id }],
            },
        });

        const bot_config = await InstagramBotConfig.findOne({ where: { ig_account_id } });

        let token_check: any = null;
        if (account?.access_token) {
            try {
                const r = await axios.get("https://graph.facebook.com/v20.0/me", {
                    params: { access_token: account.access_token, fields: "id,name" },
                });
                token_check = { valid: true, ...r.data };
            } catch (err: any) {
                token_check = { valid: false, error: err?.response?.data?.error ?? err?.message };
            }
        }

        return res.status(200).send({
            account: account
                ? { id: account.id, account_id: account.account_id, page_id: account.page_id, status: account.status, has_token: !!account.access_token, expires_at: account.expires_at }
                : null,
            bot_config: bot_config
                ? { id: bot_config.id, ig_account_id: bot_config.ig_account_id, reply_text: bot_config.reply_text, buttons: bot_config.buttons, is_active: bot_config.is_active }
                : null,
            token_check,
        });
    });

    // Test: send DM via sender_id
    app.post("/test-dm", async (req: FastifyRequest, res: FastifyReply) => {
        const { ig_account_id, sender_id } = req.body as any;
        if (!ig_account_id || !sender_id) return res.status(400).send({ error: "ig_account_id and sender_id required" });
        try {
            await send_ig_dm(ig_account_id, sender_id);
            return res.status(200).send({ success: true });
        } catch (err: any) {
            return res.status(500).send({ error: err?.response?.data ?? err?.message });
        }
    });

    // Test: send DM via comment_id
    app.post("/test-dm-from-comment", async (req: FastifyRequest, res: FastifyReply) => {
        const { ig_account_id, comment_id } = req.body as any;
        if (!ig_account_id || !comment_id) return res.status(400).send({ error: "ig_account_id and comment_id required" });
        try {
            await send_ig_dm_from_comment(ig_account_id, comment_id);
            return res.status(200).send({ success: true });
        } catch (err: any) {
            return res.status(500).send({ error: err?.response?.data ?? err?.message });
        }
    });

    // List all bot configs
    app.get("/bot-configs", async (_req: FastifyRequest, res: FastifyReply) => {
        const configs = await InstagramBotConfig.findAll({ order: [["createdAt", "DESC"]] });
        return res.status(200).send({ success: true, data: configs });
    });

    // Create bot config
    app.post("/bot-config", async (req: FastifyRequest, res: FastifyReply) => {
        const { ig_account_id, reply_text, buttons, is_active } = req.body as any;
        if (!ig_account_id) return res.status(400).send({ error: "ig_account_id is required" });

        const existing = await InstagramBotConfig.findOne({ where: { ig_account_id } });
        if (existing) return res.status(409).send({ error: "Bot config already exists — use PUT /bot-config/:id to update" });

        const account = await SocialAccount.findOne({
            where: { platform: "instagram", [Op.or]: [{ account_id: ig_account_id }, { page_id: ig_account_id }] },
        });
        if (!account) console.warn(`[ig] ⚠️  Bot config created but no SocialAccount found for ${ig_account_id}`);

        const bot_config = await InstagramBotConfig.create({
            ig_account_id,
            reply_text: reply_text ?? "Thanks for contacting us 👇",
            buttons: buttons ?? [],
            is_active: is_active ?? true,
        } as any);

        return res.status(201).send({ success: true, data: bot_config });
    });

    // Update bot config
    app.put("/bot-config/:id", async (req: FastifyRequest, res: FastifyReply) => {
        const { id } = req.params as any;
        const { ig_account_id, reply_text, buttons, is_active } = req.body as any;

        const bot_config = await InstagramBotConfig.findByPk(id);
        if (!bot_config) return res.status(404).send({ error: "Bot config not found" });

        await bot_config.update({
            ...(ig_account_id !== undefined && { ig_account_id }),
            ...(reply_text !== undefined && { reply_text }),
            ...(buttons !== undefined && { buttons }),
            ...(is_active !== undefined && { is_active }),
        });

        return res.status(200).send({ success: true, data: bot_config });
    });

    // Delete bot config
    app.delete("/bot-config/:id", async (req: FastifyRequest, res: FastifyReply) => {
        const { id } = req.params as any;
        const bot_config = await InstagramBotConfig.findByPk(id);
        if (!bot_config) return res.status(404).send({ error: "Bot config not found" });
        await bot_config.destroy();
        return res.status(200).send({ success: true });
    });
};
