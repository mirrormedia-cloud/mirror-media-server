import { loadDotEnv } from "../env";
loadDotEnv();

const logDir = `${process.cwd()}/logs`;

const prodConfig = {
  app: {
    name: "backend",
    env: "prod",
    port: Number(process.env.PORT) || 3002,
    timezone: process.env.TIMEZONE || "Asia/Kolkata",
  },

  database: {
    host: process.env.PROD_DATABASE_HOST || "",
    port: Number(process.env.PROD_DATABASE_PORT || "5432"),
    user: process.env.PROD_DATABASE_USER || "postgres",
    password: process.env.PROD_DATABASE_PASSWORD || "postgres",
    name: process.env.PROD_DATABASE_NAME || "",
    ssl: true,
  },

  logging: {
    captureErrors: true,
    captureSuccess: true,
    dir: logDir,
    exportDir: `${process.cwd()}/exports`,
  },

  security: {
    jwtSecret: process.env.JWT_SECRET || "jwt",
    bcryptSaltRounds: Number(process.env.BCRYPT_ROUNDS) || 10,
    encryptionKey: process.env.ENCRYPTION_KEY || "",
  },

  file: {
    access_url: process.env.FILE_ACCESS_URL || `http://localhost:${process.env.PORT}`,
  },

  ffmpeg: {
    path: process.env.FFMPEG_PATH ?? "",
  },

  r2: {
    account_id: process.env.R2_ACCOUNT_ID ?? "",
    access_key_id: process.env.R2_ACCESS_KEY_ID ?? "",
    secret_access_key: process.env.R2_SECRET_ACCESS_KEY ?? "",
    bucket_name: process.env.R2_BUCKET_NAME ?? "",
    endpoint: process.env.R2_ENDPOINT ?? "",
    public_base_url: process.env.R2_PUBLIC_BASE_URL ?? "",
    region: process.env.R2_REGION ?? "auto",
  },

  whatsapp: {
    access_token: process.env.WHATSAPP_ACCESS_TOKEN ?? "",
    phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    verify_token: process.env.WHATSAPP_VERIFY_TOKEN ?? "",
    api_version: process.env.WHATSAPP_API_VERSION ?? "v25.0",
  },
  // Firebase Admin creds are loaded from `backend/firebase-service-account.json`.
};

export default prodConfig;
