import { User, Session, AuthenticationOtp, UserSetting, SsoVerificationDetail, UserProfile, RegistrationDetail, OtpRateLimit } from "../../db/models";
import { SsoVerifyDto, SsoRegisterDto, ManualRegisterDto, VerifyOtpDto, LoginDto } from "./dto";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import { verifyPassword } from "../../shared/security/password";
import { JWTHandler } from "../../shared/security/jwt";
import bcrypt from "bcrypt";
import { randomUUID, randomInt } from "crypto";
import { FastifyRequest } from "fastify";

function getClientFields(req: FastifyRequest) {
    const ci = req.clientInfo;
    const browserName = ci?.browser?.name ? `${ci.browser.name} ${ci.browser.version || ""}`.trim() : null;
    const osName = ci?.os?.name ? `${ci.os.name} ${ci.os.version || ""}`.trim() : null;
    // Composed once here so the "Chrome on Windows"-style label in the
    // active-sessions UI stays consistent with the columns it's derived from.
    const deviceName = browserName && osName ? `${browserName} on ${osName}` : (browserName || osName || null);
    return {
        ip_address: ci?.ipv4 || ci?.ip || null,
        device: ci?.device?.vendor ? `${ci.device.vendor} ${ci.device.model || ""}`.trim() : ci?.device?.type || null,
        os: osName,
        browser: browserName,
        user_agent: (req.headers["user-agent"] as string | undefined) || null,
        device_name: deviceName,
    };
}

async function createSession(req: FastifyRequest, user: any, token: string, platform?: "web" | "app", appType?: string) {
    const resolvedPlatform: "web" | "app" = platform ?? (user.platform === "app" ? "app" : "web");
    const resolvedAppType = resolvedPlatform === "app" ? (appType ?? user.app_type ?? "android") : null;

    // Enforce one active session per platform slot — delete the existing one
    await Session.destroy({ where: { user_id: user.id, platform: resolvedPlatform } });

    const client = getClientFields(req);
    const now = new Date();
    await Session.create({
        user_id: user.id,
        email: user.email,
        jwt: token,
        login_time: now,
        last_seen_at: now,
        is_active: true,
        register_type: user.register_type,
        platform: resolvedPlatform,
        device_type: resolvedPlatform === "app" ? resolvedAppType : "web",
        app_type: resolvedAppType,
        notification_permission: "default",
        ...client,
    } as any);
}

function getRetryAfter(record: any): number {
    return Math.ceil((new Date(record.blocked_until).getTime() - Date.now()) / 1000);
}

// Simple in-memory rate limiter for check-email / check-username (prevent enumeration)
const checkRateMap = new Map<string, { count: number; windowStart: number }>();
const CHECK_RATE_MAX = 10;       // max requests per window
const CHECK_RATE_WINDOW = 60000; // 1 minute window

function isCheckRateLimited(key: string): boolean {
    const now = Date.now();
    const entry = checkRateMap.get(key);
    if (!entry || now - entry.windowStart > CHECK_RATE_WINDOW) {
        checkRateMap.set(key, { count: 1, windowStart: now });
        return false;
    }
    entry.count++;
    if (entry.count > CHECK_RATE_MAX) return true;
    return false;
}

function formatRetryMessage(prefix: string, retrySeconds?: number): string {
    if (!retrySeconds || retrySeconds <= 0) return `${prefix}. Try again later`;
    const minutes = Math.ceil(retrySeconds / 60);
    return `${prefix}. Try again after ${minutes} minute${minutes !== 1 ? "s" : ""}`;
}

function isBlocked(record: any): { blocked: boolean; retry_after?: number } {
    if (!record.blocked_until) return { blocked: false };
    if (new Date() >= new Date(record.blocked_until)) return { blocked: false };

    const maxSend = record.max_send_attempts ?? OtpRateLimit.DEFAULT_MAX_SEND;
    const maxVerify = record.max_verify_attempts ?? OtpRateLimit.DEFAULT_MAX_VERIFY;

    // If an admin manually reduced both counts below their limits, treat as unblocked
    if ((record.send_count || 0) < maxSend && (record.verify_count || 0) < maxVerify) {
        return { blocked: false };
    }

    return { blocked: true, retry_after: getRetryAfter(record) };
}

async function checkOtpSendLimit(email: string): Promise<{ allowed: boolean; retry_after?: number }> {
    const record = await OtpRateLimit.findOne({ where: { email }, raw: true });

    if (!record) {
        await OtpRateLimit.create({
            email,
            send_count: 1,
            verify_count: 0,
            max_send_attempts: OtpRateLimit.DEFAULT_MAX_SEND,
            max_verify_attempts: OtpRateLimit.DEFAULT_MAX_VERIFY,
            cooldown_minutes: OtpRateLimit.DEFAULT_COOLDOWN,
            window_start: new Date(),
        } as any);
        return { allowed: true };
    }

    const maxSend = record.max_send_attempts ?? OtpRateLimit.DEFAULT_MAX_SEND;
    const cooldown = record.cooldown_minutes ?? OtpRateLimit.DEFAULT_COOLDOWN;

    const blockCheck = isBlocked(record);
    if (blockCheck.blocked) return { allowed: false, ...(blockCheck.retry_after !== undefined ? { retry_after: blockCheck.retry_after } : {}) };

    // Cooldown passed or counts manually reset — reset everything
    if (record.blocked_until) {
        await OtpRateLimit.update({ send_count: 1, verify_count: 0, window_start: new Date(), blocked_until: null as any }, { where: { email } });
        return { allowed: true };
    }

    if ((record.send_count || 0) < maxSend) {
        await OtpRateLimit.update({ send_count: (record.send_count || 0) + 1 }, { where: { email } });
        return { allowed: true };
    }

    // Exceeded send limit — block for cooldown
    const blocked_until = new Date(Date.now() + cooldown * 60 * 1000);
    await OtpRateLimit.update({ blocked_until }, { where: { email } });
    return { allowed: false, retry_after: cooldown * 60 };
}

async function checkOtpVerifyLimit(email: string): Promise<{ allowed: boolean; retry_after?: number; remaining?: number; exhausted?: boolean }> {
    const record = await OtpRateLimit.findOne({ where: { email }, raw: true });
    if (!record) return { allowed: true, remaining: OtpRateLimit.DEFAULT_MAX_VERIFY };

    const maxVerify = record.max_verify_attempts ?? OtpRateLimit.DEFAULT_MAX_VERIFY;
    const cooldown = record.cooldown_minutes ?? OtpRateLimit.DEFAULT_COOLDOWN;

    const blockCheck = isBlocked(record);
    if (blockCheck.blocked) return { allowed: false, ...(blockCheck.retry_after !== undefined ? { retry_after: blockCheck.retry_after } : {}) };

    // Cooldown passed — reset
    if (record.blocked_until) {
        await OtpRateLimit.update({ send_count: 0, verify_count: 1, window_start: new Date(), blocked_until: null as any }, { where: { email } });
        return { allowed: true, remaining: maxVerify - 1 };
    }

    const currentCount = record.verify_count || 0;
    if (currentCount < maxVerify) {
        const newCount = currentCount + 1;
        await OtpRateLimit.update({ verify_count: newCount }, { where: { email } });
        const remaining = maxVerify - newCount;

        // Last attempt used — block immediately
        if (remaining === 0) {
            const blocked_until = new Date(Date.now() + cooldown * 60 * 1000);
            await OtpRateLimit.update({ blocked_until }, { where: { email } });
            return { allowed: true, remaining: 0, exhausted: true, retry_after: cooldown * 60 };
        }

        return { allowed: true, remaining };
    }

    // Already exceeded — block for cooldown
    const blocked_until = new Date(Date.now() + cooldown * 60 * 1000);
    await OtpRateLimit.update({ blocked_until }, { where: { email } });
    return { allowed: false, retry_after: cooldown * 60 };
}

async function resetOtpLimits(email: string) {
    await OtpRateLimit.destroy({ where: { email } });
}

export async function ssoVerify(req: FastifyRequest) {
    try {
        const { email, username, first_name, last_name, profile_picture, platform = "web", app_type } = req.body as any;

        const existingUser = await User.findOne({ where: { email }, raw: true });
        if (existingUser) {
            const token = JWTHandler.generate({ userId: existingUser.id });
            await createSession(req, existingUser, token, platform, app_type);

            if (existingUser.password_hash === "SSO_USER") {
                return success("Password setup required", { type: "set_password", user: existingUser, token });
            }

            return success("Login successful", { type: "login", user: existingUser, token });
        }

        let pendingSso = await SsoVerificationDetail.findOne({ where: { email }, raw: true });
        if (pendingSso) {
            const updateData: any = { username, first_name, last_name, profile_picture };
            if (!pendingSso.verification_id) {
                updateData.verification_id = randomUUID();
            }
            await SsoVerificationDetail.update(updateData, { where: { email } });
            pendingSso = await SsoVerificationDetail.findOne({ where: { email }, raw: true });
        } else {
            await SsoVerificationDetail.create({
                email,
                username,
                first_name,
                last_name,
                profile_picture,
                verification_id: randomUUID(),
            } as any);
            pendingSso = await SsoVerificationDetail.findOne({ where: { email }, raw: true });
        }

        return success("Pending SSO verification", { type: "register", details: pendingSso });
    } catch (err) {
        console.log("Error:- ssoVerify", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function ssoRegister(req: FastifyRequest) {
    try {
        const { verification_id, first_name, last_name, profile_picture, platform = "web", app_type } = req.body as any;
        console.log("[ssoRegister] verification_id:", verification_id);
        const pendingSso = await SsoVerificationDetail.findOne({ where: { verification_id }, raw: true });
        console.log("[ssoRegister] pendingSso:", pendingSso);
        if (!pendingSso) {
            return error(HttpStatus.BAD_REQUEST, "Invalid or expired verification session");
        }

        const email = pendingSso.email;
        const targetUsername = email?.split("@")[0]?.replace(/\./g, "_").replace(/[^a-zA-Z0-9_]/g, "");

        // Check uniqueness
        if (email) {
            const existingEmail = await User.findOne({ where: { email }, raw: true });
            if (existingEmail) return error(HttpStatus.BAD_REQUEST, "Email already exists", "email");
        }

        let resolvedUsername = targetUsername;
        if (resolvedUsername) {
            let suffix = 1;
            while (await User.findOne({ where: { username: resolvedUsername }, raw: true })) {
                resolvedUsername = `${targetUsername}${suffix++}`;
            }
        }

        const client = getClientFields(req);
        const create_user = await User.create({
            username: resolvedUsername,
            email: email,
            password_hash: "SSO_USER",
            register_type: "google",
            platform: "app",
            is_active: true,
            email_verified: true,   // Google already verified the email
            ...client,
        } as any);

        const user = await User.findOne({ where: { id: create_user.id }, raw: true });

        if (!user) {
            return error(HttpStatus.BAD_REQUEST, "User not found");
        }

        const uploadedPicture = (req as any).file?.url;
        await UserProfile.create({
            user_id: user.id,
            first_name: first_name || pendingSso.first_name || "",
            last_name: last_name || pendingSso.last_name || "",
            profile_picture: uploadedPicture || profile_picture || pendingSso.profile_picture,
        } as any);

        await UserSetting.create({ user_id: user.id, two_step_verification: false } as any);
        await SsoVerificationDetail.destroy({ where: { verification_id } });

        const token = JWTHandler.generate({ userId: user.id });
        await createSession(req, user, token, platform, app_type);
        return success("Registration successful", { user, token });
    } catch (err) {
        console.log("Error:- ssoRegister", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function checkUsername(req: FastifyRequest) {
    try {
        const { username } = req.params as { username: string };

        const ip = req.clientInfo?.ipv4 || req.clientInfo?.ip || req.ip;
        if (isCheckRateLimited(`check-username:${ip}`)) {
            return error(HttpStatus.TOO_MANY_REQUESTS, "Too many requests. Please try again later");
        }

        const user = await User.findOne({ where: { username }, raw: true });
        return success("Check username", { available: !user });
    } catch (err) {
        console.log("Error:- checkUsername", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function checkEmail(req: FastifyRequest) {
    try {
        const { email } = req.params as { email: string };

        const ip = req.clientInfo?.ipv4 || req.clientInfo?.ip || req.ip;
        if (isCheckRateLimited(`check-email:${ip}`)) {
            return error(HttpStatus.TOO_MANY_REQUESTS, "Too many requests. Please try again later");
        }

        const user = await User.findOne({ where: { email }, raw: true });
        return success("Check email", { exists: !!user });
    } catch (err) {
        console.log("Error:- checkEmail", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function register(req: FastifyRequest) {
    try {
        const { email, password, username, first_name, last_name } = req.body as any;

        // Check fully registered users
        const existing = await User.findOne({ where: { email }, raw: true });
        if (existing) {
            // Email exists but not verified — send OTP to verify
            if (!existing.email_verified) {
                const rateLimit = await checkOtpSendLimit(email);
                if (!rateLimit.allowed) {
                    return error(HttpStatus.TOO_MANY_REQUESTS, formatRetryMessage("Too many OTP requests", rateLimit.retry_after), undefined, { retry_after: rateLimit.retry_after });
                }
                const verification_id = randomUUID();
                await AuthenticationOtp.destroy({ where: { email } });
                const otp = randomInt(1000, 9999).toString();
                const expires_at = new Date(Date.now() + AuthenticationOtp.otp_expiry_seconds * 1000);
                await AuthenticationOtp.create({ email, otp, verification_id, expires_at } as any);
                console.log(`[OTP] Email verification pending ${otp} to ${email}`);
                return success("Email verification pending", {
                    type: "email_verification",
                    verification_id,
                    email,
                });
            }
            return error(HttpStatus.BAD_REQUEST, "Email already exists", "email");
        }

        const existingUsername = await User.findOne({ where: { username }, raw: true });
        if (existingUsername) return error(HttpStatus.BAD_REQUEST, "Username already exists", "username");

        // Check pending (mid-registration) — email already has an unverified OTP session
        const pendingEmail = await RegistrationDetail.findOne({ where: { email }, raw: true });
        if (pendingEmail) {
            const rateLimit = await checkOtpSendLimit(email);
            if (!rateLimit.allowed) {
                return error(HttpStatus.TOO_MANY_REQUESTS, formatRetryMessage("Too many OTP requests", rateLimit.retry_after), undefined, { retry_after: rateLimit.retry_after });
            }
            // Refresh OTP so user can verify immediately from the popup
            await AuthenticationOtp.destroy({ where: { verification_id: pendingEmail.verification_id } });
            const pendingOtp = randomInt(1000, 9999).toString();
            const pendingExpiry = new Date(Date.now() + AuthenticationOtp.otp_expiry_seconds * 1000);
            await AuthenticationOtp.create({ email, otp: pendingOtp, verification_id: pendingEmail.verification_id, expires_at: pendingExpiry } as any);
            console.log(`[OTP] Pending resent ${pendingOtp} to ${email}`);
            return success("Email verification pending", {
                type: "pending_verification",
                verification_id: pendingEmail.verification_id,
                email,
            });
        }

        const pendingUsername = await RegistrationDetail.findOne({ where: { username }, raw: true });
        if (pendingUsername) return error(HttpStatus.BAD_REQUEST, "Username already exists", "username");

        const rateLimit = await checkOtpSendLimit(email);
        if (!rateLimit.allowed) {
            return error(HttpStatus.TOO_MANY_REQUESTS, formatRetryMessage("Too many OTP requests", rateLimit.retry_after), undefined, { retry_after: rateLimit.retry_after });
        }

        const password_hash = await bcrypt.hash(password, 10);
        const verification_id = randomUUID();
        const otp = randomInt(1000, 9999).toString();
        const expires_at = new Date(Date.now() + AuthenticationOtp.otp_expiry_seconds * 1000);

        await AuthenticationOtp.create({ email, otp, verification_id, expires_at } as any);
        await RegistrationDetail.create({
            email, username, password_hash, plain_password: password,
            first_name, last_name, verification_id,
        } as any);

        console.log(`[OTP] Sent ${otp} to ${email}`);
        return success("OTP sent", { verification_id });
    } catch (err) {
        console.log("Error:- register", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function resendOtp(req: FastifyRequest) {
    try {
        const { verification_id } = req.body as any;

        // Find email from registration detail or existing OTP record
        const regDetail = await RegistrationDetail.findOne({ where: { verification_id }, raw: true });
        const existingOtp = !regDetail ? await AuthenticationOtp.findOne({ where: { verification_id }, raw: true }) : null;
        const email = regDetail?.email || existingOtp?.email;

        if (!email) return error(HttpStatus.BAD_REQUEST, "Invalid or expired verification session");

        const rateLimit = await checkOtpSendLimit(email);
        if (!rateLimit.allowed) {
            return error(HttpStatus.TOO_MANY_REQUESTS, formatRetryMessage("Too many OTP requests", rateLimit.retry_after), undefined, { retry_after: rateLimit.retry_after });
        }

        // Replace old OTP with a fresh one
        await AuthenticationOtp.destroy({ where: { verification_id } });
        const otp = randomInt(1000, 9999).toString();
        const expires_at = new Date(Date.now() + AuthenticationOtp.otp_expiry_seconds * 1000);
        await AuthenticationOtp.create({ email, otp, verification_id, expires_at } as any);

        console.log(`[OTP] Resent ${otp} to ${email}`);
        return success("OTP resent", { verification_id });
    } catch (err) {
        console.log("Error:- resendOtp", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function verifyOtp(req: FastifyRequest) {
    try {
        const { verification_id, otp, platform = "web", app_type } = req.body as any;

        // Check if this verification_id is rate limited (by email from OTP or rate limit table)
        const otpRecord = await AuthenticationOtp.findOne({ where: { verification_id }, raw: true });

        if (!otpRecord || otpRecord.expires_at! < new Date()) {
            return error(HttpStatus.BAD_REQUEST, "Invalid or expired OTP");
        }

        // Check verify attempt limit
        const verifyLimit = await checkOtpVerifyLimit(otpRecord.email!);
        if (!verifyLimit.allowed) {
            return error(HttpStatus.TOO_MANY_REQUESTS, formatRetryMessage("Too many wrong attempts", verifyLimit.retry_after), undefined, { retry_after: verifyLimit.retry_after });
        }

        // Now check if the OTP matches
        if (otpRecord.otp !== otp) {
            if (verifyLimit.exhausted) {
                return error(HttpStatus.TOO_MANY_REQUESTS, formatRetryMessage("Too many wrong attempts", verifyLimit.retry_after), undefined, { retry_after: verifyLimit.retry_after });
            }
            return error(HttpStatus.BAD_REQUEST, `Invalid OTP. ${verifyLimit.remaining} attempt${verifyLimit.remaining !== 1 ? "s" : ""} remaining`);
        }

        const record = otpRecord;

        // OTP verified — reset rate limits for this email
        await resetOtpLimits(record.email!);

        const regDetail = await RegistrationDetail.findOne({ where: { verification_id }, raw: true });
        if (regDetail) {
            const client = getClientFields(req);
            const created_user = await User.create({
                username: regDetail.username,
                email: regDetail.email,
                password_hash: regDetail.password_hash,
                plain_password: regDetail.plain_password,
                register_type: "manually",
                platform: "app",
                is_active: true,
                email_verified: true,
                ...client,
            } as any);

            const user = await User.findOne({ where: { id: created_user.id }, raw: true });

            if (!user) {
                return error(HttpStatus.BAD_REQUEST, "User not found");
            }

            await UserProfile.create({
                user_id: user.id,
                first_name: regDetail.first_name || "",
                last_name: regDetail.last_name || "",
            } as any);

            await UserSetting.create({ user_id: user.id, two_step_verification: false } as any);

            const token = JWTHandler.generate({ userId: user.id });
            await AuthenticationOtp.destroy({ where: { verification_id } });
            await RegistrationDetail.destroy({ where: { verification_id } });
            await createSession(req, user, token, platform, app_type);
            return success("Registration successful", { user, token });
        }

        // 2FA or email verification login
        const user = await User.findOne({ where: { email: record.email }, raw: true });
        if (!user) return error(HttpStatus.BAD_REQUEST, "User not found");

        // If email was not verified, mark it verified now
        if (!user.email_verified) {
            await User.update({ email_verified: true }, { where: { id: user.id } });
        }

        const token = JWTHandler.generate({ userId: user.id });
        await AuthenticationOtp.destroy({ where: { verification_id } });
        await createSession(req, user, token, platform, app_type);
        return success("Login successful", { user, token });
    } catch (err) {
        console.log("Error:- verifyOtp", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function setPassword(req: FastifyRequest) {
    try {
        const { token, password } = req.body as any;
        const payload = JWTHandler.verify(token) as { userId: string };
        if (!payload?.userId) {
            return error(HttpStatus.UNAUTHORIZED, "Invalid token");
        }

        const user = await User.findOne({ where: { id: payload.userId }, raw: true });
        if (!user) return error(HttpStatus.BAD_REQUEST, "User not found");

        const password_hash = await bcrypt.hash(password, 10);
        await User.update({ password_hash, plain_password: password }, { where: { id: user.id } });

        return success("Password set successfully");
    } catch (err) {
        console.log("Error:- setPassword", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function forgotPasswordSendOtp(req: FastifyRequest) {
    try {
        const { email } = req.body as any;

        const user = await User.findOne({ where: { email }, raw: true });
        if (!user) return error(HttpStatus.NOT_FOUND, "If this email is registered, you will receive an OTP shortly", "email");

        const rateLimit = await checkOtpSendLimit(email);
        if (!rateLimit.allowed) {
            return error(HttpStatus.TOO_MANY_REQUESTS, formatRetryMessage("Too many OTP requests", rateLimit.retry_after), undefined, { retry_after: rateLimit.retry_after });
        }

        // Delete any existing forgot-password OTPs for this email
        await AuthenticationOtp.destroy({ where: { email } });

        const verification_id = randomUUID();
        const otp = randomInt(1000, 9999).toString();
        const expires_at = new Date(Date.now() + AuthenticationOtp.otp_expiry_seconds * 1000);

        await AuthenticationOtp.create({ email, otp, verification_id, expires_at } as any);
        console.log(`[OTP] Forgot-password OTP ${otp} sent to ${email}`);
        return success("OTP sent", { verification_id });
    } catch (err) {
        console.log("Error:- forgotPasswordSendOtp", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function forgotPasswordSendLink(req: FastifyRequest) {
    try {
        const { email } = req.body as any;

        const user = await User.findOne({ where: { email }, raw: true });
        if (!user) return error(HttpStatus.NOT_FOUND, "If this email is registered, you will receive a reset link shortly", "email");

        const rateLimit = await checkOtpSendLimit(email);
        if (!rateLimit.allowed) {
            return error(HttpStatus.TOO_MANY_REQUESTS, formatRetryMessage("Too many reset link requests", rateLimit.retry_after), undefined, { retry_after: rateLimit.retry_after });
        }

        const reset_token = JWTHandler.generate({ userId: user.id, type: "password_reset" }, { expiresIn: "1h" });
        const reset_link = `${process.env.APP_URL || "http://localhost:3002"}/reset-password?token=${reset_token}`;

        console.log(`[RESET LINK] Sent to ${email}: ${reset_link}`);
        return success("Reset link sent to your email");
    } catch (err) {
        console.log("Error:- forgotPasswordSendLink", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function forgotPasswordVerifyOtp(req: FastifyRequest) {
    try {
        const { verification_id, otp } = req.body as any;

        const otpRecord = await AuthenticationOtp.findOne({ where: { verification_id }, raw: true });
        if (!otpRecord || otpRecord.expires_at! < new Date()) {
            return error(HttpStatus.BAD_REQUEST, "Invalid or expired OTP");
        }

        const verifyLimit = await checkOtpVerifyLimit(otpRecord.email!);
        if (!verifyLimit.allowed) {
            await AuthenticationOtp.destroy({ where: { verification_id } });
            return error(HttpStatus.TOO_MANY_REQUESTS, formatRetryMessage("Too many wrong attempts", verifyLimit.retry_after), undefined, { retry_after: verifyLimit.retry_after });
        }

        if (otpRecord.otp !== otp) {
            if (verifyLimit.exhausted) {
                return error(HttpStatus.TOO_MANY_REQUESTS, formatRetryMessage("Too many wrong attempts", verifyLimit.retry_after), undefined, { retry_after: verifyLimit.retry_after });
            }
            return error(HttpStatus.BAD_REQUEST, `Invalid OTP. ${verifyLimit.remaining} attempt${verifyLimit.remaining !== 1 ? "s" : ""} remaining`);
        }

        await resetOtpLimits(otpRecord.email!);

        const user = await User.findOne({ where: { email: otpRecord.email }, raw: true });
        if (!user) return error(HttpStatus.NOT_FOUND, "User not found");

        // Short-lived reset token — valid for 15 minutes
        const reset_token = JWTHandler.generate({ userId: user.id, type: "password_reset" }, { expiresIn: "15m" });
        await AuthenticationOtp.destroy({ where: { verification_id } });

        return success("OTP verified", { reset_token });
    } catch (err) {
        console.log("Error:- forgotPasswordVerifyOtp", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function forgotPasswordResendOtp(req: FastifyRequest) {
    try {
        const { verification_id } = req.body as any;

        const existing = await AuthenticationOtp.findOne({ where: { verification_id }, raw: true });
        if (!existing) return error(HttpStatus.BAD_REQUEST, "Invalid or expired verification session");

        const rateLimit = await checkOtpSendLimit(existing.email!);
        if (!rateLimit.allowed) {
            return error(HttpStatus.TOO_MANY_REQUESTS, formatRetryMessage("Too many OTP requests", rateLimit.retry_after), undefined, { retry_after: rateLimit.retry_after });
        }

        await AuthenticationOtp.destroy({ where: { verification_id } });

        const otp = randomInt(1000, 9999).toString();
        const expires_at = new Date(Date.now() + AuthenticationOtp.otp_expiry_seconds * 1000);
        await AuthenticationOtp.create({ email: existing.email, otp, verification_id, expires_at } as any);

        console.log(`[OTP] Forgot-password OTP resent ${otp} to ${existing.email}`);
        return success("OTP resent", { verification_id });
    } catch (err) {
        console.log("Error:- forgotPasswordResendOtp", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function resetPassword(req: FastifyRequest) {
    try {
        const { reset_token, password } = req.body as any;

        let payload: any;
        try {
            payload = JWTHandler.verify(reset_token);
        } catch {
            return error(HttpStatus.UNAUTHORIZED, "Invalid or expired reset token");
        }

        if (!payload?.userId || payload?.type !== "password_reset") {
            return error(HttpStatus.UNAUTHORIZED, "Invalid reset token");
        }

        const user = await User.findOne({ where: { id: payload.userId }, raw: true });
        if (!user) return error(HttpStatus.NOT_FOUND, "User not found");

        const password_hash = await bcrypt.hash(password, 10);
        await User.update({ password_hash, plain_password: password }, { where: { id: user.id } });

        // Invalidate all existing sessions so stolen tokens can't be reused.
        // Mark inactive + clear push tokens rather than destroying — keeps the
        // audit trail and lets the user see what devices were active before
        // the reset on the sessions page.
        await Session.update(
            {
                is_active: false,
                logout_time: new Date(),
                fcm_token: null,
                fcm_token_updated_at: null,
                notification_permission: "default",
                jwt: null,
            } as any,
            { where: { user_id: user.id } }
        );

        return success("Password reset successfully");
    } catch (err) {
        console.log("Error:- resetPassword", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function login(req: FastifyRequest) {
    try {
        const { email, password, platform = "web", app_type } = req.body as any;
        const user = await User.findOne({ where: { email }, raw: true });

        if (!user) {
            // Check if email has a pending registration (OTP not yet verified)
            const pendingReg = await RegistrationDetail.findOne({ where: { email }, raw: true });
            if (pendingReg) {
                const isValid = await bcrypt.compare(password, pendingReg.password_hash!);
                if (!isValid) return error(HttpStatus.UNAUTHORIZED, "Invalid credentials");

                // Resend a fresh OTP for the pending registration
                const rl1 = await checkOtpSendLimit(email);
                if (!rl1.allowed) {
                    return error(HttpStatus.TOO_MANY_REQUESTS, formatRetryMessage("Too many OTP requests", rl1.retry_after), undefined, { retry_after: rl1.retry_after });
                }
                await AuthenticationOtp.destroy({ where: { verification_id: pendingReg.verification_id } });
                const otp = randomInt(1000, 9999).toString();
                const expires_at = new Date(Date.now() + AuthenticationOtp.otp_expiry_seconds * 1000);
                await AuthenticationOtp.create({ email, otp, verification_id: pendingReg.verification_id, expires_at } as any);
                console.log(`[OTP] Pending verification resent ${otp} to ${email}`);
                return success("Email verification pending", {
                    type: "pending_verification",
                    verification_id: pendingReg.verification_id,
                    email,
                });
            }
            return error(HttpStatus.UNAUTHORIZED, "Invalid credentials");
        }

        const isValid = await verifyPassword(password, user.password_hash!);
        if (!isValid) return error(HttpStatus.UNAUTHORIZED, "Invalid credentials");

        // Email not verified — send OTP to verify first
        if (!user.email_verified) {
            const rl2 = await checkOtpSendLimit(email);
            if (!rl2.allowed) {
                return error(HttpStatus.TOO_MANY_REQUESTS, formatRetryMessage("Too many OTP requests", rl2.retry_after), undefined, { retry_after: rl2.retry_after });
            }
            const verification_id = randomUUID();
            const otp = randomInt(1000, 9999).toString();
            const expires_at = new Date(Date.now() + AuthenticationOtp.otp_expiry_seconds * 1000);
            await AuthenticationOtp.create({ email: user.email, otp, verification_id, expires_at } as any);
            console.log(`[OTP] Email verification ${otp} sent to ${email}`);
            return success("Email verification required", {
                type: "email_verification",
                verification_id,
                email: user.email,
            });
        }

        const settings = await UserSetting.findOne({ where: { user_id: user.id }, raw: true });
        const needs2fa = settings?.two_step_verification && user.register_type !== "google";

        if (needs2fa) {
            const rl3 = await checkOtpSendLimit(email);
            if (!rl3.allowed) {
                return error(HttpStatus.TOO_MANY_REQUESTS, formatRetryMessage("Too many OTP requests", rl3.retry_after), undefined, { retry_after: rl3.retry_after });
            }
            const verification_id = randomUUID();
            const otp = randomInt(1000, 9999).toString();
            const expires_at = new Date(Date.now() + AuthenticationOtp.otp_expiry_seconds * 1000);
            await AuthenticationOtp.create({ email: user.email, otp, verification_id, expires_at } as any);
            console.log(`[OTP] 2FA code ${otp} sent to ${email}`);
            return success("2FA required", { type: "2fa_required", verification_id });
        }

        const token = JWTHandler.generate({ userId: user.id });
        await createSession(req, user, token, platform, app_type);
        return success("Login successful", { user, token });
    } catch (err) {
        console.log("Error:- login", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function googleTokenVerify(req: FastifyRequest) {
    try {
        const { token, token_type = "access_token" } = req.body as any;

        let email: string;
        let given_name: string | null = null;
        let family_name: string | null = null;
        let picture: string | null = null;
        let email_verified: string | boolean | null = null;

        if (token_type === "id_token") {
            // Verify Google ID token via tokeninfo endpoint (no client secret needed)
            const res = await fetch(
                `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`
            );
            if (!res.ok) {
                return error(HttpStatus.UNAUTHORIZED, "Invalid Google ID token");
            }
            const payload = await res.json() as any;

            // Optionally enforce audience — prevents tokens issued for other apps
            const clientId = process.env.GOOGLE_CLIENT_ID;
            if (clientId && payload.aud !== clientId) {
                return error(HttpStatus.UNAUTHORIZED, "Google token not issued for this application");
            }

            email = payload.email;
            given_name = payload.given_name ?? null;
            family_name = payload.family_name ?? null;
            picture = payload.picture ?? null;
            email_verified = payload.email_verified;
        } else {
            // Verify access token via Google's userinfo endpoint
            const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) {
                return error(HttpStatus.UNAUTHORIZED, "Invalid Google access token");
            }
            const payload = await res.json() as any;

            email = payload.email;
            given_name = payload.given_name ?? null;
            family_name = payload.family_name ?? null;
            picture = payload.picture ?? null;
            email_verified = payload.email_verified;
        }

        if (!email) {
            return error(HttpStatus.UNAUTHORIZED, "Could not retrieve email from Google");
        }

        if (!email_verified || email_verified === "false") {
            return error(HttpStatus.UNAUTHORIZED, "Google account email is not verified");
        }

        // Derive a username candidate from the Google display name
        const raw = [given_name, family_name].filter(Boolean).join("").toLowerCase().replace(/[^a-z0-9]/g, "");
        const derivedUsername = raw.length >= 3 ? raw : email.split("@")[0];

        // Delegate to existing ssoVerify logic with Google-sourced profile data
        (req as any).body = {
            email,
            first_name: given_name,
            last_name: family_name,
            profile_picture: picture,
            username: derivedUsername,
        };

        return ssoVerify(req);
    } catch (err) {
        console.log("Error:- googleTokenVerify", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Google sign-in failed");
    }
}
