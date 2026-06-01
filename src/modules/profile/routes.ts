import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "../../shared/security/auth.middleware";
import { uploadProfilePic } from "../../shared/upload/upload.config";
import { getProfile, updateProfile, updateProfilePicture, toggleTwoFactor, updatePreferences, getPictureUploadUrl, confirmPictureUpload } from "./service";
import { HttpStatus } from "../../shared/http/status";
import { serverError } from "../../shared/http/response";

const getProfileHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await getProfile(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const updateProfileHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await updateProfile(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const updateProfilePictureHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await updateProfilePicture(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const toggleTwoFactorHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await toggleTwoFactor(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const updatePreferencesHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await updatePreferences(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const getPictureUploadUrlHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await getPictureUploadUrl(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

const confirmPictureUploadHandler = async (req: FastifyRequest, res: FastifyReply) => {
    try {
        const result = await confirmPictureUpload(req);
        const code = result?.success?.code || result?.error?.code;
        res.status(code).send(result);
    } catch (err) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
    }
};

export const profileRoutes: FastifyPluginAsync = async (app) => {
    // All profile routes require authentication
    app.addHook("preHandler", authenticate);

    app.get("/", getProfileHandler);
    app.patch("/", updateProfileHandler);
    app.patch("/picture", { preHandler: uploadProfilePic }, updateProfilePictureHandler);
    app.patch("/two-factor", toggleTwoFactorHandler);
    app.patch("/preferences", updatePreferencesHandler);
    app.get("/picture/upload-url", getPictureUploadUrlHandler);
    app.post("/picture/confirm", confirmPictureUploadHandler);
};
