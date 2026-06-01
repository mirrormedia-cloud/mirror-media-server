/**
 * Compatibility shim — the implementation moved to
 * `src/services/media_analysis/`. This file is kept only as a
 * re-export of the `AnalysisPlatform` type so existing call-sites
 * keep compiling without touching their imports.
 *
 * Prefer importing from `services/media_analysis/*` in new code.
 *
 * The pre-R2 `analyze_media(drive_file_id)` entry point was removed
 * with the Drive cleanup — the only live entry point now is
 * `analyze_library_item_media` in media_to_details.service.ts, which
 * streams from the library row's `file_url`.
 */

import { MediaPlatform } from "../media_analysis/media_analysis.types";

// Legacy alias — keeps existing imports working.
export type AnalysisPlatform = MediaPlatform;
