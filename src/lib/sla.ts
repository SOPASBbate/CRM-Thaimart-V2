import type { AlertStage, CaseItem, CaseStatus, RoleLevel, SlaState } from '../types.ts';

export function toLocalDateInput(value: string | number | Date): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseLocalMidnightMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return Number.NaN;
  return new Date(y, m - 1, d).getTime();
}

export function computeLiveSlaState(slaDueAt: string, status: CaseStatus, nowMs: number): SlaState {
  if (status === 'done') return 'resolved';
  const dueDateStr = toLocalDateInput(slaDueAt);
  if (!dueDateStr) return 'normal';
  const todayStr = toLocalDateInput(nowMs);
  if (dueDateStr < todayStr) return 'overdue';
  if (dueDateStr === todayStr) return 'due_today';
  return 'normal';
}

export function computeAlertStage(
  slaDueAt: string,
  status: CaseStatus,
  nowMs: number
): AlertStage | null {
  if (status === 'done') return null;
  const dueDateStr = toLocalDateInput(slaDueAt);
  if (!dueDateStr) return null;
  const todayStr = toLocalDateInput(nowMs);
  if (dueDateStr < todayStr) return 'overdue';
  if (dueDateStr === todayStr) return 'due_today';
  return null;
}

export function needsUserAck(item: CaseItem, nowMs: number): boolean {
  const stage = computeAlertStage(item.sla_due_at, item.status, nowMs);
  if (!stage) return false;
  const acked = item.my_ack_stages ?? [];
  if (stage === 'due_today') {
    return (
      !acked.includes('due_today') &&
      !acked.includes('overdue') &&
      !acked.includes('due_reached')
    );
  }
  if (stage === 'overdue') {
    return !acked.includes('overdue') && !acked.includes('due_reached');
  }
  return false;
}

export function formatThaiDate(value: string | null | undefined): string {
  if (!value) return '-';
  const dateStr = toLocalDateInput(value);
  if (!dateStr) return '-';
  const ms = parseLocalMidnightMs(dateStr);
  if (Number.isNaN(ms)) return '-';
  return new Date(ms).toLocaleDateString('th-TH', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  });
}

export function formatThaiDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('th-TH', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatSlaCountdown(slaDueAt: string, status: CaseStatus, nowMs: number): string {
  if (status === 'done') return 'ปิดเคสแล้ว';
  const dueDateStr = toLocalDateInput(slaDueAt);
  const todayStr = toLocalDateInput(nowMs);
  if (!dueDateStr || !todayStr) return '-';
  const dueMidnight = parseLocalMidnightMs(dueDateStr);
  const todayMidnight = parseLocalMidnightMs(todayStr);
  const diffDays = Math.round((dueMidnight - todayMidnight) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) {
    return `เกินกำหนด ${Math.abs(diffDays)} วัน`;
  }
  if (diffDays === 0) {
    return 'ครบกำหนดวันนี้';
  }
  if (diffDays === 1) {
    return 'ครบกำหนดพรุ่งนี้';
  }
  return `อีก ${diffDays} วัน`;
}

export function getStatusLabel(status: CaseStatus): string {
  switch (status) {
    case 'todo':
      return 'รอดำเนินการ';
    case 'in_progress':
      return 'กำลังดำเนินการ';
    case 'done':
      return 'ปิดเคสแล้ว';
  }
}

export function getSlaLabel(state: SlaState): string {
  switch (state) {
    case 'overdue':
      return 'เกินกำหนด SLA';
    case 'due_today':
      return 'ถึงกำหนด SLA';
    case 'normal':
      return 'อยู่ในเกณฑ์ปกติ';
    case 'resolved':
      return 'เสร็จสิ้น';
  }
}

export function getRoleLabel(role: RoleLevel): string {
  switch (role) {
    case 'admin':
      return 'Admin (ผู้ดูแลระบบ)';
    case 'tl':
      return 'TL (หัวหน้าทีม)';
    case 'agent':
      return 'Agent (เจ้าหน้าที่)';
  }
}
