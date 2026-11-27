import { auth } from './firebase.ts';
import type { AttachmentKind, NoteAttachment } from '../types.ts';

export const MAX_NOTE_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const SINGLE_SHOT_LIMIT_BYTES = 2 * 1024 * 1024; // 2 MB
const DEFAULT_CHUNK_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB per chunk

const EXT_MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
};

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif']);
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', '3gp', '3g2', 'mkv', 'avi']);

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function summarizeAttachments(attachments: NoteAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) return 'ไม่มีไฟล์แนบ';
  return attachments
    .map((a) => a.name)
    .join(', ')
    .slice(0, 1000);
}

export function getAttachmentDownloadUrl(att: NoteAttachment): string {
  if (!att.url) return '';
  if (att.url.startsWith('/api/attachments/')) {
    return att.url.includes('?') ? `${att.url}&download=1` : `${att.url}?download=1`;
  }
  return att.url;
}

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

function inferClientMimeAndKind(file: File): {
  safeName: string;
  mimeType: string;
  kind: AttachmentKind;
} {
  const rawType = (file.type || '').split(';')[0].trim().toLowerCase().slice(0, 128);
  let safeName = (file.name || '').trim().slice(0, 255);
  if (!safeName) {
    if (rawType.startsWith('image/')) {
      const ext = rawType.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'png';
      safeName = `pasted-image-${Date.now()}.${ext === 'jpeg' ? 'jpg' : ext}`;
    } else if (rawType.startsWith('video/')) {
      const ext = rawType.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'mp4';
      safeName = `video-${Date.now()}.${ext}`;
    } else {
      safeName = `attachment-${Date.now()}`;
    }
  }

  const ext = getFileExtension(safeName);
  let mimeType = rawType;
  if (!mimeType || mimeType === 'application/octet-stream' || mimeType === 'binary/octet-stream') {
    mimeType = EXT_MIME_MAP[ext] ?? 'application/octet-stream';
  }

  if (
    mimeType === 'image/svg+xml' ||
    mimeType === 'text/html' ||
    mimeType === 'application/xhtml+xml'
  ) {
    return { safeName, mimeType, kind: 'file' };
  }

  const kind: AttachmentKind =
    mimeType.startsWith('image/') || IMAGE_EXTS.has(ext)
      ? 'image'
      : mimeType.startsWith('video/') || VIDEO_EXTS.has(ext)
        ? 'video'
        : 'file';

  return { safeName, mimeType, kind };
}

function parseErrorFromResponse(status: number, bodyText: string, contentType: string | null): string {
  try {
    const parsed = JSON.parse(bodyText || '{}') as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    // non-JSON response (HTML from proxy/static host)
  }
  if (status === 401) {
    return 'สิทธิ์เข้าสู่ระบบหมดอายุ กรุณาเข้าสู่ระบบใหม่อีกครั้ง';
  }
  if (status === 413) {
    return 'ไฟล์มีขนาดเกินขีดจำกัดการส่งต่อครั้ง';
  }
  if (status === 404 || (contentType && contentType.includes('text/html') && status === 200)) {
    return 'ไม่พบบริการรับอัปโหลดไฟล์บนเซิร์ฟเวอร์ (/api/attachments)';
  }
  if (status >= 500) {
    return `เซิร์ฟเวอร์อัปโหลดไฟล์ขัดข้องชั่วคราว (HTTP ${status})`;
  }
  return status > 0
    ? `ไม่สามารถอัปโหลดไฟล์แนบได้ (HTTP ${status})`
    : 'ไม่สามารถอัปโหลดไฟล์แนบได้';
}

function normalizeUploadedAttachment(
  parsed: Partial<NoteAttachment>,
  fallbackName: string,
  fallbackMime: string,
  fallbackKind: AttachmentKind,
  fallbackSize: number
): NoteAttachment {
  if (!parsed.id || !parsed.url) {
    throw new Error('ข้อมูลไฟล์แนบที่ได้รับจากเซิร์ฟเวอร์ไม่สมบูรณ์');
  }
  return {
    id: String(parsed.id),
    name: String(parsed.name ?? fallbackName).slice(0, 255),
    mime_type: String(parsed.mime_type ?? fallbackMime).slice(0, 128),
    size_bytes: Number(parsed.size_bytes ?? fallbackSize),
    kind:
      parsed.kind === 'image' || parsed.kind === 'video' || parsed.kind === 'file'
        ? parsed.kind
        : fallbackKind,
    url: String(parsed.url).slice(0, 1024),
  };
}

class HttpStatusError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function uploadSingleShot(
  caseId: string,
  file: File,
  idToken: string,
  safeName: string,
  mimeType: string,
  fallbackKind: AttachmentKind,
  onProgress?: (percent: number) => void
): Promise<NoteAttachment> {
  return new Promise<NoteAttachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/attachments', true);
    xhr.setRequestHeader('Authorization', `Bearer ${idToken}`);
    xhr.setRequestHeader('X-Case-Id', caseId);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(safeName));
    xhr.setRequestHeader('Content-Type', mimeType);

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable && onProgress) {
        onProgress(Math.min(99, Math.round((evt.loaded / evt.total) * 100)));
      }
    };

    xhr.onload = () => {
      const contentType = xhr.getResponseHeader('content-type');
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const parsed = JSON.parse(xhr.responseText || '{}') as Partial<NoteAttachment> & {
            error?: string;
          };
          if (parsed.id && parsed.url) {
            onProgress?.(100);
            resolve(
              normalizeUploadedAttachment(parsed, safeName, mimeType, fallbackKind, file.size)
            );
            return;
          }
          reject(
            new HttpStatusError(
              xhr.status,
              parseErrorFromResponse(xhr.status, xhr.responseText, contentType)
            )
          );
          return;
        } catch {
          reject(
            new HttpStatusError(
              xhr.status,
              parseErrorFromResponse(xhr.status, xhr.responseText, contentType)
            )
          );
          return;
        }
      }
      reject(
        new HttpStatusError(
          xhr.status,
          parseErrorFromResponse(xhr.status, xhr.responseText, contentType)
        )
      );
    };

    xhr.onerror = () => {
      reject(new Error('การเชื่อมต่ออัปโหลดไฟล์ขัดข้อง กรุณาลองใหม่อีกครั้ง'));
    };

    xhr.send(file);
  });
}

function sendChunkXhr(
  uploadId: string,
  chunkIndex: number,
  chunkBlob: Blob,
  idToken: string,
  onChunkProgress: (loaded: number) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/attachments/chunk', true);
    xhr.setRequestHeader('Authorization', `Bearer ${idToken}`);
    xhr.setRequestHeader('X-Upload-Id', uploadId);
    xhr.setRequestHeader('X-Chunk-Index', String(chunkIndex));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) {
        onChunkProgress(evt.loaded);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onChunkProgress(chunkBlob.size);
        resolve();
        return;
      }
      reject(
        new HttpStatusError(
          xhr.status,
          parseErrorFromResponse(
            xhr.status,
            xhr.responseText,
            xhr.getResponseHeader('content-type')
          )
        )
      );
    };

    xhr.onerror = () => {
      reject(new Error('การเชื่อมต่ออัปโหลดไฟล์ขัดข้องระหว่างส่งข้อมูล'));
    };

    xhr.send(chunkBlob);
  });
}

async function uploadChunked(
  caseId: string,
  file: File,
  idToken: string,
  safeName: string,
  mimeType: string,
  fallbackKind: AttachmentKind,
  chunkSizeBytes: number,
  onProgress?: (percent: number) => void
): Promise<NoteAttachment> {
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSizeBytes));
  const initResp = await fetch('/api/attachments/init', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      caseId,
      fileName: safeName,
      mimeType,
      totalSize: file.size,
      totalChunks,
    }),
  });

  const initText = await initResp.text();
  if (!initResp.ok) {
    throw new HttpStatusError(
      initResp.status,
      parseErrorFromResponse(initResp.status, initText, initResp.headers.get('content-type'))
    );
  }

  let initData: { uploadId?: string; chunkSize?: number } = {};
  try {
    initData = JSON.parse(initText) as { uploadId?: string; chunkSize?: number };
  } catch {
    throw new Error(
      parseErrorFromResponse(initResp.status, initText, initResp.headers.get('content-type'))
    );
  }

  if (!initData.uploadId) {
    throw new Error('ไม่พบรหัส session สำหรับอัปโหลดไฟล์');
  }

  const effectiveChunkSize = Math.min(chunkSizeBytes, initData.chunkSize || chunkSizeBytes);
  const actualTotalChunks = Math.max(1, Math.ceil(file.size / effectiveChunkSize));
  if (actualTotalChunks !== totalChunks) {
    throw new Error('ขนาดชิ้นส่วนไฟล์ไม่สอดคล้องกัน กรุณาลองใหม่อีกครั้ง');
  }

  let uploadedBaseBytes = 0;
  for (let idx = 0; idx < totalChunks; idx += 1) {
    const start = idx * effectiveChunkSize;
    const end = Math.min(file.size, start + effectiveChunkSize);
    const slice = file.slice(start, end);

    await sendChunkXhr(initData.uploadId, idx, slice, idToken, (loadedInChunk) => {
      if (onProgress) {
        const totalLoaded = Math.min(file.size, uploadedBaseBytes + loadedInChunk);
        onProgress(Math.min(98, Math.round((totalLoaded / file.size) * 100)));
      }
    });
    uploadedBaseBytes = end;
  }

  const completeResp = await fetch('/api/attachments/complete', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uploadId: initData.uploadId }),
  });

  const completeText = await completeResp.text();
  if (!completeResp.ok) {
    throw new HttpStatusError(
      completeResp.status,
      parseErrorFromResponse(
        completeResp.status,
        completeText,
        completeResp.headers.get('content-type')
      )
    );
  }

  let completeData: Partial<NoteAttachment> = {};
  try {
    completeData = JSON.parse(completeText) as Partial<NoteAttachment>;
  } catch {
    throw new Error(
      parseErrorFromResponse(
        completeResp.status,
        completeText,
        completeResp.headers.get('content-type')
      )
    );
  }

  onProgress?.(100);
  return normalizeUploadedAttachment(
    completeData,
    safeName,
    mimeType,
    fallbackKind,
    file.size
  );
}

export async function uploadNoteAttachment(
  caseId: string,
  file: File,
  onProgress?: (percent: number) => void
): Promise<NoteAttachment> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('กรุณาเข้าสู่ระบบก่อนอัปโหลดไฟล์');
  }
  if (file.size === 0) {
    throw new Error(`ไฟล์ "${file.name || 'ที่เลือก'}" มีขนาด 0 ไบต์ ไม่สามารถอัปโหลดได้`);
  }
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new Error(`ไฟล์ "${file.name}" มีขนาดใหญ่เกิน 50 MB`);
  }

  const idToken = await user.getIdToken();
  const { safeName, mimeType, kind } = inferClientMimeAndKind(file);

  if (file.size > SINGLE_SHOT_LIMIT_BYTES) {
    return uploadChunked(
      caseId,
      file,
      idToken,
      safeName,
      mimeType,
      kind,
      DEFAULT_CHUNK_SIZE_BYTES,
      onProgress
    );
  }

  try {
    return await uploadSingleShot(caseId, file, idToken, safeName, mimeType, kind, onProgress);
  } catch (err) {
    // Fallback to smaller 512 KB chunks if a strict proxy rejects single-shot payloads with 413
    if (err instanceof HttpStatusError && err.status === 413) {
      return uploadChunked(
        caseId,
        file,
        idToken,
        safeName,
        mimeType,
        kind,
        512 * 1024,
        onProgress
      );
    }
    throw err;
  }
}

export async function deleteServerAttachment(caseId: string, attachmentId: string): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  try {
    const idToken = await user.getIdToken();
    await fetch(
      `/api/attachments/${encodeURIComponent(caseId)}/${encodeURIComponent(attachmentId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${idToken}` },
      }
    );
  } catch {
    // Best-effort cleanup on server disk
  }
}
