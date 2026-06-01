import local from "./local";
import prod from "./prod";
import { AppConfig, ConfigSchema } from "../schema";

type AppEnv = "local" | "prod";
const env = (process.env.APP_ENV || process.env.NODE_ENV || "local") as AppEnv;

const configs: Record<AppEnv, unknown> = { local, prod };
const env_config: AppConfig = ConfigSchema.parse(configs[env]);

if (!env_config) {
  throw new Error(`Invalid APP_ENV / NODE_ENV value: ${env}`);
}

export default env_config;
