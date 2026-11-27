import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface AttachmentRow {
  id: string;
  case_id: string;
  uploader_uid: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  kind: 'image' | 'video' | 'file';
  storage_filename: string;
  access_token: string;
  created_at: string;
}

interface UploadSession {
  uploadId: string;
  caseId: string;
  uid: string;
  fileName: string;
  mimeType: string;
  kind: 'image' | 'video' | 'file';
  totalSize: number;
  totalChunks: number;
  tempDir: string;
  receivedChunks: Map<number, number>;
  createdAt: number;
}

const VALID_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const CHUNK_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB per chunk (well below 32 MB proxy limits)
const MAX_CHUNKS = 64;
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

const SAFE_INLINE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-m4v',
  'video/3gpp',
  'video/3gpp2',
  'video/x-matroska',
  'video/x-msvideo',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'application/pdf',
]);

const EXT_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
};

const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.avif',
  '.heic',
  '.heif',
]);

const VIDEO_EXTS = new Set([
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.ogv',
  '.3gp',
  '.3g2',
  '.mkv',
  '.avi',
]);

function loadFirebaseApiKey(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'firebase-applet-config.json'),
    path.resolve(__dirname, 'firebase-applet-config.json'),
  ];
  for (const cfgPath of candidates) {
    try {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      const parsed = JSON.parse(raw) as { apiKey?: string };
      if (parsed.apiKey) return parsed.apiKey;
    } catch {
      // try next candidate
    }
  }
  return '';
}

async function verifyFirebaseIdToken(
  authHeader: string | undefined,
  firebaseApiKey: string
): Promise<string | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ') || !firebaseApiKey) {
    return null;
  }
  const idToken = authHeader.slice('Bearer '.length).trim();
  if (!idToken || idToken.length > 8192) return null;

  try {
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { users?: Array<{ localId?: string }> };
    const uid = data.users?.[0]?.localId;
    return typeof uid === 'string' && VALID_ID_RE.test(uid) ? uid : null;
  } catch {
    return null;
  }
}

function sanitizeFileName(rawHeader: string | undefined): string {
  let decoded = 'attachment';
  if (rawHeader) {
    try {
      decoded = decodeURIComponent(rawHeader);
    } catch {
      decoded = rawHeader;
    }
  }
  const cleaned = decoded
    .replace(/[\r\n\t\x00-\x1f/\\]/g, '_')
    .trim()
    .slice(0, 255);
  return cleaned || 'attachment';
}

function resolveMimeAndKind(
  fileName: string,
  rawMimeHeader: string | undefined
): { mimeType: string; kind: 'image' | 'video' | 'file' } {
  const cleanedRaw = String(rawMimeHeader ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
    .slice(0, 128);
  const ext = path.extname(fileName).toLowerCase();

  let mimeType = cleanedRaw;
  if (!mimeType || mimeType === 'application/octet-stream' || mimeType === 'binary/octet-stream') {
    mimeType = EXT_MIME_MAP[ext] ?? 'application/octet-stream';
  }
  if (!mimeType) {
    mimeType = 'application/octet-stream';
  }

  // Never treat SVG or active HTML/XML as inline image for XSS safety
  if (mimeType === 'image/svg+xml' || mimeType === 'text/html' || mimeType === 'application/xhtml+xml') {
    return { mimeType, kind: 'file' };
  }

  if (mimeType.startsWith('image/') || IMAGE_EXTS.has(ext)) {
    return { mimeType: mimeType.startsWith('image/') ? mimeType : EXT_MIME_MAP[ext] ?? 'image/png', kind: 'image' };
  }
  if (mimeType.startsWith('video/') || VIDEO_EXTS.has(ext)) {
    return { mimeType: mimeType.startsWith('video/') ? mimeType : EXT_MIME_MAP[ext] ?? 'video/mp4', kind: 'video' };
  }
  return { mimeType, kind: 'file' };
}

function safeContentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function isConfinedPath(baseDir: string, targetPath: string): boolean {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedBase + path.sep);
}

function resolveWritableDataDir(): string {
  const candidates = [
    path.resolve(process.cwd(), '.data'),
    path.join(os.tmpdir(), 'crm-desk-data'),
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
      const probeFile = path.join(dir, `.write-probe-${process.pid}`);
      fs.writeFileSync(probeFile, 'ok');
      fs.unlinkSync(probeFile);
      return dir;
    } catch {
      // Try fallback directory
    }
  }
  throw new Error('No writable directory found for attachment storage');
}

async function startServer(): Promise<void> {
  const app = express();
  const httpServer = http.createServer(app);
  const firebaseApiKey = loadFirebaseApiKey();

  // Persistent local storage for Internal Note attachments (with tmp fallback if .data is read-only)
  const dataDir = resolveWritableDataDir();
  const uploadsDir = path.resolve(dataDir, 'attachments');
  const tmpUploadsDir = path.resolve(dataDir, 'tmp');

  const db = new Database(path.join(dataDir, 'attachments.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_attachments (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      uploader_uid TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      kind TEXT NOT NULL,
      storage_filename TEXT NOT NULL,
      access_token TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_note_attachments_case ON note_attachments(case_id);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO note_attachments (
      id, case_id, uploader_uid, original_name, mime_type,
      size_bytes, kind, storage_filename, access_token, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getStmt = db.prepare(`
    SELECT * FROM note_attachments WHERE id = ? AND case_id = ?
  `);
  const deleteStmt = db.prepare(`
    DELETE FROM note_attachments WHERE id = ? AND case_id = ?
  `);

  const uploadSessions = new Map<string, UploadSession>();

  const cleanupSession = (session: UploadSession): void => {
    uploadSessions.delete(session.uploadId);
    if (isConfinedPath(tmpUploadsDir, session.tempDir)) {
      try {
        fs.rmSync(session.tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  };

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const session of uploadSessions.values()) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        cleanupSession(session);
      }
    }
  }, 5 * 60 * 1000);
  cleanupTimer.unref();

  interface AuthenticatedRequest extends Request {
    authUid?: string;
  }

  const requireFirebaseAuth = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const uid = await verifyFirebaseIdToken(req.header('authorization'), firebaseApiKey);
    if (!uid) {
      res.status(401).json({ error: 'ไม่มีสิทธิ์อัปโหลดไฟล์ กรุณาเข้าสู่ระบบใหม่' });
      return;
    }
    req.authUid = uid;
    next();
  };

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, backend: 'firebase', time: new Date().toISOString() });
  });

  // 1) Initialize chunked upload (bypasses 32 MB Cloud Run / Nginx proxy limit for videos & large files)
  app.post(
    '/api/attachments/init',
    requireFirebaseAuth,
    express.json({ limit: '16kb' }),
    (req: AuthenticatedRequest, res) => {
      const uid = req.authUid;
      if (!uid) {
        res.status(401).json({ error: 'ไม่มีสิทธิ์อัปโหลดไฟล์ กรุณาเข้าสู่ระบบใหม่' });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const caseId = String(body.caseId ?? '').trim();
      if (!VALID_ID_RE.test(caseId)) {
        res.status(400).json({ error: 'รหัสเคสไม่ถูกต้อง' });
        return;
      }

      const totalSize = Number(body.totalSize);
      const totalChunks = Number(body.totalChunks);
      if (
        !Number.isInteger(totalSize) ||
        totalSize <= 0 ||
        totalSize > MAX_UPLOAD_BYTES
      ) {
        res.status(400).json({ error: 'ขนาดไฟล์ต้องอยู่ระหว่าง 1 ไบต์ ถึง 50 MB' });
        return;
      }
      if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_CHUNKS) {
        res.status(400).json({ error: 'จำนวนชิ้นส่วนไฟล์ไม่ถูกต้อง' });
        return;
      }

      const fileName = sanitizeFileName(typeof body.fileName === 'string' ? body.fileName : undefined);
      const { mimeType, kind } = resolveMimeAndKind(
        fileName,
        typeof body.mimeType === 'string' ? body.mimeType : undefined
      );

      const uploadId = crypto.randomUUID();
      const tempDir = path.resolve(tmpUploadsDir, uploadId);
      if (!isConfinedPath(tmpUploadsDir, tempDir)) {
        res.status(400).json({ error: 'เส้นทางจัดเก็บชั่วคราวไม่ถูกต้อง' });
        return;
      }

      try {
        fs.mkdirSync(tempDir, { recursive: true });
      } catch (err) {
        console.error('Failed to create temp upload dir:', err);
        res.status(500).json({ error: 'ไม่สามารถเตรียมพื้นที่อัปโหลดไฟล์ได้' });
        return;
      }

      uploadSessions.set(uploadId, {
        uploadId,
        caseId,
        uid,
        fileName,
        mimeType,
        kind,
        totalSize,
        totalChunks,
        tempDir,
        receivedChunks: new Map(),
        createdAt: Date.now(),
      });

      res.status(201).json({ uploadId, chunkSize: CHUNK_SIZE_BYTES });
    }
  );

  // 2) Upload individual chunk (<= 2 MB each)
  app.post(
    '/api/attachments/chunk',
    requireFirebaseAuth,
    express.raw({ limit: '4mb', type: () => true }),
    (req: AuthenticatedRequest, res) => {
      const uid = req.authUid;
      const uploadId = String(req.header('x-upload-id') ?? '').trim();
      const chunkIndex = Number(req.header('x-chunk-index'));

      if (!VALID_ID_RE.test(uploadId)) {
        res.status(400).json({ error: 'รหัส session อัปโหลดไม่ถูกต้อง' });
        return;
      }

      const session = uploadSessions.get(uploadId);
      if (!session) {
        res.status(404).json({ error: 'ไม่พบ session อัปโหลด หรือหมดเวลาแล้ว กรุณาลองใหม่' });
        return;
      }

      if (session.uid !== uid) {
        res.status(403).json({ error: 'ไม่มีสิทธิ์อัปโหลดในรายการนี้' });
        return;
      }

      if (
        !Number.isInteger(chunkIndex) ||
        chunkIndex < 0 ||
        chunkIndex >= session.totalChunks
      ) {
        res.status(400).json({ error: 'ลำดับชิ้นส่วนไฟล์ไม่ถูกต้อง' });
        return;
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: 'ไม่พบข้อมูลชิ้นส่วนไฟล์' });
        return;
      }

      if (req.body.length > CHUNK_SIZE_BYTES + 1024) {
        res.status(413).json({ error: 'ขนาดชิ้นส่วนไฟล์เกินกำหนด' });
        return;
      }

      let cumulative = req.body.length;
      for (const [idx, sz] of session.receivedChunks.entries()) {
        if (idx !== chunkIndex) cumulative += sz;
      }
      if (cumulative > session.totalSize || cumulative > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: 'ขนาดไฟล์รวมเกินกว่าที่กำหนด' });
        return;
      }

      const chunkPath = path.resolve(session.tempDir, `chunk_${chunkIndex}`);
      if (!isConfinedPath(session.tempDir, chunkPath)) {
        res.status(400).json({ error: 'เส้นทางชิ้นส่วนไฟล์ไม่ถูกต้อง' });
        return;
      }

      try {
        fs.writeFileSync(chunkPath, req.body);
        session.receivedChunks.set(chunkIndex, req.body.length);
        res.json({
          ok: true,
          received: session.receivedChunks.size,
          total: session.totalChunks,
        });
      } catch (err) {
        console.error('Failed to write upload chunk:', err);
        res.status(500).json({ error: 'ไม่สามารถบันทึกชิ้นส่วนไฟล์ได้' });
      }
    }
  );

  // 3) Finalize chunked upload & persist attachment
  app.post(
    '/api/attachments/complete',
    requireFirebaseAuth,
    express.json({ limit: '16kb' }),
    (req: AuthenticatedRequest, res) => {
      const uid = req.authUid;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const uploadId = String(body.uploadId ?? '').trim();

      if (!VALID_ID_RE.test(uploadId)) {
        res.status(400).json({ error: 'รหัส session อัปโหลดไม่ถูกต้อง' });
        return;
      }

      const session = uploadSessions.get(uploadId);
      if (!session) {
        res.status(404).json({ error: 'ไม่พบ session อัปโหลด หรือหมดเวลาแล้ว กรุณาลองใหม่' });
        return;
      }

      if (session.uid !== uid) {
        res.status(403).json({ error: 'ไม่มีสิทธิ์ยืนยันการอัปโหลดนี้' });
        return;
      }

      if (session.receivedChunks.size !== session.totalChunks) {
        res.status(400).json({ error: 'ยังได้รับชิ้นส่วนไฟล์ไม่ครบถ้วน กรุณาลองใหม่' });
        return;
      }

      const id = crypto.randomUUID();
      const accessToken = crypto.randomBytes(24).toString('hex');
      const rawExt = path.extname(session.fileName).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
      const storageFilename = `${id}${rawExt}`;
      const storagePath = path.resolve(uploadsDir, storageFilename);

      if (!isConfinedPath(uploadsDir, storagePath)) {
        cleanupSession(session);
        res.status(400).json({ error: 'เส้นทางจัดเก็บไฟล์ไม่ถูกต้อง' });
        return;
      }

      let outFd: number | null = null;
      let totalWritten = 0;

      try {
        outFd = fs.openSync(storagePath, 'w');
        for (let i = 0; i < session.totalChunks; i += 1) {
          const chunkPath = path.resolve(session.tempDir, `chunk_${i}`);
          if (!isConfinedPath(session.tempDir, chunkPath) || !fs.existsSync(chunkPath)) {
            throw new Error(`Missing chunk ${i}`);
          }
          const chunkBuf = fs.readFileSync(chunkPath);
          totalWritten += chunkBuf.length;
          if (totalWritten > MAX_UPLOAD_BYTES) {
            throw new Error('File exceeds maximum allowed size');
          }
          fs.writeSync(outFd, chunkBuf);
        }
        fs.closeSync(outFd);
        outFd = null;

        if (totalWritten !== session.totalSize) {
          throw new Error(`Size mismatch: expected ${session.totalSize}, got ${totalWritten}`);
        }

        insertStmt.run(
          id,
          session.caseId,
          session.uid,
          session.fileName,
          session.mimeType,
          totalWritten,
          session.kind,
          storageFilename,
          accessToken,
          new Date().toISOString()
        );

        cleanupSession(session);

        res.status(201).json({
          id,
          name: session.fileName,
          mime_type: session.mimeType,
          size_bytes: totalWritten,
          kind: session.kind,
          url: `/api/attachments/${encodeURIComponent(session.caseId)}/${encodeURIComponent(id)}?token=${accessToken}`,
        });
      } catch (err) {
        if (outFd !== null) {
          try {
            fs.closeSync(outFd);
          } catch {
            // ignore close error
          }
        }
        if (fs.existsSync(storagePath)) {
          try {
            fs.unlinkSync(storagePath);
          } catch {
            // ignore cleanup error
          }
        }
        cleanupSession(session);
        console.error('Failed to assemble chunked attachment:', err);
        res.status(500).json({ error: 'ไม่สามารถรวมและบันทึกไฟล์แนบได้' });
      }
    }
  );

  // Single-shot upload (authenticated via Firebase ID token, ideal for <= 16 MB files)
  app.post(
    '/api/attachments',
    requireFirebaseAuth,
    express.raw({ limit: '24mb', type: () => true }),
    (req: AuthenticatedRequest, res) => {
      const uid = req.authUid;
      if (!uid) {
        res.status(401).json({ error: 'ไม่มีสิทธิ์อัปโหลดไฟล์ กรุณาเข้าสู่ระบบใหม่' });
        return;
      }

      const caseId = String(req.header('x-case-id') ?? '').trim();
      if (!VALID_ID_RE.test(caseId)) {
        res.status(400).json({ error: 'รหัสเคสไม่ถูกต้อง' });
        return;
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: 'ไม่พบข้อมูลไฟล์ที่อัปโหลด' });
        return;
      }

      if (req.body.length > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: 'ไฟล์มีขนาดใหญ่เกิน 50 MB' });
        return;
      }

      const fileName = sanitizeFileName(req.header('x-file-name'));
      const { mimeType, kind } = resolveMimeAndKind(fileName, req.header('content-type'));

      const id = crypto.randomUUID();
      const accessToken = crypto.randomBytes(24).toString('hex');
      const rawExt = path.extname(fileName).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
      const storageFilename = `${id}${rawExt}`;
      const storagePath = path.resolve(uploadsDir, storageFilename);

      if (!isConfinedPath(uploadsDir, storagePath)) {
        res.status(400).json({ error: 'เส้นทางจัดเก็บไฟล์ไม่ถูกต้อง' });
        return;
      }

      try {
        fs.writeFileSync(storagePath, req.body);
        insertStmt.run(
          id,
          caseId,
          uid,
          fileName,
          mimeType,
          req.body.length,
          kind,
          storageFilename,
          accessToken,
          new Date().toISOString()
        );

        res.status(201).json({
          id,
          name: fileName,
          mime_type: mimeType,
          size_bytes: req.body.length,
          kind,
          url: `/api/attachments/${encodeURIComponent(caseId)}/${encodeURIComponent(id)}?token=${accessToken}`,
        });
      } catch (err) {
        console.error('Failed to store attachment:', err);
        res.status(500).json({ error: 'ไม่สามารถบันทึกไฟล์แนบได้' });
      }
    }
  );

  // Download or stream attachment (supports Range requests for video playback)
  app.get('/api/attachments/:caseId/:attachmentId', (req, res) => {
    const { caseId, attachmentId } = req.params;
    if (!VALID_ID_RE.test(caseId) || !VALID_ID_RE.test(attachmentId)) {
      res.status(400).send('Invalid attachment ID');
      return;
    }

    const token = String(req.query.token ?? '');
    if (!token) {
      res.status(403).send('Missing access token');
      return;
    }

    const row = getStmt.get(attachmentId, caseId) as AttachmentRow | undefined;
    if (!row) {
      res.status(404).send('Attachment not found');
      return;
    }

    const expectedBuf = Buffer.from(row.access_token, 'utf8');
    const providedBuf = Buffer.from(token, 'utf8');
    if (
      expectedBuf.length !== providedBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, providedBuf)
    ) {
      res.status(403).send('Invalid access token');
      return;
    }

    const filePath = path.resolve(uploadsDir, path.basename(row.storage_filename));
    if (!isConfinedPath(uploadsDir, filePath) || !fs.existsSync(filePath)) {
      res.status(404).send('Attachment file missing');
      return;
    }

    const forceDownload = req.query.download === '1';
    const allowInline = !forceDownload && SAFE_INLINE_MIMES.has(row.mime_type);
    const disposition = safeContentDisposition(
      allowInline ? 'inline' : 'attachment',
      row.original_name
    );

    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(filePath, { dotfiles: 'allow' });
  });

  // Delete attachment (when Admin deletes note or removes attachment)
  app.delete('/api/attachments/:caseId/:attachmentId', async (req, res) => {
    const uid = await verifyFirebaseIdToken(req.header('authorization'), firebaseApiKey);
    if (!uid) {
      res.status(401).json({ error: 'ไม่มีสิทธิ์ลบไฟล์แนบ' });
      return;
    }

    const { caseId, attachmentId } = req.params;
    if (!VALID_ID_RE.test(caseId) || !VALID_ID_RE.test(attachmentId)) {
      res.status(400).json({ error: 'รหัสไฟล์แนบไม่ถูกต้อง' });
      return;
    }

    const row = getStmt.get(attachmentId, caseId) as AttachmentRow | undefined;
    if (row) {
      const filePath = path.resolve(uploadsDir, path.basename(row.storage_filename));
      if (isConfinedPath(uploadsDir, filePath) && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore disk unlink race
        }
      }
      deleteStmt.run(attachmentId, caseId);
    }

    res.json({ ok: true });
  });

  // JSON error handler for /api/* routes (prevents Express HTML error pages on PayloadTooLargeError etc.)
  app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: number; statusCode?: number; type?: string; message?: string };
    const status = e.statusCode ?? e.status ?? 500;
    if (status === 413 || e.type === 'entity.too.large') {
      res.status(413).json({ error: 'ไฟล์หรือชิ้นส่วนมีขนาดใหญ่เกินกำหนด' });
      return;
    }
    console.error('API error:', err);
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: e.message || 'เกิดข้อผิดพลาดในการประมวลผลคำขอ',
    });
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found');
      }
    });
  }

  const port = Number(process.env.PORT) || 3000;
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`CRM Desk server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
