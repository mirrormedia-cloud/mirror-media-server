/**
 * TikTok app-review test account — create or reset.
 *
 * Used by:
 *   - npm run seed:test-account            (src/scripts/create_test_account.ts)
 *   - GET /api/auth/seed-test-account?key=  (src/modules/auth/routes.ts)
 *
 * Idempotent: an existing user gets its password reset and is re-activated,
 * verified and has 2FA turned off, so a reviewer always lands on the dashboard.
 */
import bcrypt from "bcrypt";
import { User, UserProfile, UserSetting } from "../db/models";
import { REVIEW_ACCOUNT_EMAILS } from "./platform_access";

export const TEST_ACCOUNT = {
    email: "test@gmail.com",
    password: "Test@1234",
    username: "tiktok_reviewer",
    first_name: "TikTok",
    last_name: "Reviewer",
};

export async function ensure_test_account(): Promise<{ action: "created" | "updated"; user_id: string; email: string }> {
    const { email, password, username, first_name, last_name } = TEST_ACCOUNT;
    if (!REVIEW_ACCOUNT_EMAILS.includes(email)) {
        throw new Error(`${email} is not in REVIEW_ACCOUNT_EMAILS; platform restrictions would not apply.`);
    }

    const password_hash = await bcrypt.hash(password, 10);
    let action: "created" | "updated";

    let user = await User.findOne({ where: { email } as any });
    if (user) {
        await user.update({ password_hash, plain_password: password, is_active: true, email_verified: true } as any);
        action = "updated";
    } else {
        user = await User.create({
            username,
            email,
            password_hash,
            plain_password: password,
            register_type: "manually",
            platform: "web",
            is_active: true,
            email_verified: true,
        } as any);
        action = "created";
    }

    if (!(await UserProfile.findOne({ where: { user_id: user.id } as any }))) {
        await UserProfile.create({ user_id: user.id, first_name, last_name } as any);
    }

    const setting = await UserSetting.findOne({ where: { user_id: user.id } as any });
    if (setting) await setting.update({ two_step_verification: false } as any);
    else await UserSetting.create({ user_id: user.id, two_step_verification: false } as any);

    return { action, user_id: String(user.id), email };
}
