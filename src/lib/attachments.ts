import { auth } from './firebase.ts';
import type { NoteAttachment } from '../types.ts';

export const MAX_NOTE_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

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
    throw new Error(`ไฟล์ "${file.name}" มีขนาด 0 ไบต์ ไม่สามารถอัปโหลดได้`);
  }
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new Error(`ไฟล์ "${file.name}" มีขนาดใหญ่เกิน 50 MB`);
  }

  const idToken = await user.getIdToken();
  const mimeType = (file.type || 'application/octet-stream').slice(0, 128);
  const safeName = (file.name || 'attachment').slice(0, 255);

  return new Promise<NoteAttachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/attachments', true);
    xhr.setRequestHeader('Authorization', `Bearer ${idToken}`);
    xhr.setRequestHeader('X-Case-Id', caseId);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(safeName));
    xhr.setRequestHeader('Content-Type', mimeType);

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable && onProgress) {
        onProgress(Math.min(100, Math.round((evt.loaded / evt.total) * 100)));
      }
    };

    xhr.onload = () => {
      try {
        const parsed = JSON.parse(xhr.responseText || '{}') as Partial<NoteAttachment> & {
          error?: string;
        };
        if (xhr.status >= 200 && xhr.status < 300 && parsed.id && parsed.url) {
          resolve({
            id: String(parsed.id),
            name: String(parsed.name ?? safeName).slice(0, 255),
            mime_type: String(parsed.mime_type ?? mimeType).slice(0, 128),
            size_bytes: Number(parsed.size_bytes ?? file.size),
            kind:
              parsed.kind === 'image' || parsed.kind === 'video' || parsed.kind === 'file'
                ? parsed.kind
                : mimeType.startsWith('image/')
                  ? 'image'
                  : mimeType.startsWith('video/')
                    ? 'video'
                    : 'file',
            url: String(parsed.url).slice(0, 1024),
          });
          return;
        }
        reject(new Error(parsed.error || 'ไม่สามารถอัปโหลดไฟล์แนบได้'));
      } catch {
        reject(new Error('ไม่สามารถอัปโหลดไฟล์แนบได้'));
      }
    };

    xhr.onerror = () => {
      reject(new Error('การเชื่อมต่ออัปโหลดไฟล์ขัดข้อง กรุณาลองใหม่อีกครั้ง'));
    };

    xhr.send(file);
  });
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
