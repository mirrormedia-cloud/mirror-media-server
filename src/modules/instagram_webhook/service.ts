import axios from "axios";
import { Op } from "sequelize";
import { SocialAccount } from "../../db/models/social/social_account";
import { InstagramBotConfig } from "../../db/models/instagram/instagram_bot_config";
import { find_matching_rule } from "../automation/automation.service";

const GRAPH_BASE = "https://graph.facebook.com/v20.0";

async function find_ig_account(ig_account_id: string): Promise<SocialAccount | null> {
    const account = await SocialAccount.findOne({
        where: {
            platform: "instagram",
            [Op.or]: [{ account_id: ig_account_id }, { page_id: ig_account_id }],
        },
    });
    if (!account) {
        console.warn(`[ig] ⚠️  No connected Instagram account for id=${ig_account_id}`);
        return null;
    }
    return account;
}

async function handle_token_error(err: any, ig_account_id: string): Promise<void> {
    const meta_error = err?.response?.data?.error;
    if (meta_error?.code === 190) {
        console.error(`[ig] ❌ Token expired for ${ig_account_id} — marking account as expired`);
        await SocialAccount.update(
            { status: "expired" },
            { where: { platform: "instagram", [Op.or]: [{ account_id: ig_account_id }, { page_id: ig_account_id }] } },
        );
    } else {
        console.error(`[ig] ❌ Graph API error:`, meta_error ?? err?.message);
    }
}

/**
 * Build an Instagram message payload.
 * - With buttons → button template (renders as tappable cards in the DM).
 * - Without buttons → plain text message.
 * Meta allows max 3 buttons per template.
 */
function build_message_payload(
    text: string,
    buttons: Array<{ title: string; url?: string }> = [],
): any {
    if (buttons.length > 0) {
        return {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text,
                    buttons: buttons.slice(0, 3).map((btn) => ({
                        type: "web_url",
                        url: btn.url ?? "",
                        title: btn.title,
                    })),
                },
            },
        };
    }
    return { text };
}

async function build_dm_message(ig_account_id: string): Promise<{ message: any; account: SocialAccount } | null> {
    const account = await find_ig_account(ig_account_id);
    if (!account?.access_token) return null;

    const bot_config = await InstagramBotConfig.findOne({ where: { ig_account_id, is_active: true } });
    if (!bot_config) {
        console.warn(`[ig] ⚠️  No active bot config for ${ig_account_id}`);
        return null;
    }

    const reply_text = bot_config.reply_text ?? "Thanks for contacting us 👇";
    const raw_buttons = bot_config.buttons ?? [];
    const message = build_message_payload(reply_text, raw_buttons);
    return { message, account };
}

export async function reply_to_comment(ig_account_id: string, comment_id: string, text: string): Promise<void> {
    const account = await find_ig_account(ig_account_id);
    if (!account?.access_token) return;

    console.log(`[ig]   ↳ Replying to comment: "${text}"`);
    try {
        await axios.post(
            `${GRAPH_BASE}/${comment_id}/replies`,
            { message: text },
            { params: { access_token: account.access_token } },
        );
        console.log(`[ig]   ✅ Comment reply sent`);
    } catch (err: any) {
        await handle_token_error(err, ig_account_id);
        throw err;
    }
}

export async function send_ig_dm(ig_account_id: string, sender_id: string): Promise<void> {
    const result = await build_dm_message(ig_account_id);
    if (!result) return;

    const endpoint_id = result.account.page_id ?? ig_account_id;
    console.log(`[ig]   ↳ Sending DM to sender=${sender_id} via page=${endpoint_id}`);
    try {
        await axios.post(
            `${GRAPH_BASE}/${endpoint_id}/messages`,
            { recipient: { id: sender_id }, message: result.message },
            { params: { access_token: result.account.access_token } },
        );
        console.log(`[ig]   ✅ DM sent`);
    } catch (err: any) {
        await handle_token_error(err, ig_account_id);
        throw err;
    }
}

export async function send_ig_dm_from_comment(
    ig_account_id: string,
    comment_id: string,
    override_message?: any,
): Promise<void> {
    let message: any;
    let account: SocialAccount | null;

    if (override_message !== undefined) {
        account = await find_ig_account(ig_account_id);
        if (!account?.access_token) return;
        message = override_message;
    } else {
        const result = await build_dm_message(ig_account_id);
        if (!result) return;
        account = result.account;
        message = result.message;
    }

    const endpoint_id = account.page_id ?? ig_account_id;
    console.log(`[ig]   ↳ Sending DM via comment_id=${comment_id} via page=${endpoint_id}`);
    try {
        await axios.post(
            `${GRAPH_BASE}/${endpoint_id}/messages`,
            { recipient: { comment_id }, message },
            { params: { access_token: account.access_token } },
        );
        console.log(`[ig]   ✅ DM sent`);
    } catch (err: any) {
        await handle_token_error(err, ig_account_id);
        throw err;
    }
}

export async function handle_comment_event(
    ig_account_id: string,
    comment_id: string,
    comment_text: string,
): Promise<void> {
    const rule = await find_matching_rule(ig_account_id, comment_text);

    if (rule) {
        const reply_text = rule.comment_reply?.text ?? "Check your DM 📩";
        const dm = rule.dm_message ?? { text: "", buttons: [] };

        const dm_payload = build_message_payload(dm.text, dm.buttons ?? []);
        console.log(`[ig]   ↳ Automation rule matched: "${rule.trigger_keywords?.join(", ")}"`);

        await reply_to_comment(ig_account_id, comment_id, reply_text).catch((err: any) => {
            const code = err?.response?.data?.error?.code;
            if (code === 190) throw err;
            if (code === 100) console.warn(`[ig]   ⚠️  Comment reply needs instagram_manage_comments (App Review)`);
            else console.error(`[ig]   ⚠️  Comment reply failed (non-fatal):`, err?.response?.data?.error ?? err?.message);
        });

        await send_ig_dm_from_comment(ig_account_id, comment_id, dm_payload);
    } else {
        // Fallback: use legacy InstagramBotConfig (always-on, no keyword filter)
        await reply_to_comment(ig_account_id, comment_id, "Check your DM 📩").catch((err: any) => {
            const code = err?.response?.data?.error?.code;
            if (code === 190) throw err;
            if (code === 100) console.warn(`[ig]   ⚠️  Comment reply needs instagram_manage_comments (App Review)`);
            else console.error(`[ig]   ⚠️  Comment reply failed (non-fatal):`, err?.response?.data?.error ?? err?.message);
        });
        await send_ig_dm_from_comment(ig_account_id, comment_id);
    }
}
