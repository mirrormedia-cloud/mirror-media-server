import { uploadFile } from "./upload";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
const MB = 1024 * 1024;

// ── Users ─────────────────────────────────────────────────────────────────────

export const uploadProfilePic = uploadFile({
  folder: "profile_pics",
  field_name: "profile_pic",
  mx_upload: 1,
  file_type: IMAGE_TYPES,
  file_size: 2 * MB,
});