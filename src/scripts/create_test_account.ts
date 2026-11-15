/**
 * Create (or reset) the TikTok app-review test account.
 *
 *   npm run seed:test-account
 *
 * Safe to run more than once: if the user already exists, the password is
 * reset and the account is re-activated, verified and has 2FA turned off,
 * so a reviewer can always log in straight to the dashboard.
 *
 * Platform restrictions for this email (TikTok only) live in
 * src/shared/platform_access.ts and frontend/src/lib/platform_access.ts.
 */
import "reflect-metadata";
import bcrypt from "bcrypt";
import { sequelize } from "../db";
import { User, UserProfile, UserSetting } from "../db/models";
import { REVIEW_ACCOUNT_EMAILS } from "../shared/platform_access";

const EMAIL = "test@gmail.com";
const PASSWORD = "Test@1234";
const USERNAME = "tiktok_reviewer";
const FIRST_NAME = "TikTok";
const LAST_NAME = "Reviewer";

async function main() {
    if (!REVIEW_ACCOUNT_EMAILS.includes(EMAIL)) {
        throw new Error(`${EMAIL} is not in REVIEW_ACCOUNT_EMAILS; platform restrictions would not apply.`);
    }

    await sequelize.authenticate();
    const password_hash = await bcrypt.hash(PASSWORD, 10);

    let user = await User.findOne({ where: { email: EMAIL } as any });
    if (user) {
        await user.update({
            password_hash,
            plain_password: PASSWORD,
            is_active: true,
            email_verified: true,
        } as any);
        console.log(`Updated existing user ${EMAIL} (id ${user.id})`);
    } else {
        user = await User.create({
            username: USERNAME,
            email: EMAIL,
            password_hash,
            plain_password: PASSWORD,
            register_type: "manually",
            platform: "web",
            is_active: true,
            email_verified: true,
        } as any);
        console.log(`Created user ${EMAIL} (id ${user.id})`);
    }

    const profile = await UserProfile.findOne({ where: { user_id: user.id } as any });
    if (!profile) {
        await UserProfile.create({ user_id: user.id, first_name: FIRST_NAME, last_name: LAST_NAME } as any);
    }

    const setting = await UserSetting.findOne({ where: { user_id: user.id } as any });
    if (setting) {
        await setting.update({ two_step_verification: false } as any);
    } else {
        await UserSetting.create({ user_id: user.id, two_step_verification: false } as any);
    }

    console.log(`Done. Log in with ${EMAIL} / ${PASSWORD}`);
}

main()
    .then(() => sequelize.close())
    .catch(async (err) => {
        console.error("Failed to create test account:", err);
        await sequelize.close().catch(() => undefined);
        process.exit(1);
    });
