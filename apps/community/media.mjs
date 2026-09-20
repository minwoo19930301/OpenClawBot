import Busboy from "busboy";
import { createWriteStream } from "node:fs";
import { mkdir, chmod, unlink, stat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_DEFAULT = 12 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const AUDIO_TYPES = new Set(["audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/mp4", "video/mp4"]);

export const attachmentKind = (mime) => IMAGE_TYPES.has(mime) ? "image" : AUDIO_TYPES.has(mime) ? "audio" : null;
export const cleanFilename = (value) => {
  const base = String(value || "upload").replace(/[\\/\0\r\n]+/g, "_").replace(/[^\p{L}\p{N}._ ()-]/gu, "_").trim().slice(0, 180);
  return base || "upload";
};
const signature = (buf, mime) => {
  if (mime === "image/jpeg") return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === "image/png") return buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mime === "image/gif") return buf.subarray(0, 6).toString() === "GIF87a" || buf.subarray(0, 6).toString() === "GIF89a";
  if (mime === "image/webp") return buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP";
  if (mime === "audio/webm") return buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === "audio/ogg") return buf.subarray(0, 4).toString() === "OggS";
  if (mime === "audio/wav" || mime === "audio/x-wav") return buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WAVE";
  if (mime === "audio/mpeg" || mime === "audio/mp3") return (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) || buf.subarray(0, 3).toString() === "ID3";
  if (mime === "audio/mp4" || mime === "video/mp4") return buf.subarray(4, 8).toString() === "ftyp";
  return false;
};

export async function prepareMediaDir(dataDir) {
  const dir = join(dataDir, "media");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

export async function cleanupOrphans(db, mediaDir, ttlMs = 24 * 3600000) {
  const cutoff = Date.now() - ttlMs;
  const rows = db.prepare("SELECT id,path FROM attachments WHERE bound_at IS NULL AND created_at<?").all(cutoff);
  // Remove expired, unbound records synchronously before yielding, so a
  // concurrent message cannot bind an attachment whose file is being removed.
  const remove = db.prepare("DELETE FROM attachments WHERE id=? AND bound_at IS NULL AND created_at<?");
  const expired = rows.filter(row => remove.run(row.id,cutoff).changes === 1);
  for (const row of expired) await unlink(row.path).catch(() => {});
  for (const name of await readdir(mediaDir).catch(() => [])) {
    if (!name.startsWith(".upload-") && !/^[a-f0-9-]{36}$/.test(name)) continue;
    const path = join(mediaDir, name);
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs >= cutoff) continue;
    if (name.startsWith(".upload-") || !db.prepare("SELECT 1 FROM attachments WHERE id=?").get(name)) await unlink(path).catch(() => {});
  }
}

export function createUploadLimiter({ global = 4, perUser = 2 } = {}) {
  let total = 0;
  const users = new Map();
  return {
    async acquire(userId = "anonymous") {
      const current = users.get(userId) ?? 0;
      if (total >= global || current >= perUser) { const e = new Error("업로드 요청이 많습니다. 잠시 후 다시 시도해 주세요."); e.status = 429; throw e; }
      total++; users.set(userId, current + 1);
      let released = false;
      return () => { if (released) return; released = true; total--; const next = (users.get(userId) ?? 1) - 1; if (next) users.set(userId, next); else users.delete(userId); };
    },
  };
}

export async function receiveAttachment(req, { mediaDir, maxBytes = MAX_DEFAULT, userId = "anonymous", limiter = defaultLimiter }) {
  if (!(req.headers["content-type"] || "").toLowerCase().startsWith("multipart/form-data")) {
    const e = new Error("multipart/form-data 요청이 필요합니다."); e.status = 415; throw e;
  }
  const tempPath = join(mediaDir, `.upload-${randomUUID()}`);
  const release = await limiter.acquire(userId);
  if (req.destroyed || req.aborted || req.complete) {
    release();
    await unlink(tempPath).catch(() => {});
    const e = new Error("업로드 연결이 중단되었습니다."); e.status = 400; throw e;
  }
  let write;
  let streamRef;
  let busboy;
  let abortHandler;
  let requestErrorHandler;
  let writeDone = Promise.resolve();
  let fileSeen = false;
  let fileName = "upload";
  let declaredMime = "";
  let bytes = 0;
  let tooLarge = false;
  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => { if (settled) return; settled = true; err ? reject(err) : resolve(value); };
      let bb;
      try { bb = Busboy({ headers: req.headers, limits: { files: 1, fields: 2, parts: 3, fileSize: maxBytes } }); busboy = bb; }
      catch { const e = new Error("multipart 요청 형식을 확인해 주세요."); e.status = 400; return finish(e); }
      bb.on("file", (field, stream, info) => {
        if (field !== "file" || fileSeen) { stream.resume(); return; }
        fileSeen = true; fileName = cleanFilename(info.filename); declaredMime = String(info.mimeType || "").toLowerCase().split(";", 1)[0];
        streamRef = stream;
        write = createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
        writeDone = new Promise((resolveWrite, rejectWrite) => {
          write.once("close", resolveWrite);
          write.once("error", rejectWrite);
        });
        writeDone.catch(() => {});
        stream.on("data", (chunk) => { bytes += chunk.length; });
        stream.on("limit", () => { tooLarge = true; });
        stream.on("error", (e) => finish(e));
        write.on("error", (e) => finish(e));
        stream.pipe(write);
      });
      bb.on("error", (e) => finish(e));
      abortHandler = () => { if (req.complete) return; const e = new Error("업로드 연결이 중단되었습니다."); e.status = 400; req.unpipe(bb); streamRef?.destroy(); write?.destroy(); bb.destroy(e); finish(e); };
      requestErrorHandler = abortHandler;
      req.once("aborted", abortHandler);
      req.once("close", abortHandler);
      req.once("error", requestErrorHandler);
      if (req.destroyed || req.aborted || req.complete) { abortHandler(); return; }
      bb.on("partsLimit", () => { const e = new Error("multipart 요청이 너무 큽니다."); e.status = 413; finish(e); });
      bb.on("filesLimit", () => { const e = new Error("파일은 하나만 업로드할 수 있습니다."); e.status = 400; finish(e); });
      bb.on("finish", async () => {
        try { await writeDone; } catch (e) { return finish(e); }
        if (!fileSeen) { const e = new Error("file 필드가 필요합니다."); e.status = 400; return finish(e); }
        if (tooLarge || bytes > maxBytes) { const e = new Error("파일 크기 제한을 초과했습니다."); e.status = 413; return finish(e); }
        const kind = attachmentKind(declaredMime);
        if (!kind) { const e = new Error("지원하지 않는 이미지 또는 오디오 형식입니다."); e.status = 415; return finish(e); }
        try {
          const handle = await open(tempPath, "r");
          const head = Buffer.alloc(4100);
          let read;
          try { read = await handle.read(head, 0, head.length, 0); }
          finally { await handle.close(); }
          const sample = head.subarray(0, read.bytesRead);
          if (!signature(sample, declaredMime)) { const e = new Error("파일 내용과 MIME 형식이 일치하지 않습니다."); e.status = 415; return finish(e); }
        } catch (e) { return finish(e); }
        finish(null, { tempPath, fileName, declaredMime, kind, size: bytes });
      });
      req.pipe(bb);
    });
    await chmod(tempPath, 0o600);
    return result;
  } catch (e) {
    req.unpipe(busboy);
    busboy?.destroy();
    req.resume();
    streamRef?.destroy();
    write?.destroy();
    await writeDone.catch(() => {});
    await unlink(tempPath).catch(() => {});
    if (e.status) throw e;
    const err = new Error("업로드를 처리하지 못했습니다."); err.status = 400; throw err;
  } finally {
    if (abortHandler) req.removeListener("aborted", abortHandler);
    if (abortHandler) req.removeListener("close", abortHandler);
    if (requestErrorHandler) req.removeListener("error", requestErrorHandler);
    release();
  }
}

export async function finalizeAttachment(upload, mediaDir, id) {
  const path = join(mediaDir, id);
  await import("node:fs/promises").then(({ rename }) => rename(upload.tempPath, path));
  await chmod(path, 0o600);
  return path;
}

export { MAX_DEFAULT };

const defaultLimiter = createUploadLimiter();
