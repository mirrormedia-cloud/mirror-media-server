import { z } from "zod";

export const SsoVerifyDto = z.object({
    email: z.string().email(),
    username: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    profile_picture: z.string().url().optional(),
});

export const SsoRegisterDto = z.object({
    verification_id: z.string().uuid(),
    username: z.string().min(3).optional(),
    first_name: z.string().min(1).optional(),
    last_name: z.string().min(1).optional(),
    profile_picture: z.string().min(1).optional(),
});

export const GoogleTokenDto = z.object({
    token: z.string().min(1),
    token_type: z.enum(["access_token", "id_token"]).default("access_token"),
});

export const ManualRegisterDto = z.object({
    username: z.string().min(3),
    email: z.string().email(),
    password: z.string().min(6),
    first_name: z.string().min(1),
    last_name: z.string().min(1),
});

export const VerifyOtpDto = z.object({
    verification_id: z.string().uuid(),
    otp: z.string().length(4),
    platform: z.enum(["web", "app"]).default("web"),
    app_type: z.enum(["android", "ios", "other"]).optional(),
});

export const ResendOtpDto = z.object({
    verification_id: z.string().uuid(),
});

export const ForgotPasswordSendOtpDto = z.object({
    email: z.string().email(),
});

export const ForgotPasswordSendLinkDto = z.object({
    email: z.string().email(),
});

export const ForgotPasswordVerifyOtpDto = z.object({
    verification_id: z.string().uuid(),
    otp: z.string().length(4),
});

export const ForgotPasswordResendOtpDto = z.object({
    verification_id: z.string().uuid(),
});

export const ResetPasswordDto = z.object({
    reset_token: z.string().min(1),
    password: z.string()
        .min(8, "Password must be at least 8 characters")
        .regex(/[A-Z]/, "Must contain an uppercase letter")
        .regex(/[a-z]/, "Must contain a lowercase letter")
        .regex(/[0-9]/, "Must contain a digit")
        .regex(/[^A-Za-z0-9]/, "Must contain a special character"),
});

export const LoginDto = z.object({
    email: z.string().email(),
    password: z.string().min(6),
    platform: z.enum(["web", "app"]).default("web"),
    app_type: z.enum(["android", "ios", "other"]).optional(),
});

export type SsoVerifyInput = z.infer<typeof SsoVerifyDto>;
export type SsoRegisterInput = z.infer<typeof SsoRegisterDto>;
export type ManualRegisterInput = z.infer<typeof ManualRegisterDto>;
export type VerifyOtpInput = z.infer<typeof VerifyOtpDto>;
export const SetPasswordDto = z.object({
    token: z.string().min(1),
    password: z.string()
        .min(8, "Password must be at least 8 characters")
        .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
        .regex(/[a-z]/, "Password must contain at least one lowercase letter")
        .regex(/[0-9]/, "Password must contain at least one digit")
        .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character"),
});

export type LoginInput = z.infer<typeof LoginDto>;
export type SetPasswordInput = z.infer<typeof SetPasswordDto>;
export type GoogleTokenInput = z.infer<typeof GoogleTokenDto>;
