export type RoleLevel = 'admin' | 'tl' | 'agent';

export type CaseStatus = 'todo' | 'in_progress' | 'done';

export type SlaState = 'normal' | 'due_today' | 'overdue' | 'resolved';

export type AlertStage = 'due_today' | 'overdue' | 'pre_30m' | 'due_reached';

export type AckLevel = AlertStage;

export type EscalationStatus = 'pending' | 'accepted' | 'rejected';

export interface Team {
  id: string;
  name: string;
  description: string;
  is_archived?: boolean;
  created_at: string;
  updated_at?: string;
  user_count?: number;
  case_count?: number;
}

export interface Position {
  id: string;
  name: string;
  role_level: RoleLevel;
  is_system: boolean;
  is_archived?: boolean;
  created_at: string;
  updated_at?: string;
  user_count?: number;
}

export interface UserPublic {
  id: string;
  uid: string;
  staff_id: string;
  username?: string;
  display_name: string;
  role: RoleLevel;
  position_id: string;
  position_name: string;
  team_id: string;
  team_name: string;
  is_active: boolean;
  email?: string;
  created_at: string;
}

export interface StaffEntry {
  id: string;
  email: string;
  username?: string;
  display_name: string;
  position_id: string;
  position_name: string;
  role: RoleLevel;
  team_id: string;
  team_name: string;
  is_active: boolean;
  linked_uid: string;
  created_at: string;
  updated_at: string;
}

export interface UserCaseAck {
  id: string;
  case_id: string;
  user_id: string;
  ack_stage: AlertStage;
  sla_due_at: string;
  ack_at: string;
}

export interface CaseItem {
  id: string;
  case_no: string;
  case_url?: string;
  shop_id: string;
  issue_summary: string;
  details: string;
  status: CaseStatus;
  team_id: string;
  team_name: string;
  assignee_id: string;
  assignee_name: string;
  created_by: string;
  sla_due_at: string;
  sla_state: SlaState;
  alert_stage_required: AlertStage | null;
  my_ack_stages: AlertStage[];
  needs_ack: boolean;
  ack_level_required: AlertStage | null;
  last_ack_at: string | null;
  last_ack_by_name: string | null;
  last_ack_level: string | null;
  pending_escalation_id?: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface AckHistoryEntry {
  id: string;
  case_id: string;
  user_id: string;
  user_name: string;
  ack_level: string;
  note: string;
  ack_at: string;
}

export type AttachmentKind = 'image' | 'video' | 'file';

export interface NoteAttachment {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  kind: AttachmentKind;
  url: string;
}

export interface InternalNoteEditLog {
  id: string;
  note_id: string;
  case_id: string;
  editor_id: string;
  editor_name: string;
  editor_role: RoleLevel;
  old_content: string;
  new_content: string;
  old_sla_due_at: string;
  new_sla_due_at: string;
  old_attachments_summary?: string;
  new_attachments_summary?: string;
  edited_at: string;
}

export interface InternalNote {
  id: string;
  case_id: string;
  author_id: string;
  author_name: string;
  author_role: RoleLevel;
  content: string;
  sla_changed: boolean;
  previous_sla_due_at: string;
  new_sla_due_at: string;
  attachments?: NoteAttachment[];
  is_edited: boolean;
  last_edited_by: string;
  last_edited_by_name: string;
  last_edit_log_id: string;
  created_at: string;
  updated_at: string;
}

export interface CaseEscalation {
  id: string;
  case_id: string;
  case_no: string;
  case_url?: string;
  shop_id: string;
  issue_summary: string;
  details_preview: string;
  sla_due_at: string;
  from_user_id: string;
  from_user_name: string;
  from_team_id: string;
  from_team_name: string;
  to_user_id: string;
  to_user_name: string;
  to_team_id: string;
  to_team_name: string;
  note: string;
  status: EscalationStatus;
  reject_reason: string;
  sender_ack_done: boolean;
  created_at: string;
  updated_at: string;
}

export interface CaseEscalationLog {
  id: string;
  case_id: string;
  from_user_id: string;
  from_user_name: string;
  from_team_id: string;
  from_team_name: string;
  to_user_id: string;
  to_user_name: string;
  to_team_id: string;
  to_team_name: string;
  note: string;
  status: EscalationStatus;
  reject_reason: string;
  sender_ack_done?: boolean;
  sender_ack_at?: string;
  created_at: string;
  updated_at: string;
}

export interface TeamStat {
  team_id: string;
  team_name: string;
  total_open: number;
  todo_count: number;
  in_progress_count: number;
  due_today_count: number;
  overdue_count: number;
  done_count: number;
}

export interface AssigneeStat {
  user_id: string;
  display_name: string;
  team_name: string;
  total_open: number;
  due_today_count: number;
  overdue_count: number;
  done_count: number;
}

export interface DashboardSummary {
  scope: 'team' | 'global';
  scope_team_name: string | null;
  totals: {
    open_cases: number;
    todo_cases: number;
    in_progress_cases: number;
    due_today_cases: number;
    overdue_cases: number;
    done_cases: number;
    unacknowledged_alerts: number;
  };
  team_stats: TeamStat[];
  assignee_stats: AssigneeStat[];
  server_time: string;
}
