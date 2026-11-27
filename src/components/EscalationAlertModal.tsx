import React, { useEffect, useState } from 'react';
import {
  ArrowRightLeft,
  Check,
  ExternalLink,
  RotateCcw,
  Send,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  playEscalationIncomingChime,
  playEscalationRejectedChime,
  unlockAudio,
} from '../lib/bell.ts';
import { resolveCaseLinkDisplay } from '../lib/caseLink.ts';
import { formatActionErrorMessage } from '../lib/firestoreService.ts';
import { formatThaiDate, formatThaiDateTime } from '../lib/sla.ts';
import type { CaseEscalation } from '../types.ts';

interface EscalationAlertModalProps {
  open: boolean;
  incomingEscalations: CaseEscalation[];
  rejectedEscalations: CaseEscalation[];
  alertNonce: number;
  onAccept: (esc: CaseEscalation) => Promise<void>;
  onReject: (esc: CaseEscalation, reason: string) => Promise<void>;
  onAcknowledgeRejected: (esc: CaseEscalation) => Promise<void>;
  onInspectCaseById: (caseId: string) => void;
  onClose: () => void;
}

export const EscalationAlertModal: React.FC<EscalationAlertModalProps> = ({
  open,
  incomingEscalations,
  rejectedEscalations,
  alertNonce,
  onAccept,
  onReject,
  onAcknowledgeRejected,
  onInspectCaseById,
  onClose,
}) => {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);

  const totalCount = incomingEscalations.length + rejectedEscalations.length;
  const hasIncoming = incomingEscalations.length > 0;

  useEffect(() => {
    if (open && totalCount > 0) {
      setMuted(false);
      setActionError(null);
    }
  }, [open, totalCount, alertNonce]);

  useEffect(() => {
    if (!open || totalCount === 0 || muted) {
      return;
    }

    let cancelled = false;

    const ringOnce = async () => {
      if (cancelled) return;
      const played = hasIncoming
        ? await playEscalationIncomingChime()
        : await playEscalationRejectedChime();
      if (!cancelled) {
        setAudioBlocked(!played);
      }
    };

    void ringOnce();
    const intervalId = setInterval(() => {
      void ringOnce();
    }, 3200);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [open, totalCount, muted, hasIncoming]);

  if (!open || totalCount === 0) return null;

  const handleToggleSound = async () => {
    if (audioBlocked) {
      const ok = await unlockAudio();
      setAudioBlocked(!ok);
      setMuted(false);
      if (ok) {
        if (hasIncoming) {
          void playEscalationIncomingChime();
        } else {
          void playEscalationRejectedChime();
        }
      }
      return;
    }
    setMuted((prev) => !prev);
  };

  const handleAccept = async (esc: CaseEscalation) => {
    setActionError(null);
    setBusyId(esc.id);
    try {
      await onAccept(esc);
      setRejectingId((prev) => (prev === esc.id ? null : prev));
    } catch (err) {
      setActionError(formatActionErrorMessage(err, 'ไม่สามารถตอบรับเคสได้'));
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmReject = async (esc: CaseEscalation) => {
    setActionError(null);
    setBusyId(esc.id);
    try {
      const reason = rejectReasons[esc.id] ?? '';
      await onReject(esc, reason);
      setRejectingId(null);
      setRejectReasons((prev) => {
        const next = { ...prev };
        delete next[esc.id];
        return next;
      });
    } catch (err) {
      setActionError(formatActionErrorMessage(err, 'ไม่สามารถ Reject เคสได้'));
    } finally {
      setBusyId(null);
    }
  };

  const handleAckRejected = async (esc: CaseEscalation) => {
    setActionError(null);
    setBusyId(esc.id);
    try {
      await onAcknowledgeRejected(esc);
    } catch (err) {
      setActionError(formatActionErrorMessage(err, 'ไม่สามารถกดรับทราบการส่งคืนได้'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="escalation-popup-title"
    >
      <div className="w-full max-w-3xl max-h-[88vh] flex flex-col bg-slate-50 border border-slate-200 rounded-xl shadow-xl overflow-hidden">
        {/* Header */}
        <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 ${
                hasIncoming
                  ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                  : 'bg-rose-50 border-rose-200 text-rose-700'
              }`}
            >
              {hasIncoming ? (
                <ArrowRightLeft className="w-5 h-5" />
              ) : (
                <RotateCcw className="w-5 h-5" />
              )}
            </div>
            <div className="min-w-0">
              <h2 id="escalation-popup-title" className="text-base font-semibold text-slate-900">
                แจ้งเตือนการส่งต่อเคส ({totalCount} รายการ)
              </h2>
              <p className="text-xs text-slate-500">
                {hasIncoming
                  ? 'มีเคสที่ส่งต่อ (Escalate) มาให้คุณดูแล กรุณากด Accepted หรือ Reject'
                  : 'มีเคสที่คุณส่งต่อถูก Reject กลับคืนมาที่ผู้ส่ง'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleToggleSound}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                audioBlocked
                  ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
                  : muted
                    ? 'border-slate-300 bg-slate-50 text-slate-600 hover:bg-slate-100'
                    : 'border-indigo-200 bg-indigo-50 text-indigo-800 hover:bg-indigo-100'
              }`}
            >
              {muted || audioBlocked ? (
                <VolumeX className="w-3.5 h-3.5 shrink-0" />
              ) : (
                <Volume2 className="w-3.5 h-3.5 shrink-0" />
              )}
              <span>
                {audioBlocked
                  ? 'กดเปิดเสียงแจ้งเตือน'
                  : muted
                    ? 'ปิดเสียงอยู่'
                    : 'เสียงแจ้งเตือนส่งต่อ'}
              </span>
            </button>

            <button
              type="button"
              onClick={onClose}
              aria-label="ปิดหน้าต่างชั่วคราว"
              className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {actionError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
              {actionError}
            </div>
          )}

          {/* Incoming Escalations for Recipient */}
          {incomingEscalations.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-indigo-800">
                  <Send className="w-4 h-4 shrink-0" />
                  <span>มีเคสส่งต่อ (Escalate) มาถึงคุณ</span>
                </div>
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  {incomingEscalations.length} เคส
                </span>
              </div>

              <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg bg-white">
                {incomingEscalations.map((esc) => {
                  const isRejectOpen = rejectingId === esc.id;
                  return (
                    <div key={esc.id} className="p-4 space-y-3">
                      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                            {(() => {
                              const caseLink = resolveCaseLinkDisplay(esc.case_no, esc.case_url);
                              return caseLink.url ? (
                                <a
                                  href={caseLink.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title="คลิกเพื่อเปิดลิงก์เคส"
                                  className="inline-flex items-center gap-1 font-mono font-semibold text-blue-700 hover:text-blue-900 hover:underline tabular-nums"
                                >
                                  <span>{caseLink.label}</span>
                                  <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                                </a>
                              ) : (
                                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                                  {caseLink.label}
                                </span>
                              );
                            })()}
                            <span aria-hidden="true">·</span>
                            <span className="text-indigo-700 font-medium">
                              ส่งต่อจาก: {esc.from_user_name} ({esc.from_team_name})
                            </span>
                          </div>

                          <p className="text-sm font-medium text-slate-900">{esc.issue_summary}</p>

                          {esc.details_preview && (
                            <p className="text-xs text-slate-600 line-clamp-2 leading-relaxed">
                              {esc.details_preview}
                            </p>
                          )}

                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 pt-0.5">
                            <span className="tabular-nums">
                              วันครบกำหนด SLA: {formatThaiDate(esc.sla_due_at)}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="tabular-nums">
                              ส่งเมื่อ: {formatThaiDateTime(esc.created_at)}
                            </span>
                          </div>

                          {esc.note && (
                            <div className="mt-2 rounded-md border border-indigo-100 bg-indigo-50/70 px-3 py-2 text-xs text-indigo-950">
                              <span className="font-semibold">หมายเหตุการส่งต่อ:</span> {esc.note}
                            </div>
                          )}
                        </div>

                        {!isRejectOpen && (
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() => {
                                setActionError(null);
                                setRejectingId(esc.id);
                              }}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white hover:bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>Reject</span>
                            </button>

                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() => handleAccept(esc)}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-3.5 py-1.5 text-xs font-medium text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>{busyId === esc.id ? 'กำลังรับเคส...' : 'Accepted'}</span>
                            </button>
                          </div>
                        )}
                      </div>

                      {isRejectOpen && (
                        <div className="rounded-lg border border-rose-200 bg-rose-50/60 p-3 space-y-2.5">
                          <label className="block text-xs font-medium text-rose-900">
                            ระบุเหตุผลการส่งคืน (ไม่บังคับ) — เคสจะถูกส่งกลับไปยัง {esc.from_user_name}
                          </label>
                          <input
                            type="text"
                            value={rejectReasons[esc.id] ?? ''}
                            onChange={(e) =>
                              setRejectReasons((prev) => ({ ...prev, [esc.id]: e.target.value }))
                            }
                            placeholder="เช่น ข้อมูลไม่ครบถ้วน / ผิดทีมที่รับผิดชอบ..."
                            className="w-full rounded-md border border-rose-200 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-rose-500 focus:outline-none"
                          />
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() => setRejectingId(null)}
                              className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer"
                            >
                              ยกเลิก
                            </button>
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() => handleConfirmReject(esc)}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-60 px-3.5 py-1.5 text-xs font-medium text-white cursor-pointer"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>{busyId === esc.id ? 'กำลังส่งคืน...' : 'ยืนยัน Reject ส่งกลับต้นทาง'}</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Rejected Outgoing Escalations back to Sender */}
          {rejectedEscalations.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-rose-800">
                  <RotateCcw className="w-4 h-4 shrink-0" />
                  <span>เคสที่ส่งต่อถูก Reject กลับคืนมา</span>
                </div>
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  {rejectedEscalations.length} เคส
                </span>
              </div>

              <div className="divide-y divide-slate-200 border border-rose-200 rounded-lg bg-white">
                {rejectedEscalations.map((esc) => (
                  <div key={esc.id} className="p-4 space-y-2.5">
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                          {(() => {
                            const caseLink = resolveCaseLinkDisplay(esc.case_no, esc.case_url);
                            return caseLink.url ? (
                              <a
                                href={caseLink.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="คลิกเพื่อเปิดลิงก์เคส"
                                className="inline-flex items-center gap-1 font-mono font-semibold text-blue-700 hover:text-blue-900 hover:underline tabular-nums"
                              >
                                <span>{caseLink.label}</span>
                                <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                              </a>
                            ) : (
                              <span className="font-mono font-semibold text-slate-900 tabular-nums">
                                {caseLink.label}
                              </span>
                            );
                          })()}
                          <span aria-hidden="true">·</span>
                          <span className="text-rose-700 font-medium">
                            ถูก Reject โดย: {esc.to_user_name} ({esc.to_team_name})
                          </span>
                        </div>

                        <p className="text-sm font-medium text-slate-900">{esc.issue_summary}</p>

                        <div className="text-xs text-slate-500 tabular-nums">
                          ปฏิเสธเมื่อ: {formatThaiDateTime(esc.updated_at)} · เคสกลับคืนสู่ต้นทางแล้ว
                        </div>

                        {esc.reject_reason && (
                          <div className="mt-1.5 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                            <span className="font-semibold">เหตุผลการ Reject:</span> {esc.reject_reason}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            onInspectCaseById(esc.case_id);
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>ดูเคส</span>
                        </button>

                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => handleAckRejected(esc)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-60 px-3.5 py-1.5 text-xs font-medium text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>{busyId === esc.id ? 'กำลังบันทึก...' : 'รับทราบการส่งคืน'}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="bg-white border-t border-slate-200 px-6 py-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            ระบบจะแจ้งเตือนซ้ำอัตโนมัติทุก 30 วินาที จนกว่าจะกดตอบรับหรือรับทราบครบทุกรายการ
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-4 py-2 text-xs font-medium text-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            ซ่อนชั่วคราว (แจ้งเตือนซ้ำใน 30 วิ)
          </button>
        </div>
      </div>
    </div>
  );
};
