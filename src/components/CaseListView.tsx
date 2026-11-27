import React from 'react';
import {
  AlertTriangle,
  Check,
  Clock,
  ExternalLink,
  Plus,
  Search,
} from 'lucide-react';
import { resolveCaseLinkDisplay } from '../lib/caseLink.ts';
import {
  computeAlertStage,
  computeClosedCaseRetention,
  computeLiveSlaState,
  formatSlaCountdown,
  formatThaiDate,
  getSlaLabel,
  getStatusLabel,
  needsUserAck,
} from '../lib/sla.ts';
import type { CaseItem, CaseStatus, Team, UserPublic } from '../types.ts';

interface CaseListViewProps {
  currentUser: UserPublic;
  cases: CaseItem[];
  teams: Team[];
  nowMs: number;
  loading: boolean;
  statusFilter: 'all' | CaseStatus;
  slaFilter: 'all' | 'alert' | 'overdue' | 'due_today' | 'normal';
  teamFilter: string | null;
  searchQuery: string;
  onStatusFilterChange: (val: 'all' | CaseStatus) => void;
  onSlaFilterChange: (val: 'all' | 'alert' | 'overdue' | 'due_today' | 'normal') => void;
  onTeamFilterChange: (val: string | null) => void;
  onSearchChange: (val: string) => void;
  onCreateCase: () => void;
  onInspectCase: (item: CaseItem) => void;
  onAcknowledgeOne: (item: CaseItem) => Promise<void>;
}

export const CaseListView: React.FC<CaseListViewProps> = ({
  currentUser,
  cases,
  teams,
  nowMs,
  loading,
  statusFilter,
  slaFilter,
  teamFilter,
  searchQuery,
  onStatusFilterChange,
  onSlaFilterChange,
  onTeamFilterChange,
  onSearchChange,
  onCreateCase,
  onInspectCase,
  onAcknowledgeOne,
}) => {
  const isAgent = currentUser.role === 'agent';

  const filtered = cases.filter((c) => {
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    if (!isAgent && teamFilter !== null && c.team_id !== teamFilter) return false;
    const liveSla = computeLiveSlaState(c.sla_due_at, c.status, nowMs);
    if (slaFilter === 'alert' && liveSla !== 'overdue' && liveSla !== 'due_today') return false;
    if (slaFilter !== 'all' && slaFilter !== 'alert' && liveSla !== slaFilter) return false;

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      const hit =
        c.case_no.toLowerCase().includes(q) ||
        (c.case_url ?? '').toLowerCase().includes(q) ||
        c.shop_id.toLowerCase().includes(q) ||
        c.issue_summary.toLowerCase().includes(q) ||
        c.details.toLowerCase().includes(q) ||
        c.assignee_name.toLowerCase().includes(q) ||
        c.team_name.toLowerCase().includes(q);
      if (!hit) return false;
    }
    return true;
  });

  return (
    <div className="space-y-5">
      {/* Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">รายการงาน To-Do และติดตามเคส</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {isAgent
              ? `แสดงเฉพาะเคสของทีม ${currentUser.team_name} · จำนวน ${filtered.length} รายการ`
              : `แสดงเคสทั้งหมดตามตัวกรอง · จำนวน ${filtered.length} รายการ`}
          </p>
        </div>

        <button
          type="button"
          onClick={onCreateCase}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-700 hover:bg-blue-800 px-4 py-2 text-sm font-medium text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4 shrink-0" />
          <span>เปิดเคสใหม่</span>
        </button>
      </div>

      {/* Filter & Search Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          {/* Segmented Status Tabs */}
          <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(
              [
                { id: 'all', label: 'ทั้งหมด' },
                { id: 'todo', label: 'รอดำเนินการ' },
                { id: 'in_progress', label: 'กำลังดำเนินการ' },
                { id: 'done', label: 'ปิดเคสแล้ว' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => onStatusFilterChange(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  statusFilter === tab.id
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 flex-1 lg:max-w-xl justify-end">
            <select
              aria-label="กรองตามสถานะ SLA"
              value={slaFilter}
              onChange={(e) =>
                onSlaFilterChange(
                  e.target.value as 'all' | 'alert' | 'overdue' | 'due_today' | 'normal'
                )
              }
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 focus:border-blue-600 focus:outline-none"
            >
              <option value="all">ทุกสถานะ SLA</option>
              <option value="alert">ถึงกำหนด &amp; เกิน SLA</option>
              <option value="overdue">เฉพาะเกิน SLA</option>
              <option value="due_today">เฉพาะถึงกำหนด SLA</option>
              <option value="normal">อยู่ในเกณฑ์ปกติ</option>
            </select>

            {!isAgent && (
              <select
                aria-label="กรองตามแผนก"
                value={teamFilter ?? ''}
                onChange={(e) => onTeamFilterChange(e.target.value ? e.target.value : null)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 focus:border-blue-600 focus:outline-none"
              >
                <option value="">ทุกทีม / แผนก</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}

            <div className="relative flex-1 min-w-[200px]">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="ค้นหาเลขเคส, ลิงก์เคส, ปัญหา, ผู้รับเรื่อง..."
                className="w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Case To-Do Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {loading && cases.length === 0 ? (
          <div className="p-8 space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-12 bg-slate-100 rounded animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-14 px-6 text-center">
            <div className="text-sm font-medium text-slate-900">ไม่พบรายการเคสที่ตรงกับเงื่อนไข</div>
            <p className="text-xs text-slate-500 mt-1">
              ลองปรับเปลี่ยนตัวกรองสถานะ หรือสร้างเคสใหม่เพื่อเริ่มติดตามงาน To-Do
            </p>
            <button
              type="button"
              onClick={onCreateCase}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-700 hover:bg-blue-800 px-4 py-2 text-xs font-medium text-white transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>เปิดเคสใหม่</span>
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                  <th className="py-3 pl-5 pr-3">เลขเคส / สถานะ</th>
                  <th className="py-3 px-3">รายละเอียดปัญหา &amp; บันทึก</th>
                  <th className="py-3 px-3">ทีม / ผู้รับเรื่อง</th>
                  <th className="py-3 px-3">SLA (วันครบกำหนด)</th>
                  <th className="py-3 pl-3 pr-5 text-right">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filtered.map((item) => {
                  const liveSla = computeLiveSlaState(item.sla_due_at, item.status, nowMs);
                  const alertStage = computeAlertStage(item.sla_due_at, item.status, nowMs);
                  const countdown = formatSlaCountdown(item.sla_due_at, item.status, nowMs);
                  const closedRetention = computeClosedCaseRetention(
                    item.resolved_at || item.updated_at,
                    item.status,
                    nowMs
                  );
                  const needsAckNow = needsUserAck(item, nowMs);
                  const userAckedCurrentStage = alertStage !== null && !needsAckNow;
                  const caseLink = resolveCaseLinkDisplay(item.case_no, item.case_url);

                  return (
                    <tr key={item.id} className="hover:bg-slate-50/80 transition-colors align-top">
                      <td className="py-3.5 pl-5 pr-3 whitespace-nowrap">
                        {caseLink.url ? (
                          <a
                            href={caseLink.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="คลิกเพื่อเปิดลิงก์เคส"
                            className="inline-flex items-center gap-1 font-mono text-xs font-semibold text-blue-700 hover:text-blue-900 hover:underline tabular-nums"
                          >
                            <span>{caseLink.label}</span>
                            <ExternalLink className="w-3 h-3 shrink-0" />
                          </a>
                        ) : (
                          <div className="font-mono text-xs font-semibold text-slate-900 tabular-nums">
                            {caseLink.label}
                          </div>
                        )}
                        <div className="text-xs text-slate-500 mt-1">
                          {getStatusLabel(item.status)}
                        </div>
                      </td>

                      <td className="py-3.5 px-3 max-w-md">
                        <button
                          type="button"
                          onClick={() => onInspectCase(item)}
                          className={`text-left font-medium hover:text-blue-700 transition-colors cursor-pointer ${
                            item.status === 'done' ? 'line-through text-slate-500' : 'text-slate-900'
                          }`}
                        >
                          {item.issue_summary}
                        </button>
                        {item.details && (
                          <p className="text-xs text-slate-500 mt-1 line-clamp-2 leading-relaxed">
                            {item.details}
                          </p>
                        )}
                      </td>

                      <td className="py-3.5 px-3 whitespace-nowrap">
                        <div className="text-xs font-medium text-slate-900">{item.team_name}</div>
                        <div className="text-xs text-slate-500 mt-0.5">{item.assignee_name}</div>
                        {item.pending_escalation_id && (
                          <div className="text-xs font-medium text-amber-700 mt-0.5">
                            รอการตอบรับ Escalate
                          </div>
                        )}
                      </td>

                      <td className="py-3.5 px-3 whitespace-nowrap">
                        <div
                          className={`inline-flex items-center gap-1.5 text-xs font-medium tabular-nums ${
                            liveSla === 'overdue'
                              ? 'text-red-700'
                              : liveSla === 'due_today'
                                ? 'text-amber-700'
                                : liveSla === 'resolved'
                                  ? 'text-emerald-700'
                                  : 'text-slate-700'
                          }`}
                        >
                          {liveSla === 'overdue' && <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
                          {liveSla === 'due_today' && <Clock className="w-3.5 h-3.5 shrink-0" />}
                          <span>{getSlaLabel(liveSla)}</span>
                        </div>
                        <div className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                          {formatThaiDate(item.sla_due_at)}
                        </div>
                        <div className="text-xs text-slate-500 tabular-nums mt-0.5">
                          {countdown}
                          {userAckedCurrentStage && (
                            <span className="text-slate-400"> · คุณรับทราบแล้ว</span>
                          )}
                        </div>
                        {closedRetention && (
                          <div
                            className={`text-xs font-medium tabular-nums mt-0.5 ${
                              closedRetention.isExpired ? 'text-red-700' : 'text-emerald-700'
                            }`}
                          >
                            {closedRetention.countdownText}
                          </div>
                        )}
                      </td>

                      <td className="py-3.5 pl-3 pr-5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-2">
                          {needsAckNow && (
                            <button
                              type="button"
                              onClick={() => onAcknowledgeOne(item)}
                              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-white transition-colors whitespace-nowrap cursor-pointer ${
                                alertStage === 'overdue'
                                  ? 'bg-red-600 hover:bg-red-700'
                                  : 'bg-amber-600 hover:bg-amber-700'
                              }`}
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>รับทราบ</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onInspectCase(item)}
                            className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors whitespace-nowrap cursor-pointer"
                          >
                            {currentUser.role === 'admin'
                              ? 'ตรวจสอบ / แก้ไข'
                              : 'ดู / อัปเดต'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
