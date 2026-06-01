// Re-export the existing AES-GCM helpers under the spec-required path so callers
// inside src/utils/ can `import { encrypt, decrypt } from "./encryption"`.
export { encrypt, decrypt } from "../shared/security/encryption";
