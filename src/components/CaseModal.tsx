import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  Download,
  Edit3,
  ExternalLink,
  FileText,
  History,
  Image as ImageIcon,
  Lock,
  MessageSquarePlus,
  Paperclip,
  RotateCcw,
  Send,
  Trash2,
  Video,
  X,
  ZoomIn,
} from 'lucide-react';
import {
  deleteServerAttachment,
  formatFileSize,
  getAttachmentDownloadUrl,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_NOTE_ATTACHMENTS,
  uploadNoteAttachment,
} from '../lib/attachments.ts';
import { getSafeCaseUrl, resolveCaseLinkDisplay } from '../lib/caseLink.ts';
import {
  createCaseDoc,
  createCaseEscalationDoc,
  createInternalNoteDoc,
  deleteCaseDoc,
  deleteInternalNoteDoc,
  fetchCaseAckHistory,
  fetchInternalNoteEditLogs,
  formatActionErrorMessage,
  subscribeCaseEscalationLogs,
  subscribeCaseInternalNotes,
  updateCaseDoc,
  updateInternalNoteDoc,
} from '../lib/firestoreService.ts';
import {
  computeClosedCaseRetention,
  computeLiveSlaState,
  formatThaiDate,
  formatThaiDateTime,
  toLocalDateInput,
} from '../lib/sla.ts';
import type {
  AckHistoryEntry,
  CaseEscalation,
  CaseEscalationLog,
  CaseItem,
  CaseStatus,
  InternalNote,
  InternalNoteEditLog,
  NoteAttachment,
  RoleLevel,
  Team,
  UserPublic,
} from '../types.ts';

interface CaseModalProps {
  open: boolean;
  editingCase: CaseItem | null;
  currentUser: UserPublic;
  nowMs: number;
  teams: Team[];
  assignableUsers: UserPublic[];
  allActiveUsers: UserPublic[];
  existingCases: CaseItem[];
  incomingEscalations: CaseEscalation[];
  rejectedEscalations: CaseEscalation[];
  onAcceptEscalation: (esc: CaseEscalation) => Promise<void>;
  onRejectEscalation: (esc: CaseEscalation, reason: string) => Promise<void>;
  onAcknowledgeRejectedEscalation: (esc: CaseEscalation) => Promise<void>;
  onClose: () => void;
}

type CaseModalTab = 'details' | 'history';
type HistoryFilter = 'all' | 'escalation' | 'sla' | 'note_edit';

interface UnifiedHistoryItem {
  id: string;
  category: 'escalation' | 'sla' | 'note_edit';
  timestampIso: string;
  timestampMs: number;
  title: string;
  actorLabel?: string;
  description?: string;
  badgeTone: 'indigo' | 'emerald' | 'rose' | 'red' | 'amber' | 'slate';
  diffOldContent?: string;
  diffNewContent?: string;
  diffOldSla?: string;
  diffNewSla?: string;
  diffOldAttachments?: string;
  diffNewAttachments?: string;
}

function getDefaultSlaDate(daysAhead = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return toLocalDateInput(d);
}

function getShortRoleLabel(role: RoleLevel): string {
  switch (role) {
    case 'admin':
      return 'Admin';
    case 'tl':
      return 'TL';
    case 'agent':
      return 'Agent';
  }
}

function getAckLevelText(level: string): string {
  switch (level) {
    case 'overdue':
      return 'กดรับทราบเมื่อเกินวันครบกำหนด SLA';
    case 'due_today':
      return 'กดรับทราบเมื่อถึงวันครบกำหนด SLA';
    case 'due_reached':
      return 'กดรับทราบเมื่อถึง/เกินกำหนด SLA';
    default:
      return 'กดรับทราบแจ้งเตือน SLA';
  }
}

function computeOverdueStartIso(slaDueAt: string): string | null {
  const dateStr = toLocalDateInput(slaDueAt);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return null;
  // SLA becomes overdue at 00:00 of the day immediately after sla_due_at
  const overdueDate = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return overdueDate.toISOString();
}

export const CaseModal: React.FC<CaseModalProps> = ({
  open,
  editingCase,
  currentUser,
  nowMs,
  teams,
  assignableUsers,
  allActiveUsers,
  existingCases,
  incomingEscalations,
  rejectedEscalations,
  onAcceptEscalation,
  onRejectEscalation,
  onAcknowledgeRejectedEscalation,
  onClose,
}) => {
  const activeCase = editingCase
    ? existingCases.find((c) => c.id === editingCase.id) ?? editingCase
    : null;
  const isNew = !activeCase;
  const isAdmin = currentUser.role === 'admin';
  const isTL = currentUser.role === 'tl';
  const canEditOriginalDetails = isNew || isAdmin;
  const canReassign = !isNew && (isAdmin || isTL);
  const canDeleteCase = !isNew && isAdmin;

  const [activeTab, setActiveTab] = useState<CaseModalTab>('details');
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all');
  const [historySortAsc, setHistorySortAsc] = useState(true);

  const [caseNo, setCaseNo] = useState('');
  const [caseUrl, setCaseUrl] = useState('');
  const [issueSummary, setIssueSummary] = useState('');
  const [details, setDetails] = useState('');
  const [status, setStatus] = useState<CaseStatus>('todo');
  const [slaDueInput, setSlaDueInput] = useState('');
  const [assigneeId, setAssigneeId] = useState<string>(currentUser.uid);
  const [teamId, setTeamId] = useState<string>(currentUser.team_id);

  const [ackHistory, setAckHistory] = useState<AckHistoryEntry[]>([]);
  const [escalationLogs, setEscalationLogs] = useState<CaseEscalationLog[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [caseSavedMsg, setCaseSavedMsg] = useState<string | null>(null);

  // Escalate states
  const [escalateTargetId, setEscalateTargetId] = useState('');
  const [escalateNote, setEscalateNote] = useState('');
  const [escalateConfirming, setEscalateConfirming] = useState(false);
  const [escalateSubmitting, setEscalateSubmitting] = useState(false);
  const [escalateError, setEscalateError] = useState<string | null>(null);
  const [escalateSuccess, setEscalateSuccess] = useState<string | null>(null);
  const [inModalRejectOpen, setInModalRejectOpen] = useState(false);
  const [inModalRejectReason, setInModalRejectReason] = useState('');
  const [escalateActionBusy, setEscalateActionBusy] = useState(false);

  // Internal Note states
  const [notes, setNotes] = useState<InternalNote[]>([]);
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [editLogsByNote, setEditLogsByNote] = useState<Record<string, InternalNoteEditLog[]>>({});
  const [newNoteContent, setNewNoteContent] = useState('');
  const [newAttachments, setNewAttachments] = useState<NoteAttachment[]>([]);
  const [uploadingNewFiles, setUploadingNewFiles] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [adjustSla, setAdjustSla] = useState(false);
  const [noteNewSla, setNoteNewSla] = useState('');
  const [noteSubmitting, setNoteSubmitting] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  // Inline note edit & delete states
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editNoteContent, setEditNoteContent] = useState('');
  const [editNoteSla, setEditNoteSla] = useState('');
  const [editAttachments, setEditAttachments] = useState<NoteAttachment[]>([]);
  const [uploadingEditFiles, setUploadingEditFiles] = useState(false);
  const [editUploadProgress, setEditUploadProgress] = useState(0);
  const [savingNoteEdit, setSavingNoteEdit] = useState(false);
  const [confirmDeleteNoteId, setConfirmDeleteNoteId] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<NoteAttachment | null>(null);

  const newFileInputRef = useRef<HTMLInputElement | null>(null);
  const editFileInputRef = useRef<HTMLInputElement | null>(null);

  const editingCaseId = editingCase?.id ?? null;

  // Initialize form when modal opens or switches case
  useEffect(() => {
    if (!open) return;
    setActiveTab('details');
    setHistoryFilter('all');
    setHistorySortAsc(true);
    setError(null);
    setCaseSavedMsg(null);
    setConfirmDelete(false);
    setNoteError(null);
    setNewNoteContent('');
    setNewAttachments([]);
    setUploadingNewFiles(false);
    setUploadProgress(0);
    setAdjustSla(false);
    setEditingNoteId(null);
    setEditAttachments([]);
    setUploadingEditFiles(false);
    setEditUploadProgress(0);
    setConfirmDeleteNoteId(null);
    setPreviewImage(null);
    setEscalateTargetId('');
    setEscalateNote('');
    setEscalateConfirming(false);
    setEscalateError(null);
    setEscalateSuccess(null);
    setInModalRejectOpen(false);
    setInModalRejectReason('');
    setEscalateActionBusy(false);

    if (editingCase) {
      const legacyUrl = !editingCase.case_url ? getSafeCaseUrl(editingCase.case_no) : null;
      setCaseNo(editingCase.case_no);
      setCaseUrl(editingCase.case_url ?? legacyUrl ?? '');
      setIssueSummary(editingCase.issue_summary);
      setDetails(editingCase.details);
      setStatus(editingCase.status);
      const localDue = toLocalDateInput(editingCase.sla_due_at);
      setSlaDueInput(localDue);
      setNoteNewSla(localDue || getDefaultSlaDate(1));
      setAssigneeId(editingCase.assignee_id);
      setTeamId(editingCase.team_id);
      fetchCaseAckHistory(editingCase.id)
        .then((res) => setAckHistory(res))
        .catch(() => setAckHistory([]));
    } else {
      setCaseNo('');
      setCaseUrl('');
      setIssueSummary('');
      setDetails('');
      setStatus('todo');
      setSlaDueInput(getDefaultSlaDate(0));
      setNoteNewSla(getDefaultSlaDate(0));
      setAssigneeId(currentUser.uid);
      setTeamId(currentUser.team_id);
      setAckHistory([]);
      setEscalationLogs([]);
      setNotes([]);
      setEditLogsByNote({});
    }
  }, [open, editingCaseId, currentUser.uid, currentUser.team_id]);

  // Refresh ack history whenever switching to History tab
  useEffect(() => {
    if (!open || !editingCaseId || activeTab !== 'history') return;
    fetchCaseAckHistory(editingCaseId)
      .then((res) => setAckHistory(res))
      .catch(() => {});
  }, [open, editingCaseId, activeTab]);

  // Keep SLA date and assignee synced if updated in real time while modal is open
  useEffect(() => {
    if (!open || !activeCase) return;
    const latestDue = toLocalDateInput(activeCase.sla_due_at);
    if (latestDue) {
      setSlaDueInput(latestDue);
      if (!adjustSla) {
        setNoteNewSla(latestDue);
      }
    }
    setAssigneeId(activeCase.assignee_id);
    setTeamId(activeCase.team_id);
  }, [open, activeCase?.sla_due_at, activeCase?.assignee_id, activeCase?.team_id, adjustSla]);

  // Subscribe to real-time Internal Notes for the opened case
  useEffect(() => {
    if (!open || !editingCaseId) return;
    setLoadingNotes(true);
    const unsub = subscribeCaseInternalNotes(
      editingCaseId,
      (list) => {
        setNotes(list);
        setLoadingNotes(false);
      },
      (err) => {
        setNoteError(err.message || 'ไม่สามารถโหลด Internal Note ได้');
        setLoadingNotes(false);
      }
    );
    return () => unsub();
  }, [open, editingCaseId]);

  // Subscribe to real-time Escalation Logs for the opened case
  useEffect(() => {
    if (!open || !editingCaseId) return;
    const unsub = subscribeCaseEscalationLogs(
      editingCaseId,
      (logs) => setEscalationLogs(logs),
      () => setEscalationLogs([])
    );
    return () => unsub();
  }, [open, editingCaseId]);

  // Load edit logs for edited notes
  const editedSignature = notes
    .filter((n) => n.is_edited)
    .map((n) => `${n.id}:${n.last_edit_log_id}`)
    .join('|');

  useEffect(() => {
    if (!open || !editingCaseId) return;
    const editedNotes = notes.filter((n) => n.is_edited);
    if (editedNotes.length === 0) {
      setEditLogsByNote({});
      return;
    }

    let cancelled = false;
    Promise.all(
      editedNotes.map(async (n) => {
        const logs = await fetchInternalNoteEditLogs(editingCaseId, n.id).catch(() => []);
        return [n.id, logs] as const;
      })
    ).then((pairs) => {
      if (cancelled) return;
      const map: Record<string, InternalNoteEditLog[]> = {};
      for (const [id, logs] of pairs) {
        map[id] = logs;
      }
      setEditLogsByNote(map);
    });

    return () => {
      cancelled = true;
    };
  }, [open, editingCaseId, editedSignature]);

  // Eligible Escalate recipients (all active users excluding self)
  const escalateRecipients = useMemo(() => {
    return allActiveUsers
      .filter((u) => u.uid !== currentUser.uid)
      .sort((a, b) => a.display_name.localeCompare(b.display_name, 'th'));
  }, [allActiveUsers, currentUser.uid]);

  const pendingEscalationLog = useMemo(() => {
    if (!activeCase?.pending_escalation_id) return null;
    return escalationLogs.find((l) => l.id === activeCase.pending_escalation_id) ?? null;
  }, [activeCase?.pending_escalation_id, escalationLogs]);

  const incomingPendingForCase = useMemo(() => {
    if (!activeCase) return null;
    return incomingEscalations.find((e) => e.case_id === activeCase.id) ?? null;
  }, [activeCase, incomingEscalations]);

  const rejectedForCase = useMemo(() => {
    if (!activeCase) return null;
    return rejectedEscalations.find((e) => e.case_id === activeCase.id) ?? null;
  }, [activeCase, rejectedEscalations]);

  // Build unified chronological history timeline (acks, SLA overdue time, internal note edits, escalations)
  const unifiedHistory = useMemo<UnifiedHistoryItem[]>(() => {
    if (!activeCase) return [];
    const items: UnifiedHistoryItem[] = [];

    // 1. SLA Overdue timestamp event (if SLA date passed before resolution or currently overdue)
    const overdueStartIso = computeOverdueStartIso(activeCase.sla_due_at);
    if (overdueStartIso) {
      const overdueStartMs = new Date(overdueStartIso).getTime();
      const nowMs = Date.now();
      const liveState = computeLiveSlaState(activeCase.sla_due_at, activeCase.status, nowMs);
      const resolvedAfterOverdue =
        activeCase.status === 'done' &&
        activeCase.resolved_at &&
        new Date(activeCase.resolved_at).getTime() >= overdueStartMs;

      if (liveState === 'overdue' || resolvedAfterOverdue) {
        items.push({
          id: `sla-overdue-${activeCase.sla_due_at}`,
          category: 'sla',
          timestampIso: overdueStartIso,
          timestampMs: overdueStartMs,
          title: 'เคสเกินกำหนด SLA',
          description: `ครบกำหนดวันที่ ${formatThaiDate(activeCase.sla_due_at)} — ระบบเปลี่ยนสถานะเป็นเกิน SLA`,
          badgeTone: 'red',
        });
      }
    }

    // 2. SLA Acknowledgments
    for (const ack of ackHistory) {
      const ms = new Date(ack.ack_at).getTime() || 0;
      const isOverdueAck = ack.ack_level === 'overdue' || ack.ack_level === 'due_reached';
      items.push({
        id: `ack-${ack.id}`,
        category: 'sla',
        timestampIso: ack.ack_at,
        timestampMs: ms,
        title: getAckLevelText(ack.ack_level),
        actorLabel: ack.user_name,
        description: ack.note ? `หมายเหตุ: ${ack.note}` : undefined,
        badgeTone: isOverdueAck ? 'red' : 'amber',
      });
    }

    // 3. Internal Note Edit Logs
    for (const logs of Object.values(editLogsByNote)) {
      for (const log of logs) {
        const ms = new Date(log.edited_at).getTime() || 0;
        const hasAttachmentDiff =
          (log.old_attachments_summary !== undefined || log.new_attachments_summary !== undefined) &&
          log.old_attachments_summary !== log.new_attachments_summary;
        items.push({
          id: `note-edit-${log.id}`,
          category: 'note_edit',
          timestampIso: log.edited_at,
          timestampMs: ms,
          title: 'แก้ไขข้อมูล Internal Note',
          actorLabel: `${log.editor_name} (${getShortRoleLabel(log.editor_role)})`,
          badgeTone: 'amber',
          diffOldContent: log.old_content !== log.new_content ? log.old_content : undefined,
          diffNewContent: log.old_content !== log.new_content ? log.new_content : undefined,
          diffOldSla: log.old_sla_due_at !== log.new_sla_due_at ? log.old_sla_due_at : undefined,
          diffNewSla: log.old_sla_due_at !== log.new_sla_due_at ? log.new_sla_due_at : undefined,
          diffOldAttachments: hasAttachmentDiff ? log.old_attachments_summary : undefined,
          diffNewAttachments: hasAttachmentDiff ? log.new_attachments_summary : undefined,
        });
      }
    }

    // 4. Escalation send & outcome logs
    for (const esc of escalationLogs) {
      const createdMs = new Date(esc.created_at).getTime() || 0;
      items.push({
        id: `esc-send-${esc.id}`,
        category: 'escalation',
        timestampIso: esc.created_at,
        timestampMs: createdMs,
        title: `ส่งต่อเคส (Escalate) → ${esc.to_user_name}`,
        actorLabel: `${esc.from_user_name} (${esc.from_team_name}) → ${esc.to_user_name} (${esc.to_team_name})`,
        description: esc.note ? `หมายเหตุ: ${esc.note}` : undefined,
        badgeTone: 'indigo',
      });

      if (esc.status === 'accepted') {
        const updatedMs = new Date(esc.updated_at).getTime() || createdMs + 1;
        items.push({
          id: `esc-acc-${esc.id}`,
          category: 'escalation',
          timestampIso: esc.updated_at,
          timestampMs: updatedMs,
          title: `ตอบรับเคส (Accepted)`,
          actorLabel: `${esc.to_user_name} (${esc.to_team_name})`,
          description: `รับเคสจาก ${esc.from_user_name} เข้าดูแลต่อเรียบร้อยแล้ว`,
          badgeTone: 'emerald',
        });
      } else if (esc.status === 'rejected') {
        const updatedMs = new Date(esc.updated_at).getTime() || createdMs + 1;
        items.push({
          id: `esc-rej-${esc.id}`,
          category: 'escalation',
          timestampIso: esc.updated_at,
          timestampMs: updatedMs,
          title: `ปฏิเสธรับเคส (Reject) — ส่งกลับต้นทาง`,
          actorLabel: `${esc.to_user_name} (${esc.to_team_name}) → ${esc.from_user_name}`,
          description: esc.reject_reason
            ? `เหตุผลการส่งคืน: ${esc.reject_reason}`
            : 'เคสถูกส่งกลับให้ผู้ส่งเดิมดูแลต่อ',
          badgeTone: 'rose',
        });

        if (esc.sender_ack_done && esc.sender_ack_at) {
          const ackMs = new Date(esc.sender_ack_at).getTime() || updatedMs + 1;
          items.push({
            id: `esc-sender-ack-${esc.id}`,
            category: 'escalation',
            timestampIso: esc.sender_ack_at,
            timestampMs: ackMs,
            title: 'ต้นทางรับทราบการส่งคืน (Reject Acknowledged)',
            actorLabel: `${esc.from_user_name} (${esc.from_team_name})`,
            description: 'ผู้ส่งต้นทางกดรับทราบการ Reject คืนเคสเรียบร้อยแล้ว',
            badgeTone: 'slate',
          });
        }
      }
    }

    items.sort((a, b) =>
      historySortAsc ? a.timestampMs - b.timestampMs : b.timestampMs - a.timestampMs
    );
    return items;
  }, [activeCase, ackHistory, editLogsByNote, escalationLogs, historySortAsc]);

  const filteredHistory = useMemo(() => {
    if (historyFilter === 'all') return unifiedHistory;
    return unifiedHistory.filter((item) => item.category === historyFilter);
  }, [unifiedHistory, historyFilter]);

  if (!open) return null;

  const setQuickSlaDays = (daysAhead: number) => {
    setSlaDueInput(getDefaultSlaDate(daysAhead));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCaseSavedMsg(null);
    setSubmitting(true);

    try {
      if (isNew) {
        const normalizedDate = toLocalDateInput(slaDueInput);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
          setError('กรุณาระบุวันครบกำหนด SLA ให้ถูกต้อง');
          setSubmitting(false);
          return;
        }
        await createCaseDoc(
          currentUser,
          {
            case_no: caseNo,
            case_url: caseUrl,
            issue_summary: issueSummary,
            details,
            status,
            sla_due_at: normalizedDate,
          },
          existingCases
        );
        onClose();
        return;
      }

      if (!activeCase) return;

      const selectedTeam = teams.find((t) => t.id === teamId);
      const selectedAssignee = assignableUsers.find((u) => u.uid === assigneeId);

      if (isAdmin) {
        const normalizedDate = toLocalDateInput(slaDueInput);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
          setError('กรุณาระบุวันครบกำหนด SLA ให้ถูกต้อง');
          setSubmitting(false);
          return;
        }
        await updateCaseDoc(
          currentUser,
          activeCase,
          {
            case_no: caseNo,
            case_url: caseUrl,
            issue_summary: issueSummary,
            details,
            status,
            sla_due_at: normalizedDate,
            ...(selectedTeam ? { team_id: selectedTeam.id, team_name: selectedTeam.name } : {}),
            ...(selectedAssignee
              ? { assignee_id: selectedAssignee.uid, assignee_name: selectedAssignee.display_name }
              : {}),
          },
          existingCases
        );
        onClose();
      } else {
        await updateCaseDoc(
          currentUser,
          activeCase,
          {
            status,
            ...(canReassign && selectedTeam
              ? { team_id: selectedTeam.id, team_name: selectedTeam.name }
              : {}),
            ...(canReassign && selectedAssignee
              ? { assignee_id: selectedAssignee.uid, assignee_name: selectedAssignee.display_name }
              : {}),
          },
          existingCases
        );
        setCaseSavedMsg('อัปเดตสถานะเคสเรียบร้อยแล้ว');
      }
    } catch (err) {
      setError(formatActionErrorMessage(err, 'ไม่สามารถบันทึกข้อมูลเคสได้'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!activeCase || !isAdmin) return;
    setSubmitting(true);
    try {
      await deleteCaseDoc(activeCase.id);
      onClose();
    } catch (err) {
      setError(formatActionErrorMessage(err, 'ไม่สามารถลบเคสได้'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleInitiateEscalate = () => {
    setEscalateError(null);
    setEscalateSuccess(null);
    if (!escalateTargetId) {
      setEscalateError('กรุณาเลือกชื่อผู้รับเรื่องที่ต้องการส่งต่อเคส');
      return;
    }
    setEscalateConfirming(true);
  };

  const handleConfirmEscalate = async () => {
    if (!activeCase) return;
    const targetUser = escalateRecipients.find((u) => u.uid === escalateTargetId);
    if (!targetUser) {
      setEscalateError('ไม่พบข้อมูลผู้รับเรื่องที่เลือก');
      setEscalateConfirming(false);
      return;
    }

    setEscalateError(null);
    setEscalateSubmitting(true);
    try {
      await createCaseEscalationDoc(currentUser, activeCase, targetUser, escalateNote);
      setEscalateConfirming(false);
      setEscalateTargetId('');
      setEscalateNote('');
      setEscalateSuccess(
        `ส่งต่อเคสไปยัง ${targetUser.display_name} (${targetUser.team_name}) แล้ว กำลังรอผู้รับเรื่องกด Accepted`
      );
    } catch (err) {
      setEscalateError(formatActionErrorMessage(err, 'ไม่สามารถส่งต่อเคสได้'));
      setEscalateConfirming(false);
    } finally {
      setEscalateSubmitting(false);
    }
  };

  const handleInModalAccept = async (esc: CaseEscalation) => {
    setEscalateError(null);
    setEscalateSuccess(null);
    setEscalateActionBusy(true);
    try {
      await onAcceptEscalation(esc);
      setEscalateSuccess('ตอบรับเคส (Accepted) เรียบร้อยแล้ว');
    } catch (err) {
      setEscalateError(formatActionErrorMessage(err, 'ไม่สามารถตอบรับเคสได้'));
    } finally {
      setEscalateActionBusy(false);
    }
  };

  const handleInModalConfirmReject = async (esc: CaseEscalation) => {
    setEscalateError(null);
    setEscalateSuccess(null);
    setEscalateActionBusy(true);
    try {
      await onRejectEscalation(esc, inModalRejectReason);
      setInModalRejectOpen(false);
      setInModalRejectReason('');
      setEscalateSuccess(
        `Reject เคสส่งกลับไปยัง ${esc.from_user_name} แล้ว ระบบกำลังแจ้งเตือนต้นทาง`
      );
    } catch (err) {
      setEscalateError(formatActionErrorMessage(err, 'ไม่สามารถ Reject ส่งคืนเคสได้'));
    } finally {
      setEscalateActionBusy(false);
    }
  };

  const handleInModalAckRejected = async (esc: CaseEscalation) => {
    setEscalateError(null);
    setEscalateSuccess(null);
    setEscalateActionBusy(true);
    try {
      await onAcknowledgeRejectedEscalation(esc);
      setEscalateSuccess('บันทึกการรับทราบเคสที่ถูก Reject ส่งคืนเรียบร้อยแล้ว');
    } catch (err) {
      setEscalateError(formatActionErrorMessage(err, 'ไม่สามารถรับทราบการส่งคืนได้'));
    } finally {
      setEscalateActionBusy(false);
    }
  };

  const uploadFilesForTarget = async (files: FileList | File[], target: 'new' | 'edit') => {
    if (!activeCase) return;
    const selected = Array.from(files);
    if (selected.length === 0) return;

    const currentList = target === 'new' ? newAttachments : editAttachments;
    if (currentList.length + selected.length > MAX_NOTE_ATTACHMENTS) {
      const remaining = Math.max(0, MAX_NOTE_ATTACHMENTS - currentList.length);
      setNoteError(
        remaining > 0
          ? `แนบไฟล์ได้สูงสุด ${MAX_NOTE_ATTACHMENTS} ไฟล์ต่อ 1 Internal Note (เลือกเพิ่มได้อีก ${remaining} ไฟล์)`
          : `แนบไฟล์ครบ ${MAX_NOTE_ATTACHMENTS} ไฟล์แล้ว`
      );
      return;
    }

    for (const file of selected) {
      if (file.size === 0) {
        setNoteError(`ไฟล์ "${file.name}" มีขนาด 0 ไบต์ ไม่สามารถอัปโหลดได้`);
        return;
      }
      if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
        setNoteError(`ไฟล์ "${file.name}" มีขนาดใหญ่เกิน 50 MB`);
        return;
      }
    }

    setNoteError(null);
    if (target === 'new') {
      setUploadingNewFiles(true);
      setUploadProgress(0);
    } else {
      setUploadingEditFiles(true);
      setEditUploadProgress(0);
    }

    try {
      const uploaded: NoteAttachment[] = [];
      for (let i = 0; i < selected.length; i += 1) {
        const file = selected[i];
        const att = await uploadNoteAttachment(activeCase.id, file, (pct) => {
          const overall = Math.round(((i + pct / 100) / selected.length) * 100);
          if (target === 'new') {
            setUploadProgress(overall);
          } else {
            setEditUploadProgress(overall);
          }
        });
        uploaded.push(att);
      }

      if (target === 'new') {
        setNewAttachments((prev) => [...prev, ...uploaded]);
      } else {
        setEditAttachments((prev) => [...prev, ...uploaded]);
      }
    } catch (err) {
      setNoteError(formatActionErrorMessage(err, 'ไม่สามารถอัปโหลดไฟล์แนบได้'));
    } finally {
      if (target === 'new') {
        setUploadingNewFiles(false);
        setUploadProgress(0);
      } else {
        setUploadingEditFiles(false);
        setEditUploadProgress(0);
      }
    }
  };

  const handleNotePaste = (
    e: React.ClipboardEvent<HTMLTextAreaElement>,
    target: 'new' | 'edit'
  ) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void uploadFilesForTarget(files, target);
    }
  };

  const handleRemoveNewAttachment = (attachmentId: string) => {
    setNewAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
    if (activeCase) {
      void deleteServerAttachment(activeCase.id, attachmentId);
    }
  };

  const handleRemoveEditAttachment = (attachmentId: string) => {
    setEditAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
  };

  const handleCreateNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCase || uploadingNewFiles) return;
    setNoteError(null);
    setNoteSubmitting(true);
    try {
      await createInternalNoteDoc(currentUser, activeCase, {
        content: newNoteContent,
        adjustSla,
        newSlaDueAt: adjustSla ? noteNewSla : undefined,
        attachments: newAttachments,
      });
      setNewNoteContent('');
      setNewAttachments([]);
      setAdjustSla(false);
    } catch (err) {
      setNoteError(formatActionErrorMessage(err, 'ไม่สามารถบันทึก Internal Note ได้'));
    } finally {
      setNoteSubmitting(false);
    }
  };

  const startEditNote = (note: InternalNote) => {
    setNoteError(null);
    setConfirmDeleteNoteId(null);
    setEditingNoteId(note.id);
    setEditNoteContent(note.content);
    setEditNoteSla(toLocalDateInput(note.new_sla_due_at));
    setEditAttachments(note.attachments ?? []);
  };

  const cancelEditNote = (note: InternalNote) => {
    if (activeCase) {
      const originalIds = new Set((note.attachments ?? []).map((a) => a.id));
      for (const att of editAttachments) {
        if (!originalIds.has(att.id)) {
          void deleteServerAttachment(activeCase.id, att.id);
        }
      }
    }
    setEditingNoteId(null);
    setEditAttachments([]);
  };

  const handleSaveEditNote = async (note: InternalNote) => {
    if (!activeCase || uploadingEditFiles) return;
    setNoteError(null);
    setSavingNoteEdit(true);
    try {
      await updateInternalNoteDoc(currentUser, activeCase, note, {
        content: editNoteContent,
        newSlaDueAt: note.sla_changed ? editNoteSla : undefined,
        attachments: editAttachments,
      });
      setEditingNoteId(null);
      setEditAttachments([]);
    } catch (err) {
      setNoteError(formatActionErrorMessage(err, 'ไม่สามารถแก้ไข Internal Note ได้'));
    } finally {
      setSavingNoteEdit(false);
    }
  };

  const handleDeleteNote = async (note: InternalNote) => {
    if (!activeCase || !isAdmin) return;
    setNoteError(null);
    setSavingNoteEdit(true);
    try {
      await deleteInternalNoteDoc(activeCase.id, note.id, note.attachments ?? []);
      setConfirmDeleteNoteId(null);
    } catch (err) {
      setNoteError(formatActionErrorMessage(err, 'ไม่สามารถลบ Internal Note ได้'));
    } finally {
      setSavingNoteEdit(false);
    }
  };

  const displayTeamName = isNew ? currentUser.team_name : activeCase.team_name;
  const displayAssigneeName = isNew ? currentUser.display_name : activeCase.assignee_name;
  const selectedEscalateTarget = escalateRecipients.find((u) => u.uid === escalateTargetId);
  const activeCaseLink =
    !isNew && activeCase
      ? resolveCaseLinkDisplay(activeCase.case_no, activeCase.case_url)
      : null;
  const closedRetention =
    !isNew && activeCase
      ? computeClosedCaseRetention(
          activeCase.resolved_at || activeCase.updated_at,
          activeCase.status,
          nowMs
        )
      : null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="case-modal-title"
    >
      <div className="w-full max-w-3xl max-h-[92vh] flex flex-col bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 id="case-modal-title" className="text-base font-semibold text-slate-900">
                {isNew ? 'เปิดเคสใหม่ (To-Do Case)' : 'รายละเอียดเคส (To-Do Case)'}
              </h2>
              {activeCaseLink &&
                (activeCaseLink.url ? (
                  <a
                    href={activeCaseLink.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="คลิกเพื่อเปิดลิงก์เคส"
                    className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 hover:bg-blue-100 px-2.5 py-0.5 font-mono text-xs font-semibold text-blue-700 transition-colors"
                  >
                    <span>{activeCaseLink.label}</span>
                    <ExternalLink className="w-3 h-3 shrink-0" />
                  </a>
                ) : (
                  <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-100 px-2.5 py-0.5 font-mono text-xs font-semibold text-slate-700">
                    {activeCaseLink.label}
                  </span>
                ))}
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              {isNew
                ? 'ทีมและผู้รับเรื่องถูกผูกอัตโนมัติตามบัญชีที่เข้าสู่ระบบ'
                : `อัปเดตล่าสุด ${formatThaiDateTime(activeCase.updated_at)}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิดหน้าต่าง"
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs for Existing Case */}
        {!isNew && activeCase && (
          <div className="px-6 border-b border-slate-200 bg-slate-50 flex items-center gap-6 shrink-0">
            <button
              type="button"
              onClick={() => setActiveTab('details')}
              className={`py-3 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === 'details'
                  ? 'border-blue-700 text-blue-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              รายละเอียดเคส &amp; Internal Note
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('history')}
              className={`inline-flex items-center gap-1.5 py-3 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === 'history'
                  ? 'border-blue-700 text-blue-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              <span>History ({unifiedHistory.length})</span>
            </button>
          </div>
        )}

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {(isNew || activeTab === 'details') && (
            <>
              {/* Case Form */}
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {error}
                  </div>
                )}
                {caseSavedMsg && (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs font-medium text-emerald-700">
                    {caseSavedMsg}
                  </div>
                )}

                {/* Account-bound Team & Assignee Info */}
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold text-slate-700">ข้อมูลผู้รับผิดชอบเคส</span>
                    {!canReassign && (
                      <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                        <Lock className="w-3 h-3" />
                        <span>อ้างอิงจากบัญชีที่เข้าสู่ระบบ</span>
                      </span>
                    )}
                  </div>

                  {canReassign ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">ทีม / แผนก</label>
                        <select
                          value={teamId}
                          onChange={(e) => {
                            const nextTeam = e.target.value;
                            setTeamId(nextTeam);
                            const firstMember = assignableUsers.find((u) => u.team_id === nextTeam);
                            if (firstMember) setAssigneeId(firstMember.uid);
                          }}
                          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                        >
                          {teams.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">ผู้รับเรื่อง</label>
                        <select
                          value={assigneeId}
                          onChange={(e) => {
                            const nextUserId = e.target.value;
                            setAssigneeId(nextUserId);
                            const found = assignableUsers.find((u) => u.uid === nextUserId);
                            if (found) setTeamId(found.team_id);
                          }}
                          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                        >
                          {assignableUsers.map((u) => (
                            <option key={u.uid} value={u.uid}>
                              {u.display_name} ({u.team_name})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                      <div>
                        <div className="text-xs text-slate-500">ทีม / แผนก</div>
                        <div className="mt-0.5 font-medium text-slate-900">{displayTeamName}</div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500">ผู้รับเรื่อง</div>
                        <div className="mt-0.5 font-medium text-slate-900">{displayAssigneeName}</div>
                      </div>
                    </div>
                  )}
                </div>

                {closedRetention && activeCase && (
                  <div
                    className={`rounded-lg border px-4 py-3 flex items-start gap-2.5 text-xs ${
                      closedRetention.isExpired
                        ? 'border-red-200 bg-red-50 text-red-800'
                        : 'border-emerald-200 bg-emerald-50 text-emerald-900'
                    }`}
                  >
                    <Clock className="w-4 h-4 shrink-0 mt-0.5" />
                    <div className="space-y-0.5">
                      <div className="font-semibold">
                        เคสปิดสำเร็จแล้ว · {closedRetention.countdownText}
                      </div>
                      <div className="opacity-90">
                        ปิดเคสเมื่อ {formatThaiDateTime(activeCase.resolved_at || activeCase.updated_at)} ·
                        ระบบจะเก็บข้อมูลไว้ 15 วันก่อนลบอัตโนมัติ (หากปรับสถานะกลับมาดำเนินการ จะหยุดนับและเริ่มนับ 15 วันใหม่เมื่อปิดเคสอีกครั้ง)
                      </div>
                    </div>
                  </div>
                )}

                {canEditOriginalDetails ? (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="case-no" className="block text-sm font-medium text-slate-700 mb-1.5">
                          เลขเคส <span className="text-red-600">*</span>
                        </label>
                        <input
                          id="case-no"
                          type="text"
                          required
                          value={caseNo}
                          onChange={(e) => setCaseNo(e.target.value)}
                          placeholder="เช่น CASE-2026-001 หรือหมายเลขทิกเก็ต"
                          className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-mono text-slate-900 focus:border-blue-600 focus:outline-none"
                        />
                      </div>

                      <div>
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                          <label htmlFor="case-url" className="block text-sm font-medium text-slate-700">
                            ลิงก์เคส (URL) {(isNew || Boolean(caseUrl.trim())) && <span className="text-red-600">*</span>}
                          </label>
                          {getSafeCaseUrl(caseUrl) && (
                            <a
                              href={getSafeCaseUrl(caseUrl)!}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900 hover:underline"
                            >
                              <ExternalLink className="w-3 h-3 shrink-0" />
                              <span>เปิดลิงก์เคส</span>
                            </a>
                          )}
                        </div>
                        <input
                          id="case-url"
                          type="text"
                          inputMode="url"
                          required={isNew}
                          value={caseUrl}
                          onChange={(e) => setCaseUrl(e.target.value)}
                          placeholder="https://... (วางลิงก์ URL ของเคส)"
                          className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                        />
                      </div>
                    </div>

                    <div>
                      <label htmlFor="issue-summary" className="block text-sm font-medium text-slate-700 mb-1.5">
                        รายละเอียดปัญหา (หัวข้อเคส) <span className="text-red-600">*</span>
                      </label>
                      <input
                        id="issue-summary"
                        type="text"
                        required
                        value={issueSummary}
                        onChange={(e) => setIssueSummary(e.target.value)}
                        placeholder="สรุปปัญหาที่พบ เช่น ร้านค้าไม่สามารถอัปเดตเมนูได้ / ระบบชำระเงินค้าง"
                        className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="sla-due" className="block text-sm font-medium text-slate-700 mb-1.5">
                          SLA (วันครบกำหนด) <span className="text-red-600">*</span>
                        </label>
                        <input
                          id="sla-due"
                          type="date"
                          required
                          value={slaDueInput}
                          onChange={(e) => setSlaDueInput(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-mono tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none"
                        />
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            onClick={() => setQuickSlaDays(0)}
                            className="rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 px-2 py-1 text-xs text-slate-600 whitespace-nowrap cursor-pointer"
                          >
                            วันนี้
                          </button>
                          <button
                            type="button"
                            onClick={() => setQuickSlaDays(1)}
                            className="rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 px-2 py-1 text-xs text-slate-600 whitespace-nowrap cursor-pointer"
                          >
                            พรุ่งนี้
                          </button>
                          <button
                            type="button"
                            onClick={() => setQuickSlaDays(2)}
                            className="rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 px-2 py-1 text-xs text-slate-600 whitespace-nowrap cursor-pointer"
                          >
                            +2 วัน
                          </button>
                          <button
                            type="button"
                            onClick={() => setQuickSlaDays(3)}
                            className="rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 px-2 py-1 text-xs text-slate-600 whitespace-nowrap cursor-pointer"
                          >
                            +3 วัน
                          </button>
                        </div>
                      </div>

                      <div>
                        <label htmlFor="case-status" className="block text-sm font-medium text-slate-700 mb-1.5">
                          สถานะงาน
                        </label>
                        <select
                          id="case-status"
                          value={status}
                          onChange={(e) => setStatus(e.target.value as CaseStatus)}
                          className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                        >
                          <option value="todo">รอดำเนินการ (To Do)</option>
                          <option value="in_progress">กำลังดำเนินการ (In Progress)</option>
                          <option value="done">ปิดเคสแล้ว (Done)</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label htmlFor="case-details" className="block text-sm font-medium text-slate-700 mb-1.5">
                        รายละเอียดเพิ่มเติม / บันทึกเริ่มต้น
                      </label>
                      <textarea
                        id="case-details"
                        rows={3}
                        value={details}
                        onChange={(e) => setDetails(e.target.value)}
                        placeholder="บันทึกรายละเอียดเพิ่มเติม ขั้นตอนการตรวจสอบ หรือผลการประสานงาน..."
                        className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                      />
                    </div>
                  </>
                ) : (
                  /* Read-only original details for Agent & TL */
                  <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-100">
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                        <Lock className="w-3.5 h-3.5 text-slate-400" />
                        <span>รายละเอียดเคสที่บันทึกไว้ก่อนหน้า</span>
                      </span>
                      <span className="text-xs text-slate-400">
                        อัปเดตข้อมูลหรือปรับ SLA ได้ที่ Internal Note ด้านล่าง
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                      <div>
                        <div className="text-xs text-slate-500">เลขเคส</div>
                        {activeCaseLink?.url ? (
                          <a
                            href={activeCaseLink.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-0.5 inline-flex items-center gap-1.5 font-mono text-sm font-semibold text-blue-700 hover:text-blue-900 hover:underline"
                          >
                            <span>{activeCaseLink.label}</span>
                            <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                          </a>
                        ) : (
                          <div className="mt-0.5 font-mono font-semibold text-slate-900">
                            {activeCaseLink?.label ?? activeCase.case_no}
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="text-xs text-slate-500">SLA (วันครบกำหนดปัจจุบัน)</div>
                        <div className="mt-0.5 font-mono font-semibold text-blue-700">
                          {formatThaiDate(activeCase.sla_due_at)}
                        </div>
                      </div>
                    </div>

                    <div>
                      <div className="text-xs text-slate-500">หัวข้อปัญหา</div>
                      <div className="mt-0.5 text-sm font-medium text-slate-900">{activeCase.issue_summary}</div>
                    </div>

                    {activeCase.details && (
                      <div>
                        <div className="text-xs text-slate-500">รายละเอียดเพิ่มเติม</div>
                        <div className="mt-1 rounded-md bg-slate-50 border border-slate-100 px-3 py-2 text-xs text-slate-700 whitespace-pre-wrap leading-relaxed">
                          {activeCase.details}
                        </div>
                      </div>
                    )}

                    <div className="pt-2 border-t border-slate-100 flex flex-col sm:flex-row sm:items-end justify-between gap-3">
                      <div className="sm:w-64">
                        <label htmlFor="case-status" className="block text-xs font-medium text-slate-600 mb-1">
                          สถานะงาน
                        </label>
                        <select
                          id="case-status"
                          value={status}
                          onChange={(e) => setStatus(e.target.value as CaseStatus)}
                          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                        >
                          <option value="todo">รอดำเนินการ (To Do)</option>
                          <option value="in_progress">กำลังดำเนินการ (In Progress)</option>
                          <option value="done">ปิดเคสแล้ว (Done)</option>
                        </select>
                      </div>
                      <button
                        type="submit"
                        disabled={submitting}
                        className="rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-60 px-4 py-2 text-xs font-medium text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {submitting
                          ? 'กำลังบันทึก...'
                          : canReassign
                            ? 'บันทึกสถานะ / ผู้รับเรื่อง'
                            : 'บันทึกสถานะงาน'}
                      </button>
                    </div>
                  </div>
                )}

                {(isNew || isAdmin) && (
                  <div className="border-t border-slate-200 pt-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      {canDeleteCase && !confirmDelete && (
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(true)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white hover:bg-red-50 px-3 py-2 text-xs font-medium text-red-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>ลบเคสนี้</span>
                        </button>
                      )}
                      {canDeleteCase && confirmDelete && (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={submitting}
                            onClick={handleDelete}
                            className="rounded-lg bg-red-600 hover:bg-red-700 px-3 py-2 text-xs font-medium text-white whitespace-nowrap cursor-pointer"
                          >
                            ยืนยันการลบ
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(false)}
                            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 whitespace-nowrap cursor-pointer"
                          >
                            ยกเลิก
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-3 ml-auto">
                      <button
                        type="button"
                        onClick={onClose}
                        className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-4 py-2 text-sm font-medium text-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        ยกเลิก
                      </button>
                      <button
                        type="submit"
                        disabled={submitting}
                        className="rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 px-5 py-2 text-sm font-medium text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {submitting ? 'กำลังบันทึก...' : isNew ? 'บันทึกเปิดเคส' : 'บันทึกการแก้ไขเคส'}
                      </button>
                    </div>
                  </div>
                )}
              </form>

              {/* Escalate Case Panel (outside main form to avoid nested forms) */}
              {!isNew && activeCase && (
                <section className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <ArrowRightLeft className="w-4 h-4 text-indigo-700 shrink-0" />
                      <h3 className="text-sm font-semibold text-slate-900">
                        ส่งต่อเคสให้ผู้อื่นดูแล (Escalate)
                      </h3>
                    </div>
                    {activeCase.pending_escalation_id && (
                      <span className="text-xs font-medium text-amber-700">
                        รอการตอบรับจากผู้รับเรื่อง
                      </span>
                    )}
                  </div>

                  {escalateError && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                      {escalateError}
                    </div>
                  )}
                  {escalateSuccess && (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                      {escalateSuccess}
                    </div>
                  )}

                  {rejectedForCase && (
                    <div className="rounded-lg border border-rose-300 bg-rose-50 px-3.5 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="space-y-1 text-xs text-rose-900">
                        <div className="font-semibold flex items-center gap-1.5">
                          <RotateCcw className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                          <span>
                            เคสนี้ถูก Reject กลับคืนมาโดย {rejectedForCase.to_user_name} (
                            {rejectedForCase.to_team_name})
                          </span>
                        </div>
                        {rejectedForCase.reject_reason ? (
                          <div className="text-rose-800">
                            เหตุผลการส่งคืน: {rejectedForCase.reject_reason}
                          </div>
                        ) : (
                          <div className="text-rose-700">
                            ผู้รับเรื่องส่งเคสกลับคืนให้คุณดูแลต่อ กรุณากดรับทราบการส่งคืน
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={escalateActionBusy}
                        onClick={() => handleInModalAckRejected(rejectedForCase)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-rose-700 hover:bg-rose-800 disabled:opacity-50 px-3 py-1.5 text-xs font-medium text-white whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>{escalateActionBusy ? 'กำลังบันทึก...' : 'รับทราบการส่งคืน'}</span>
                      </button>
                    </div>
                  )}

                  {activeCase.pending_escalation_id ? (
                    incomingPendingForCase ? (
                      <div className="rounded-lg border border-indigo-300 bg-white p-3.5 space-y-3">
                        <div className="space-y-1 text-xs text-slate-800">
                          <div className="font-semibold text-indigo-900">
                            เคสนี้ถูกส่งต่อ (Escalate) มาให้คุณดูแล
                          </div>
                          <div>
                            ส่งมาจาก{' '}
                            <strong>
                              {incomingPendingForCase.from_user_name} (
                              {incomingPendingForCase.from_team_name})
                            </strong>{' '}
                            เมื่อ {formatThaiDateTime(incomingPendingForCase.created_at)}
                          </div>
                          {incomingPendingForCase.note && (
                            <div className="rounded bg-indigo-50/70 border border-indigo-100 px-2.5 py-1.5 text-indigo-900">
                              หมายเหตุจากผู้ส่ง: {incomingPendingForCase.note}
                            </div>
                          )}
                        </div>

                        {inModalRejectOpen ? (
                          <div className="rounded-lg border border-rose-200 bg-rose-50/60 p-3 space-y-2.5">
                            <label
                              htmlFor="inmodal-reject-reason"
                              className="block text-xs font-medium text-rose-900"
                            >
                              ระบุเหตุผลการ Reject ส่งกลับต้นทาง (ไม่บังคับ)
                            </label>
                            <input
                              id="inmodal-reject-reason"
                              type="text"
                              value={inModalRejectReason}
                              disabled={escalateActionBusy}
                              onChange={(e) => setInModalRejectReason(e.target.value)}
                              placeholder="เช่น ข้อมูลยังไม่ครบถ้วน หรือไม่ใช่ขอบเขตทีมที่รับผิดชอบ..."
                              className="w-full rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-rose-600 focus:outline-none"
                            />
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                disabled={escalateActionBusy}
                                onClick={() => {
                                  setInModalRejectOpen(false);
                                  setInModalRejectReason('');
                                }}
                                className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer"
                              >
                                ยกเลิก
                              </button>
                              <button
                                type="button"
                                disabled={escalateActionBusy}
                                onClick={() => handleInModalConfirmReject(incomingPendingForCase)}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-50 px-3 py-1.5 text-xs font-medium text-white cursor-pointer"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span>
                                  {escalateActionBusy
                                    ? 'กำลังส่งคืน...'
                                    : 'ยืนยัน Reject ส่งกลับต้นทาง'}
                                </span>
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            <button
                              type="button"
                              disabled={escalateActionBusy}
                              onClick={() => setInModalRejectOpen(true)}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white hover:bg-rose-50 disabled:opacity-50 px-3 py-1.5 text-xs font-medium text-rose-700 cursor-pointer"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>Reject (ส่งกลับต้นทาง)</span>
                            </button>
                            <button
                              type="button"
                              disabled={escalateActionBusy}
                              onClick={() => handleInModalAccept(incomingPendingForCase)}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 px-3.5 py-1.5 text-xs font-medium text-white cursor-pointer"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>{escalateActionBusy ? 'กำลังตอบรับ...' : 'Accepted'}</span>
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
                        {pendingEscalationLog ? (
                          <span>
                            เคสนี้กำลังส่งต่อไปยัง{' '}
                            <strong>
                              {pendingEscalationLog.to_user_name} ({pendingEscalationLog.to_team_name})
                            </strong>{' '}
                            โดย {pendingEscalationLog.from_user_name} เมื่อ{' '}
                            {formatThaiDateTime(pendingEscalationLog.created_at)} — รอผู้รับเรื่องกด
                            Accepted หรือ Reject
                          </span>
                        ) : (
                          <span>
                            เคสนี้มีคำขอส่งต่อ (Escalate) ที่กำลังรอการตอบรับอยู่
                            ไม่สามารถส่งต่อซ้อนได้จนกว่าผู้รับเรื่องจะตอบรับหรือ Reject
                          </span>
                        )}
                      </div>
                    )
                  ) : escalateRecipients.length === 0 ? (
                    <p className="text-xs text-slate-500">
                      ยังไม่มีผู้ใช้งานรายอื่นที่เปิดใช้งานอยู่ในระบบสำหรับส่งต่อเคส
                    </p>
                  ) : (
                    <div className="space-y-3">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label
                            htmlFor="escalate-target"
                            className="block text-xs font-medium text-slate-700 mb-1"
                          >
                            เลือกชื่อผู้รับเรื่อง <span className="text-red-600">*</span>
                          </label>
                          <select
                            id="escalate-target"
                            value={escalateTargetId}
                            disabled={escalateConfirming || escalateSubmitting}
                            onChange={(e) => {
                              setEscalateTargetId(e.target.value);
                              setEscalateError(null);
                              setEscalateSuccess(null);
                            }}
                            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-600 focus:outline-none disabled:bg-slate-100"
                          >
                            <option value="">-- เลือกผู้รับเรื่องที่ต้องการส่งต่อ --</option>
                            {escalateRecipients.map((u) => (
                              <option key={u.uid} value={u.uid}>
                                {u.display_name} ({u.position_name} · {u.team_name})
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label
                            htmlFor="escalate-note"
                            className="block text-xs font-medium text-slate-700 mb-1"
                          >
                            หมายเหตุการส่งต่อ (ไม่บังคับ)
                          </label>
                          <input
                            id="escalate-note"
                            type="text"
                            value={escalateNote}
                            disabled={escalateConfirming || escalateSubmitting}
                            onChange={(e) => setEscalateNote(e.target.value)}
                            placeholder="ระบุสิ่งที่ต้องการให้ผู้รับเรื่องดำเนินการต่อ..."
                            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-600 focus:outline-none disabled:bg-slate-100"
                          />
                        </div>
                      </div>

                      {!escalateConfirming ? (
                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={handleInitiateEscalate}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-700 hover:bg-indigo-800 px-4 py-2 text-xs font-medium text-white transition-colors whitespace-nowrap cursor-pointer"
                          >
                            <Send className="w-3.5 h-3.5" />
                            <span>Escalate</span>
                          </button>
                        </div>
                      ) : (
                        <div className="rounded-lg border border-indigo-300 bg-white p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                          <div className="text-xs text-slate-800">
                            ยืนยันส่งต่อเคส <strong>{activeCase.issue_summary}</strong> ไปยัง{' '}
                            <strong className="text-indigo-800">
                              {selectedEscalateTarget?.display_name} ({selectedEscalateTarget?.team_name})
                            </strong>
                            ? ระบบจะแจ้งเตือน POPUP ไปยังผู้รับเรื่องทันที
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              disabled={escalateSubmitting}
                              onClick={() => setEscalateConfirming(false)}
                              className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer"
                            >
                              ยกเลิก
                            </button>
                            <button
                              type="button"
                              disabled={escalateSubmitting}
                              onClick={handleConfirmEscalate}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-700 hover:bg-indigo-800 disabled:opacity-60 px-3.5 py-1.5 text-xs font-medium text-white cursor-pointer"
                            >
                              <Send className="w-3.5 h-3.5" />
                              <span>{escalateSubmitting ? 'กำลังส่งเคส...' : 'ยืนยันส่งเคส'}</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}

              {/* Internal Note & SLA Adjustment Section */}
              {!isNew && activeCase && (
                <section className="border-t border-slate-200 pt-5 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <MessageSquarePlus className="w-4 h-4 text-blue-700" />
                      <h3 className="text-sm font-semibold text-slate-900">
                        Internal Note (บันทึกอัปเดตเคส &amp; ปรับ SLA)
                      </h3>
                    </div>
                    <span className="text-xs text-slate-500 tabular-nums">
                      {notes.length} รายการ
                    </span>
                  </div>

                  {noteError && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700">
                      {noteError}
                    </div>
                  )}

                  {/* Add Internal Note Form */}
                  <form
                    onSubmit={handleCreateNote}
                    className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3"
                  >
                    <div>
                      <label htmlFor="new-internal-note" className="block text-xs font-medium text-slate-700 mb-1.5">
                        บันทึกข้อมูลอัปเดตเคสเพิ่มเติม
                      </label>
                      <textarea
                        id="new-internal-note"
                        rows={3}
                        value={newNoteContent}
                        onChange={(e) => setNewNoteContent(e.target.value)}
                        onPaste={(e) => handleNotePaste(e, 'new')}
                        placeholder="ระบุรายละเอียดการอัปเดตเคส ความคืบหน้า หรือวางภาพหน้าจอ (Ctrl+V)..."
                        className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                      />
                    </div>

                    {/* Attachment Upload Controls for New Note */}
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <input
                          ref={newFileInputRef}
                          type="file"
                          multiple
                          accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip,.rar,.ppt,.pptx"
                          className="hidden"
                          onChange={(e) => {
                            if (e.target.files) {
                              void uploadFilesForTarget(e.target.files, 'new');
                            }
                            e.target.value = '';
                          }}
                        />
                        <button
                          type="button"
                          disabled={uploadingNewFiles || newAttachments.length >= MAX_NOTE_ATTACHMENTS}
                          onClick={() => newFileInputRef.current?.click()}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors cursor-pointer"
                        >
                          <Paperclip className="w-3.5 h-3.5 text-blue-700" />
                          <span>แนบภาพ / วิดีโอ / ไฟล์</span>
                        </button>
                        <span className="text-[11px] text-slate-500">
                          สูงสุด {MAX_NOTE_ATTACHMENTS} ไฟล์ · ไม่เกิน 50 MB/ไฟล์ · วางภาพ Ctrl+V ได้
                        </span>
                      </div>

                      {uploadingNewFiles && (
                        <div className="rounded-lg border border-blue-200 bg-white px-3 py-2 space-y-1">
                          <div className="flex items-center justify-between text-xs text-blue-800">
                            <span>กำลังอัปโหลดไฟล์แนบ...</span>
                            <span className="font-mono tabular-nums">{uploadProgress}%</span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-blue-100 overflow-hidden">
                            <div
                              className="h-full bg-blue-600 transition-all duration-150"
                              style={{ width: `${uploadProgress}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {newAttachments.length > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {newAttachments.map((att) => (
                            <div
                              key={att.id}
                              className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white p-2"
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                {att.kind === 'image' ? (
                                  <img
                                    src={att.url}
                                    alt={att.name}
                                    className="w-10 h-10 rounded object-cover border border-slate-200 shrink-0"
                                  />
                                ) : att.kind === 'video' ? (
                                  <div className="w-10 h-10 rounded bg-indigo-50 border border-indigo-200 flex items-center justify-center shrink-0">
                                    <Video className="w-4 h-4 text-indigo-700" />
                                  </div>
                                ) : (
                                  <div className="w-10 h-10 rounded bg-slate-100 border border-slate-200 flex items-center justify-center shrink-0">
                                    <FileText className="w-4 h-4 text-slate-600" />
                                  </div>
                                )}
                                <div className="min-w-0">
                                  <div className="text-xs font-medium text-slate-800 truncate">
                                    {att.name}
                                  </div>
                                  <div className="text-[11px] text-slate-500 font-mono">
                                    {formatFileSize(att.size_bytes)}
                                  </div>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleRemoveNewAttachment(att.id)}
                                title="ลบไฟล์แนบนี้"
                                className="rounded p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer shrink-0"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="space-y-2.5">
                      <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={adjustSla}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setAdjustSla(checked);
                            if (checked) {
                              setNoteNewSla(toLocalDateInput(activeCase.sla_due_at) || getDefaultSlaDate(0));
                            }
                          }}
                          className="rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                        />
                        <span>ปรับวันครบกำหนด SLA ด้วย (โดยไม่แก้ไขรายละเอียดเคสเดิม)</span>
                      </label>

                      {adjustSla && (
                        <div className="rounded-lg border border-blue-200 bg-white p-3 space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <span className="text-slate-600">
                              วันครบกำหนดเดิม:{' '}
                              <strong className="font-mono text-slate-900">
                                {formatThaiDate(activeCase.sla_due_at)}
                              </strong>
                            </span>
                            <span className="text-blue-700 font-medium">เลือกวันครบกำหนด SLA ใหม่</span>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type="date"
                              required={adjustSla}
                              value={noteNewSla}
                              onChange={(e) => setNoteNewSla(e.target.value)}
                              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-mono tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => setNoteNewSla(getDefaultSlaDate(0))}
                              className="rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 px-2.5 py-1.5 text-xs text-slate-600 cursor-pointer"
                            >
                              วันนี้
                            </button>
                            <button
                              type="button"
                              onClick={() => setNoteNewSla(getDefaultSlaDate(1))}
                              className="rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 px-2.5 py-1.5 text-xs text-slate-600 cursor-pointer"
                            >
                              พรุ่งนี้
                            </button>
                            <button
                              type="button"
                              onClick={() => setNoteNewSla(getDefaultSlaDate(2))}
                              className="rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 px-2.5 py-1.5 text-xs text-slate-600 cursor-pointer"
                            >
                              +2 วัน
                            </button>
                            <button
                              type="button"
                              onClick={() => setNoteNewSla(getDefaultSlaDate(3))}
                              className="rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 px-2.5 py-1.5 text-xs text-slate-600 cursor-pointer"
                            >
                              +3 วัน
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-end">
                      <button
                        type="submit"
                        disabled={
                          noteSubmitting ||
                          uploadingNewFiles ||
                          (!newNoteContent.trim() && newAttachments.length === 0)
                        }
                        className="rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 px-4 py-2 text-xs font-medium text-white transition-colors whitespace-nowrap cursor-pointer"
                      >
                        {noteSubmitting ? 'กำลังบันทึก...' : 'บันทึก Internal Note'}
                      </button>
                    </div>
                  </form>

                  {/* Internal Notes List */}
                  {loadingNotes && notes.length === 0 ? (
                    <div className="space-y-2">
                      <div className="h-16 rounded-lg bg-slate-100 animate-pulse" />
                      <div className="h-16 rounded-lg bg-slate-100 animate-pulse" />
                    </div>
                  ) : notes.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-200 py-6 text-center text-xs text-slate-500">
                      ยังไม่มี Internal Note สำหรับเคสนี้
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {notes.map((note) => {
                        const canEditNote = isAdmin || isTL || note.author_id === currentUser.uid;
                        const isEditingThis = editingNoteId === note.id;
                        const noteAttachments = note.attachments ?? [];
                        const imageAttachments = noteAttachments.filter((a) => a.kind === 'image');
                        const videoAttachments = noteAttachments.filter((a) => a.kind === 'video');
                        const fileAttachments = noteAttachments.filter((a) => a.kind === 'file');

                        return (
                          <div
                            key={note.id}
                            className="rounded-lg border border-slate-200 bg-white p-4 space-y-2.5"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="text-xs text-slate-600 flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="font-semibold text-slate-900">{note.author_name}</span>
                                <span className="text-slate-400">({getShortRoleLabel(note.author_role)})</span>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono text-slate-500 tabular-nums">
                                  {formatThaiDateTime(note.created_at)}
                                </span>
                                {note.is_edited && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setHistoryFilter('note_edit');
                                        setActiveTab('history');
                                      }}
                                      className="text-amber-700 hover:text-amber-900 underline font-medium cursor-pointer"
                                    >
                                      แก้ไขแล้วโดย {note.last_edited_by_name} ({formatThaiDateTime(note.updated_at)})
                                    </button>
                                  </>
                                )}
                              </div>

                              {!isEditingThis && (
                                <div className="flex items-center gap-2 shrink-0">
                                  {canEditNote && (
                                    <button
                                      type="button"
                                      onClick={() => startEditNote(note)}
                                      className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white hover:bg-slate-50 px-2 py-1 text-xs text-slate-600 cursor-pointer"
                                    >
                                      <Edit3 className="w-3 h-3" />
                                      <span>แก้ไข</span>
                                    </button>
                                  )}
                                  {isAdmin && confirmDeleteNoteId !== note.id && (
                                    <button
                                      type="button"
                                      onClick={() => setConfirmDeleteNoteId(note.id)}
                                      className="inline-flex items-center gap-1 rounded border border-red-200 bg-white hover:bg-red-50 px-2 py-1 text-xs text-red-700 cursor-pointer"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                      <span>ลบ</span>
                                    </button>
                                  )}
                                  {isAdmin && confirmDeleteNoteId === note.id && (
                                    <div className="flex items-center gap-1.5">
                                      <button
                                        type="button"
                                        disabled={savingNoteEdit}
                                        onClick={() => handleDeleteNote(note)}
                                        className="rounded bg-red-600 hover:bg-red-700 px-2 py-1 text-xs font-medium text-white cursor-pointer"
                                      >
                                        ยืนยันลบ
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setConfirmDeleteNoteId(null)}
                                        className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 cursor-pointer"
                                      >
                                        ยกเลิก
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>

                            {note.sla_changed && !isEditingThis && (
                              <div className="inline-flex items-center gap-1.5 rounded-md bg-blue-50 border border-blue-200 px-2.5 py-1 text-xs text-blue-800">
                                <Calendar className="w-3.5 h-3.5 shrink-0" />
                                <span>
                                  ปรับ SLA:{' '}
                                  <strong className="font-mono">{formatThaiDate(note.previous_sla_due_at)}</strong>{' '}
                                  → <strong className="font-mono">{formatThaiDate(note.new_sla_due_at)}</strong>
                                </span>
                              </div>
                            )}

                            {isEditingThis ? (
                              <div className="space-y-3 pt-1">
                                <textarea
                                  rows={3}
                                  value={editNoteContent}
                                  onChange={(e) => setEditNoteContent(e.target.value)}
                                  onPaste={(e) => handleNotePaste(e, 'edit')}
                                  placeholder="ระบุข้อความอัปเดตหรือวางภาพ (Ctrl+V)..."
                                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                                />

                                {/* Edit Note Attachments */}
                                <div className="space-y-2">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <input
                                      ref={editFileInputRef}
                                      type="file"
                                      multiple
                                      accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip,.rar,.ppt,.pptx"
                                      className="hidden"
                                      onChange={(e) => {
                                        if (e.target.files) {
                                          void uploadFilesForTarget(e.target.files, 'edit');
                                        }
                                        e.target.value = '';
                                      }}
                                    />
                                    <button
                                      type="button"
                                      disabled={
                                        uploadingEditFiles ||
                                        editAttachments.length >= MAX_NOTE_ATTACHMENTS
                                      }
                                      onClick={() => editFileInputRef.current?.click()}
                                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 px-2.5 py-1 text-xs font-medium text-slate-700 cursor-pointer"
                                    >
                                      <Paperclip className="w-3.5 h-3.5 text-blue-700" />
                                      <span>เพิ่มภาพ / วิดีโอ / ไฟล์</span>
                                    </button>
                                    <span className="text-[11px] text-slate-500">
                                      {editAttachments.length}/{MAX_NOTE_ATTACHMENTS} ไฟล์
                                    </span>
                                  </div>

                                  {uploadingEditFiles && (
                                    <div className="rounded-lg border border-blue-200 bg-blue-50/40 px-3 py-1.5 space-y-1">
                                      <div className="flex items-center justify-between text-xs text-blue-800">
                                        <span>กำลังอัปโหลดไฟล์แนบ...</span>
                                        <span className="font-mono tabular-nums">
                                          {editUploadProgress}%
                                        </span>
                                      </div>
                                      <div className="h-1.5 w-full rounded-full bg-blue-100 overflow-hidden">
                                        <div
                                          className="h-full bg-blue-600 transition-all duration-150"
                                          style={{ width: `${editUploadProgress}%` }}
                                        />
                                      </div>
                                    </div>
                                  )}

                                  {editAttachments.length > 0 && (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                      {editAttachments.map((att) => (
                                        <div
                                          key={att.id}
                                          className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2"
                                        >
                                          <div className="flex items-center gap-2 min-w-0">
                                            {att.kind === 'image' ? (
                                              <img
                                                src={att.url}
                                                alt={att.name}
                                                className="w-9 h-9 rounded object-cover border border-slate-200 shrink-0"
                                              />
                                            ) : att.kind === 'video' ? (
                                              <div className="w-9 h-9 rounded bg-indigo-50 border border-indigo-200 flex items-center justify-center shrink-0">
                                                <Video className="w-4 h-4 text-indigo-700" />
                                              </div>
                                            ) : (
                                              <div className="w-9 h-9 rounded bg-white border border-slate-200 flex items-center justify-center shrink-0">
                                                <FileText className="w-4 h-4 text-slate-600" />
                                              </div>
                                            )}
                                            <div className="min-w-0">
                                              <div className="text-xs font-medium text-slate-800 truncate">
                                                {att.name}
                                              </div>
                                              <div className="text-[11px] text-slate-500 font-mono">
                                                {formatFileSize(att.size_bytes)}
                                              </div>
                                            </div>
                                          </div>
                                          <button
                                            type="button"
                                            onClick={() => handleRemoveEditAttachment(att.id)}
                                            title="นำไฟล์แนบนี้ออก"
                                            className="rounded p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer shrink-0"
                                          >
                                            <X className="w-4 h-4" />
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>

                                {note.sla_changed && (
                                  <div className="flex flex-wrap items-center gap-2 text-xs">
                                    <span className="text-slate-600">แก้ไขวันครบกำหนด SLA:</span>
                                    <input
                                      type="date"
                                      value={editNoteSla}
                                      onChange={(e) => setEditNoteSla(e.target.value)}
                                      className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-mono text-slate-900 focus:border-blue-600 focus:outline-none"
                                    />
                                  </div>
                                )}
                                <div className="flex items-center justify-end gap-2">
                                  <button
                                    type="button"
                                    onClick={() => cancelEditNote(note)}
                                    className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer"
                                  >
                                    ยกเลิก
                                  </button>
                                  <button
                                    type="button"
                                    disabled={
                                      savingNoteEdit ||
                                      uploadingEditFiles ||
                                      (!editNoteContent.trim() && editAttachments.length === 0)
                                    }
                                    onClick={() => handleSaveEditNote(note)}
                                    className="rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 px-3.5 py-1.5 text-xs font-medium text-white cursor-pointer"
                                  >
                                    {savingNoteEdit ? 'กำลังบันทึก...' : 'บันทึกการแก้ไข'}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                {note.content && (
                                  <div className="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">
                                    {note.content}
                                  </div>
                                )}

                                {noteAttachments.length > 0 && (
                                  <div className="space-y-2.5 pt-1">
                                    {/* Images Grid */}
                                    {imageAttachments.length > 0 && (
                                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                        {imageAttachments.map((att) => (
                                          <div
                                            key={att.id}
                                            className="group relative rounded-lg border border-slate-200 bg-slate-50 overflow-hidden"
                                          >
                                            <button
                                              type="button"
                                              onClick={() => setPreviewImage(att)}
                                              className="block w-full text-left cursor-pointer focus:outline-none"
                                              title={`คลิกเพื่อดูภาพขนาดเต็ม: ${att.name}`}
                                            >
                                              <img
                                                src={att.url}
                                                alt={att.name}
                                                loading="lazy"
                                                className="w-full h-36 object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                                              />
                                              <span className="absolute top-2 right-2 rounded-md bg-slate-900/65 p-1 text-white opacity-0 group-hover:opacity-100 transition-opacity">
                                                <ZoomIn className="w-3.5 h-3.5" />
                                              </span>
                                            </button>
                                            <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-white border-t border-slate-200 text-[11px]">
                                              <span className="inline-flex items-center gap-1 text-slate-700 truncate">
                                                <ImageIcon className="w-3 h-3 text-blue-600 shrink-0" />
                                                <span className="truncate">{att.name}</span>
                                              </span>
                                              <a
                                                href={getAttachmentDownloadUrl(att)}
                                                download={att.name}
                                                className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-900 font-medium shrink-0"
                                                title="ดาวน์โหลดภาพ"
                                              >
                                                <Download className="w-3 h-3" />
                                              </a>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {/* Videos List */}
                                    {videoAttachments.length > 0 && (
                                      <div className="space-y-2">
                                        {videoAttachments.map((att) => (
                                          <div
                                            key={att.id}
                                            className="rounded-lg border border-slate-200 bg-slate-50 overflow-hidden"
                                          >
                                            <video
                                              src={att.url}
                                              controls
                                              preload="metadata"
                                              playsInline
                                              className="w-full max-h-72 bg-slate-950"
                                            />
                                            <div className="flex items-center justify-between gap-2 px-3 py-2 bg-white border-t border-slate-200 text-xs">
                                              <div className="flex items-center gap-2 min-w-0">
                                                <Video className="w-3.5 h-3.5 text-indigo-700 shrink-0" />
                                                <span className="font-medium text-slate-800 truncate">
                                                  {att.name}
                                                </span>
                                                <span className="text-[11px] font-mono text-slate-500 shrink-0">
                                                  ({formatFileSize(att.size_bytes)})
                                                </span>
                                              </div>
                                              <a
                                                href={getAttachmentDownloadUrl(att)}
                                                download={att.name}
                                                className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-900 font-medium shrink-0"
                                              >
                                                <Download className="w-3.5 h-3.5" />
                                                <span>ดาวน์โหลด</span>
                                              </a>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {/* Generic Files List */}
                                    {fileAttachments.length > 0 && (
                                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                        {fileAttachments.map((att) => (
                                          <a
                                            key={att.id}
                                            href={getAttachmentDownloadUrl(att)}
                                            download={att.name}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 hover:bg-blue-50/50 hover:border-blue-300 px-3 py-2 transition-colors"
                                          >
                                            <div className="flex items-center gap-2.5 min-w-0">
                                              <div className="w-8 h-8 rounded bg-white border border-slate-200 flex items-center justify-center shrink-0">
                                                <FileText className="w-4 h-4 text-slate-600" />
                                              </div>
                                              <div className="min-w-0">
                                                <div className="text-xs font-medium text-slate-800 truncate">
                                                  {att.name}
                                                </div>
                                                <div className="text-[11px] text-slate-500 font-mono">
                                                  {formatFileSize(att.size_bytes)}
                                                </div>
                                              </div>
                                            </div>
                                            <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 shrink-0">
                                              <Download className="w-3.5 h-3.5" />
                                              <span>ดาวน์โหลด</span>
                                            </span>
                                          </a>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}
            </>
          )}

          {/* Unified Chronological History Tab */}
          {!isNew && activeCase && activeTab === 'history' && (
            <section className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    ประวัติเหตุการณ์ทั้งหมดของเคส (History)
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    รวมประวัติการกดรับทราบ SLA, เวลาเกิน SLA, การแก้ไข Internal Note และการส่งต่อ Escalate ไล่ลำดับตามวันและเวลา
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setHistorySortAsc((prev) => !prev)}
                  className="self-start sm:self-auto rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 whitespace-nowrap cursor-pointer"
                >
                  เรียงตามเวลา: {historySortAsc ? 'เก่า → ใหม่' : 'ใหม่ → เก่า'}
                </button>
              </div>

              {/* Filter Tabs */}
              <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
                {(
                  [
                    { id: 'all', label: `ทั้งหมด (${unifiedHistory.length})` },
                    {
                      id: 'escalation',
                      label: `Escalate (${unifiedHistory.filter((i) => i.category === 'escalation').length})`,
                    },
                    {
                      id: 'sla',
                      label: `รับทราบ / เกิน SLA (${unifiedHistory.filter((i) => i.category === 'sla').length})`,
                    },
                    {
                      id: 'note_edit',
                      label: `แก้ไข Note (${unifiedHistory.filter((i) => i.category === 'note_edit').length})`,
                    },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setHistoryFilter(f.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      historyFilter === f.id
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              {filteredHistory.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 py-10 text-center text-xs text-slate-500">
                  ยังไม่มีรายการ History ในหมวดหมู่นี้สำหรับเคสนี้
                </div>
              ) : (
                <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg bg-white">
                  {filteredHistory.map((item) => {
                    const renderIcon = () => {
                      if (item.category === 'escalation') {
                        if (item.badgeTone === 'emerald') {
                          return <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />;
                        }
                        if (item.badgeTone === 'rose') {
                          return <RotateCcw className="w-4 h-4 text-rose-600 shrink-0" />;
                        }
                        if (item.badgeTone === 'slate') {
                          return <CheckCircle2 className="w-4 h-4 text-slate-600 shrink-0" />;
                        }
                        return <Send className="w-4 h-4 text-indigo-600 shrink-0" />;
                      }
                      if (item.category === 'note_edit') {
                        return <Edit3 className="w-4 h-4 text-amber-600 shrink-0" />;
                      }
                      if (item.badgeTone === 'red') {
                        return <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />;
                      }
                      return <Clock className="w-4 h-4 text-amber-600 shrink-0" />;
                    };

                    const titleColor =
                      item.badgeTone === 'red'
                        ? 'text-red-700'
                        : item.badgeTone === 'rose'
                          ? 'text-rose-700'
                          : item.badgeTone === 'emerald'
                            ? 'text-emerald-700'
                            : item.badgeTone === 'indigo'
                              ? 'text-indigo-800'
                              : item.badgeTone === 'amber'
                                ? 'text-amber-800'
                                : 'text-slate-900';

                    return (
                      <div key={item.id} className="p-4 space-y-1.5">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5">
                          <div className="flex items-center gap-2 min-w-0">
                            {renderIcon()}
                            <span className={`text-xs font-semibold ${titleColor}`}>{item.title}</span>
                          </div>
                          <span className="text-xs font-mono text-slate-500 tabular-nums shrink-0">
                            {formatThaiDateTime(item.timestampIso)}
                          </span>
                        </div>

                        {item.actorLabel && (
                          <div className="text-xs font-medium text-slate-700 pl-6">
                            {item.actorLabel}
                          </div>
                        )}

                        {item.description && (
                          <div className="text-xs text-slate-600 pl-6 whitespace-pre-wrap">
                            {item.description}
                          </div>
                        )}

                        {(item.diffOldContent !== undefined ||
                          item.diffOldSla !== undefined ||
                          item.diffOldAttachments !== undefined) && (
                          <div className="ml-6 mt-1.5 rounded-md border border-amber-200 bg-amber-50/50 p-2.5 space-y-1 text-xs">
                            {item.diffOldContent !== undefined && item.diffNewContent !== undefined && (
                              <>
                                <div className="text-red-700">
                                  <span className="font-medium">จากเดิม:</span>{' '}
                                  <span className="whitespace-pre-wrap">
                                    {item.diffOldContent || '(ไม่มีข้อความ)'}
                                  </span>
                                </div>
                                <div className="text-emerald-800">
                                  <span className="font-medium">แก้ไขเป็น:</span>{' '}
                                  <span className="whitespace-pre-wrap">
                                    {item.diffNewContent || '(ไม่มีข้อความ)'}
                                  </span>
                                </div>
                              </>
                            )}
                            {item.diffOldSla !== undefined && item.diffNewSla !== undefined && (
                              <div className="text-blue-800">
                                <span className="font-medium">แก้ SLA จาก:</span>{' '}
                                <span className="font-mono">{formatThaiDate(item.diffOldSla)}</span>{' '}
                                <span>→</span>{' '}
                                <span className="font-mono">{formatThaiDate(item.diffNewSla)}</span>
                              </div>
                            )}
                            {item.diffOldAttachments !== undefined &&
                              item.diffNewAttachments !== undefined && (
                                <div className="text-amber-900">
                                  <span className="font-medium">แก้ไฟล์แนบจาก:</span>{' '}
                                  <span>{item.diffOldAttachments}</span> <span>→</span>{' '}
                                  <span>{item.diffNewAttachments}</span>
                                </div>
                              )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {!isNew && (!isAdmin || activeTab === 'history') && (
            <div className="border-t border-slate-200 pt-4 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-4 py-2 text-sm font-medium text-slate-700 transition-colors cursor-pointer"
              >
                ปิดหน้าต่าง
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Image Preview Lightbox */}
      {previewImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4"
          onClick={() => setPreviewImage(null)}
          role="dialog"
          aria-modal="true"
          aria-label={`ดูภาพ ${previewImage.name}`}
        >
          <div
            className="relative max-w-4xl max-h-[90vh] flex flex-col bg-white rounded-xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900 truncate">
                  {previewImage.name}
                </div>
                <div className="text-xs font-mono text-slate-500">
                  {formatFileSize(previewImage.size_bytes)}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={getAttachmentDownloadUrl(previewImage)}
                  download={previewImage.name}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>ดาวน์โหลด</span>
                </a>
                <button
                  type="button"
                  onClick={() => setPreviewImage(null)}
                  className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
                  aria-label="ปิดภาพตัวอย่าง"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="bg-slate-950 flex items-center justify-center p-2 overflow-auto">
              <img
                src={previewImage.url}
                alt={previewImage.name}
                className="max-h-[75vh] max-w-full object-contain rounded"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
