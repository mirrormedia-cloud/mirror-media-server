import path from "path";
import fs from "fs";
import { UPLOAD_BASE } from "../upload/upload";
import { ensure_default_library_folders } from "../../modules/library_browser/local_uploads_crud.service";

export async function ensureUserFolders(userId: string): Promise<void> {
    const userDir = path.join(UPLOAD_BASE, "users", userId);
    const mediaDir = path.join(userDir, "media");
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
    await ensure_default_library_folders(userId);
}
