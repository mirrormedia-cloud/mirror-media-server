import bcrypt from "bcrypt";
import { config } from "../../config";

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, config.security.bcryptSaltRounds);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
