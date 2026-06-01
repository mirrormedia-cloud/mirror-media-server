import type { AppConfig } from "./schema";
import { loadConfig } from "./loadConfig";

let cachedConfig: AppConfig | null = null;

export const config: AppConfig = (() => {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
})();
