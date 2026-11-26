import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileSpreadsheet,
  FolderPlus,
  Link2,
  Loader2,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Table2,
  UploadCloud,
} from 'lucide-react';
import { auth } from '../lib/firebase.ts';
import { fetchCaseBackupSnapshot, formatActionErrorMessage } from '../lib/firestoreService.ts';
import {
  BACKUP_SHEET_TABS,
  connectGoogleSheets,
  createBackupSpreadsheet,
  disconnectGoogleSheets,
  fetchSpreadsheetMetadata,
  getCachedGoogleSession,
  initGoogleSheetsAuthListener,
  parseSpreadsheetId,
  readBackupPreviewFromSheet,
  writeBackupToSpreadsheet,
  type BackupExecutionResult,
  type CaseBackupSnapshot,
  type GoogleAccountProfile,
  type SpreadsheetMetadata,
} from '../lib/googleSheetsBackup.ts';
import { formatThaiDateTime } from '../lib/sla.ts';
import type { CaseItem, Team, UserPublic } from '../types.ts';

interface GoogleSheetsBackupViewProps {
  currentUser: UserPublic;
  cases: CaseItem[];
  teams: Team[];
  nowMs: number;
}

type TargetMode = 'new' | 'existing';

interface StoredBackupPrefs {
  lastSpreadsheetId?: string;
  lastSpreadsheetUrl?: string;
  lastSpreadsheetTitle?: string;
  history?: BackupExecutionResult[];
}

interface PendingBackupPlan {
  mode: TargetMode;
  newTitle: string;
  existingMeta: SpreadsheetMetadata | null;
  snapshot: CaseBackupSnapshot;
}

function getPrefsStorageKey(uid: string): string {
  return `crm_desk_sheets_backup_prefs_${uid}`;
}

function loadBackupPrefs(uid: string): StoredBackupPrefs {
  try {
    const raw = window.localStorage.getItem(getPrefsStorageKey(uid));
    if (!raw) return {};
    return JSON.parse(raw) as StoredBackupPrefs;
  } catch {
    return {};
  }
}

function saveBackupPrefs(uid: string, prefs: StoredBackupPrefs): void {
  try {
    window.localStorage.setItem(getPrefsStorageKey(uid), JSON.stringify(prefs));
  } catch {
    // Ignore storage quota errors
  }
}

export const GoogleSheetsBackupView: React.FC<GoogleSheetsBackupViewProps> = ({
  currentUser,
  cases,
  teams,
  nowMs,
}) => {
  const initialSession = getCachedGoogleSession();
  const [connected, setConnected] = useState(initialSession.connected);
  const [googleProfile, setGoogleProfile] = useState<GoogleAccountProfile | null>(
    initialSession.profile
  );
  const [connecting, setConnecting] = useState(false);

  const [prefs, setPrefs] = useState<StoredBackupPrefs>(() => loadBackupPrefs(currentUser.uid));
  const [targetMode, setTargetMode] = useState<TargetMode>(() =>
    loadBackupPrefs(currentUser.uid).lastSpreadsheetId ? 'existing' : 'new'
  );
  const [newSheetTitle, setNewSheetTitle] = useState(
    `CRM Desk Backup - ${new Date().toISOString().slice(0, 10)}`
  );
  const [existingSheetInput, setExistingSheetInput] = useState(
    () => loadBackupPrefs(currentUser.uid).lastSpreadsheetUrl || ''
  );
  const [verifiedSheetMeta, setVerifiedSheetMeta] = useState<SpreadsheetMetadata | null>(null);
  const [checkingSheet, setCheckingSheet] = useState(false);

  const [preparingPlan, setPreparingPlan] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<PendingBackupPlan | null>(null);
  const [executingBackup, setExecutingBackup] = useState(false);

  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewData, setPreviewData] = useState<{
    metadata: SpreadsheetMetadata;
    summaryRows: string[][];
    sampleCaseRows: string[][];
  } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<BackupExecutionResult | null>(null);

  useEffect(() => {
    const loaded = loadBackupPrefs(currentUser.uid);
    setPrefs(loaded);
    if (loaded.lastSpreadsheetUrl) {
      setExistingSheetInput(loaded.lastSpreadsheetUrl);
      setTargetMode('existing');
    }
  }, [currentUser.uid]);

  useEffect(() => {
    return initGoogleSheetsAuthListener(auth, () => {
      setConnected(false);
      setGoogleProfile(null);
      setVerifiedSheetMeta(null);
      setPreviewData(null);
    });
  }, []);

  const handleConnectGoogle = async () => {
    setError(null);
    setSuccessMsg(null);
    setConnecting(true);
    try {
      const res = await connectGoogleSheets();
      setConnected(true);
      setGoogleProfile(res.profile);
      setSuccessMsg(`เชื่อมต่อบัญชี Google (${res.profile.email || res.profile.displayName}) สำเร็จ`);
    } catch (err) {
      setError(formatActionErrorMessage(err, 'ไม่สามารถเชื่อมต่อ Google Sheets ได้'));
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnectGoogle = async () => {
    await disconnectGoogleSheets();
    setConnected(false);
    setGoogleProfile(null);
    setVerifiedSheetMeta(null);
    setPreviewData(null);
    setPendingPlan(null);
    setSuccessMsg('ตัดการเชื่อมต่อบัญชี Google เรียบร้อยแล้ว');
  };

  const handleVerifyExistingSheet = async () => {
    setError(null);
    setSuccessMsg(null);
    const id = parseSpreadsheetId(existingSheetInput);
    if (!id) {
      setError('กรุณาวางลิงก์ Google ชีต หรือ Spreadsheet ID ให้ถูกต้อง');
      return;
    }

    setCheckingSheet(true);
    try {
      const meta = await fetchSpreadsheetMetadata(id);
      setVerifiedSheetMeta(meta);
      setExistingSheetInput(meta.spreadsheetUrl);
      setSuccessMsg(`ตรวจสอบไฟล์ "${meta.title}" สำเร็จ พร้อมสำรองข้อมูล`);
    } catch (err) {
      setVerifiedSheetMeta(null);
      const msg = formatActionErrorMessage(err, 'ไม่สามารถตรวจสอบ Google ชีตได้');
      setError(msg);
      if (msg.includes('หมดเวลาการเชื่อมต่อ')) {
        setConnected(false);
        setGoogleProfile(null);
      }
    } finally {
      setCheckingSheet(false);
    }
  };

  const handlePrepareBackup = async () => {
    setError(null);
    setSuccessMsg(null);

    if (!connected) {
      setError('กรุณาเชื่อมต่อบัญชี Google ก่อนสำรองข้อมูล');
      return;
    }

    let existingMeta: SpreadsheetMetadata | null = null;
    if (targetMode === 'existing') {
      const id = parseSpreadsheetId(existingSheetInput);
      if (!id) {
        setError('กรุณาระบุลิงก์ Google ชีต หรือ Spreadsheet ID ที่ต้องการสำรองข้อมูล');
        return;
      }
      setPreparingPlan(true);
      try {
        existingMeta = await fetchSpreadsheetMetadata(id);
        setVerifiedSheetMeta(existingMeta);
      } catch (err) {
        setPreparingPlan(false);
        const msg = formatActionErrorMessage(err, 'ไม่สามารถเข้าถึง Google ชีตปลายทางได้');
        setError(msg);
        if (msg.includes('หมดเวลาการเชื่อมต่อ')) {
          setConnected(false);
          setGoogleProfile(null);
        }
        return;
      }
    } else {
      if (!newSheetTitle.trim()) {
        setError('กรุณาระบุชื่อไฟล์ Google ชีตใหม่');
        return;
      }
      setPreparingPlan(true);
    }

    try {
      const snapshot = await fetchCaseBackupSnapshot(cases);
      setPendingPlan({
        mode: targetMode,
        newTitle: newSheetTitle.trim(),
        existingMeta,
        snapshot,
      });
    } catch (err) {
      setError(formatActionErrorMessage(err, 'ไม่สามารถรวบรวมข้อมูลจากระบบเพื่อสำรองได้'));
    } finally {
      setPreparingPlan(false);
    }
  };

  const handleConfirmExecuteBackup = async () => {
    if (!pendingPlan) return;
    setError(null);
    setSuccessMsg(null);
    setExecutingBackup(true);

    try {
      let targetSpreadsheetId = pendingPlan.existingMeta?.spreadsheetId ?? '';
      if (pendingPlan.mode === 'new') {
        const created = await createBackupSpreadsheet(pendingPlan.newTitle);
        targetSpreadsheetId = created.spreadsheetId;
      }

      const result = await writeBackupToSpreadsheet({
        spreadsheetId: targetSpreadsheetId,
        currentUser,
        cases,
        teams,
        snapshot: pendingPlan.snapshot,
        nowMs: Date.now(),
      });

      const updatedHistory = [result, ...(prefs.history ?? [])].slice(0, 10);
      const nextPrefs: StoredBackupPrefs = {
        lastSpreadsheetId: result.spreadsheetId,
        lastSpreadsheetUrl: result.spreadsheetUrl,
        lastSpreadsheetTitle: result.spreadsheetTitle,
        history: updatedHistory,
      };
      saveBackupPrefs(currentUser.uid, nextPrefs);
      setPrefs(nextPrefs);
      setLastResult(result);
      setExistingSheetInput(result.spreadsheetUrl);
      setTargetMode('existing');
      setVerifiedSheetMeta({
        spreadsheetId: result.spreadsheetId,
        spreadsheetUrl: result.spreadsheetUrl,
        title: result.spreadsheetTitle,
        sheets: [],
      });
      setPendingPlan(null);
      setSuccessMsg(
        `สำรองข้อมูลลง Google ชีต "${result.spreadsheetTitle}" สำเร็จ (${result.counts.cases} เคส, ${result.counts.notes} Internal Notes, ${result.counts.history} History Logs)`
      );
    } catch (err) {
      setPendingPlan(null);
      const msg = formatActionErrorMessage(err, 'ไม่สามารถสำรองข้อมูลลง Google ชีตได้');
      setError(msg);
      if (msg.includes('หมดเวลาการเชื่อมต่อ')) {
        setConnected(false);
        setGoogleProfile(null);
      }
    } finally {
      setExecutingBackup(false);
    }
  };

  const handleReadPreview = async () => {
    setError(null);
    const id = parseSpreadsheetId(existingSheetInput) || prefs.lastSpreadsheetId || null;
    if (!id) {
      setError('กรุณาระบุลิงก์ Google ชีตที่ต้องการอ่านข้อมูลตัวอย่าง');
      return;
    }

    setLoadingPreview(true);
    try {
      const data = await readBackupPreviewFromSheet(id);
      setPreviewData(data);
    } catch (err) {
      const msg = formatActionErrorMessage(err, 'ไม่สามารถอ่านข้อมูลจาก Google ชีตได้');
      setError(msg);
      if (msg.includes('หมดเวลาการเชื่อมต่อ')) {
        setConnected(false);
        setGoogleProfile(null);
      }
    } finally {
      setLoadingPreview(false);
    }
  };

  const openCaseCount = cases.filter((c) => c.status !== 'done').length;
  const doneCaseCount = cases.filter((c) => c.status === 'done').length;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            ระบบสำรองข้อมูลบน Google ชีต
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            ส่งออกและสำรองข้อมูลเคส, Internal Notes, ประวัติ History และข้อมูลทีมไปยัง Google Sheets ของคุณ
          </p>
        </div>
        {(lastResult?.spreadsheetUrl || prefs.lastSpreadsheetUrl) && (
          <a
            href={lastResult?.spreadsheetUrl || prefs.lastSpreadsheetUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 px-4 py-2 text-xs font-semibold text-emerald-800 transition-colors whitespace-nowrap shrink-0"
          >
            <ExternalLink className="w-3.5 h-3.5 shrink-0" />
            <span>เปิด Google ชีตล่าสุด</span>
          </a>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {successMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Step 1: Google Connection Card */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center shrink-0">
              <FileSpreadsheet className="w-5 h-5 text-emerald-700" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                1. เชื่อมต่อบัญชี Google สำหรับ Google ชีต
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {connected && googleProfile
                  ? `เชื่อมต่อแล้ว: ${googleProfile.displayName} (${googleProfile.email})`
                  : 'เข้าสู่ระบบบัญชี Google ของคุณเพื่อสร้างหรืออัปเดตไฟล์ Google ชีต (ไม่กระทบสถานะการเข้าสู่ระบบ CRM Desk)'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {connected ? (
              <>
                <button
                  type="button"
                  disabled={connecting}
                  onClick={handleConnectGoogle}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700 transition-colors cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>เปลี่ยนบัญชี Google</span>
                </button>
                <button
                  type="button"
                  onClick={handleDisconnectGoogle}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white hover:bg-red-50 px-3 py-2 text-xs font-medium text-red-700 transition-colors cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>ตัดการเชื่อมต่อ</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={connecting}
                onClick={handleConnectGoogle}
                className="inline-flex items-center gap-2.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-60 px-4 py-2 text-sm font-medium text-slate-800 shadow-sm transition-colors cursor-pointer"
              >
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 48 48" aria-hidden="true">
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                  />
                </svg>
                <span>{connecting ? 'กำลังเชื่อมต่อ...' : 'Sign in with Google'}</span>
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Step 2 & 3: Destination + Data Preview + Backup Trigger */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 space-y-5">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              2. เลือกไฟล์ Google ชีตปลายทางและเริ่มสำรองข้อมูล
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              สร้างไฟล์ Google ชีตใหม่ หรือเลือกอัปเดตลงในไฟล์ Google ชีตที่มีอยู่แล้ว
            </p>
          </div>

          {/* Mode Tabs */}
          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => {
                setTargetMode('new');
                setError(null);
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                targetMode === 'new'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>สร้าง Google ชีตใหม่</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setTargetMode('existing');
                setError(null);
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                targetMode === 'existing'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Link2 className="w-3.5 h-3.5" />
              <span>ใช้ Google ชีตที่มีอยู่แล้ว</span>
            </button>
          </div>

          {targetMode === 'new' ? (
            <div className="space-y-2">
              <label htmlFor="new-sheet-title" className="block text-xs font-medium text-slate-700">
                ชื่อไฟล์ Google ชีตใหม่
              </label>
              <input
                id="new-sheet-title"
                type="text"
                value={newSheetTitle}
                onChange={(e) => setNewSheetTitle(e.target.value)}
                placeholder="เช่น CRM Desk Backup - 2026-11-26"
                className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
              />
              <p className="text-xs text-slate-500">
                ระบบจะสร้างสเปรดชีตใหม่ใน Google Drive ของบัญชี Google ที่เชื่อมต่อ พร้อมแท็บข้อมูล 5 แท็บให้อัตโนมัติ
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label htmlFor="existing-sheet-url" className="block text-xs font-medium text-slate-700 mb-1.5">
                  ลิงก์ Google ชีต (URL) หรือ Spreadsheet ID
                </label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    id="existing-sheet-url"
                    type="text"
                    value={existingSheetInput}
                    onChange={(e) => {
                      setExistingSheetInput(e.target.value);
                      setVerifiedSheetMeta(null);
                    }}
                    placeholder="https://docs.google.com/spreadsheets/d/..."
                    className="flex-1 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={!connected || checkingSheet}
                    onClick={handleVerifyExistingSheet}
                    className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 px-3.5 py-2 text-xs font-medium text-slate-700 whitespace-nowrap cursor-pointer"
                  >
                    {checkingSheet ? 'กำลังตรวจสอบ...' : 'ตรวจสอบชีต'}
                  </button>
                </div>
              </div>

              {verifiedSheetMeta && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                  <div>
                    <div className="font-semibold text-emerald-900">
                      ชื่อไฟล์: {verifiedSheetMeta.title}
                    </div>
                    {verifiedSheetMeta.sheets.length > 0 && (
                      <div className="text-emerald-700 mt-0.5">
                        แท็บที่มีอยู่: {verifiedSheetMeta.sheets.map((s) => s.title).join(', ')}
                      </div>
                    )}
                  </div>
                  <a
                    href={verifiedSheetMeta.spreadsheetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-emerald-800 font-medium hover:underline shrink-0"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>เปิดดูชีต</span>
                  </a>
                </div>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="pt-2 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <ShieldCheck className="w-4 h-4 text-blue-700 shrink-0" />
              <span>ระบบจะแสดงหน้าต่างยืนยันรายละเอียดก่อนเขียนข้อมูลทุกครั้ง</span>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {targetMode === 'existing' && (
                <button
                  type="button"
                  disabled={!connected || loadingPreview}
                  onClick={handleReadPreview}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 px-3.5 py-2 text-xs font-medium text-slate-700 transition-colors cursor-pointer"
                >
                  <Table2 className="w-3.5 h-3.5" />
                  <span>{loadingPreview ? 'กำลังอ่านข้อมูล...' : 'อ่านตัวอย่างจากชีต'}</span>
                </button>
              )}

              <button
                type="button"
                disabled={!connected || preparingPlan || executingBackup}
                onClick={handlePrepareBackup}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 px-4 py-2 text-xs font-semibold text-white transition-colors cursor-pointer"
              >
                {preparingPlan ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <UploadCloud className="w-4 h-4" />
                )}
                <span>
                  {preparingPlan
                    ? 'กำลังเตรียมข้อมูล...'
                    : targetMode === 'new'
                      ? 'สร้างชีตใหม่และสำรองข้อมูล'
                      : 'สำรองข้อมูลลง Google ชีตนี้'}
                </span>
              </button>
            </div>
          </div>
        </section>

        {/* Scope & Tabs Summary Card */}
        <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">ขอบเขตข้อมูลที่จะสำรอง</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              อัปเดตตามสิทธิ์การมองเห็นของบัญชี {currentUser.display_name}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs text-slate-500">เคสทั้งหมด</div>
              <div className="text-lg font-bold text-slate-900 font-mono tabular-nums mt-0.5">
                {cases.length}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                ค้าง {openCaseCount} · ปิด {doneCaseCount}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs text-slate-500">ทีม / แผนก</div>
              <div className="text-lg font-bold text-slate-900 font-mono tabular-nums mt-0.5">
                {teams.length}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">พร้อมข้อมูล Internal Note</div>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="text-xs font-medium text-slate-700">แท็บที่จะสร้าง/อัปเดตใน Google ชีต:</div>
            <ul className="space-y-1 text-xs text-slate-600">
              <li className="flex items-center justify-between py-1 border-b border-slate-100">
                <span>1. {BACKUP_SHEET_TABS.CASES}</span>
                <span className="text-slate-400">ข้อมูลเคส &amp; SLA</span>
              </li>
              <li className="flex items-center justify-between py-1 border-b border-slate-100">
                <span>2. {BACKUP_SHEET_TABS.NOTES}</span>
                <span className="text-slate-400">โน้ต &amp; รายชื่อไฟล์แนบ</span>
              </li>
              <li className="flex items-center justify-between py-1 border-b border-slate-100">
                <span>3. {BACKUP_SHEET_TABS.HISTORY}</span>
                <span className="text-slate-400">รับทราบ SLA / แก้โน้ต / Escalate</span>
              </li>
              <li className="flex items-center justify-between py-1 border-b border-slate-100">
                <span>4. {BACKUP_SHEET_TABS.TEAMS}</span>
                <span className="text-slate-400">สรุปรายทีม</span>
              </li>
              <li className="flex items-center justify-between py-1">
                <span>5. {BACKUP_SHEET_TABS.SUMMARY}</span>
                <span className="text-slate-400">เวลา &amp; ยอดสำรอง</span>
              </li>
            </ul>
          </div>
        </section>
      </div>

      {/* Preview Table from Google Sheet */}
      {previewData && (
        <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                ตัวอย่างข้อมูลล่าสุดใน Google ชีต: {previewData.metadata.title}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                แสดงสูงสุด 10 รายการแรกจาก Google ชีตจริง
              </p>
            </div>
            <a
              href={previewData.metadata.spreadsheetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:underline"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>เปิดดูฉบับเต็มบน Google Sheets</span>
            </a>
          </div>

          {previewData.summaryRows.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs">
              {previewData.summaryRows.slice(1).map((row, idx) => (
                <div key={idx} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="text-slate-500">{row[0] ?? '-'}</div>
                  <div className="font-medium text-slate-900 mt-0.5 truncate">{row[1] ?? '-'}</div>
                </div>
              ))}
            </div>
          )}

          {previewData.sampleCaseRows.length > 0 ? (
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    {previewData.sampleCaseRows[0].slice(0, 8).map((h, idx) => (
                      <th key={idx} className="py-2 px-3 font-medium whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {previewData.sampleCaseRows.slice(1).map((row, rIdx) => (
                    <tr key={rIdx} className="hover:bg-slate-50">
                      {previewData.sampleCaseRows[0].slice(0, 8).map((_, cIdx) => (
                        <td key={cIdx} className="py-2 px-3 text-slate-700 max-w-[200px] truncate">
                          {row[cIdx] ?? '-'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-xs text-slate-500 py-4 text-center">
              ยังไม่มีข้อมูลแถวเคสใน Google ชีตนี้
            </div>
          )}
        </section>
      )}

      {/* Local Backup Execution Log */}
      {(prefs.history ?? []).length > 0 && (
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              ประวัติการสำรองข้อมูลบนอุปกรณ์นี้
            </h2>
            <span className="text-xs text-slate-500 tabular-nums">
              เวลาปัจจุบัน {formatThaiDateTime(new Date(nowMs).toISOString())}
            </span>
          </div>
          <div className="divide-y divide-slate-100">
            {(prefs.history ?? []).map((item, idx) => (
              <div
                key={`${item.spreadsheetId}-${idx}`}
                className="px-5 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
              >
                <div>
                  <div className="font-medium text-slate-900">{item.spreadsheetTitle}</div>
                  <div className="text-slate-500 mt-0.5 tabular-nums">
                    สำรองเมื่อ {formatThaiDateTime(item.backedUpAt)} · {item.counts.cases} เคส ·{' '}
                    {item.counts.notes} Internal Notes · {item.counts.history} History Logs
                  </div>
                </div>
                <a
                  href={item.spreadsheetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-700 hover:underline font-medium shrink-0"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>เปิดชีต</span>
                </a>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Mandatory Confirmation Dialog Before Mutating / Overwriting Google Sheets */}
      {pendingPlan && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="backup-confirm-title"
        >
          <div className="w-full max-w-lg bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-2.5 bg-amber-50/70">
              <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0" />
              <h3 id="backup-confirm-title" className="text-sm font-semibold text-slate-900">
                ยืนยันการสำรองข้อมูลลง Google ชีต
              </h3>
            </div>

            <div className="p-6 space-y-4 text-sm text-slate-700">
              <p className="text-xs leading-relaxed text-slate-600">
                {pendingPlan.mode === 'new' ? (
                  <>
                    ระบบจะสร้างไฟล์ Google ชีตใหม่ชื่อ{' '}
                    <strong className="text-slate-900">"{pendingPlan.newTitle}"</strong>{' '}
                    ในบัญชี Google ({googleProfile?.email}) และเขียนข้อมูลสำรองทั้งหมดลงไป
                  </>
                ) : (
                  <>
                    ระบบจะ<strong className="text-amber-800">ล้างข้อมูลเดิมและเขียนข้อมูลสำรองทับ</strong>ในแท็บสำรองทั้ง
                    5 แท็บของไฟล์ Google ชีต{' '}
                    <strong className="text-slate-900">
                      "{pendingPlan.existingMeta?.title}"
                    </strong>
                  </>
                )}
              </p>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-1.5 text-xs">
                <div className="font-semibold text-slate-900 mb-1">รายการข้อมูลที่จะถูกบันทึก:</div>
                <div className="flex justify-between">
                  <span>เคสทั้งหมด ({BACKUP_SHEET_TABS.CASES})</span>
                  <strong className="font-mono">{cases.length} รายการ</strong>
                </div>
                <div className="flex justify-between">
                  <span>Internal Notes ({BACKUP_SHEET_TABS.NOTES})</span>
                  <strong className="font-mono">{pendingPlan.snapshot.totalNotes} รายการ</strong>
                </div>
                <div className="flex justify-between">
                  <span>ประวัติ History &amp; Logs ({BACKUP_SHEET_TABS.HISTORY})</span>
                  <strong className="font-mono">
                    {pendingPlan.snapshot.totalHistoryEvents} รายการ
                  </strong>
                </div>
                <div className="flex justify-between">
                  <span>ทีม / แผนก ({BACKUP_SHEET_TABS.TEAMS})</span>
                  <strong className="font-mono">{teams.length} รายการ</strong>
                </div>
              </div>
            </div>

            <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2.5">
              <button
                type="button"
                disabled={executingBackup}
                onClick={() => setPendingPlan(null)}
                className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-4 py-2 text-xs font-medium text-slate-700 cursor-pointer"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                disabled={executingBackup}
                onClick={handleConfirmExecuteBackup}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 px-4 py-2 text-xs font-semibold text-white cursor-pointer"
              >
                {executingBackup && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>
                  {executingBackup ? 'กำลังสำรองข้อมูลลง Google ชีต...' : 'ยืนยันสำรองข้อมูล'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
