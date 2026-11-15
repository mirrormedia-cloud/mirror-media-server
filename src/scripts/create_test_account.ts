/**
 * Create (or reset) the TikTok app-review test account.
 *
 *   npm run seed:test-account
 *
 * Same logic is exposed over HTTP at GET /api/auth/seed-test-account?key=<SEED_SECRET>.
 * See src/shared/test_account.ts.
 */
import "reflect-metadata";
import { sequelize } from "../db";
import { ensure_test_account, TEST_ACCOUNT } from "../shared/test_account";

async function main() {
    await sequelize.authenticate();
    const result = await ensure_test_account();
    console.log(`${result.action === "created" ? "Created" : "Updated"} user ${result.email} (id ${result.user_id})`);
    console.log(`Done. Log in with ${TEST_ACCOUNT.email} / ${TEST_ACCOUNT.password}`);
}

main()
    .then(() => sequelize.close())
    .catch(async (err) => {
        console.error("Failed to create test account:", err);
        await sequelize.close().catch(() => undefined);
        process.exit(1);
    });
