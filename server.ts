import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

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

const VALID_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

const SAFE_INLINE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'application/pdf',
]);

function loadFirebaseApiKey(): string {
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw) as { apiKey?: string };
    return parsed.apiKey ?? '';
  } catch {
    return '';
  }
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

function safeContentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function startServer(): Promise<void> {
  const app = express();
  const httpServer = http.createServer(app);
  const firebaseApiKey = loadFirebaseApiKey();

  // Persistent local storage for Internal Note attachments (images, videos, files)
  const dataDir = path.resolve(process.cwd(), '.data');
  const uploadsDir = path.join(dataDir, 'attachments');
  fs.mkdirSync(uploadsDir, { recursive: true });

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

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, backend: 'firebase', time: new Date().toISOString() });
  });

  // Upload attachment (authenticated via Firebase ID token)
  app.post(
    '/api/attachments',
    express.raw({ limit: '52mb', type: () => true }),
    async (req, res) => {
      const uid = await verifyFirebaseIdToken(req.header('authorization'), firebaseApiKey);
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
      const rawMime = String(req.header('content-type') ?? 'application/octet-stream')
        .split(';')[0]
        .trim()
        .toLowerCase()
        .slice(0, 128);
      const mimeType = rawMime || 'application/octet-stream';

      const kind: 'image' | 'video' | 'file' = mimeType.startsWith('image/')
        ? 'image'
        : mimeType.startsWith('video/')
          ? 'video'
          : 'file';

      const id = crypto.randomUUID();
      const accessToken = crypto.randomBytes(24).toString('hex');
      const rawExt = path.extname(fileName).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
      const storageFilename = `${id}${rawExt}`;
      const storagePath = path.join(uploadsDir, storageFilename);

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
    if (!fs.existsSync(filePath)) {
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
    res.sendFile(filePath);
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
      if (fs.existsSync(filePath)) {
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
