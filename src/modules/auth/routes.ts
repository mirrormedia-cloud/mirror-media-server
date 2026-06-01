import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { SsoVerifyDto, SsoRegisterDto, ManualRegisterDto, VerifyOtpDto, LoginDto, SetPasswordDto, ResendOtpDto, ForgotPasswordSendOtpDto, ForgotPasswordSendLinkDto, ForgotPasswordVerifyOtpDto, ForgotPasswordResendOtpDto, ResetPasswordDto, GoogleTokenDto } from "./dto";
import { ssoVerify, ssoRegister, googleTokenVerify, checkUsername, checkEmail, register, verifyOtp, login, setPassword, resendOtp, forgotPasswordSendOtp, forgotPasswordSendLink, forgotPasswordVerifyOtp, forgotPasswordResendOtp, resetPassword } from "./service";
import { logout } from "../profile/service";
import { authenticate } from "../../shared/security/auth.middleware";
import { validate } from "../../shared/http/validate";
import { uploadProfilePic } from "../../shared/upload/upload.config";
import { HttpStatus } from "../../shared/http/status";
import { serverError } from "../../shared/http/response";

const googleTokenVerifyHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await googleTokenVerify(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        console.log("Error:- googleTokenVerifyHandler", err);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const ssoVerifyHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await ssoVerify(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        console.log("Error:- ssoVerifyHandler", err);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const ssoRegisterHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await ssoRegister(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        console.log("Error:- ssoRegisterHandler", err);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const checkUsernameHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await checkUsername(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        console.log("Error:- checkUsernameHandler", err);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const checkEmailHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await checkEmail(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        console.log("Error:- checkEmailHandler", err);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const registerHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await register(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        console.log("Error:- registerHandler", err);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const verifyOtpHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await verifyOtp(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        console.log("Error:- verifyOtpHandler", err);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const loginHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await login(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        console.log("Error:- loginHandler", err);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const setPasswordHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await setPassword(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        console.log("Error:- setPasswordHandler", err);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const resendOtpHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await resendOtp(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const logoutHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await logout(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const forgotPasswordSendOtpHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await forgotPasswordSendOtp(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const forgotPasswordSendLinkHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await forgotPasswordSendLink(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const forgotPasswordVerifyOtpHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await forgotPasswordVerifyOtp(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const forgotPasswordResendOtpHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await forgotPasswordResendOtp(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const resetPasswordHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await resetPassword(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

// GET /api/auth/me — returns the authenticated user's basic profile. Frontend
// uses this on app boot to confirm the JWT is still valid and rehydrate auth
// state (instead of trusting localStorage alone).
const meHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const { User } = await import("../../db/models");
        const user = await User.findOne({ where: { id: req.userId! }, raw: true });
        if (!user) {
            res.status(HttpStatus.NOT_FOUND).send({ success: null, data: null, error: { status: false, code: HttpStatus.NOT_FOUND, message: "User not found" } });
            return;
        }
        res.status(HttpStatus.OK).send({
            success: { status: true, code: HttpStatus.OK, message: "user fetched successfully" },
            data: {
                id: user.id,
                email: user.email,
                username: user.username,
                email_verified: user.email_verified,
                is_active: user.is_active,
                createdAt: (user as any).createdAt instanceof Date
                    ? (user as any).createdAt.toISOString()
                    : (user as any).createdAt ?? null,
            },
            error: null,
        });
    } catch (err) {
        console.log("Error:- meHandler", err);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

export const authRoutes: FastifyPluginAsync = async (app) => {
    app.post("/sso/google-token", { preHandler: validate(GoogleTokenDto) }, googleTokenVerifyHandler);
    app.post("/sso/verify", { preHandler: validate(SsoVerifyDto) }, ssoVerifyHandler);
    app.post("/sso/register", { preHandler: [uploadProfilePic, validate(SsoRegisterDto)] }, ssoRegisterHandler);
    app.get("/check-username/:username", checkUsernameHandler);
    app.get("/check-email/:email", checkEmailHandler);
    app.post("/register", { preHandler: validate(ManualRegisterDto) }, registerHandler);
    app.post("/verify-otp", { preHandler: validate(VerifyOtpDto) }, verifyOtpHandler);
    app.post("/resend-otp", { preHandler: validate(ResendOtpDto) }, resendOtpHandler);
    app.post("/login", { preHandler: validate(LoginDto) }, loginHandler);
    app.post("/set-password", { preHandler: validate(SetPasswordDto) }, setPasswordHandler);
    app.post("/logout", { preHandler: authenticate }, logoutHandler);
    app.get("/me", { preHandler: authenticate }, meHandler);
    app.post("/forgot-password/send-otp", { preHandler: validate(ForgotPasswordSendOtpDto) }, forgotPasswordSendOtpHandler);
    app.post("/forgot-password/send-link", { preHandler: validate(ForgotPasswordSendLinkDto) }, forgotPasswordSendLinkHandler);
    app.post("/forgot-password/verify-otp", { preHandler: validate(ForgotPasswordVerifyOtpDto) }, forgotPasswordVerifyOtpHandler);
    app.post("/forgot-password/resend-otp", { preHandler: validate(ForgotPasswordResendOtpDto) }, forgotPasswordResendOtpHandler);
    app.post("/forgot-password/reset", { preHandler: validate(ResetPasswordDto) }, resetPasswordHandler);
};
