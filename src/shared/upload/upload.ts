import { FastifyRequest, FastifyReply } from "fastify";
import path from "path";
import fs from "fs";
import { generateSlug } from "../utils/slug";
import { config } from "../../config";
import { error } from "../http/response";

export const UPLOAD_BASE = path.join(process.cwd(), "public");

interface UploadOptions {
  folder: string;
  field_name?: string;
  name_field?: string;
  mx_upload?: number;
  file_type?: string[];
  file_size?: number;
}

const DEFAULT_FILE_TYPE = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/svg+xml"];
const DEFAULT_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_MX_UPLOAD = 1;

function generateImageName(original_name: string, ext: string): string {
  const slug = generateSlug(path.basename(original_name, path.extname(original_name)));
  const round = Math.round(Math.random() * 10000);
  return `image_${Date.now()}_${slug}_${round}${ext}`;
}

export function uploadFile(options: UploadOptions) {
  const {
    folder,
    field_name = "file",
    name_field,
    mx_upload = DEFAULT_MX_UPLOAD,
    file_type = DEFAULT_FILE_TYPE,
    file_size = DEFAULT_FILE_SIZE,
  } = options;

  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const parts = req.parts();
      const body: Record<string, any> = {};
      const uploaded: any[] = [];

      for await (const part of parts) {
        if (part.type === "field") {
          body[part.fieldname] = part.value;
          continue;
        }

        if (part.type === "file") {
          if (part.fieldname !== field_name) { part.file.resume(); continue; }
          if (uploaded.length >= mx_upload) { part.file.resume(); continue; }
          if (!file_type.includes(part.mimetype)) {
            return reply.status(400).send({
              error: { status: false, code: 400, message: `Invalid file type. Allowed: ${file_type.join(", ")}` },
              success: null,
              data: null,
            });
          }

          const chunks: Buffer[] = [];
          for await (const chunk of part.file) chunks.push(chunk);
          const buffer = Buffer.concat(chunks);

          if (buffer.length > file_size) {
            return reply.status(400).send({
              error: { status: false, code: 400, message: `File too large. Max size: ${Math.round(file_size / 1024 / 1024)}MB` },
              success: null,
              data: null,
            });
          }

          const ext = path.extname(part.filename) || ".png";
          let file_name: string;

          if (name_field && body[name_field]) {
            file_name = `${generateSlug(body[name_field])}${ext}`;
          } else {
            file_name = generateImageName(part.filename, ext);
          }

          const folder_path = path.join(UPLOAD_BASE, folder);
          if (!fs.existsSync(folder_path)) fs.mkdirSync(folder_path, { recursive: true });

          const file_path = path.join(folder_path, file_name);
          fs.writeFileSync(file_path, buffer);

          const file_key = `${folder}/${file_name}`;
          const full_url = `${config.file.access_url}${file_key}`;

          uploaded.push({
            key: file_key,
            url: full_url,
            filename: file_name,
            original_name: part.filename,
            mimetype: part.mimetype,
            size: buffer.length,
          });
        }
      }

      req.body = body;

      if (uploaded.length === 1) (req as any).file = uploaded[0];
      else if (uploaded.length > 1) (req as any).files = uploaded;
    } catch (err: any) {
      if (err.code === "FST_REQ_FILE_TOO_LARGE") return reply.status(400).send(error(400, "File too large"));
    }
  };
}
