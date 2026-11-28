import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
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

interface FirebaseServerConfig {
  apiKey: string;
  projectId: string;
  firestoreDatabaseId: string;
}

interface VerifiedFirebaseToken {
  uid: string;
  email: string;
  emailVerified: boolean;
  idToken: string;
}

interface VerifiedStaffUser extends VerifiedFirebaseToken {
  role: string;
  teamId: string;
  displayName: string;
}

interface TeamWebhookRow {
  team_id: string;
  webhook_url: string;
  enabled: number;
  events_json: string;
  last_status: string | null;
  last_error: string | null;
  last_sent_at: string | null;
  updated_by: string;
  updated_at: string;
}

type WebhookEventType = 'escalation' | 'mention' | 'sla_due' | 'sla_overdue';
const ALLOWED_WEBHOOK_EVENTS = new Set<WebhookEventType>([
  'escalation',
  'mention',
  'sla_due',
  'sla_overdue',
]);
const DEDUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function loadFirebaseServerConfig(): FirebaseServerConfig {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'firebase-applet-config.json'),
    path.resolve(__dirname, 'firebase-applet-config.json'),
  ];
  for (const cfgPath of candidates) {
    try {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<FirebaseServerConfig>;
      if (parsed.apiKey && parsed.projectId && parsed.firestoreDatabaseId) {
        return {
          apiKey: parsed.apiKey,
          projectId: parsed.projectId,
          firestoreDatabaseId: parsed.firestoreDatabaseId,
        };
      }
    } catch {
      // try next candidate
    }
  }
  return { apiKey: '', projectId: '', firestoreDatabaseId: '' };
}

async function verifyFirebaseTokenDetails(
  authHeader: string | undefined,
  firebaseApiKey: string
): Promise<VerifiedFirebaseToken | null> {
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
    const data = (await resp.json()) as {
      users?: Array<{ localId?: string; email?: string; emailVerified?: boolean }>;
    };
    const user = data.users?.[0];
    const uid = user?.localId;
    if (typeof uid !== 'string' || !VALID_ID_RE.test(uid)) return null;
    return {
      uid,
      email: String(user?.email ?? '').trim().toLowerCase(),
      emailVerified: Boolean(user?.emailVerified),
      idToken,
    };
  } catch {
    return null;
  }
}

async function verifyFirebaseIdToken(
  authHeader: string | undefined,
  firebaseApiKey: string
): Promise<string | null> {
  const details = await verifyFirebaseTokenDetails(authHeader, firebaseApiKey);
  return details?.uid ?? null;
}

async function fetchActiveStaffProfile(
  tokenInfo: VerifiedFirebaseToken,
  cfg: FirebaseServerConfig
): Promise<VerifiedStaffUser | null> {
  if (!cfg.projectId || !cfg.firestoreDatabaseId) return null;
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      cfg.projectId
    )}/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents/users/${encodeURIComponent(
      tokenInfo.uid
    )}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${tokenInfo.idToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const docData = (await resp.json()) as {
      fields?: Record<string, { stringValue?: string; booleanValue?: boolean }>;
    };
    const fields = docData.fields;
    if (!fields || fields.is_active?.booleanValue !== true) return null;
    return {
      ...tokenInfo,
      role: String(fields.role?.stringValue ?? 'agent'),
      teamId: String(fields.team_id?.stringValue ?? ''),
      displayName: String(fields.display_name?.stringValue ?? ''),
    };
  } catch {
    return null;
  }
}

async function isFirebaseAdminUser(
  tokenInfo: VerifiedFirebaseToken,
  cfg: FirebaseServerConfig
): Promise<boolean> {
  if (tokenInfo.emailVerified && tokenInfo.email === 'tanawin.wat@gmail.com') {
    return true;
  }
  if (!cfg.projectId || !cfg.firestoreDatabaseId) return false;
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      cfg.projectId
    )}/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents/admins/${encodeURIComponent(
      tokenInfo.uid
    )}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${tokenInfo.idToken}` },
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // Link-local / cloud metadata 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // Private 172.16.0.0/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 168) return true; // Private 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // Benchmark
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true; // Multicast & reserved
  return false;
}

function isPrivateOrReservedIp(ip: string): boolean {
  const clean = ip.trim().toLowerCase();
  const ipVersion = net.isIP(clean);
  if (ipVersion === 4) {
    return isPrivateOrReservedIpv4(clean);
  }
  if (ipVersion === 6) {
    if (clean === '::' || clean === '::1') return true;
    if (clean.startsWith('fc') || clean.startsWith('fd')) return true; // ULA fc00::/7
    if (clean.startsWith('fe8') || clean.startsWith('fe9') || clean.startsWith('fea') || clean.startsWith('feb')) {
      return true; // Link-local fe80::/10
    }
    if (clean.startsWith('ff')) return true; // Multicast
    if (clean.startsWith('::ffff:')) {
      const mapped = clean.slice('::ffff:'.length);
      if (net.isIP(mapped) === 4) {
        return isPrivateOrReservedIpv4(mapped);
      }
      return true;
    }
    return false;
  }
  return true;
}

async function validateAndCheckWebhookUrl(rawUrl: string): Promise<URL> {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 1024) {
    throw new Error('URL ของ Webhook ต้องมีความยาวไม่เกิน 1,024 ตัวอักษร');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('รูปแบบ Webhook URL ไม่ถูกต้อง');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook URL ต้องขึ้นต้นด้วย https:// เท่านั้น');
  }
  if (parsed.username || parsed.password) {
    throw new Error('ไม่อนุญาตให้ฝังข้อมูลยืนยันตัวตนใน Webhook URL');
  }
  if (parsed.port && parsed.port !== '443') {
    throw new Error('ไม่อนุญาตให้ระบุพอร์ตที่ไม่ใช่ HTTPS มาตรฐาน');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('ไม่อนุญาตให้ใช้ที่อยู่เครือข่ายภายในหรือ localhost');
  }

  if (net.isIP(hostname) !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error('ไม่อนุญาตให้ใช้ IP ภายในหรือ IP ต้องห้ามสำหรับ Webhook');
    }
    return parsed;
  }

  let resolved: Array<{ address: string }>;
  try {
    resolved = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error('ไม่สามารถตรวจสอบ DNS ของโดเมน Webhook URL ได้');
  }
  if (!resolved || resolved.length === 0) {
    throw new Error('ไม่พบที่อยู่ปลายทางของโดเมน Webhook URL');
  }
  for (const entry of resolved) {
    if (isPrivateOrReservedIp(entry.address)) {
      throw new Error('โดเมนของ Webhook ชี้ไปยัง IP เครือข่ายภายในที่ไม่อนุญาต');
    }
  }
  return parsed;
}

function maskWebhookUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const tail = pathParts.length > 0 ? pathParts[pathParts.length - 1] : '';
    const visibleTail = tail.length > 6 ? `...${tail.slice(-4)}` : '...';
    const prefix = pathParts.length > 1 ? `/${pathParts.slice(0, -1).join('/')}` : '';
    return `${parsed.origin}${prefix}/${visibleTail}`;
  } catch {
    return '***';
  }
}

function sanitizeSafeHttpUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().slice(0, 1000);
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {
    // ignore invalid URL
  }
  return '';
}

function parseWebhookEvents(rawJson: string): WebhookEventType[] {
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is WebhookEventType =>
      typeof item === 'string' && ALLOWED_WEBHOOK_EVENTS.has(item as WebhookEventType)
    );
  } catch {
    return [];
  }
}

function serializeTeamWebhookRow(row: TeamWebhookRow) {
  return {
    team_id: row.team_id,
    has_webhook: Boolean(row.webhook_url),
    masked_url: row.webhook_url ? maskWebhookUrl(row.webhook_url) : '',
    enabled: Boolean(row.enabled),
    events: parseWebhookEvents(row.events_json),
    last_status: row.last_status === 'success' || row.last_status === 'error' ? row.last_status : null,
    last_error: row.last_error ?? '',
    last_sent_at: row.last_sent_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function formatWebhookEventTitle(eventType: WebhookEventType): string {
  switch (eventType) {
    case 'escalation':
      return 'ส่งต่อเคส (Escalate)';
    case 'mention':
      return 'มีการแท็ก @Mention ใน Internal Note';
    case 'sla_due':
      return 'เคสถึงกำหนด SLA วันนี้';
    case 'sla_overdue':
      return 'เคสเกินกำหนด SLA';
  }
}

function getWebhookEventColor(eventType: WebhookEventType): { hex: string; int: number } {
  switch (eventType) {
    case 'escalation':
      return { hex: '#4338ca', int: 0x4338ca };
    case 'mention':
      return { hex: '#2563eb', int: 0x2563eb };
    case 'sla_due':
      return { hex: '#d97706', int: 0xd97706 };
    case 'sla_overdue':
      return { hex: '#dc2626', int: 0xdc2626 };
  }
}

function buildWebhookPayloadForTarget(
  targetUrl: URL,
  data: {
    eventType: WebhookEventType;
    title: string;
    message: string;
    teamId: string;
    caseId: string;
    caseNo: string;
    caseUrl: string;
    issueSummary: string;
    slaDueAt: string;
    actorName: string;
    notePreview: string;
    isTest?: boolean;
  }
): Record<string, unknown> {
  const host = targetUrl.hostname.toLowerCase();
  const color = getWebhookEventColor(data.eventType);
  const timestamp = new Date().toISOString();

  const lines = [
    `เคส: ${data.caseNo}${data.issueSummary ? ` — ${data.issueSummary}` : ''}`,
    ...(data.actorName ? [`ผู้ดำเนินการ: ${data.actorName}`] : []),
    ...(data.slaDueAt ? [`กำหนด SLA: ${data.slaDueAt}`] : []),
    ...(data.notePreview ? [`รายละเอียด: ${data.notePreview}`] : []),
    ...(data.caseUrl ? [`ลิงก์เคส: ${data.caseUrl}`] : []),
  ];
  const fullBody = [data.title, data.message, ...lines].filter(Boolean).join('\n');

  // Discord Webhook
  if (host === 'discord.com' || host.endsWith('.discord.com') || host === 'discordapp.com' || host.endsWith('.discordapp.com')) {
    return {
      username: 'CRM Desk',
      content: `**${data.title}**`,
      embeds: [
        {
          title: `${data.caseNo}${data.issueSummary ? ` — ${data.issueSummary}` : ''}`.slice(0, 250),
          description: data.message.slice(0, 1500),
          url: data.caseUrl || undefined,
          color: color.int,
          fields: [
            ...(data.actorName ? [{ name: 'ผู้ดำเนินการ', value: data.actorName, inline: true }] : []),
            ...(data.slaDueAt ? [{ name: 'กำหนด SLA', value: data.slaDueAt, inline: true }] : []),
            ...(data.notePreview ? [{ name: 'หมายเหตุ', value: data.notePreview.slice(0, 1000), inline: false }] : []),
          ],
          timestamp,
        },
      ],
    };
  }

  // Slack Webhook
  if (host === 'hooks.slack.com') {
    return {
      text: `${data.title}: ${data.caseNo}`,
      attachments: [
        {
          color: color.hex,
          title: `${data.title} — ${data.caseNo}`,
          title_link: data.caseUrl || undefined,
          text: [data.message, ...lines].filter(Boolean).join('\n'),
        },
      ],
    };
  }

  // Google Chat Webhook
  if (host === 'chat.googleapis.com') {
    return {
      text: `*${data.title}*\n${[data.message, ...lines].filter(Boolean).join('\n')}`,
    };
  }

  // Generic / n8n / Make / Rocket.Chat / Custom Webhook JSON
  return {
    event: data.isTest ? 'test' : data.eventType,
    title: data.title,
    message: data.message,
    text: fullBody,
    team_id: data.teamId,
    case_id: data.caseId,
    case_no: data.caseNo,
    case_url: data.caseUrl || null,
    issue_summary: data.issueSummary,
    sla_due_at: data.slaDueAt || null,
    actor_name: data.actorName || null,
    note_preview: data.notePreview || null,
    timestamp,
  };
}

async function deliverWebhookRequest(
  rawUrl: string,
  payloadInput: Parameters<typeof buildWebhookPayloadForTarget>[1]
): Promise<void> {
  const parsedUrl = await validateAndCheckWebhookUrl(rawUrl);
  const body = buildWebhookPayloadForTarget(parsedUrl, payloadInput);
  const resp = await fetch(parsedUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'CRMDesk-Webhook/1.0',
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}${errText ? `: ${errText.slice(0, 140)}` : ''}`);
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
  const firebaseCfg = loadFirebaseServerConfig();
  const firebaseApiKey = firebaseCfg.apiKey;

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
    CREATE TABLE IF NOT EXISTS team_webhooks (
      team_id TEXT PRIMARY KEY,
      webhook_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      events_json TEXT NOT NULL,
      last_status TEXT,
      last_error TEXT,
      last_sent_at TEXT,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_dedup (
      dedup_key TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
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

  const listWebhooksStmt = db.prepare(`SELECT * FROM team_webhooks`);
  const getWebhookStmt = db.prepare(`SELECT * FROM team_webhooks WHERE team_id = ?`);
  const upsertWebhookStmt = db.prepare(`
    INSERT INTO team_webhooks (
      team_id, webhook_url, enabled, events_json, last_status, last_error, last_sent_at, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(team_id) DO UPDATE SET
      webhook_url = excluded.webhook_url,
      enabled = excluded.enabled,
      events_json = excluded.events_json,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `);
  const updateWebhookStatusStmt = db.prepare(`
    UPDATE team_webhooks
    SET last_status = ?, last_error = ?, last_sent_at = ?
    WHERE team_id = ?
  `);
  const deleteWebhookStmt = db.prepare(`DELETE FROM team_webhooks WHERE team_id = ?`);
  const insertDedupStmt = db.prepare(`
    INSERT OR IGNORE INTO webhook_dedup (dedup_key, created_at) VALUES (?, ?)
  `);
  const pruneDedupStmt = db.prepare(`DELETE FROM webhook_dedup WHERE created_at < ?`);

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
    try {
      pruneDedupStmt.run(now - DEDUP_RETENTION_MS);
    } catch {
      // ignore dedup prune error
    }
  }, 5 * 60 * 1000);
  cleanupTimer.unref();

  interface AuthenticatedRequest extends Request {
    authUid?: string;
    staffUser?: VerifiedStaffUser;
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

  const requireActiveStaff = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const tokenInfo = await verifyFirebaseTokenDetails(req.header('authorization'), firebaseApiKey);
    if (!tokenInfo) {
      res.status(401).json({ error: 'กรุณาเข้าสู่ระบบใหม่ก่อนทำรายการ' });
      return;
    }
    const staff = await fetchActiveStaffProfile(tokenInfo, firebaseCfg);
    if (!staff) {
      res.status(403).json({ error: 'บัญชีของคุณยังไม่มีสิทธิ์ใช้งานในระบบ' });
      return;
    }
    req.authUid = staff.uid;
    req.staffUser = staff;
    next();
  };

  const requireAdminStaff = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const staff = req.staffUser;
    if (!staff) {
      res.status(401).json({ error: 'กรุณาเข้าสู่ระบบใหม่ก่อนทำรายการ' });
      return;
    }
    const isAdmin = await isFirebaseAdminUser(staff, firebaseCfg);
    if (!isAdmin) {
      res.status(403).json({ error: 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นที่จัดการ Webhook ได้' });
      return;
    }
    next();
  };

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, backend: 'firebase', time: new Date().toISOString() });
  });

  // ==================== ADMIN & TEAM WEBHOOK ROUTES ====================
  app.get('/api/admin/webhooks', requireActiveStaff, requireAdminStaff, (_req, res) => {
    const rows = listWebhooksStmt.all() as TeamWebhookRow[];
    res.json({ webhooks: rows.map(serializeTeamWebhookRow) });
  });

  app.put(
    '/api/admin/webhooks/:teamId',
    requireActiveStaff,
    requireAdminStaff,
    express.json({ limit: '16kb' }),
    async (req: AuthenticatedRequest, res) => {
      const teamId = String(req.params.teamId ?? '').trim();
      if (!VALID_ID_RE.test(teamId)) {
        res.status(400).json({ error: 'รหัสทีมไม่ถูกต้อง' });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawUrl = typeof body.webhook_url === 'string' ? body.webhook_url.trim() : '';
      const existingRow = getWebhookStmt.get(teamId) as TeamWebhookRow | undefined;

      let finalUrl = existingRow?.webhook_url ?? '';
      if (rawUrl) {
        try {
          const validated = await validateAndCheckWebhookUrl(rawUrl);
          finalUrl = validated.toString();
        } catch (err) {
          res.status(400).json({
            error: err instanceof Error ? err.message : 'Webhook URL ไม่ถูกต้อง',
          });
          return;
        }
      }

      if (!finalUrl) {
        res.status(400).json({ error: 'กรุณาระบุ Webhook URL (https://...)' });
        return;
      }

      const enabled = body.enabled !== false;
      const rawEvents = Array.isArray(body.events) ? body.events : [];
      const events = rawEvents.filter((item): item is WebhookEventType =>
        typeof item === 'string' && ALLOWED_WEBHOOK_EVENTS.has(item as WebhookEventType)
      );
      const uniqueEvents = Array.from(new Set(events));
      const nowIso = new Date().toISOString();

      upsertWebhookStmt.run(
        teamId,
        finalUrl,
        enabled ? 1 : 0,
        JSON.stringify(uniqueEvents),
        req.authUid ?? '',
        nowIso
      );

      const saved = getWebhookStmt.get(teamId) as TeamWebhookRow;
      res.json({ webhook: serializeTeamWebhookRow(saved) });
    }
  );

  app.delete(
    '/api/admin/webhooks/:teamId',
    requireActiveStaff,
    requireAdminStaff,
    (req, res) => {
      const teamId = String(req.params.teamId ?? '').trim();
      if (!VALID_ID_RE.test(teamId)) {
        res.status(400).json({ error: 'รหัสทีมไม่ถูกต้อง' });
        return;
      }
      deleteWebhookStmt.run(teamId);
      res.json({ ok: true });
    }
  );

  app.post(
    '/api/admin/webhooks/:teamId/test',
    requireActiveStaff,
    requireAdminStaff,
    express.json({ limit: '16kb' }),
    async (req: AuthenticatedRequest, res) => {
      const teamId = String(req.params.teamId ?? '').trim();
      if (!VALID_ID_RE.test(teamId)) {
        res.status(400).json({ ok: false, error: 'รหัสทีมไม่ถูกต้อง' });
        return;
      }

      const row = getWebhookStmt.get(teamId) as TeamWebhookRow | undefined;
      if (!row || !row.webhook_url) {
        res.status(404).json({ ok: false, error: 'ยังไม่ได้บันทึก Webhook URL สำหรับทีมนี้' });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const teamName = String(body.teamName ?? teamId).trim().slice(0, 80) || teamId;
      const nowIso = new Date().toISOString();

      try {
        await deliverWebhookRequest(row.webhook_url, {
          eventType: 'mention',
          title: `ทดสอบแจ้งเตือน Webhook — ทีม ${teamName}`,
          message: 'การเชื่อมต่อห้องแชทกับ CRM Desk สำเร็จ พร้อมรับแจ้งเตือน Escalate, @Mention และ SLA',
          teamId,
          caseId: 'test',
          caseNo: 'CRM-TEST-001',
          caseUrl: '',
          issueSummary: 'ข้อความทดสอบการเชื่อมต่อ Webhook',
          slaDueAt: new Date().toISOString().slice(0, 10),
          actorName: req.staffUser?.displayName || 'Admin',
          notePreview: 'ทดสอบส่งจากหน้าจัดการทีม CRM Desk',
          isTest: true,
        });
        updateWebhookStatusStmt.run('success', '', nowIso, teamId);
        const updated = getWebhookStmt.get(teamId) as TeamWebhookRow;
        res.json({ ok: true, webhook: serializeTeamWebhookRow(updated) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'ไม่สามารถส่งข้อความทดสอบได้';
        updateWebhookStatusStmt.run('error', msg.slice(0, 300), nowIso, teamId);
        const updated = getWebhookStmt.get(teamId) as TeamWebhookRow;
        res.status(502).json({ ok: false, error: msg, webhook: serializeTeamWebhookRow(updated) });
      }
    }
  );

  app.post(
    '/api/webhooks/dispatch',
    requireActiveStaff,
    express.json({ limit: '32kb' }),
    async (req: AuthenticatedRequest, res) => {
      const staff = req.staffUser;
      if (!staff) {
        res.status(401).json({ error: 'กรุณาเข้าสู่ระบบใหม่' });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const eventType = String(body.eventType ?? '') as WebhookEventType;
      if (!ALLOWED_WEBHOOK_EVENTS.has(eventType)) {
        res.status(400).json({ error: 'ประเภทเหตุการณ์ไม่ถูกต้อง' });
        return;
      }

      const rawTeamIds = Array.isArray(body.teamIds) ? body.teamIds : [];
      const teamIds = Array.from(
        new Set(
          rawTeamIds
            .filter((t): t is string => typeof t === 'string' && VALID_ID_RE.test(t.trim()))
            .map((t) => t.trim())
        )
      ).slice(0, 20);

      if (teamIds.length === 0) {
        res.json({ ok: true, sent: 0 });
        return;
      }

      const caseId = String(body.caseId ?? '').trim();
      if (!VALID_ID_RE.test(caseId)) {
        res.status(400).json({ error: 'รหัสเคสไม่ถูกต้อง' });
        return;
      }

      const caseNo = String(body.caseNo ?? caseId).trim().slice(0, 200) || caseId;
      const caseUrl = sanitizeSafeHttpUrl(body.caseUrl);
      const issueSummary = String(body.issueSummary ?? '').trim().slice(0, 300);
      const slaDueAt = String(body.slaDueAt ?? '').trim().slice(0, 64);
      const actorName =
        String(body.actorName ?? staff.displayName ?? '').trim().slice(0, 120) || 'ผู้ใช้งาน';
      const notePreview = String(body.notePreview ?? '').trim().slice(0, 400);
      const extraInfo = String(body.extraInfo ?? '').trim().slice(0, 400);
      const rawDedup = typeof body.dedupKey === 'string' ? body.dedupKey.trim().slice(0, 180) : '';

      const title = formatWebhookEventTitle(eventType);
      const message =
        extraInfo ||
        (eventType === 'escalation'
          ? `มีการส่งต่อเคส ${caseNo} มายังทีมของคุณ`
          : eventType === 'mention'
            ? `${actorName} ได้แท็กทีมหรือผู้ร่วมงานในเคส ${caseNo}`
            : eventType === 'sla_overdue'
              ? `เคส ${caseNo} เกินกำหนด SLA แล้ว กรุณาเร่งตรวจสอบ`
              : `เคส ${caseNo} ครบกำหนด SLA วันนี้`);

      let sentCount = 0;
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();

      for (const teamId of teamIds) {
        const row = getWebhookStmt.get(teamId) as TeamWebhookRow | undefined;
        if (!row || !row.enabled || !row.webhook_url) continue;
        const allowedEvents = parseWebhookEvents(row.events_json);
        if (!allowedEvents.includes(eventType)) continue;

        if (rawDedup) {
          const scopedDedup = `${rawDedup}:${teamId}`;
          const dedupRes = insertDedupStmt.run(scopedDedup, nowMs);
          if (dedupRes.changes === 0) {
            continue;
          }
        }

        try {
          await deliverWebhookRequest(row.webhook_url, {
            eventType,
            title,
            message,
            teamId,
            caseId,
            caseNo,
            caseUrl,
            issueSummary,
            slaDueAt,
            actorName,
            notePreview,
          });
          updateWebhookStatusStmt.run('success', '', nowIso, teamId);
          sentCount += 1;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'ส่ง Webhook ไม่สำเร็จ';
          updateWebhookStatusStmt.run('error', errMsg.slice(0, 300), nowIso, teamId);
        }
      }

      res.json({ ok: true, sent: sentCount });
    }
  );

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
