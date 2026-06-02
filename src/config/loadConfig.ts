import { ConfigSchema, type AppConfig, type AppEnv } from "./schema";
import { loadDotEnv } from "./env";

// environment configs
import local from "./environments/local";
import prod from "./environments/prod";

export function loadConfig(): AppConfig {
  loadDotEnv();

  const env = (process.env.APP_ENV || "local") as AppEnv;
  const configs: Record<AppEnv, unknown> = { local, prod };

  const baseConfig = configs[env];

  if (!baseConfig) {
    throw new Error(`Invalid SERVER_MODE value: ${env}`);
  }

  const mergedConfig = { ...baseConfig };
  const parsed = ConfigSchema.parse(mergedConfig);

  return Object.freeze(parsed);
}
