import { z } from "zod";

export const AppEnvSchema = z.enum(["local", "prod"]);

export const ConfigSchema = z.object({
  app: z.object({
    name: z.string().min(1),
    env: AppEnvSchema,
    port: z.number().int().positive(),
    timezone: z.string().min(1).default("Asia/Kolkata"),
  }),

  database: z.object({
    host: z.string(),
    port: z.number(),
    user: z.string(),
    password: z.string(),
    name: z.string(),
    ssl: z.boolean(),
  }),

  logging: z.object({
    captureErrors: z.boolean(),
    captureSuccess: z.boolean().default(false),
    logDbErrors: z.boolean().default(false),
    dir: z.string().min(1),
    exportDir: z.string().optional(),
  }),

  security: z.object({
    jwtSecret: z.string().min(1),
    bcryptSaltRounds: z.number().int().min(4).max(20),
    encryptionKey: z.string().min(16),
  }),

  file: z.object({
    access_url: z.string().min(1),
  }),

  ffmpeg: z.object({
    /** Absolute path to the ffmpeg binary. When empty, the spawn falls back to "ffmpeg" on PATH. */
    path: z.string().default(""),
  }),

  r2: z.object({
    account_id: z.string().default(""),
    access_key_id: z.string().default(""),
    secret_access_key: z.string().default(""),
    bucket_name: z.string().default(""),
    endpoint: z.string().default(""),
    public_base_url: z.string().default(""),
    region: z.string().default("auto"),
  }).default({}),

  whatsapp: z.object({
    /** Long-lived Cloud API access token (Bearer). Generated from Meta App
     *  Dashboard → WhatsApp → API Setup. Empty means the sender is disabled. */
    access_token: z.string().default(""),
    /** Numeric Phone Number ID from the same screen — NOT the phone number. */
    phone_number_id: z.string().default(""),
    /** Webhook verification token. Must match the value entered in
     *  Meta App Dashboard → WhatsApp → Configuration → Verify token. */
    verify_token: z.string().default(""),
    /** Graph API version used in the messages URL. Bump when Meta deprecates. */
    api_version: z.string().default("v25.0"),
  }).default({}),
});

export type AppEnv = z.infer<typeof AppEnvSchema>;
export type AppConfig = z.infer<typeof ConfigSchema>;
