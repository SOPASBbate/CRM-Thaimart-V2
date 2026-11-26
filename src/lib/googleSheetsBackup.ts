import { getApps, initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  inMemoryPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import googleSheetsOAuthConfig from './googleSheetsOAuthConfig.json';
import { formatFileSize } from './attachments.ts';
import {
  computeLiveSlaState,
  formatThaiDate,
  formatThaiDateTime,
  getRoleLabel,
  getSlaLabel,
  getStatusLabel,
} from './sla.ts';
import type {
  AckHistoryEntry,
  CaseEscalationLog,
  CaseItem,
  InternalNote,
  InternalNoteEditLog,
  Team,
  UserPublic,
} from '../types.ts';

export const GOOGLE_SHEETS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'] as const;

export const BACKUP_SHEET_TABS = {
  CASES: 'เคสทั้งหมด (Cases)',
  NOTES: 'Internal Notes',
  HISTORY: 'History & Logs',
  SUMMARY: 'สรุปข้อมูลสำรอง',
  TEAMS: 'ทีมและแผนก',
} as const;

export interface GoogleAccountProfile {
  email: string;
  displayName: string;
}

export interface SpreadsheetTabInfo {
  sheetId: number;
  title: string;
}

export interface SpreadsheetMetadata {
  spreadsheetId: string;
  title: string;
  spreadsheetUrl: string;
  sheets: SpreadsheetTabInfo[];
}

export interface CaseBackupSnapshot {
  notesByCase: Record<string, InternalNote[]>;
  editLogsByCase: Record<string, InternalNoteEditLog[]>;
  acksByCase: Record<string, AckHistoryEntry[]>;
  escalationLogsByCase: Record<string, CaseEscalationLog[]>;
  totalNotes: number;
  totalHistoryEvents: number;
}

export interface BackupExecutionResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  spreadsheetTitle: string;
  backedUpAt: string;
  counts: {
    cases: number;
    notes: number;
    history: number;
    teams: number;
  };
}

// Strict in-memory token cache (never persisted to localStorage or sessionStorage)
let cachedAccessToken: string | null = null;
let cachedProfile: GoogleAccountProfile | null = null;

function getSheetsOAuthInstance() {
  const secondaryApp =
    getApps().find((a) => a.name === 'GoogleSheetsOAuth') ??
    initializeApp(googleSheetsOAuthConfig, 'GoogleSheetsOAuth');
  return getAuth(secondaryApp);
}

export function initGoogleSheetsAuthListener(
  primaryAuth: ReturnType<typeof getAuth>,
  onDisconnected?: () => void
): () => void {
  return onAuthStateChanged(primaryAuth, (user) => {
    if (!user) {
      cachedAccessToken = null;
      cachedProfile = null;
      const secondaryAuth = getApps().find((a) => a.name === 'GoogleSheetsOAuth');
      if (secondaryAuth) {
        void signOut(getAuth(secondaryAuth)).catch(() => {});
      }
      if (onDisconnected) onDisconnected();
    }
  });
}

export function getCachedGoogleSession(): {
  connected: boolean;
  accessToken: string | null;
  profile: GoogleAccountProfile | null;
} {
  return {
    connected: Boolean(cachedAccessToken),
    accessToken: cachedAccessToken,
    profile: cachedProfile,
  };
}

export async function connectGoogleSheets(): Promise<{
  accessToken: string;
  profile: GoogleAccountProfile;
}> {
  const sheetsAuth = getSheetsOAuthInstance();
  await setPersistence(sheetsAuth, inMemoryPersistence);

  const provider = new GoogleAuthProvider();
  for (const scope of GOOGLE_SHEETS_SCOPES) {
    provider.addScope(scope);
  }
  provider.setCustomParameters({ prompt: 'select_account' });

  try {
    const result = await signInWithPopup(sheetsAuth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('ไม่ได้รับสิทธิ์การเข้าถึง Google Sheets กรุณาลองใหม่อีกครั้ง');
    }

    cachedAccessToken = credential.accessToken;
    cachedProfile = {
      email: result.user.email ?? '',
      displayName: result.user.displayName ?? result.user.email ?? 'Google Account',
    };

    return {
      accessToken: cachedAccessToken,
      profile: cachedProfile,
    };
  } catch (err) {
    const code = (err as { code?: string })?.code ?? '';
    if (code === 'auth/popup-closed-by-user') {
      throw new Error('คุณปิดหน้าต่างเชื่อมต่อ Google ก่อนดำเนินการเสร็จสิ้น');
    }
    if (code === 'auth/popup-blocked') {
      throw new Error('เบราว์เซอร์บล็อกหน้าต่างป๊อปอัป กรุณาอนุญาตป๊อปอัปแล้วลองใหม่');
    }
    throw err instanceof Error ? err : new Error('ไม่สามารถเชื่อมต่อบัญชี Google ได้');
  }
}

export async function disconnectGoogleSheets(): Promise<void> {
  cachedAccessToken = null;
  cachedProfile = null;
  const existingApp = getApps().find((a) => a.name === 'GoogleSheetsOAuth');
  if (existingApp) {
    await signOut(getAuth(existingApp)).catch(() => {});
  }
}

export function parseSpreadsheetId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }
  if (/^[a-zA-Z0-9-_]{15,120}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

async function sheetsApiRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  if (!cachedAccessToken) {
    throw new Error('ยังไม่ได้เชื่อมต่อบัญชี Google กรุณากดเชื่อมต่อก่อนดำเนินการ');
  }

  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${cachedAccessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 401) {
    cachedAccessToken = null;
    cachedProfile = null;
    throw new Error('หมดเวลาการเชื่อมต่อบัญชี Google กรุณากดเชื่อมต่อ Google ใหม่อีกครั้ง');
  }

  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }

  if (!res.ok) {
    const errObj = json.error as { message?: string; status?: string } | undefined;
    if (res.status === 403) {
      throw new Error(
        'บัญชี Google ที่เชื่อมต่อไม่มีสิทธิ์แก้ไข Google ชีตนี้ หรือยังไม่ได้อนุญาตสิทธิ์จัดการ Google Sheets'
      );
    }
    if (res.status === 404) {
      throw new Error('ไม่พบไฟล์ Google ชีตตามลิงก์หรือ ID ที่ระบุ');
    }
    throw new Error(errObj?.message || `เกิดข้อผิดพลาดจาก Google Sheets (HTTP ${res.status})`);
  }

  return json as T;
}

export async function fetchSpreadsheetMetadata(spreadsheetId: string): Promise<SpreadsheetMetadata> {
  const fields = 'spreadsheetId,properties.title,spreadsheetUrl,sheets.properties(sheetId,title)';
  const data = await sheetsApiRequest<{
    spreadsheetId: string;
    properties?: { title?: string };
    spreadsheetUrl?: string;
    sheets?: { properties?: { sheetId?: number; title?: string } }[];
  }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`
  );

  return {
    spreadsheetId: data.spreadsheetId,
    title: data.properties?.title || 'Google Spreadsheet',
    spreadsheetUrl:
      data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${data.spreadsheetId}/edit`,
    sheets: (data.sheets ?? []).map((s) => ({
      sheetId: Number(s.properties?.sheetId ?? 0),
      title: String(s.properties?.title ?? ''),
    })),
  };
}

export async function createBackupSpreadsheet(title: string): Promise<SpreadsheetMetadata> {
  const cleanTitle = title.trim().slice(0, 120) || `CRM Desk Backup - ${new Date().toISOString().slice(0, 10)}`;
  const tabNames = [
    BACKUP_SHEET_TABS.CASES,
    BACKUP_SHEET_TABS.NOTES,
    BACKUP_SHEET_TABS.HISTORY,
    BACKUP_SHEET_TABS.TEAMS,
    BACKUP_SHEET_TABS.SUMMARY,
  ];

  const data = await sheetsApiRequest<{
    spreadsheetId: string;
    properties?: { title?: string };
    spreadsheetUrl?: string;
    sheets?: { properties?: { sheetId?: number; title?: string } }[];
  }>('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: cleanTitle },
      sheets: tabNames.map((t) => ({ properties: { title: t } })),
    }),
  });

  return {
    spreadsheetId: data.spreadsheetId,
    title: data.properties?.title || cleanTitle,
    spreadsheetUrl:
      data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${data.spreadsheetId}/edit`,
    sheets: (data.sheets ?? []).map((s) => ({
      sheetId: Number(s.properties?.sheetId ?? 0),
      title: String(s.properties?.title ?? ''),
    })),
  };
}

function quoteSheetTab(tabTitle: string): string {
  return `'${tabTitle.replace(/'/g, "''")}'`;
}

function getAckLabel(level: string): string {
  switch (level) {
    case 'overdue':
      return 'รับทราบเมื่อเกินกำหนด SLA';
    case 'due_today':
      return 'รับทราบเมื่อถึงวันครบกำหนด SLA';
    case 'due_reached':
      return 'รับทราบเมื่อถึง/เกินกำหนด SLA';
    default:
      return 'รับทราบแจ้งเตือน SLA';
  }
}

export function buildBackupSheetRows(params: {
  currentUser: UserPublic;
  cases: CaseItem[];
  teams: Team[];
  snapshot: CaseBackupSnapshot;
  nowMs: number;
  googleEmail: string;
}): {
  casesRows: string[][];
  notesRows: string[][];
  historyRows: string[][];
  teamsRows: string[][];
  summaryRows: string[][];
  counts: { cases: number; notes: number; history: number; teams: number };
} {
  const { currentUser, cases, teams, snapshot, nowMs, googleEmail } = params;
  const nowIso = new Date(nowMs).toISOString();

  // 1. Cases Sheet
  const casesHeader = [
    'Case ID',
    'ลิงก์เคส',
    'หัวข้อปัญหา',
    'รายละเอียดเพิ่มเติม',
    'สถานะงาน',
    'ทีม / แผนก',
    'ผู้รับเรื่อง',
    'วันครบกำหนด SLA',
    'สถานะ SLA ปัจจุบัน',
    'วันที่ปิดเคส',
    'รับทราบ SLA ล่าสุด',
    'ผู้รับทราบล่าสุด',
    'วันที่สร้างเคส',
    'อัปเดตล่าสุด',
  ];

  const casesDataRows = cases.map((c) => {
    const liveSla = computeLiveSlaState(c.sla_due_at, c.status, nowMs);
    return [
      c.id,
      c.case_no,
      c.issue_summary,
      c.details || '-',
      getStatusLabel(c.status),
      c.team_name,
      c.assignee_name,
      formatThaiDate(c.sla_due_at),
      getSlaLabel(liveSla),
      c.resolved_at ? formatThaiDateTime(c.resolved_at) : '-',
      c.last_ack_at ? formatThaiDateTime(c.last_ack_at) : '-',
      c.last_ack_by_name || '-',
      c.created_at ? formatThaiDateTime(c.created_at) : '-',
      c.updated_at ? formatThaiDateTime(c.updated_at) : '-',
    ];
  });

  // 2. Internal Notes Sheet
  const notesHeader = [
    'Note ID',
    'Case ID',
    'ลิงก์เคส',
    'หัวข้อเคส',
    'ผู้บันทึก',
    'สิทธิ์',
    'ข้อความบันทึก',
    'ปรับ SLA',
    'SLA เดิม',
    'SLA ใหม่',
    'จำนวนไฟล์แนบ',
    'ไฟล์แนบ',
    'สถานะแก้ไข',
    'ผู้แก้ไขล่าสุด',
    'วัน-เวลาที่บันทึก',
    'อัปเดตล่าสุด',
  ];

  const notesDataRows: string[][] = [];
  for (const c of cases) {
    const noteList = snapshot.notesByCase[c.id] ?? [];
    for (const n of noteList) {
      const atts = n.attachments ?? [];
      const attSummary =
        atts.length > 0
          ? atts.map((a) => `${a.name} (${formatFileSize(a.size_bytes)})`).join(' | ')
          : '-';
      notesDataRows.push([
        n.id,
        c.id,
        c.case_no,
        c.issue_summary,
        n.author_name,
        getRoleLabel(n.author_role),
        n.content || '-',
        n.sla_changed ? 'ใช่' : 'ไม่',
        n.sla_changed ? formatThaiDate(n.previous_sla_due_at) : '-',
        n.sla_changed ? formatThaiDate(n.new_sla_due_at) : '-',
        String(atts.length),
        attSummary,
        n.is_edited ? 'แก้ไขแล้ว' : 'ปกติ',
        n.is_edited ? n.last_edited_by_name : '-',
        n.created_at ? formatThaiDateTime(n.created_at) : '-',
        n.updated_at ? formatThaiDateTime(n.updated_at) : '-',
      ]);
    }
  }

  // 3. History & Logs Sheet
  const historyHeader = [
    'วัน-เวลา',
    'Case ID',
    'ลิงก์เคส',
    'หัวข้อเคส',
    'หมวดหมู่',
    'เหตุการณ์',
    'ผู้ดำเนินการ',
    'รายละเอียดเพิ่มเติม',
  ];

  interface RawHistoryRow {
    ms: number;
    row: string[];
  }
  const collectedHistory: RawHistoryRow[] = [];

  for (const c of cases) {
    const acks = snapshot.acksByCase[c.id] ?? [];
    for (const a of acks) {
      collectedHistory.push({
        ms: new Date(a.ack_at).getTime() || 0,
        row: [
          formatThaiDateTime(a.ack_at),
          c.id,
          c.case_no,
          c.issue_summary,
          'รับทราบ SLA',
          getAckLabel(a.ack_level),
          a.user_name,
          a.note || '-',
        ],
      });
    }

    const edits = snapshot.editLogsByCase[c.id] ?? [];
    for (const e of edits) {
      const changes: string[] = [];
      if (e.old_content !== e.new_content) {
        changes.push(`ข้อความ: "${e.old_content || '-'}" → "${e.new_content || '-'}"`);
      }
      if (e.old_sla_due_at !== e.new_sla_due_at) {
        changes.push(
          `SLA: ${formatThaiDate(e.old_sla_due_at)} → ${formatThaiDate(e.new_sla_due_at)}`
        );
      }
      if (
        (e.old_attachments_summary !== undefined || e.new_attachments_summary !== undefined) &&
        e.old_attachments_summary !== e.new_attachments_summary
      ) {
        changes.push(
          `ไฟล์แนบ: ${e.old_attachments_summary || '-'} → ${e.new_attachments_summary || '-'}`
        );
      }
      collectedHistory.push({
        ms: new Date(e.edited_at).getTime() || 0,
        row: [
          formatThaiDateTime(e.edited_at),
          c.id,
          c.case_no,
          c.issue_summary,
          'แก้ไข Internal Note',
          'แก้ไขบันทึก Internal Note',
          `${e.editor_name} (${getRoleLabel(e.editor_role)})`,
          changes.join(' | ') || '-',
        ],
      });
    }

    const escLogs = snapshot.escalationLogsByCase[c.id] ?? [];
    for (const esc of escLogs) {
      collectedHistory.push({
        ms: new Date(esc.created_at).getTime() || 0,
        row: [
          formatThaiDateTime(esc.created_at),
          c.id,
          c.case_no,
          c.issue_summary,
          'ส่งต่อเคส (Escalate)',
          `ส่งต่อเคส → ${esc.to_user_name} (${esc.to_team_name})`,
          `${esc.from_user_name} (${esc.from_team_name})`,
          esc.note || '-',
        ],
      });

      if (esc.status === 'accepted') {
        collectedHistory.push({
          ms: new Date(esc.updated_at).getTime() || 0,
          row: [
            formatThaiDateTime(esc.updated_at),
            c.id,
            c.case_no,
            c.issue_summary,
            'ส่งต่อเคส (Escalate)',
            'ตอบรับเคส (Accepted)',
            `${esc.to_user_name} (${esc.to_team_name})`,
            `รับเคสจาก ${esc.from_user_name}`,
          ],
        });
      } else if (esc.status === 'rejected') {
        collectedHistory.push({
          ms: new Date(esc.updated_at).getTime() || 0,
          row: [
            formatThaiDateTime(esc.updated_at),
            c.id,
            c.case_no,
            c.issue_summary,
            'ส่งต่อเคส (Escalate)',
            'ปฏิเสธรับเคส (Reject) — ส่งกลับต้นทาง',
            `${esc.to_user_name} (${esc.to_team_name})`,
            esc.reject_reason || 'ส่งคืนให้ผู้ส่งเดิม',
          ],
        });
        if (esc.sender_ack_done && esc.sender_ack_at) {
          collectedHistory.push({
            ms: new Date(esc.sender_ack_at).getTime() || 0,
            row: [
              formatThaiDateTime(esc.sender_ack_at),
              c.id,
              c.case_no,
              c.issue_summary,
              'ส่งต่อเคส (Escalate)',
              'ต้นทางรับทราบการ Reject',
              `${esc.from_user_name} (${esc.from_team_name})`,
              'กดรับทราบการส่งคืนเรียบร้อยแล้ว',
            ],
          });
        }
      }
    }
  }

  collectedHistory.sort((a, b) => b.ms - a.ms);
  const historyDataRows = collectedHistory.map((item) => item.row);

  // 4. Teams Sheet
  const teamsHeader = ['Team ID', 'ชื่อทีม / แผนก', 'รายละเอียด', 'จำนวนเคสปัจจุบัน'];
  const teamsDataRows = teams.map((t) => [
    t.id,
    t.name,
    t.description || '-',
    String(cases.filter((c) => c.team_id === t.id).length),
  ]);

  // 5. Backup Summary Sheet
  const summaryRows = [
    ['หัวข้อข้อมูลสำรอง', 'รายละเอียด'],
    ['วัน-เวลาที่สำรองข้อมูล', formatThaiDateTime(nowIso)],
    ['ผู้ดำเนินการในระบบ', `${currentUser.display_name} (${getRoleLabel(currentUser.role)})`],
    ['ทีมของผู้ดำเนินการ', currentUser.team_name],
    ['บัญชี Google ที่ใช้สำรองข้อมูล', googleEmail || '-'],
    ['จำนวนเคสที่สำรอง', String(casesDataRows.length)],
    ['จำนวน Internal Notes ที่สำรอง', String(notesDataRows.length)],
    ['จำนวน History & Logs ที่สำรอง', String(historyDataRows.length)],
    ['จำนวนทีม / แผนก', String(teamsDataRows.length)],
  ];

  return {
    casesRows: [casesHeader, ...casesDataRows],
    notesRows: [notesHeader, ...notesDataRows],
    historyRows: [historyHeader, ...historyDataRows],
    teamsRows: [teamsHeader, ...teamsDataRows],
    summaryRows,
    counts: {
      cases: casesDataRows.length,
      notes: notesDataRows.length,
      history: historyDataRows.length,
      teams: teamsDataRows.length,
    },
  };
}

export async function writeBackupToSpreadsheet(params: {
  spreadsheetId: string;
  currentUser: UserPublic;
  cases: CaseItem[];
  teams: Team[];
  snapshot: CaseBackupSnapshot;
  nowMs: number;
}): Promise<BackupExecutionResult> {
  const { spreadsheetId, currentUser, cases, teams, snapshot, nowMs } = params;

  // Always inspect actual spreadsheet metadata first to discover existing tabs
  const metadata = await fetchSpreadsheetMetadata(spreadsheetId);
  const existingTitles = new Set(metadata.sheets.map((s) => s.title));

  const requiredTabs = [
    BACKUP_SHEET_TABS.CASES,
    BACKUP_SHEET_TABS.NOTES,
    BACKUP_SHEET_TABS.HISTORY,
    BACKUP_SHEET_TABS.TEAMS,
    BACKUP_SHEET_TABS.SUMMARY,
  ];

  const missingTabs = requiredTabs.filter((tab) => !existingTitles.has(tab));
  if (missingTabs.length > 0) {
    await sheetsApiRequest(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          requests: missingTabs.map((title) => ({
            addSheet: { properties: { title } },
          })),
        }),
      }
    );
  }

  const prepared = buildBackupSheetRows({
    currentUser,
    cases,
    teams,
    snapshot,
    nowMs,
    googleEmail: cachedProfile?.email ?? '',
  });

  // Clear existing data in backup tabs so stale rows don't remain
  await sheetsApiRequest(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
    {
      method: 'POST',
      body: JSON.stringify({
        ranges: requiredTabs.map((t) => `${quoteSheetTab(t)}!A:Z`),
      }),
    }
  );

  // Write fresh backup rows with RAW input option (prevents formula injection or URL mangling)
  await sheetsApiRequest(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
    {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: [
          {
            range: `${quoteSheetTab(BACKUP_SHEET_TABS.CASES)}!A1`,
            majorDimension: 'ROWS',
            values: prepared.casesRows,
          },
          {
            range: `${quoteSheetTab(BACKUP_SHEET_TABS.NOTES)}!A1`,
            majorDimension: 'ROWS',
            values: prepared.notesRows,
          },
          {
            range: `${quoteSheetTab(BACKUP_SHEET_TABS.HISTORY)}!A1`,
            majorDimension: 'ROWS',
            values: prepared.historyRows,
          },
          {
            range: `${quoteSheetTab(BACKUP_SHEET_TABS.TEAMS)}!A1`,
            majorDimension: 'ROWS',
            values: prepared.teamsRows,
          },
          {
            range: `${quoteSheetTab(BACKUP_SHEET_TABS.SUMMARY)}!A1`,
            majorDimension: 'ROWS',
            values: prepared.summaryRows,
          },
        ],
      }),
    }
  );

  return {
    spreadsheetId: metadata.spreadsheetId,
    spreadsheetUrl: metadata.spreadsheetUrl,
    spreadsheetTitle: metadata.title,
    backedUpAt: new Date(nowMs).toISOString(),
    counts: prepared.counts,
  };
}

export async function readBackupPreviewFromSheet(spreadsheetId: string): Promise<{
  metadata: SpreadsheetMetadata;
  summaryRows: string[][];
  sampleCaseRows: string[][];
}> {
  const metadata = await fetchSpreadsheetMetadata(spreadsheetId);
  const existingTitles = new Set(metadata.sheets.map((s) => s.title));

  const targetCaseTab = existingTitles.has(BACKUP_SHEET_TABS.CASES)
    ? BACKUP_SHEET_TABS.CASES
    : metadata.sheets[0]?.title || '';
  const targetSummaryTab = existingTitles.has(BACKUP_SHEET_TABS.SUMMARY)
    ? BACKUP_SHEET_TABS.SUMMARY
    : '';

  let summaryRows: string[][] = [];
  if (targetSummaryTab) {
    const res = await sheetsApiRequest<{ values?: string[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${quoteSheetTab(targetSummaryTab)}!A1:B20`)}`
    );
    summaryRows = res.values ?? [];
  }

  let sampleCaseRows: string[][] = [];
  if (targetCaseTab) {
    const res = await sheetsApiRequest<{ values?: string[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${quoteSheetTab(targetCaseTab)}!A1:N11`)}`
    );
    sampleCaseRows = res.values ?? [];
  }

  return { metadata, summaryRows, sampleCaseRows };
}
