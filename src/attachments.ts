import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

/**
 * Inline-image support for the ticket write tools.
 *
 * The Tickiti v1 API turns any `<img src="data:...;base64,...">` in a response/
 * ticket body into a stored `cid:` attachment (ApiController runs the same
 * TicketActionService::extractImages the web composer uses). So to attach an
 * inline image we only need to put a data-URI `<img>` in the body — no separate
 * upload call, no multipart.
 *
 * Crucially, the MODEL must never hand-transcribe base64 (it can't do so
 * reliably for non-trivial images). Instead the model passes a local FILE PATH;
 * this shim — which runs on the same machine — reads the bytes and builds the
 * data-URI itself. Same principle as export_responses/get_attachment: bytes go
 * straight to/from disk, never through the model's context.
 */

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

export const SUPPORTED_IMAGE_EXTS = Object.keys(IMAGE_MIME);

export interface InlineAttachment {
  /** Path to the image file on the machine running the MCP. */
  path: string;
  /** Placeholder key / display hint; defaults to the file's basename. */
  name?: string;
  /** Token in `content` to replace with the image; defaults to `{{attach:<name>}}`. */
  placeholder?: string;
}

/**
 * Embed each attachment into `content` as a base64 data-URI `<img>`. If the body
 * contains the attachment's placeholder token it is substituted in place (so the
 * model controls position); otherwise the image is appended in its own paragraph.
 * Throws on an unreadable file or an unsupported (non-image) extension.
 */
export function inlineImagesIntoContent(
  content: string,
  attachments: InlineAttachment[],
): string {
  let out = content ?? "";

  for (const att of attachments) {
    const ext = extname(att.path).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) {
      throw new Error(
        `Unsupported inline image type "${ext || "(none)"}" for ${att.path}. ` +
          `Supported: ${SUPPORTED_IMAGE_EXTS.join(", ")}.`,
      );
    }

    let bytes: Buffer;
    try {
      bytes = readFileSync(att.path);
    } catch (e) {
      throw new Error(
        `Cannot read attachment file ${att.path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const img = `<img src="data:${mime};base64,${bytes.toString("base64")}">`;
    const name = att.name ?? basename(att.path);
    const token = att.placeholder ?? `{{attach:${name}}}`;

    if (out.includes(token)) {
      out = out.split(token).join(img);
    } else {
      out += `<p>${img}</p>`;
    }
  }

  return out;
}
