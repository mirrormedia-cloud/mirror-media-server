import fs from "fs";
import path from "path";
import { FastifyRequest } from "fastify";
import { User, UserProfile, Session, UserSetting } from "../../db/models";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import { is_r2_configured, upload_buffer_to_r2, generate_upload_signed_url, get_public_url, generate_read_signed_url } from "../../services/storage/r2_storage.service";

// Derive local file path from a stored URL
// e.g. "http://localhost:3002/uploads/profile_pics/image_xxx.jpg"
//   →  "<cwd>/public/profile_pics/image_xxx.jpg"
function urlToLocalPath(url: string): string | null {
    try {
        const parsed = new URL(url);
        // pathname = "/uploads/profile_pics/image_xxx.jpg"
        // strip the "/uploads/" prefix to get the relative key
        const key = parsed.pathname.replace(/^\/uploads\//, "");
        return path.join(process.cwd(), "public", key);
    } catch {
        return null;
    }
}

function deleteFileIfExists(filePath: string | null) {
    if (!filePath) return;
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { }
}

// ── GET /profile ──────────────────────────────────────────────────────────────

export async function getProfile(req: FastifyRequest) {
    try {
        const user = await User.findOne({
            //@ts-ignore
            where: { id: req.userId },
            raw: true,
        });
        if (!user) return error(HttpStatus.NOT_FOUND, "User not found");

        const profile = await UserProfile.findOne({
            //@ts-ignore
            where: { user_id: req.userId },
            raw: true,
        });

        const settings = await UserSetting.findOne({
            //@ts-ignore
            where: { user_id: req.userId },
            raw: true,
        });

        return success("Profile fetched", {
            id: user.id,
            username: user.username,
            email: user.email,
            register_type: user.register_type,
            first_name: profile?.first_name || "",
            last_name: profile?.last_name || "",
            profile_picture: profile?.profile_picture || null,
            gender: profile?.gender || null,
            dob: profile?.dob || null,
            mobile_country_code: (profile as any)?.mobile_country_code || null,
            mobile_no: (profile as any)?.mobile_no || null,
            whatsapp_country_code: (profile as any)?.whatsapp_country_code || null,
            whatsapp_no: (profile as any)?.whatsapp_no || null,
            two_step_verification: settings?.two_step_verification ?? false,
            preferences: settings?.preferences ?? {},
        });
    } catch (err) {
        console.log("Error:- getProfile", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

// ── PATCH /profile/preferences ───────────────────────────────────────────────
// Free-form per-user UI preferences. Caller sends a partial object that gets
// merged into the existing JSONB blob, so adding a new key in the frontend
// doesn't require touching this handler. Auto-creates the user_settings row
// if a legacy user is missing one.
export async function updatePreferences(req: FastifyRequest) {
    try {
        const patch = (req.body ?? {}) as Record<string, any>;
        if (typeof patch !== "object" || Array.isArray(patch)) {
            return error(HttpStatus.BAD_REQUEST, "preferences must be an object");
        }

        let settings = await UserSetting.findOne({ where: { user_id: req.userId } as any });
        if (!settings) {
            settings = await UserSetting.create({
                user_id: req.userId,
                preferences: patch,
            } as any);
        } else {
            const merged = { ...(settings.preferences ?? {}), ...patch };
            await settings.update({ preferences: merged });
            settings = await UserSetting.findOne({ where: { user_id: req.userId } as any });
        }

        return success("Preferences updated", {
            preferences: settings?.preferences ?? {},
        });
    } catch (err) {
        console.log("Error:- updatePreferences", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

// ── PATCH /profile ────────────────────────────────────────────────────────────

export async function updateProfile(req: FastifyRequest) {
    try {
        const { first_name, last_name, username, gender, dob, mobile_country_code, mobile_no, whatsapp_country_code, whatsapp_no } = req.body as {
            first_name?: string;
            last_name?: string;
            username?: string;
            gender?: string;
            dob?: string;
            mobile_country_code?: string | null;
            mobile_no?: string | null;
            whatsapp_country_code?: string | null;
            whatsapp_no?: string | null;
        };

        if (username) {
            const existing = await User.findOne({ where: { username }, raw: true });
            if (existing && existing.id !== req.userId) {
                return error(HttpStatus.CONFLICT, "Username already taken");
            }
            //@ts-ignore
            await User.update({ username }, { where: { id: req.userId } });
        }

        const profileUpdates: Record<string, any> = {};
        if (first_name !== undefined) profileUpdates.first_name = first_name;
        if (last_name !== undefined) profileUpdates.last_name = last_name;
        if (gender !== undefined) profileUpdates.gender = gender;
        if (dob !== undefined) profileUpdates.dob = dob;
        if (mobile_country_code !== undefined) profileUpdates.mobile_country_code = mobile_country_code;
        if (mobile_no !== undefined) profileUpdates.mobile_no = mobile_no;
        if (whatsapp_country_code !== undefined) profileUpdates.whatsapp_country_code = whatsapp_country_code;
        if (whatsapp_no !== undefined) profileUpdates.whatsapp_no = whatsapp_no;

        if (Object.keys(profileUpdates).length > 0) {
            //@ts-ignore
            const existing = await UserProfile.findOne({ where: { user_id: req.userId } });
            if (existing) {
                await existing.update(profileUpdates);
            } else {
                await UserProfile.create({ user_id: req.userId, ...profileUpdates } as any);
            }
        }

        return success("Profile updated");
    } catch (err) {
        console.log("Error:- updateProfile", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

// ── POST /logout ──────────────────────────────────────────────────────────────

export async function logout(req: FastifyRequest) {
    try {
        const token = req.headers.authorization?.replace("Bearer ", "");
        if (token) {
            // Mark only THIS session inactive — other browsers/devices stay
            // logged in. Clearing fcm_token here so a logged-out device can't
            // keep receiving pushes; the next login will register a fresh one.
            await Session.update(
                {
                    logout_time: new Date(),
                    is_active: false,
                    fcm_token: null,
                    fcm_token_updated_at: null,
                    notification_permission: "default",
                    jwt: null,
                } as any,
                //@ts-ignore
                { where: { jwt: token, user_id: req.userId } }
            );
        }
        return success("Logged out successfully");
    } catch (err) {
        console.log("Error:- logout", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

// ── PATCH /profile/picture ────────────────────────────────────────────────────

export async function updateProfilePicture(req: FastifyRequest) {
    try {
        const uploadedFile = (req as any).file;
        if (!uploadedFile) {
            return error(HttpStatus.BAD_REQUEST, "No file uploaded");
        }

        // Fetch as a live instance (no raw:true) so .update() is available.
        // @ts-ignore
        const existing = await UserProfile.findOne({ where: { user_id: req.userId } });

        let picture_url: string;

        if (is_r2_configured()) {
            // R2 path: always store at a predictable key so updates overwrite in-place.
            const r2_key = `profile/${req.userId}/profile.jpg`;

            // If old picture was a local file, delete it from disk.
            if (existing?.profile_picture && !existing.profile_picture.includes(r2_key)) {
                deleteFileIfExists(urlToLocalPath(existing.profile_picture));
            }

            // Read the locally-saved file into a buffer, upload to R2, then clean up.
            const local_path = path.join(process.cwd(), "public", uploadedFile.key);
            const buffer = fs.readFileSync(local_path);
            const result = await upload_buffer_to_r2({ buffer, key: r2_key, content_type: "image/jpeg" });

            if (result.public_url) {
                // CDN URL available — safe to remove the temp local copy.
                deleteFileIfExists(local_path);
                picture_url = result.public_url;
            } else {
                // No public CDN configured — keep the local file and serve it.
                picture_url = uploadedFile.url;
            }
        } else {
            // No R2 — fall back to local storage.
            if (existing?.profile_picture) {
                deleteFileIfExists(urlToLocalPath(existing.profile_picture));
            }
            picture_url = uploadedFile.url;
        }

        if (existing) {
            await existing.update({ profile_picture: picture_url });
        } else {
            await UserProfile.create({ user_id: req.userId, profile_picture: picture_url } as any);
        }

        return success("Profile picture updated", { profile_picture: picture_url });
    } catch (err) {
        console.log("Error:- updateProfilePicture", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

// ── PATCH /profile/two-factor ────────────────────────────────────────────────

export async function toggleTwoFactor(req: FastifyRequest) {
    try {
        const { enabled } = req.body as { enabled: boolean };

        //@ts-ignore
        const settings = await UserSetting.findOne({ where: { user_id: req.userId }, raw: true });
        if (!settings) return error(HttpStatus.NOT_FOUND, "Settings not found");

        await UserSetting.update(
            { two_step_verification: enabled },
            //@ts-ignore
            { where: { user_id: req.userId } }
        );

        return success(
            enabled ? "Two-factor authentication enabled" : "Two-factor authentication disabled",
            { two_step_verification: enabled }
        );
    } catch (err) {
        console.log("Error:- toggleTwoFactor", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

// ── GET /profile/picture/upload-url ────────────────────────────────────────────
// Returns a short-lived presigned PUT URL so the browser can upload directly
// to R2 without streaming through this server.
// NOTE: the R2 bucket must have a CORS rule allowing PUT from your frontend origin.

export async function getPictureUploadUrl(req: FastifyRequest) {
    if (!is_r2_configured()) {
        return error(HttpStatus.SERVICE_UNAVAILABLE, "R2 not configured — use the multipart upload endpoint");
    }
    try {
        const key = `profile/${req.userId}/profile.jpg`;
        const { upload_url } = await generate_upload_signed_url({ key, content_type: "image/jpeg", expires_in: 300 });
        const public_url = get_public_url(key);
        return success("Upload URL generated", { upload_url, public_url });
    } catch (err) {
        console.log("Error:- getPictureUploadUrl", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

// ── POST /profile/picture/confirm ─────────────────────────────────────────────────
// Called after the browser PUT to R2 succeeds. The key is deterministic
// (profile/<user_id>/profile.jpg) so the backend derives the access URL
// server-side rather than trusting the frontend.

export async function confirmPictureUpload(req: FastifyRequest) {
    try {
        const key = `profile/${req.userId}/profile.jpg`;
        const public_url = get_public_url(key);

        let picture_url: string;
        if (public_url) {
            picture_url = public_url;
        } else {
            // No CDN configured — generate a fresh 7-day signed read URL.
            // In production set R2_PUBLIC_BASE_URL for a permanent CDN URL.
            picture_url = await generate_read_signed_url({ key, expires_in: 7 * 24 * 3600 });
        }

        // @ts-ignore
        const row = await UserProfile.findOne({ where: { user_id: req.userId } });
        if (row) {
            await row.update({ profile_picture: picture_url });
        } else {
            await UserProfile.create({ user_id: req.userId, profile_picture: picture_url } as any);
        }

        return success("Profile picture confirmed", { profile_picture: picture_url });
    } catch (err) {
        console.log("Error:- confirmPictureUpload", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}
