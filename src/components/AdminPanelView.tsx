import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Plus,
  Send,
  Trash2,
  User,
  UserPlus,
  Users,
  Webhook,
} from 'lucide-react';
import {
  createPositionDoc,
  createStaffMemberDoc,
  createTeamDoc,
  deletePositionDoc,
  deleteStaffMemberDoc,
  deleteTeamDoc,
  updateStaffMemberDoc,
} from '../lib/firestoreService.ts';
import { formatThaiDateTime, getRoleLabel } from '../lib/sla.ts';
import {
  DEFAULT_WEBHOOK_EVENTS,
  WEBHOOK_EVENT_LABELS,
  deleteAdminTeamWebhook,
  fetchAdminTeamWebhooks,
  saveAdminTeamWebhook,
  testAdminTeamWebhook,
} from '../lib/webhookService.ts';
import type {
  CaseItem,
  Position,
  RoleLevel,
  StaffEntry,
  Team,
  TeamWebhookConfig,
  UserPublic,
  WebhookEventType,
} from '../types.ts';

const FIREBASE_PROVIDERS_URL =
  'https://console.firebase.google.com/u/0/project/crm-desk-1a741/authentication/providers';

interface AdminPanelViewProps {
  currentUser: UserPublic;
  teams: Team[];
  positions: Position[];
  staffList: StaffEntry[];
  cases: CaseItem[];
}

export const AdminPanelView: React.FC<AdminPanelViewProps> = ({
  currentUser,
  teams,
  positions,
  staffList,
  cases,
}) => {
  const [tab, setTab] = useState<'users' | 'teams' | 'positions' | 'webhooks'>('users');
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Create / Edit Staff User form state
  const [showUserForm, setShowUserForm] = useState(false);
  const [editingStaff, setEditingStaff] = useState<StaffEntry | null>(null);
  const [uUsername, setUUsername] = useState('');
  const [uPassword, setUPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [uDisplayName, setUDisplayName] = useState('');
  const [uPositionId, setUPositionId] = useState<string>(positions[0]?.id ?? '');
  const [uTeamId, setUTeamId] = useState<string>(teams[0]?.id ?? '');
  const [uActive, setUActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Add Team state
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamDesc, setNewTeamDesc] = useState('');

  // Add Position state
  const [newPosName, setNewPosName] = useState('');
  const [newPosLevel, setNewPosLevel] = useState<RoleLevel>('agent');

  // Team Webhooks state
  const [webhooks, setWebhooks] = useState<TeamWebhookConfig[]>([]);
  const [loadingWebhooks, setLoadingWebhooks] = useState(false);
  const [editingWebhookTeamId, setEditingWebhookTeamId] = useState<string | null>(null);
  const [whUrlInput, setWhUrlInput] = useState('');
  const [whEnabled, setWhEnabled] = useState(true);
  const [whEvents, setWhEvents] = useState<WebhookEventType[]>([...DEFAULT_WEBHOOK_EVENTS]);
  const [whBusyTeamId, setWhBusyTeamId] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== 'webhooks') return;
    let active = true;
    setLoadingWebhooks(true);
    fetchAdminTeamWebhooks()
      .then((list) => {
        if (active) setWebhooks(list);
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'ไม่สามารถโหลดการตั้งค่า Webhook ได้');
        }
      })
      .finally(() => {
        if (active) setLoadingWebhooks(false);
      });
    return () => {
      active = false;
    };
  }, [tab]);

  const openCreateUser = () => {
    setEditingStaff(null);
    setUUsername('');
    setUPassword('');
    setShowPassword(false);
    setUDisplayName('');
    setUPositionId(positions.find((p) => p.role_level === 'agent')?.id ?? positions[0]?.id ?? '');
    setUTeamId(teams[0]?.id ?? '');
    setUActive(true);
    setError(null);
    setSuccessMsg(null);
    setShowUserForm(true);
  };

  const openEditUser = (s: StaffEntry) => {
    setEditingStaff(s);
    setUUsername(s.username || s.email.split('@')[0]);
    setUPassword('');
    setShowPassword(false);
    setUDisplayName(s.display_name);
    setUPositionId(s.position_id);
    setUTeamId(s.team_id);
    setUActive(s.is_active);
    setError(null);
    setSuccessMsg(null);
    setShowUserForm(true);
  };

  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setSubmitting(true);

    try {
      const selectedPos = positions.find((p) => p.id === uPositionId);
      const selectedTeam = teams.find((t) => t.id === uTeamId);
      if (!selectedPos || !selectedTeam) {
        throw new Error('กรุณาเลือกตำแหน่งและทีม / แผนกให้ถูกต้อง');
      }

      if (editingStaff) {
        await updateStaffMemberDoc(
          currentUser,
          editingStaff,
          {
            display_name: uDisplayName,
            position: selectedPos,
            team: selectedTeam,
            is_active: uActive,
          },
          staffList
        );
        setSuccessMsg(`อัปเดตบัญชี "@${editingStaff.username || editingStaff.email.split('@')[0]}" เรียบร้อยแล้ว`);
      } else {
        await createStaffMemberDoc(currentUser, {
          username: uUsername,
          password: uPassword,
          display_name: uDisplayName,
          position: selectedPos,
          team: selectedTeam,
        });
        setSuccessMsg(
          `สร้างบัญชี "@${uUsername.trim().toLowerCase()}" เรียบร้อยแล้ว พนักงานสามารถใช้ Username และ Password นี้เข้าสู่ระบบได้ทันที`
        );
      }
      setShowUserForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถบันทึกข้อมูลผู้ใช้ได้');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteUser = async (s: StaffEntry) => {
    setError(null);
    setSuccessMsg(null);
    try {
      await deleteStaffMemberDoc(currentUser, s);
      setSuccessMsg(`ลบบัญชี "@${s.username || s.email.split('@')[0]}" เรียบร้อยแล้ว`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถลบบัญชีผู้ใช้ได้');
    }
  };

  const handleCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setSubmitting(true);
    try {
      await createTeamDoc({ name: newTeamName, description: newTeamDesc }, teams);
      setNewTeamName('');
      setNewTeamDesc('');
      setSuccessMsg('เพิ่มแผนก / ทีมใหม่เรียบร้อยแล้ว');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถเพิ่มทีมได้');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteTeam = async (team: Team) => {
    setError(null);
    setSuccessMsg(null);
    try {
      await deleteTeamDoc(team, staffList, cases);
      setSuccessMsg(`ลบทีม "${team.name}" เรียบร้อยแล้ว`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถลบทีมได้');
    }
  };

  const handleCreatePosition = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setSubmitting(true);
    try {
      await createPositionDoc({ name: newPosName, role_level: newPosLevel }, positions);
      setNewPosName('');
      setNewPosLevel('agent');
      setSuccessMsg('เพิ่มตำแหน่งใหม่เรียบร้อยแล้ว');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถเพิ่มตำแหน่งได้');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeletePosition = async (pos: Position) => {
    setError(null);
    setSuccessMsg(null);
    try {
      await deletePositionDoc(pos, staffList);
      setSuccessMsg(`ลบตำแหน่ง "${pos.name}" เรียบร้อยแล้ว`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถลบตำแหน่งได้');
    }
  };

  const openEditWebhook = (team: Team) => {
    const existing = webhooks.find((w) => w.team_id === team.id);
    setEditingWebhookTeamId(team.id);
    setWhUrlInput('');
    setWhEnabled(existing ? existing.enabled : true);
    setWhEvents(
      existing && existing.events.length > 0 ? [...existing.events] : [...DEFAULT_WEBHOOK_EVENTS]
    );
    setError(null);
    setSuccessMsg(null);
  };

  const toggleWebhookEvent = (ev: WebhookEventType) => {
    setWhEvents((prev) =>
      prev.includes(ev) ? prev.filter((item) => item !== ev) : [...prev, ev]
    );
  };

  const handleSaveWebhook = async (e: React.FormEvent, team: Team) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    const existing = webhooks.find((w) => w.team_id === team.id);
    const trimmedUrl = whUrlInput.trim();
    if (!existing?.has_webhook && !trimmedUrl) {
      setError('กรุณาระบุ Webhook URL (HTTPS)');
      return;
    }
    if (whEvents.length === 0) {
      setError('กรุณาเลือกเหตุการณ์แจ้งเตือนอย่างน้อย 1 รายการ');
      return;
    }

    setWhBusyTeamId(team.id);
    try {
      const saved = await saveAdminTeamWebhook(team.id, {
        ...(trimmedUrl ? { webhook_url: trimmedUrl } : {}),
        enabled: whEnabled,
        events: whEvents,
      });
      setWebhooks((prev) => {
        const filtered = prev.filter((w) => w.team_id !== team.id);
        return [...filtered, saved];
      });
      setEditingWebhookTeamId(null);
      setWhUrlInput('');
      setSuccessMsg(`บันทึกการตั้งค่า Webhook สำหรับทีม "${team.name}" เรียบร้อยแล้ว`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถบันทึกการตั้งค่า Webhook ได้');
    } finally {
      setWhBusyTeamId(null);
    }
  };

  const handleTestWebhook = async (team: Team) => {
    setError(null);
    setSuccessMsg(null);
    setWhBusyTeamId(team.id);
    try {
      const res = await testAdminTeamWebhook(team.id, team.name);
      if (res.webhook) {
        setWebhooks((prev) => {
          const filtered = prev.filter((w) => w.team_id !== team.id);
          return [...filtered, res.webhook!];
        });
      }
      if (res.ok) {
        setSuccessMsg(`ส่งข้อความทดสอบเข้าห้องแชทของทีม "${team.name}" สำเร็จแล้ว`);
      } else {
        setError(res.error || `ทดสอบส่ง Webhook ของทีม "${team.name}" ไม่สำเร็จ`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถทดสอบส่ง Webhook ได้');
    } finally {
      setWhBusyTeamId(null);
    }
  };

  const handleDeleteWebhook = async (team: Team) => {
    setError(null);
    setSuccessMsg(null);
    setWhBusyTeamId(team.id);
    try {
      await deleteAdminTeamWebhook(team.id);
      setWebhooks((prev) => prev.filter((w) => w.team_id !== team.id));
      if (editingWebhookTeamId === team.id) {
        setEditingWebhookTeamId(null);
      }
      setSuccessMsg(`ลบการเชื่อมต่อ Webhook ของทีม "${team.name}" เรียบร้อยแล้ว`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถลบ Webhook ได้');
    } finally {
      setWhBusyTeamId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">จัดการบัญชีผู้ใช้ ตำแหน่ง และแผนก</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            สร้างบัญชีพนักงานด้วย Username &amp; Password กำหนดสิทธิ์ Admin, TL, Agent และจัดการทีมปฏิบัติงาน
          </p>
        </div>

        {tab === 'users' && (
          <button
            type="button"
            onClick={openCreateUser}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-700 hover:bg-blue-800 px-4 py-2 text-sm font-medium text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <UserPlus className="w-4 h-4 shrink-0" />
            <span>เพิ่มผู้ใช้งานใหม่</span>
          </button>
        )}
      </div>

      {/* Sub-Navigation Segmented Tabs */}
      <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
        <button
          type="button"
          onClick={() => {
            setTab('users');
            setError(null);
            setSuccessMsg(null);
          }}
          className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            tab === 'users' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          <span>บัญชีผู้ใช้ ({staffList.length})</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setTab('teams');
            setError(null);
            setSuccessMsg(null);
          }}
          className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            tab === 'teams' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <span>ทีม / แผนก ({teams.length})</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setTab('positions');
            setError(null);
            setSuccessMsg(null);
          }}
          className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            tab === 'positions' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <KeyRound className="w-3.5 h-3.5" />
          <span>ตำแหน่งและสิทธิ์ ({positions.length})</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setTab('webhooks');
            setError(null);
            setSuccessMsg(null);
          }}
          className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            tab === 'webhooks' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Webhook className="w-3.5 h-3.5" />
          <span>Webhook ห้องแชท</span>
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 space-y-1.5">
          <div>{error}</div>
          {error.includes('operation-not-allowed') && (
            <a
              href={FIREBASE_PROVIDERS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-xs font-semibold text-blue-700 underline hover:text-blue-800"
            >
              คลิกเพื่อไปเปิด Email/Password ใน Firebase Console →
            </a>
          )}
        </div>
      )}
      {successMsg && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {successMsg}
        </div>
      )}

      {/* USERS TAB */}
      {tab === 'users' && (
        <div className="space-y-5">
          {showUserForm && (
            <form
              onSubmit={handleSaveUser}
              className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <h2 className="text-sm font-semibold text-slate-900">
                  {editingStaff
                    ? `แก้ไขบัญชีผู้ใช้: @${editingStaff.username || editingStaff.email.split('@')[0]}`
                    : 'เพิ่มบัญชีผู้ใช้งานใหม่ (Username & Password)'}
                </h2>
                <button
                  type="button"
                  onClick={() => setShowUserForm(false)}
                  className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer"
                >
                  ปิดฟอร์ม
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className={editingStaff ? 'sm:col-span-2' : 'sm:col-span-1'}>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Username <span className="text-red-600">*</span>
                  </label>
                  <div className="relative">
                    <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      required
                      disabled={Boolean(editingStaff)}
                      value={uUsername}
                      onChange={(e) => setUUsername(e.target.value)}
                      placeholder="เช่น somchai (a-z, 0-9, ., _, -)"
                      className="w-full rounded-lg border border-slate-300 bg-white disabled:bg-slate-100 pl-9 pr-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                    />
                  </div>
                </div>

                {!editingStaff && (
                  <div className="sm:col-span-1">
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      รหัสผ่าน (อย่างน้อย 6 ตัวอักษร) <span className="text-red-600">*</span>
                    </label>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        minLength={6}
                        value={uPassword}
                        onChange={(e) => setUPassword(e.target.value)}
                        placeholder="••••••"
                        className="w-full rounded-lg border border-slate-300 bg-white pl-9 pr-9 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        aria-label={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                )}

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    ชื่อ-นามสกุล (ผู้รับเรื่อง) <span className="text-red-600">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={uDisplayName}
                    onChange={(e) => setUDisplayName(e.target.value)}
                    placeholder="เช่น สมชาย สายตรง"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    ตำแหน่ง / สิทธิ์การใช้งาน
                  </label>
                  <select
                    value={uPositionId}
                    onChange={(e) => setUPositionId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                  >
                    {positions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — {getRoleLabel(p.role_level)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    แผนก / ทีมที่สังกัด
                  </label>
                  <select
                    value={uTeamId}
                    onChange={(e) => setUTeamId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                  >
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>

                {editingStaff && (
                  <div className="sm:col-span-2 flex items-center pt-1">
                    <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={uActive}
                        onChange={(e) => setUActive(e.target.checked)}
                        className="rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                      />
                      <span>เปิดใช้งานบัญชีนี้</span>
                    </label>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowUserForm(false)}
                  className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-4 py-2 text-xs font-medium text-slate-700 cursor-pointer"
                >
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 px-5 py-2 text-xs font-medium text-white cursor-pointer"
                >
                  {submitting ? 'กำลังบันทึก...' : editingStaff ? 'บันทึกการแก้ไข' : 'เพิ่มบัญชีผู้ใช้'}
                </button>
              </div>
            </form>
          )}

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                    <th className="py-3 px-5">Username</th>
                    <th className="py-3 px-4">ชื่อผู้รับเรื่อง</th>
                    <th className="py-3 px-4">ตำแหน่ง (สิทธิ์)</th>
                    <th className="py-3 px-4">ทีม / แผนก</th>
                    <th className="py-3 px-4">สถานะ</th>
                    <th className="py-3 px-5 text-right">จัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {staffList.map((s) => {
                    const displayAccount = `@${s.username || s.email.split('@')[0]}`;
                    return (
                    <tr key={s.id} className="hover:bg-slate-50">
                      <td className="py-3.5 px-5 font-mono text-xs font-medium text-slate-900">
                        {displayAccount}
                        {s.linked_uid === currentUser.uid && (
                          <span className="ml-1.5 font-sans text-blue-700">(คุณ)</span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-slate-900">{s.display_name}</td>
                      <td className="py-3.5 px-4 text-xs">
                        <span className="font-medium text-slate-900">{s.position_name}</span>
                        <span className="text-slate-400 mx-1.5">·</span>
                        <span className="text-slate-500">{getRoleLabel(s.role)}</span>
                      </td>
                      <td className="py-3.5 px-4 text-xs font-medium text-slate-700">{s.team_name}</td>
                      <td className="py-3.5 px-4 text-xs space-x-2">
                        <span className={s.is_active ? 'text-emerald-700 font-medium' : 'text-red-700 font-medium'}>
                          {s.is_active ? 'ใช้งานอยู่' : 'ปิดใช้งาน'}
                        </span>
                        {!s.linked_uid && (
                          <span className="text-slate-400">· รอเข้าสู่ระบบครั้งแรก</span>
                        )}
                      </td>
                      <td className="py-3.5 px-5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openEditUser(s)}
                            className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer"
                          >
                            แก้ไขสิทธิ์ / ทีม
                          </button>
                          {s.linked_uid !== currentUser.uid && (
                            <button
                              type="button"
                              onClick={() => handleDeleteUser(s)}
                              aria-label={`ลบบัญชี ${s.email}`}
                              className="rounded-lg border border-red-200 bg-white hover:bg-red-50 p-1.5 text-red-700 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TEAMS TAB */}
      {tab === 'teams' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-6 h-fit">
            <h2 className="text-sm font-semibold text-slate-900 mb-4">เพิ่มทีม / แผนกใหม่</h2>
            <form onSubmit={handleCreateTeam} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  ชื่อทีม / แผนก <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  placeholder="เช่น Live Chat / VIP Support"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">คำอธิบาย</label>
                <textarea
                  rows={3}
                  value={newTeamDesc}
                  onChange={(e) => setNewTeamDesc(e.target.value)}
                  placeholder="รายละเอียดขอบเขตงานของแผนก"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 px-4 py-2 text-xs font-medium text-white cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>เพิ่มทีมใหม่</span>
              </button>
            </form>
          </div>

          <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                  <th className="py-3 px-5">ชื่อทีม / แผนก</th>
                  <th className="py-3 px-4">รายละเอียด</th>
                  <th className="py-3 px-4 text-right">สมาชิก</th>
                  <th className="py-3 px-4 text-right">เคส</th>
                  <th className="py-3 px-5 text-right">ลบ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {teams.map((t) => {
                  const memberCount = staffList.filter((s) => s.team_id === t.id).length;
                  const caseCount = cases.filter((c) => c.team_id === t.id).length;
                  return (
                    <tr key={t.id} className="hover:bg-slate-50">
                      <td className="py-3.5 px-5 font-medium text-slate-900 whitespace-nowrap">{t.name}</td>
                      <td className="py-3.5 px-4 text-xs text-slate-500">{t.description || '-'}</td>
                      <td className="py-3.5 px-4 text-right font-mono text-xs tabular-nums text-slate-700">
                        {memberCount}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono text-xs tabular-nums text-slate-700">
                        {caseCount}
                      </td>
                      <td className="py-3.5 px-5 text-right">
                        <button
                          type="button"
                          onClick={() => handleDeleteTeam(t)}
                          aria-label={`ลบทีม ${t.name}`}
                          className="rounded-lg border border-red-200 bg-white hover:bg-red-50 p-1.5 text-red-700 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* POSITIONS TAB */}
      {tab === 'positions' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-6 h-fit">
            <h2 className="text-sm font-semibold text-slate-900 mb-4">เพิ่มตำแหน่งงานใหม่</h2>
            <form onSubmit={handleCreatePosition} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  ชื่อตำแหน่ง <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={newPosName}
                  onChange={(e) => setNewPosName(e.target.value)}
                  placeholder="เช่น Senior Agent / Supervisor"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  ระดับสิทธิ์ที่ผูกกับตำแหน่ง
                </label>
                <select
                  value={newPosLevel}
                  onChange={(e) => setNewPosLevel(e.target.value as RoleLevel)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                >
                  <option value="agent">Agent — เห็นและจัดการเฉพาะทีมตนเอง</option>
                  <option value="tl">TL — ตรวจสอบ แก้ไข และดูภาพรวมทุกทีม</option>
                  <option value="admin">Admin — สิทธิ์ผู้ดูแลระบบเต็มรูปแบบ</option>
                </select>
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 px-4 py-2 text-xs font-medium text-white cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>เพิ่มตำแหน่งใหม่</span>
              </button>
            </form>
          </div>

          <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                  <th className="py-3 px-5">ชื่อตำแหน่ง</th>
                  <th className="py-3 px-4">ระดับสิทธิ์</th>
                  <th className="py-3 px-4 text-right">ผู้ใช้งาน</th>
                  <th className="py-3 px-5 text-right">ลบ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {positions.map((p) => {
                  const userCount = staffList.filter((s) => s.position_id === p.id).length;
                  return (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="py-3.5 px-5 font-medium text-slate-900">{p.name}</td>
                      <td className="py-3.5 px-4 text-xs text-slate-600">{getRoleLabel(p.role_level)}</td>
                      <td className="py-3.5 px-4 text-right font-mono text-xs tabular-nums text-slate-700">
                        {userCount}
                      </td>
                      <td className="py-3.5 px-5 text-right">
                        {p.is_system ? (
                          <span className="text-xs text-slate-400">ตำแหน่งหลัก</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleDeletePosition(p)}
                            aria-label={`ลบตำแหน่ง ${p.name}`}
                            className="rounded-lg border border-red-200 bg-white hover:bg-red-50 p-1.5 text-red-700 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* WEBHOOKS TAB */}
      {tab === 'webhooks' && (
        <div className="space-y-5">
          <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <Webhook className="w-4 h-4 text-blue-700" />
                <span>ส่งแจ้งเตือนเข้าห้องแชทของทีม (Webhook Integration)</span>
              </h2>
              <p className="text-xs text-slate-500">
                รองรับ Discord, Slack, Google Chat หรือ Webhook URL (HTTPS) เช่น n8n / LINE Messaging Proxy
                โดยระบบจะจัดรูปแบบข้อความให้เหมาะสมกับปลายทางอัตโนมัติ และเก็บรักษา Webhook URL อย่างปลอดภัยบนเซิร์ฟเวอร์
              </p>
            </div>
          </div>

          {loadingWebhooks ? (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
              กำลังโหลดการตั้งค่า Webhook...
            </div>
          ) : (
            <div className="space-y-4">
              {teams.map((t) => {
                const cfg = webhooks.find((w) => w.team_id === t.id);
                const isEditing = editingWebhookTeamId === t.id;
                const isBusy = whBusyTeamId === t.id;
                const memberCount = staffList.filter((s) => s.team_id === t.id).length;

                return (
                  <div
                    key={t.id}
                    className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex flex-wrap items-center gap-2.5">
                          <span className="text-sm font-semibold text-slate-900">{t.name}</span>
                          <span className="text-xs text-slate-400">({memberCount} คน)</span>
                          {cfg?.has_webhook ? (
                            <span
                              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${
                                cfg.enabled
                                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                  : 'bg-slate-100 text-slate-600 border border-slate-200'
                              }`}
                            >
                              {cfg.enabled ? 'เปิดใช้งาน' : 'ปิดชั่วคราว'}
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200">
                              ยังไม่ได้เชื่อมต่อ
                            </span>
                          )}
                        </div>

                        {cfg?.has_webhook && (
                          <div className="space-y-1.5">
                            <div className="font-mono text-xs text-slate-600 break-all">
                              {cfg.masked_url}
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              {cfg.events.map((ev) => (
                                <span
                                  key={ev}
                                  className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs text-blue-800"
                                >
                                  {WEBHOOK_EVENT_LABELS[ev] || ev}
                                </span>
                              ))}
                            </div>
                            {cfg.last_status && (
                              <div className="flex items-center gap-1.5 text-xs pt-0.5">
                                {cfg.last_status === 'success' ? (
                                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                                ) : (
                                  <AlertCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />
                                )}
                                <span
                                  className={
                                    cfg.last_status === 'success' ? 'text-emerald-700' : 'text-red-700'
                                  }
                                >
                                  {cfg.last_status === 'success'
                                    ? 'ส่งล่าสุดสำเร็จ'
                                    : cfg.last_error || 'ส่งล่าสุดไม่สำเร็จ'}
                                </span>
                                {cfg.last_sent_at && (
                                  <span className="text-slate-400">
                                    · {formatThaiDateTime(cfg.last_sent_at)}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            isEditing ? setEditingWebhookTeamId(null) : openEditWebhook(t)
                          }
                          className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-60 px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer"
                        >
                          {isEditing ? 'ปิดฟอร์ม' : cfg?.has_webhook ? 'แก้ไข Webhook' : 'ตั้งค่า Webhook'}
                        </button>

                        {cfg?.has_webhook && (
                          <>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleTestWebhook(t)}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 hover:bg-blue-100 disabled:opacity-60 px-3 py-1.5 text-xs font-medium text-blue-800 cursor-pointer"
                            >
                              <Send className="w-3.5 h-3.5" />
                              <span>{isBusy ? 'กำลังส่ง...' : 'ทดสอบส่ง'}</span>
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleDeleteWebhook(t)}
                              aria-label={`ลบ Webhook ทีม ${t.name}`}
                              className="rounded-lg border border-red-200 bg-white hover:bg-red-50 disabled:opacity-60 p-1.5 text-red-700 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {isEditing && (
                      <form
                        onSubmit={(e) => void handleSaveWebhook(e, t)}
                        className="border-t border-slate-200 pt-4 space-y-4"
                      >
                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Webhook URL (ต้องเป็น HTTPS)
                          </label>
                          <input
                            type="url"
                            value={whUrlInput}
                            onChange={(e) => setWhUrlInput(e.target.value)}
                            placeholder={
                              cfg?.has_webhook
                                ? 'เว้นว่างไว้หากใช้ URL เดิมที่บันทึกไว้ หรือวาง URL ใหม่เพื่อเปลี่ยน'
                                : 'https://discord.com/api/webhooks/... หรือ Slack / Google Chat / n8n'
                            }
                            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 font-mono focus:border-blue-600 focus:outline-none"
                          />
                        </div>

                        <div className="space-y-2">
                          <div className="text-xs font-medium text-slate-700">
                            เหตุการณ์ที่ต้องการส่งแจ้งเตือนเข้าห้องแชท
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                            {(Object.keys(WEBHOOK_EVENT_LABELS) as WebhookEventType[]).map((ev) => (
                              <label
                                key={ev}
                                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 cursor-pointer hover:bg-slate-100"
                              >
                                <input
                                  type="checkbox"
                                  checked={whEvents.includes(ev)}
                                  onChange={() => toggleWebhookEvent(ev)}
                                  className="rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                                />
                                <span>{WEBHOOK_EVENT_LABELS[ev]}</span>
                              </label>
                            ))}
                          </div>
                        </div>

                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                          <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={whEnabled}
                              onChange={(e) => setWhEnabled(e.target.checked)}
                              className="rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                            />
                            <span>เปิดใช้งานการส่ง Webhook ของทีมนี้</span>
                          </label>

                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingWebhookTeamId(null)}
                              className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-4 py-2 text-xs font-medium text-slate-700 cursor-pointer"
                            >
                              ยกเลิก
                            </button>
                            <button
                              type="submit"
                              disabled={isBusy}
                              className="rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 px-4 py-2 text-xs font-medium text-white cursor-pointer"
                            >
                              {isBusy ? 'กำลังบันทึก...' : 'บันทึก Webhook'}
                            </button>
                          </div>
                        </div>
                      </form>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
