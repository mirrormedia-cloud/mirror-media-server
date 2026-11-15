/**
 * Platform-review account restrictions (server side).
 *
 * The TikTok app-review test account may only connect TikTok. Requests
 * from these emails to connect YouTube / Facebook / Instagram are refused.
 *
 * Frontend counterpart: frontend/src/lib/platform_access.ts — keep the
 * email list in sync.
 */
import { User } from "../db/models";

export const REVIEW_ACCOUNT_EMAILS = ["test@gmail.com"];
export const REVIEW_HIDDEN_PLATFORMS = ["youtube", "facebook", "instagram"];

export function is_review_account(email: string | null | undefined): boolean {
    return !!email && REVIEW_ACCOUNT_EMAILS.includes(email.trim().toLowerCase());
}

/** True when this user may use the given platform. */
export async function is_platform_allowed_for_user(user_id: string, platform: string): Promise<boolean> {
    if (!REVIEW_HIDDEN_PLATFORMS.includes(platform)) return true;
    const user = await User.findOne({ where: { id: user_id } as any, attributes: ["email"], raw: true });
    return !is_review_account(user?.email);
}
