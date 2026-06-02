import path from "path";
import fs from "fs";

const UPLOAD_BASE = path.join(process.cwd(), "public");

export function ensureUserFolders(userId: string): void {
    const userDir = path.join(UPLOAD_BASE, "users", userId);
    const mediaDir = path.join(userDir, "media");
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
}
