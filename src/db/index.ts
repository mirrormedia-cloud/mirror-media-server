import "reflect-metadata";
import { Sequelize } from "sequelize-typescript";
import { config } from "../config";

import {
  User, Session, AuthenticationOtp, UserSetting, SsoVerificationDetail, UserProfile, RegistrationDetail, OtpRateLimit,
  OttPlatform, OttApiNode, OttApiResponse, OttSelectedField, OttApiLog, OttChildApiItemResponse, OttCardAction, OttVideoAsset, OttLibraryItem,
  CalendarEvent, UploadScheduleBatch, UploadScheduleItem,
  SocialAccount, SocialUpload, MediaAnalysisResult,
  NotificationHistory, CalendarEventReminder, UserNotificationSettings,
} from "./models";

export const sequelize = new Sequelize({
  host: config.database.host,
  port: config.database.port || 5432,
  username: config.database.user,
  password: config.database.password,
  database: config.database.name,
  dialect: "postgres",
  dialectOptions: {
    ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
  },
  logging: false,
  models: [
    User,
    Session,
    AuthenticationOtp,
    UserSetting,
    SsoVerificationDetail,
    UserProfile,
    RegistrationDetail,
    OtpRateLimit,
    OttPlatform,
    OttApiNode,
    OttApiResponse,
    OttSelectedField,
    OttApiLog,
    OttChildApiItemResponse,
    OttCardAction,
    OttVideoAsset,
    OttLibraryItem,
    CalendarEvent,
    UploadScheduleBatch,
    UploadScheduleItem,
    SocialAccount,
    SocialUpload,
    MediaAnalysisResult,
    NotificationHistory,
    CalendarEventReminder,
    UserNotificationSettings,
  ],
});

export async function initDb() {
  const { host, port, user, name, ssl } = config.database;
  console.log(`🔌 DB config → host=${host} port=${port} user=${user} db=${name} ssl=${ssl}`);
  try {
    await sequelize.authenticate();
    console.log("✅ Database connected successfully");
    await sequelize.sync({ alter: true });
    console.log("✅ Database synced successfully");
    await ensureDefaultUserAndBackfill();
  } catch (err: any) {
    console.error("❌ Database connection failed");
    console.error("   message:", err?.message ?? err);
    console.error("   code   :", err?.parent?.code ?? err?.code ?? "—");
    process.exit(1);
  }
}

/**
 * Idempotent seed for the default user (ud@gmail.com / ud@123) and one-shot
 * backfill of every OTT-table's user_id. Safe to run on every boot:
 *   - Creates the user only if it doesn't exist (looks up by email).
 *   - Marks email_verified + is_active so the JWT `authenticate` middleware
 *     accepts it (the middleware rejects unverified/inactive users).
 *   - Backfills user_id on legacy rows (before this column existed) by setting
 *     them all to the default user. Uses raw SQL UPDATE since Sequelize models
 *     can't bulk-update across tables in one call.
 */
async function ensureDefaultUserAndBackfill() {
  // Lazy imports to avoid circulars during module init.
  const { User } = await import("./models");
  const { hashPassword } = await import("../shared/security/password");

  const DEFAULT_EMAIL = "mirror.mediacloud@gmail.com";
  const DEFAULT_PASSWORD = "MirrorMedia@309";
  const DEFAULT_USERNAME = "mirrormedia.cloud";

  let user = await User.findOne({ where: { email: DEFAULT_EMAIL } });
  if (!user) {
    const password_hash = await hashPassword(DEFAULT_PASSWORD);
    user = await User.create({
      email: DEFAULT_EMAIL,
      username: DEFAULT_USERNAME,
      password_hash,
      // Auto-verify + activate so the user is usable immediately. Without
      // these flags the authenticate middleware would reject every request
      // even with a valid JWT.
      email_verified: true,
      is_active: true,
      register_type: "manually",
    } as any);
    console.log("✅ Default user created:", DEFAULT_EMAIL);
  } else {
    // If the user existed but isn't verified/active (e.g. created earlier
    // through another flow), force-correct the flags so login works.
    let needs_update = false;
    if (!(user as any).email_verified) { (user as any).email_verified = true; needs_update = true; }
    if (!(user as any).is_active) { (user as any).is_active = true; needs_update = true; }
    if (needs_update) await user.save();
  }

  const default_user_id = user.id;

  // One UPDATE per OTT table. Each only touches rows where user_id IS NULL,
  // so this is idempotent and cheap on subsequent boots.
  const ott_tables = [
    "ott_platforms",
    "ott_api_nodes",
    "ott_api_responses",
    "ott_selected_fields",
    "ott_api_logs",
    "ott_child_api_item_responses",
    "ott_card_actions",
    "ott_video_assets",
    "ott_library_items",
  ];
  let total_backfilled = 0;
  for (const table of ott_tables) {
    try {
      const [, meta] = await sequelize.query(
        `UPDATE "${table}" SET "user_id" = :uid WHERE "user_id" IS NULL`,
        { replacements: { uid: default_user_id } },
      );
      const affected = (meta as any)?.rowCount ?? 0;
      if (affected > 0) {
        total_backfilled += affected;
        console.log(`   backfilled ${affected} rows in ${table}`);
      }
    } catch (err: any) {
      // Table might not exist yet (e.g. first boot before sync added the
      // column on an empty table) — non-fatal.
      console.log(`   skip backfill ${table}: ${err?.message ?? "?"}`);
    }
  }
  if (total_backfilled > 0) {
    console.log(`✅ Backfilled ${total_backfilled} legacy rows to default user`);
  }

  // ──────────────────────────────────────────────────────────────
  // R2 migration cleanup (one-shot, idempotent).
  //
  // Step 1: copy any leftover google_drive_direct_url into file_url
  // so existing rows survive the column drop below. Without this,
  // rows that were only addressable via the old Drive URL would
  // become unreachable from the frontend.
  //
  // Step 2: ALTER TABLE DROP COLUMN IF EXISTS for every Drive / HLS
  // / status / local-path column. Sequelize's `sync({alter:true})`
  // intentionally never drops columns — these statements do the job
  // on first boot and become no-ops on subsequent boots.
  //
  // Each statement is wrapped in its own try/catch so a column that
  // never existed (fresh DB) doesn't abort the boot.
  // ──────────────────────────────────────────────────────────────
  try {
    const [, backfill_meta] = await sequelize.query(
      `UPDATE "ott_library_items"
         SET "file_url" = COALESCE("file_url", "google_drive_direct_url"),
             "file_type" = COALESCE("file_type",
                CASE
                    WHEN "save_type" = 'video' THEN 'video'
                    WHEN "save_type" = 'image' THEN 'image'
                    WHEN "save_type" = 'thumbnail' THEN 'thumbnail'
                    WHEN "save_type" = 'playlist' THEN 'playlist'
                    ELSE NULL
                END)
       WHERE "file_url" IS NULL AND "google_drive_direct_url" IS NOT NULL`,
    );
    const affected = (backfill_meta as any)?.rowCount ?? 0;
    if (affected > 0) {
      console.log(`✅ R2 backfill: copied google_drive_direct_url → file_url on ${affected} rows`);
    }
  } catch (err: any) {
    console.log(`   skip R2 backfill: ${err?.message ?? "?"}`);
  }

  const drop_columns = [
    // Drive identifiers / URLs.
    "google_drive_file_id",
    "google_drive_folder_id",
    "google_drive_web_view_link",
    "google_drive_web_content_link",
    "google_drive_direct_url",
    "google_drive_mime_type",
    "google_drive_thumbnail_file_id",
    "google_drive_thumbnail_direct_url",
    "google_drive_image_file_id",
    "google_drive_image_direct_url",
    // HLS bookkeeping (feature removed entirely).
    "hls_status",
    "hls_error_message",
    "hls_failure_count",
    "hls_local_folder_path",
    "hls_local_playlist_path",
    "hls_drive_folder_id",
    "hls_drive_playlist_file_id",
    "hls_drive_playlist_url",
    "hls_drive_master_playlist_url",
    "hls_segments",
    "hls_segment_count",
    "hls_generated_at",
    "hls_uploaded_at",
    "hls_locked_at",
    "hls_locked_by",
    // Status / queue machinery (replaced by "row exists = success").
    "status",
    "progress",
    "error_message",
    "failure_count",
    "failure_stage",
    "retry_count",
    "locked_at",
    "locked_by",
    "processing_started_at",
    "processing_completed_at",
    "temp_folder_path",
    "temp_file_path",
    // Local-disk staging paths — R2 is the only storage now.
    "local_video_path",
    "local_image_path",
    "local_thumbnail_path",
    "local_playlist_path",
    // Storage selector — R2-only now.
    "storage_provider",
  ];

  let dropped = 0;
  for (const col of drop_columns) {
    try {
      await sequelize.query(
        `ALTER TABLE "ott_library_items" DROP COLUMN IF EXISTS "${col}"`,
      );
      dropped += 1;
    } catch (err: any) {
      console.log(`   skip drop ${col}: ${err?.message ?? "?"}`);
    }
  }
  if (dropped > 0) {
    console.log(`✅ Cleaned ${dropped} legacy column(s) from ott_library_items`);
  }

  // ──────────────────────────────────────────────────────────────
  // Drive removal (one-shot, idempotent).
  //
  //   - The `ott_drive_folders` table tracked per-OTT Drive folder ids
  //     and is no longer populated; drop it entirely.
  //   - `social_uploads.google_drive_file_id` was the per-upload
  //     pointer at the Drive source bytes; social uploads now stream
  //     from R2 `file_url`, so the column is dead.
  // ──────────────────────────────────────────────────────────────
  try {
    await sequelize.query(`DROP TABLE IF EXISTS "ott_drive_folders"`);
    console.log("✅ Dropped legacy table ott_drive_folders");
  } catch (err: any) {
    console.log(`   skip drop ott_drive_folders: ${err?.message ?? "?"}`);
  }
  try {
    await sequelize.query(
      `ALTER TABLE "social_uploads" DROP COLUMN IF EXISTS "google_drive_file_id"`,
    );
    console.log("✅ Dropped legacy column social_uploads.google_drive_file_id");
  } catch (err: any) {
    console.log(`   skip drop social_uploads.google_drive_file_id: ${err?.message ?? "?"}`);
  }
}

export async function closeDb() {
  await sequelize.close();
  console.log("🛑 Database connection closed");
}
