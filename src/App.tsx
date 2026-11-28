import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import {
  AlertTriangle,
  ArrowRightLeft,
  BellOff,
  BellRing,
  CheckSquare,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  Shield,
  X,
} from 'lucide-react';
import { AdminPanelView } from './components/AdminPanelView.tsx';
import { BrandLogo } from './components/BrandLogo.tsx';
import { CaseListView } from './components/CaseListView.tsx';
import { CaseModal } from './components/CaseModal.tsx';
import { ChangePasswordModal } from './components/ChangePasswordModal.tsx';
import { DashboardView } from './components/DashboardView.tsx';
import { EscalationAlertModal } from './components/EscalationAlertModal.tsx';
import { LoginView } from './components/LoginView.tsx';
import { NoteNotificationBell } from './components/NoteNotificationBell.tsx';
import { SlaAlertModal } from './components/SlaAlertModal.tsx';
import { playInternalNoteChime, unlockAudio } from './lib/bell.ts';
import {
  getBrowserNotificationState,
  isWindowInBackground,
  requestBrowserNotificationPermission,
  sendBrowserNotification,
  setBrowserNotificationOptIn,
  updateDocumentAlertTitle,
  type BrowserNotificationState,
} from './lib/browserNotifications.ts';
import { resolveCaseLinkDisplay } from './lib/caseLink.ts';
import { auth } from './lib/firebase.ts';
import {
  acceptCaseEscalationDoc,
  acknowledgeCaseForUser,
  acknowledgeCasesBulkForUser,
  acknowledgeRejectedEscalationDoc,
  buildDashboardSummary,
  clearReadNoteNotifications,
  deleteCaseDoc,
  enrichCasesForUser,
  markAllNoteNotificationsRead,
  markNoteNotificationRead,
  rejectCaseEscalationDoc,
  resolveAuthenticatedUser,
  signOutFirebase,
  subscribeActiveUsers,
  subscribeIncomingEscalations,
  subscribeMyCaseAcks,
  subscribeMyNoteNotifications,
  subscribePositions,
  subscribeRawCases,
  subscribeRejectedOutgoingEscalations,
  subscribeStaffDirectory,
  subscribeTeams,
  updateCaseDoc,
  type RawCaseDoc,
} from './lib/firestoreService.ts';
import {
  computeAlertStage,
  computeClosedCaseRetention,
  needsUserAck,
  toLocalDateInput,
} from './lib/sla.ts';
import { dispatchTeamWebhook } from './lib/webhookService.ts';
import type {
  AlertStage,
  CaseEscalation,
  CaseItem,
  CaseStatus,
  NoteNotification,
  Position,
  StaffEntry,
  Team,
  UserCaseAck,
  UserPublic,
} from './types.ts';

type NavView = 'dashboard' | 'cases' | 'admin';

export default function App() {
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [firestoreError, setFirestoreError] = useState<Error | null>(null);
  const [currentUser, setCurrentUser] = useState<UserPublic | null>(null);
  const [activeView, setActiveView] = useState<NavView>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [teams, setTeams] = useState<Team[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [activeUsers, setActiveUsers] = useState<UserPublic[]>([]);
  const [staffList, setStaffList] = useState<StaffEntry[]>([]);
  const [rawCases, setRawCases] = useState<RawCaseDoc[]>([]);
  const [myCaseAcks, setMyCaseAcks] = useState<UserCaseAck[]>([]);
  const [incomingEscalations, setIncomingEscalations] = useState<CaseEscalation[]>([]);
  const [rejectedEscalations, setRejectedEscalations] = useState<CaseEscalation[]>([]);
  const [noteNotifications, setNoteNotifications] = useState<NoteNotification[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  // Live clock for real-time SLA countdowns & automatic SLA alert transitions
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Case filters
  const [statusFilter, setStatusFilter] = useState<'all' | CaseStatus>('all');
  const [slaFilter, setSlaFilter] = useState<'all' | 'alert' | 'overdue' | 'due_today' | 'normal'>('all');
  const [teamFilter, setTeamFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Modals
  const [caseModalOpen, setCaseModalOpen] = useState(false);
  const [editingCase, setEditingCase] = useState<CaseItem | null>(null);
  const [alertModalOpen, setAlertModalOpen] = useState(false);
  const [alertNonce, setAlertNonce] = useState(0);
  const [escalationModalOpen, setEscalationModalOpen] = useState(false);
  const [escalationAlertNonce, setEscalationAlertNonce] = useState(0);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);

  // Browser Notification state
  const [browserNotifState, setBrowserNotifState] = useState<BrowserNotificationState>(() =>
    getBrowserNotificationState()
  );
  const [browserNotifNotice, setBrowserNotifNotice] = useState<string | null>(null);

  // Track which alert signatures were already triggered automatically
  const seenAlertKeysRef = useRef<Set<string>>(new Set());
  const seenBrowserSlaKeysRef = useRef<Set<string>>(new Set());
  const seenWebhookSlaKeysRef = useRef<Set<string>>(new Set());
  const seenEscalationKeysRef = useRef<Set<string>>(new Set());
  const noteNotifsInitializedRef = useRef(false);
  const seenNoteNotifIdsRef = useRef<Set<string>>(new Set());
  const deletingExpiredIdsRef = useRef<Set<string>>(new Set());
  const casesRef = useRef<CaseItem[]>([]);

  if (firestoreError) {
    throw firestoreError;
  }

  const handleLogout = useCallback(async () => {
    try {
      await signOutFirebase();
    } catch {
      // Ignore signout errors
    }
    setCurrentUser(null);
    setRawCases([]);
    setMyCaseAcks([]);
    setIncomingEscalations([]);
    setRejectedEscalations([]);
    setNoteNotifications([]);
    setTeams([]);
    setPositions([]);
    setActiveUsers([]);
    setStaffList([]);
    setAlertModalOpen(false);
    setEscalationModalOpen(false);
    seenAlertKeysRef.current.clear();
    seenBrowserSlaKeysRef.current.clear();
    seenWebhookSlaKeysRef.current.clear();
    seenEscalationKeysRef.current.clear();
    noteNotifsInitializedRef.current = false;
    seenNoteNotifIdsRef.current.clear();
    deletingExpiredIdsRef.current.clear();
    updateDocumentAlertTitle(0);
    setActiveView('dashboard');
  }, []);

  // Firebase Auth state listener
  useEffect(() => {
    let active = true;
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!active) return;
      if (!firebaseUser) {
        setCurrentUser(null);
        setCheckingAuth(false);
        return;
      }

      setCheckingAuth(true);
      setAuthError(null);
      try {
        const profile = await resolveAuthenticatedUser(firebaseUser);
        if (!active) return;
        seenAlertKeysRef.current.clear();
        seenBrowserSlaKeysRef.current.clear();
        seenWebhookSlaKeysRef.current.clear();
        seenEscalationKeysRef.current.clear();
        noteNotifsInitializedRef.current = false;
        seenNoteNotifIdsRef.current.clear();
        setCurrentUser(profile);
      } catch (err) {
        if (!active) return;
        const msg = err instanceof Error ? err.message : 'ไม่สามารถยืนยันสิทธิ์ผู้ใช้งานได้';
        setAuthError(msg);
        await signOutFirebase().catch(() => {});
        setCurrentUser(null);
      } finally {
        if (active) setCheckingAuth(false);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // Unlock Web Audio on any user gesture so SLA bell alerts can play immediately
  useEffect(() => {
    const handleGesture = () => {
      void unlockAudio();
    };
    window.addEventListener('pointerdown', handleGesture, { passive: true });
    window.addEventListener('keydown', handleGesture, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', handleGesture);
      window.removeEventListener('keydown', handleGesture);
    };
  }, []);

  // Attach Firestore real-time listeners only after auth is ready and user profile is resolved
  useEffect(() => {
    if (!currentUser) return;

    setLoadingData(true);
    const unsubs: (() => void)[] = [];
    const onErr = (err: Error) => {
      setFirestoreError(err);
    };

    unsubs.push(subscribeTeams(setTeams, onErr));
    unsubs.push(subscribePositions(setPositions, onErr));
    unsubs.push(subscribeActiveUsers(setActiveUsers, onErr));
    unsubs.push(subscribeMyCaseAcks(currentUser.uid, setMyCaseAcks, onErr));
    unsubs.push(subscribeIncomingEscalations(currentUser.uid, setIncomingEscalations, onErr));
    unsubs.push(
      subscribeRejectedOutgoingEscalations(currentUser.uid, setRejectedEscalations, onErr)
    );
    unsubs.push(
      subscribeMyNoteNotifications(
        currentUser.uid,
        (items) => {
          setNoteNotifications(items);
          if (!noteNotifsInitializedRef.current) {
            noteNotifsInitializedRef.current = true;
            items.forEach((n) => seenNoteNotifIdsRef.current.add(n.id));
            return;
          }
          let hasNewUnread = false;
          let hasNewMention = false;
          const newUnreadItems: NoteNotification[] = [];
          for (const item of items) {
            if (!seenNoteNotifIdsRef.current.has(item.id)) {
              seenNoteNotifIdsRef.current.add(item.id);
              if (!item.is_read) {
                hasNewUnread = true;
                newUnreadItems.push(item);
                if (item.notification_type === 'mention') {
                  hasNewMention = true;
                }
              }
            }
          }
          if (hasNewUnread) {
            void playInternalNoteChime(hasNewMention);
            for (const item of newUnreadItems.slice(0, 3)) {
              const caseDisplay = resolveCaseLinkDisplay(item.case_no, item.case_url).label;
              const title =
                item.notification_type === 'mention'
                  ? item.mentioned_team_name
                    ? `แท็กทีม @${item.mentioned_team_name}`
                    : 'คุณถูก @Mention ในเคส'
                  : 'Internal Note ใหม่';
              sendBrowserNotification({
                title,
                body: `${item.author_name} · ${caseDisplay}\n${item.note_preview || item.issue_summary}`,
                tag: `note-${item.id}`,
                requireInteraction: item.notification_type === 'mention',
                onClick: () => {
                  void markNoteNotificationRead(currentUser.uid, item.id).catch(() => {});
                  const matched = casesRef.current.find((c) => c.id === item.case_id);
                  if (matched) {
                    setEditingCase(matched);
                    setCaseModalOpen(true);
                  }
                },
              });
            }
          }
        },
        onErr
      )
    );
    unsubs.push(
      subscribeRawCases(
        currentUser,
        (docs) => {
          setRawCases(docs);
          setLoadingData(false);
        },
        onErr
      )
    );

    if (currentUser.role === 'admin') {
      unsubs.push(subscribeStaffDirectory(setStaffList, onErr));
    }

    const ticker = setInterval(() => {
      setNowMs(Date.now());
    }, 5000);

    return () => {
      unsubs.forEach((u) => u());
      clearInterval(ticker);
    };
  }, [currentUser]);

  // Enrich cases with live SLA & per-user ack states
  const cases = useMemo(() => {
    return enrichCasesForUser(rawCases, myCaseAcks, nowMs);
  }, [rawCases, myCaseAcks, nowMs]);

  useEffect(() => {
    casesRef.current = cases;
  }, [cases]);

  const summary = useMemo(() => {
    if (!currentUser) return null;
    return buildDashboardSummary(currentUser, cases, teams, nowMs);
  }, [currentUser, cases, teams, nowMs]);

  const assignableUsers = useMemo(() => {
    if (!currentUser) return [];
    if (currentUser.role === 'agent') {
      return activeUsers.filter((u) => u.team_id === currentUser.team_id);
    }
    return activeUsers;
  }, [currentUser, activeUsers]);

  // Automatically purge closed cases once their 15-day retention countdown expires
  useEffect(() => {
    if (!currentUser || currentUser.role !== 'admin') return;

    const expiredCases = cases.filter((c) => {
      if (c.status !== 'done') return false;
      const retention = computeClosedCaseRetention(c.resolved_at || c.updated_at, c.status, nowMs);
      return Boolean(retention?.isExpired);
    });

    for (const item of expiredCases) {
      if (deletingExpiredIdsRef.current.has(item.id)) continue;
      deletingExpiredIdsRef.current.add(item.id);
      void deleteCaseDoc(item.id).catch(() => {
        deletingExpiredIdsRef.current.delete(item.id);
      });
    }
  }, [currentUser, cases, nowMs]);

  // Compute unacknowledged SLA alerts for the current user (due today + overdue)
  const unacknowledgedAlerts = useMemo(() => {
    return cases.filter((c) => needsUserAck(c, nowMs));
  }, [cases, nowMs]);

  // Trigger SLA Alert Popup & Browser Notification immediately when a new stage enters
  useEffect(() => {
    if (!currentUser) return;

    if (unacknowledgedAlerts.length === 0) {
      setAlertModalOpen(false);
      return;
    }

    let hasNewAlert = false;
    const newlyBrowserSla: { item: CaseItem; stage: AlertStage }[] = [];
    for (const item of unacknowledgedAlerts) {
      const stage = computeAlertStage(item.sla_due_at, item.status, nowMs);
      if (!stage) continue;
      const key = `${item.id}:${item.sla_due_at}:${stage}`;
      if (!seenAlertKeysRef.current.has(key)) {
        seenAlertKeysRef.current.add(key);
        hasNewAlert = true;
      }
      if (!seenBrowserSlaKeysRef.current.has(key)) {
        seenBrowserSlaKeysRef.current.add(key);
        newlyBrowserSla.push({ item, stage });
      }
    }

    if (hasNewAlert) {
      setAlertModalOpen(true);
      setAlertNonce((n) => n + 1);
    }

    if (newlyBrowserSla.length === 1) {
      const { item, stage } = newlyBrowserSla[0];
      const caseDisplay = resolveCaseLinkDisplay(item.case_no, item.case_url).label;
      sendBrowserNotification({
        title: stage === 'overdue' ? 'เคสเกินกำหนด SLA!' : 'เคสครบกำหนด SLA วันนี้',
        body: `${caseDisplay} · ${item.issue_summary}`,
        tag: `sla-${item.id}-${stage}`,
        requireInteraction: true,
        onClick: () => {
          setEditingCase(item);
          setCaseModalOpen(true);
        },
      });
    } else if (newlyBrowserSla.length > 1) {
      const overdueCount = newlyBrowserSla.filter((x) => x.stage === 'overdue').length;
      const dueCount = newlyBrowserSla.length - overdueCount;
      const parts: string[] = [];
      if (overdueCount > 0) parts.push(`เกินกำหนด ${overdueCount} เคส`);
      if (dueCount > 0) parts.push(`ครบกำหนดวันนี้ ${dueCount} เคส`);
      sendBrowserNotification({
        title: `แจ้งเตือน SLA (${newlyBrowserSla.length} เคส)`,
        body: `${parts.join(' · ')} — คลิกเพื่อเปิดรายการแจ้งเตือน`,
        tag: 'sla-batch-alert',
        requireInteraction: true,
        onClick: () => {
          setAlertModalOpen(true);
        },
      });
    }
  }, [currentUser, unacknowledgedAlerts, nowMs]);

  // Repeat alert every 30 seconds for users who have NOT clicked acknowledge yet
  useEffect(() => {
    if (!currentUser || unacknowledgedAlerts.length === 0 || caseModalOpen) {
      return;
    }

    const repeatTimer = setInterval(() => {
      setAlertModalOpen(true);
      setAlertNonce((n) => n + 1);
      if (isWindowInBackground()) {
        sendBrowserNotification({
          title: `แจ้งเตือน SLA (${unacknowledgedAlerts.length} เคสรอกดรับทราบ)`,
          body: 'กรุณาคลิกเพื่อกลับมาตรวจสอบและกดรับทราบเคสใน CRM Desk',
          tag: 'sla-repeat-reminder',
          requireInteraction: true,
          onClick: () => {
            setAlertModalOpen(true);
          },
        });
      }
    }, 30000);

    return () => clearInterval(repeatTimer);
  }, [currentUser, unacknowledgedAlerts.length, caseModalOpen]);

  // Dispatch deduplicated team chat webhooks when cases enter due_today or overdue SLA
  useEffect(() => {
    if (!currentUser || loadingData || cases.length === 0) return;

    const todayStr = toLocalDateInput(nowMs);
    for (const c of cases) {
      const stage = computeAlertStage(c.sla_due_at, c.status, nowMs);
      if (!stage || !c.team_id) continue;
      const eventType = stage === 'overdue' ? 'sla_overdue' : 'sla_due';
      const dateKey = stage === 'overdue' ? todayStr : toLocalDateInput(c.sla_due_at) || todayStr;
      const dedupKey = `${eventType}:${c.id}:${dateKey}`;
      if (seenWebhookSlaKeysRef.current.has(dedupKey)) continue;
      seenWebhookSlaKeysRef.current.add(dedupKey);

      void dispatchTeamWebhook({
        eventType,
        teamIds: [c.team_id],
        dedupKey,
        caseId: c.id,
        caseNo: c.case_no,
        caseUrl: c.case_url ?? '',
        issueSummary: c.issue_summary,
        slaDueAt: toLocalDateInput(c.sla_due_at) || c.sla_due_at,
        actorName: c.assignee_name || c.team_name,
        extraInfo: stage === 'overdue' ? 'เกินกำหนด SLA แล้ว กรุณาเร่งติดตาม' : 'ครบกำหนด SLA วันนี้',
      });
    }
  }, [currentUser, loadingData, cases, nowMs]);

  const totalEscalationAlerts = incomingEscalations.length + rejectedEscalations.length;
  const unreadNoteNotifCount = useMemo(
    () => noteNotifications.filter((n) => !n.is_read).length,
    [noteNotifications]
  );

  // Sync pending alert count in the browser tab title
  useEffect(() => {
    if (!currentUser) {
      updateDocumentAlertTitle(0);
      return;
    }
    updateDocumentAlertTitle(
      unacknowledgedAlerts.length + totalEscalationAlerts + unreadNoteNotifCount
    );
    return () => updateDocumentAlertTitle(0);
  }, [currentUser, unacknowledgedAlerts.length, totalEscalationAlerts, unreadNoteNotifCount]);

  // Trigger Escalation Alert Popup & Browser Notification immediately
  useEffect(() => {
    if (!currentUser) return;

    if (totalEscalationAlerts === 0) {
      setEscalationModalOpen(false);
      return;
    }

    let hasNew = false;
    for (const esc of incomingEscalations) {
      const key = `inc:${esc.id}`;
      if (!seenEscalationKeysRef.current.has(key)) {
        seenEscalationKeysRef.current.add(key);
        hasNew = true;
        const caseDisplay = resolveCaseLinkDisplay(esc.case_no, esc.case_url).label;
        sendBrowserNotification({
          title: `รับส่งต่อเคสใหม่จาก ${esc.from_user_name}`,
          body: `${caseDisplay} · ${esc.issue_summary}`,
          tag: `esc-inc-${esc.id}`,
          requireInteraction: true,
          onClick: () => {
            setEscalationModalOpen(true);
          },
        });
      }
    }
    for (const esc of rejectedEscalations) {
      const key = `rej:${esc.id}`;
      if (!seenEscalationKeysRef.current.has(key)) {
        seenEscalationKeysRef.current.add(key);
        hasNew = true;
        const caseDisplay = resolveCaseLinkDisplay(esc.case_no, esc.case_url).label;
        sendBrowserNotification({
          title: `เคสส่งต่อถูกตีกลับโดย ${esc.to_user_name}`,
          body: `${caseDisplay} · ${esc.reject_reason || esc.issue_summary}`,
          tag: `esc-rej-${esc.id}`,
          requireInteraction: true,
          onClick: () => {
            setEscalationModalOpen(true);
          },
        });
      }
    }

    if (hasNew) {
      setEscalationModalOpen(true);
      setEscalationAlertNonce((n) => n + 1);
    }
  }, [currentUser, incomingEscalations, rejectedEscalations, totalEscalationAlerts]);

  // Repeat Escalation Popup every 30s until Accepted/Rejected or sender acknowledges return
  useEffect(() => {
    if (!currentUser || totalEscalationAlerts === 0 || caseModalOpen) {
      return;
    }

    const repeatTimer = setInterval(() => {
      setEscalationModalOpen(true);
      setEscalationAlertNonce((n) => n + 1);
      if (isWindowInBackground()) {
        sendBrowserNotification({
          title: `รอการตอบรับส่งต่อเคส (${totalEscalationAlerts} รายการ)`,
          body: 'กรุณาคลิกเพื่อเปิดหน้าต่างตอบรับหรือรับทราบเคสส่งต่อ',
          tag: 'esc-repeat-reminder',
          requireInteraction: true,
          onClick: () => {
            setEscalationModalOpen(true);
          },
        });
      }
    }, 30000);

    return () => clearInterval(repeatTimer);
  }, [currentUser, totalEscalationAlerts, caseModalOpen]);

  const handleQuickStatus = async (item: CaseItem, nextStatus: CaseStatus) => {
    if (!currentUser) return;
    await updateCaseDoc(currentUser, item, { status: nextStatus }, cases);
  };

  const handleAcknowledgeOne = async (item: CaseItem, note = '') => {
    if (!currentUser) return;
    await acknowledgeCaseForUser(item, currentUser, note, Date.now());
  };

  const handleAcknowledgeAll = async (items: CaseItem[]) => {
    if (!currentUser) return;
    await acknowledgeCasesBulkForUser(items, currentUser, Date.now());
    setAlertModalOpen(false);
  };

  const handleAcceptEscalation = async (esc: CaseEscalation) => {
    await acceptCaseEscalationDoc(esc);
  };

  const handleRejectEscalation = async (esc: CaseEscalation, reason: string) => {
    await rejectCaseEscalationDoc(esc, reason);
  };

  const handleAcknowledgeRejectedEscalation = async (esc: CaseEscalation) => {
    await acknowledgeRejectedEscalationDoc(esc);
  };

  const handleInspectCaseById = (caseId: string) => {
    const matched = cases.find((c) => c.id === caseId);
    if (matched) {
      setEditingCase(matched);
      setCaseModalOpen(true);
    }
  };

  const handleSelectNoteNotification = async (
    notif: NoteNotification
  ): Promise<'opened' | 'unavailable'> => {
    if (currentUser && !notif.is_read) {
      await markNoteNotificationRead(currentUser.uid, notif.id).catch(() => {});
    }
    const matched = cases.find((c) => c.id === notif.case_id);
    if (matched) {
      setEditingCase(matched);
      setCaseModalOpen(true);
      return 'opened';
    }
    return 'unavailable';
  };

  const handleMarkAllNoteNotificationsRead = async () => {
    if (!currentUser) return;
    await markAllNoteNotificationsRead(currentUser.uid, noteNotifications);
  };

  const handleClearReadNoteNotifications = async () => {
    if (!currentUser) return;
    await clearReadNoteNotifications(currentUser.uid, noteNotifications);
  };

  const handleToggleBrowserNotifications = async () => {
    const current = getBrowserNotificationState();
    setBrowserNotifState(current);

    if (!current.supported) {
      setBrowserNotifNotice('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือนข้ามแท็บ');
      return;
    }
    if (current.permission === 'denied') {
      setBrowserNotifNotice(
        'เบราว์เซอร์บล็อกสิทธิ์แจ้งเตือนอยู่ กรุณาคลิกไอคอนตั้งค่าข้าง URL เพื่อเปิด Notifications สำหรับเว็บนี้'
      );
      return;
    }
    if (current.permission === 'default') {
      const next = await requestBrowserNotificationPermission();
      setBrowserNotifState(next);
      if (next.permission === 'granted' && next.enabled) {
        setBrowserNotifNotice(null);
        sendBrowserNotification({
          title: 'เปิดการแจ้งเตือนข้ามแท็บแล้ว',
          body: 'ระบบจะแจ้งเตือนเมื่อมีการส่งต่อเคส ถูก @Mention หรือเคสใกล้/เกิน SLA',
          tag: 'browser-notif-welcome',
        });
      } else {
        setBrowserNotifNotice(
          'ยังไม่ได้รับอนุญาตให้แสดง Browser Notification (สามารถกดปุ่มอีกครั้งเมื่อพร้อม)'
        );
      }
      return;
    }

    const next = setBrowserNotificationOptIn(!current.enabled);
    setBrowserNotifState(next);
    setBrowserNotifNotice(null);
  };

  if (!currentUser) {
    return (
      <LoginView
        checkingAuth={checkingAuth}
        authError={authError}
        onClearError={() => setAuthError(null)}
      />
    );
  }

  const navItems: { id: NavView; label: string; icon: typeof LayoutDashboard }[] = [
    { id: 'dashboard', label: 'แดชบอร์ดติดตามเคส', icon: LayoutDashboard },
    { id: 'cases', label: 'รายการเคส To-Do', icon: CheckSquare },
  ];
  if (currentUser.role === 'admin') {
    navItems.push({ id: 'admin', label: 'จัดการผู้ใช้และทีม', icon: Shield });
  }

  const pageBreadcrumb =
    activeView === 'dashboard'
      ? 'แดชบอร์ดติดตามเคส'
      : activeView === 'cases'
        ? 'รายการเคส To-Do'
        : 'จัดการระบบ (Admin)';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex w-64 shrink-0 bg-white border-r border-slate-200 flex-col justify-between">
        <div>
          <div className="h-16 px-6 border-b border-slate-200 flex items-center gap-3">
            <BrandLogo size="md" />
            <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
              CRM Desk
            </span>
          </div>

          <nav className="p-4 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeView === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveView(item.id)}
                  className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap cursor-pointer ${
                    active
                      ? 'bg-blue-50 text-blue-800'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-blue-700' : 'text-slate-400'}`} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Account Summary Footer */}
        <div className="p-4 border-t border-slate-200 space-y-3">
          <div className="px-2">
            <div className="text-sm font-semibold text-slate-900 truncate">
              {currentUser.display_name}
            </div>
            <div className="text-xs text-slate-500 mt-0.5 truncate">
              {currentUser.position_name} · {currentUser.team_name}
            </div>
            {currentUser.username && (
              <div className="text-xs font-mono text-slate-400 mt-0.5 truncate">
                @{currentUser.username}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setChangePasswordOpen(true)}
              className="w-full flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700 transition-colors cursor-pointer"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>เปลี่ยนรหัสผ่าน</span>
            </button>

            <button
              type="button"
              onClick={handleLogout}
              className="w-full flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700 transition-colors cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>ออกจากระบบ</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/50"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative w-72 max-w-[85vw] bg-white h-full border-r border-slate-200 flex flex-col justify-between p-4">
            <div>
              <div className="flex items-center justify-between pb-4 border-b border-slate-200">
                <div className="flex items-center gap-2.5">
                  <BrandLogo size="sm" />
                  <span className="text-lg font-bold text-slate-900">CRM Desk</span>
                </div>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  aria-label="ปิดเมนู"
                  className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <nav className="mt-4 space-y-1">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const active = activeView === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setActiveView(item.id);
                        setMobileMenuOpen(false);
                      }}
                      className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium ${
                        active ? 'bg-blue-50 text-blue-800' : 'text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </nav>
            </div>

            <div className="border-t border-slate-200 pt-4 space-y-2">
              <div>
                <div className="text-sm font-semibold text-slate-900">{currentUser.display_name}</div>
                <div className="text-xs text-slate-500">
                  {currentUser.position_name} · {currentUser.team_name}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  setChangePasswordOpen(true);
                }}
                className="w-full flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700"
              >
                <KeyRound className="w-3.5 h-3.5" />
                <span>เปลี่ยนรหัสผ่าน</span>
              </button>
              <button
                type="button"
                onClick={handleLogout}
                className="w-full flex items-center justify-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>ออกจากระบบ</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Header Bar */}
        <header className="h-16 bg-white border-b border-slate-200 px-4 sm:px-8 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="เปิดเมนู"
              className="lg:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm text-slate-500 min-w-0 truncate">
              <span className="font-medium text-slate-900 truncate">{pageBreadcrumb}</span>
              <span aria-hidden="true">/</span>
              <span className="truncate">{currentUser.team_name}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {totalEscalationAlerts > 0 && (
              <button
                type="button"
                onClick={() => setEscalationModalOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 text-xs font-semibold text-indigo-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <ArrowRightLeft className="w-3.5 h-3.5 shrink-0" />
                <span className="tabular-nums">แจ้งเตือนส่งต่อ ({totalEscalationAlerts})</span>
              </button>
            )}

            {unacknowledgedAlerts.length > 0 && (
              <button
                type="button"
                onClick={() => setAlertModalOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span className="tabular-nums">แจ้งเตือน SLA ({unacknowledgedAlerts.length})</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                setEditingCase(null);
                setCaseModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 px-3.5 py-2 text-xs font-medium text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 shrink-0" />
              <span>เพิ่มเคส</span>
            </button>

            <button
              type="button"
              onClick={() => void handleToggleBrowserNotifications()}
              title={
                !browserNotifState.supported
                  ? 'เบราว์เซอร์ไม่รองรับแจ้งเตือนข้ามแท็บ'
                  : browserNotifState.permission === 'denied'
                    ? 'เบราว์เซอร์บล็อกสิทธิ์แจ้งเตือน (คลิกเพื่อดูวิธีเปิด)'
                    : browserNotifState.enabled
                      ? 'แจ้งเตือนข้ามแท็บเปิดอยู่ (คลิกเพื่อพักชั่วคราว)'
                      : 'เปิดแจ้งเตือนข้ามแท็บ (Browser Notification)'
              }
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                browserNotifState.enabled
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                  : browserNotifState.permission === 'denied'
                    ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {browserNotifState.enabled ? (
                <BellRing className="w-3.5 h-3.5 shrink-0" />
              ) : (
                <BellOff className="w-3.5 h-3.5 shrink-0" />
              )}
              <span className="hidden sm:inline">
                {browserNotifState.enabled
                  ? 'แจ้งเตือนข้ามแท็บ: เปิด'
                  : browserNotifState.permission === 'denied'
                    ? 'แจ้งเตือนถูกบล็อก'
                    : 'แจ้งเตือนข้ามแท็บ'}
              </span>
            </button>

            <NoteNotificationBell
              notifications={noteNotifications}
              onSelectNotification={handleSelectNoteNotification}
              onMarkAllRead={handleMarkAllNoteNotificationsRead}
              onClearRead={handleClearReadNoteNotifications}
            />
          </div>
        </header>

        {browserNotifNotice && (
          <div className="bg-amber-50 border-b border-amber-200 px-4 sm:px-8 py-2 flex items-center justify-between gap-3 text-xs text-amber-900">
            <span>{browserNotifNotice}</span>
            <button
              type="button"
              onClick={() => setBrowserNotifNotice(null)}
              aria-label="ปิดข้อความแจ้งเตือน"
              className="p-1 rounded hover:bg-amber-100 text-amber-700 cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Main Viewport */}
        <main className="flex-1 p-4 sm:p-8 max-w-[1440px] w-full mx-auto">
          {activeView === 'dashboard' && (
            <DashboardView
              currentUser={currentUser}
              summary={summary}
              cases={cases}
              nowMs={nowMs}
              loading={loadingData}
              onCreateCase={() => {
                setEditingCase(null);
                setCaseModalOpen(true);
              }}
              onInspectCase={(item) => {
                setEditingCase(item);
                setCaseModalOpen(true);
              }}
              onQuickStatus={handleQuickStatus}
              onOpenAlertModal={() => setAlertModalOpen(true)}
              onFilterByTeam={(tid) => {
                setTeamFilter(tid);
                setActiveView('cases');
              }}
              onGoToCases={() => setActiveView('cases')}
            />
          )}

          {activeView === 'cases' && (
            <CaseListView
              currentUser={currentUser}
              cases={cases}
              teams={teams}
              nowMs={nowMs}
              loading={loadingData}
              statusFilter={statusFilter}
              slaFilter={slaFilter}
              teamFilter={teamFilter}
              searchQuery={searchQuery}
              onStatusFilterChange={setStatusFilter}
              onSlaFilterChange={setSlaFilter}
              onTeamFilterChange={setTeamFilter}
              onSearchChange={setSearchQuery}
              onCreateCase={() => {
                setEditingCase(null);
                setCaseModalOpen(true);
              }}
              onInspectCase={(item) => {
                setEditingCase(item);
                setCaseModalOpen(true);
              }}
              onAcknowledgeOne={(item) => handleAcknowledgeOne(item)}
            />
          )}

          {activeView === 'admin' && currentUser.role === 'admin' && (
            <AdminPanelView
              currentUser={currentUser}
              teams={teams}
              positions={positions}
              staffList={staffList}
              cases={cases}
            />
          )}
        </main>
      </div>

      {/* Create / Edit / Inspect Case Modal */}
      <CaseModal
        open={caseModalOpen}
        editingCase={editingCase}
        currentUser={currentUser}
        nowMs={nowMs}
        teams={teams}
        assignableUsers={assignableUsers}
        allActiveUsers={activeUsers}
        existingCases={cases}
        incomingEscalations={incomingEscalations}
        rejectedEscalations={rejectedEscalations}
        onAcceptEscalation={handleAcceptEscalation}
        onRejectEscalation={handleRejectEscalation}
        onAcknowledgeRejectedEscalation={handleAcknowledgeRejectedEscalation}
        onClose={() => {
          setCaseModalOpen(false);
          setEditingCase(null);
        }}
      />

      {/* Real-time SLA Alert Popup requiring per-user acknowledgment */}
      <SlaAlertModal
        open={alertModalOpen}
        alerts={unacknowledgedAlerts}
        nowMs={nowMs}
        alertNonce={alertNonce}
        onAcknowledgeOne={handleAcknowledgeOne}
        onAcknowledgeAll={handleAcknowledgeAll}
        onInspectCase={(item) => {
          setEditingCase(item);
          setCaseModalOpen(true);
        }}
        onClose={() => setAlertModalOpen(false)}
      />

      {/* Real-time Escalation Incoming & Rejected Return Alert Popup */}
      <EscalationAlertModal
        open={escalationModalOpen}
        incomingEscalations={incomingEscalations}
        rejectedEscalations={rejectedEscalations}
        alertNonce={escalationAlertNonce}
        onAccept={handleAcceptEscalation}
        onReject={handleRejectEscalation}
        onAcknowledgeRejected={handleAcknowledgeRejectedEscalation}
        onInspectCaseById={handleInspectCaseById}
        onClose={() => setEscalationModalOpen(false)}
      />
      {/* Change Own Password Modal */}
      <ChangePasswordModal
        open={changePasswordOpen}
        username={currentUser.username}
        onClose={() => setChangePasswordOpen(false)}
      />
    </div>
  );
}
