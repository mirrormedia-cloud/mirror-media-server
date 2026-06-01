import jwt from "jsonwebtoken";
import { config } from "../../config";
import { encrypt, decrypt } from "./encryption";

export class JWTHandler {
    private static readonly secret = config.security.jwtSecret;

    /**
     * Generate a signed JWT token
     */
    static generate(payload: object, options: jwt.SignOptions = { expiresIn: "7d" }): string {
        return jwt.sign(payload, this.secret, options);
    }

    /**
     * Verify a JWT token
     */
    static verify(token: string): any {
        try {
            return jwt.verify(token, this.secret);
        } catch (err) {
            throw new Error("Invalid or expired token");
        }
    }

    /**
     * Decode a JWT token without verification
     */
    static decode(token: string): any {
        return jwt.decode(token);
    }

    /**
     * Encode (Sign + Encrypt) a payload
     * This is useful for sensitive data stored in cookies
     */
    static encode(payload: object, options?: jwt.SignOptions): string {
        const token = this.generate(payload, options);
        return encrypt(token);
    }

    /**
     * Decode (Decrypt + Verify) an encoded token
     */
    static decodeEncoded(encodedToken: string): any {
        const token = decrypt(encodedToken);
        return this.verify(token);
    }
}
