import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { getApps, initializeApp } from 'firebase/app';
import {
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  getAuth,
  inMemoryPersistence,
  reauthenticateWithCredential,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { auth, db, handleFirestoreError, OperationType } from './firebase.ts';
import {
  deleteServerAttachment,
  MAX_NOTE_ATTACHMENTS,
  summarizeAttachments,
} from './attachments.ts';
import { getSafeCaseUrl, MAX_CASE_LINK_LENGTH, normalizeCaseUrl } from './caseLink.ts';
import { computeAlertStage, computeLiveSlaState, needsUserAck, toLocalDateInput } from './sla.ts';
import type {
  AckHistoryEntry,
  AlertStage,
  AssigneeStat,
  AttachmentKind,
  CaseEscalation,
  CaseEscalationLog,
  CaseItem,
  CaseStatus,
  DashboardSummary,
  EscalationStatus,
  InternalNote,
  InternalNoteEditLog,
  NoteAttachment,
  Position,
  RoleLevel,
  StaffEntry,
  Team,
  TeamStat,
  UserCaseAck,
  UserPublic,
} from '../types.ts';

const DEFAULT_TEAMS: { id: string; name: string; description: string }[] = [
  { id: 'line_oa', name: 'Line OA', description: 'ทีมดูแลลูกค้าและร้านค้าผ่านช่องทาง Line Official Account' },
  { id: 'call', name: 'Call', description: 'ทีมรับสายโทรศัพท์และประสานงานเร่งด่วน' },
  { id: 'email', name: 'Email', description: 'ทีมตอบรับและตรวจสอบเคสผ่านช่องทางอีเมล' },
  { id: 'social_media', name: 'Social Media', description: 'ทีมดูแลช่องทาง Facebook, Instagram, TikTok และคอมเมนต์' },
];

const DEFAULT_POSITIONS: { id: string; name: string; role_level: RoleLevel; is_system: boolean }[] = [
  { id: 'pos_admin', name: 'Admin', role_level: 'admin', is_system: true },
  { id: 'pos_tl', name: 'TL', role_level: 'tl', is_system: true },
  { id: 'pos_agent', name: 'Agent', role_level: 'agent', is_system: true },
];

function timestampToIso(value: unknown): string {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  return new Date().toISOString();
}

export async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const SYNTHETIC_EMAIL_DOMAIN = 'crmdesk.local';

let activeBootstrapPromise: Promise<void> | null = null;

export function resolveLoginIdentifier(usernameInput: string): { username: string; authEmail: string } {
  const raw = usernameInput.trim().toLowerCase();
  if (!raw) {
    throw new Error('กรุณากรอกชื่อผู้ใช้ (Username)');
  }
  if (raw.includes('@')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) || raw.length > 254) {
      throw new Error('รูปแบบชื่อผู้ใช้ไม่ถูกต้อง');
    }
    return { username: raw.split('@')[0].slice(0, 80), authEmail: raw };
  }
  if (!/^[a-z0-9._-]{3,32}$/.test(raw)) {
    throw new Error('Username ต้องมีความยาว 3-32 ตัวอักษร (ใช้ได้เฉพาะตัวอักษรภาษาอังกฤษ a-z, ตัวเลข 0-9, ., _, -)');
  }
  return { username: raw, authEmail: `${raw}@${SYNTHETIC_EMAIL_DOMAIN}` };
}

export function mapAuthErrorMessage(err: unknown, context: 'login' | 'create', username?: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('auth/operation-not-allowed')) {
    return new Error(
      'auth/operation-not-allowed: ยังไม่ได้เปิดใช้งาน Email/Password ใน Firebase Console (Authentication → Sign-in method → Email/Password → เปิด Enable แล้วกด Save)'
    );
  }
  if (msg.includes('auth/email-already-in-use')) {
    return new Error(
      `ชื่อผู้ใช้ "${username ?? ''}" ถูกใช้งานแล้วในระบบ กรุณาเลือก Username อื่น หรือเข้าสู่ระบบด้วยบัญชีที่มีอยู่`
    );
  }
  if (msg.includes('auth/weak-password')) {
    return new Error('รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร');
  }
  if (msg.includes('auth/invalid-email')) {
    return new Error('รูปแบบ Username ไม่ถูกต้อง (ใช้ได้เฉพาะ a-z, 0-9, ., _, - ความยาว 3-32 ตัวอักษร)');
  }
  if (
    msg.includes('auth/invalid-credential') ||
    msg.includes('auth/wrong-password') ||
    msg.includes('auth/user-not-found')
  ) {
    return new Error('ชื่อผู้ใช้ (Username) หรือรหัสผ่านไม่ถูกต้อง');
  }
  if (msg.includes('auth/too-many-requests')) {
    return new Error('ลองทำรายการผิดพลาดหลายครั้ง กรุณารอสักครู่แล้วลองใหม่อีกครั้ง');
  }
  if (msg.includes('auth/network-request-failed')) {
    return new Error('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ยืนยันตัวตนได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
  }
  if (context === 'login' && err instanceof Error) {
    return err;
  }
  return err instanceof Error ? err : new Error(msg);
}

export function formatActionErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  if (!raw) return fallback;
  if (raw.startsWith('{') && raw.includes('"error"')) {
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      if (parsed.error?.includes('Missing or insufficient permissions')) {
        return 'ไม่มีสิทธิ์ทำรายการนี้ หรือสถานะเคสมีการเปลี่ยนแปลงแล้ว กรุณารีเฟรชและลองใหม่อีกครั้ง';
      }
      if (parsed.error) return parsed.error;
    } catch {
      // fall through
    }
  }
  if (raw.includes('Missing or insufficient permissions')) {
    return 'ไม่มีสิทธิ์ทำรายการนี้ หรือสถานะเคสมีการเปลี่ยนแปลงแล้ว กรุณารีเฟรชและลองใหม่อีกครั้ง';
  }
  return raw;
}

export async function isBootstrapNeeded(): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, 'system_config', 'bootstrap'));
    return !snap.exists();
  } catch {
    return false;
  }
}

export async function signInWithUsernamePassword(usernameInput: string, password: string): Promise<User> {
  const { authEmail, username } = resolveLoginIdentifier(usernameInput);
  if (!password) {
    throw new Error('กรุณากรอกรหัสผ่าน');
  }
  try {
    const result = await signInWithEmailAndPassword(auth, authEmail, password);
    return result.user;
  } catch (err) {
    throw mapAuthErrorMessage(err, 'login', username);
  }
}

export async function signOutFirebase(): Promise<void> {
  await signOut(auth);
}

export async function changeOwnPassword(currentPassword: string, newPassword: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.email) {
    throw new Error('ไม่พบข้อมูลผู้ใช้งานที่กำลังเข้าสู่ระบบ');
  }
  if (!currentPassword) {
    throw new Error('กรุณากรอกรหัสผ่านปัจจุบัน');
  }
  if (newPassword.length < 6) {
    throw new Error('รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร');
  }
  if (currentPassword === newPassword) {
    throw new Error('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน');
  }
  try {
    const credential = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, credential);
    await updatePassword(user, newPassword);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('auth/wrong-password') ||
      msg.includes('auth/invalid-credential')
    ) {
      throw new Error('รหัสผ่านปัจจุบันไม่ถูกต้อง');
    }
    if (msg.includes('auth/weak-password')) {
      throw new Error('รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร');
    }
    if (msg.includes('auth/too-many-requests')) {
      throw new Error('ลองทำรายการผิดพลาดหลายครั้ง กรุณารอสักครู่แล้วลองใหม่');
    }
    throw err instanceof Error ? err : new Error(msg);
  }
}

async function seedDefaultOrgMetadata(): Promise<void> {
  const teamsSnap = await getDocs(
    query(collection(db, 'teams'), where('is_archived', '==', false))
  ).catch((err) => handleFirestoreError(err, OperationType.LIST, 'teams'));

  const existingTeamIds = new Set(teamsSnap.docs.map((d) => d.id));
  const batch = writeBatch(db);
  let hasWrites = false;

  for (const t of DEFAULT_TEAMS) {
    if (!existingTeamIds.has(t.id)) {
      batch.set(doc(db, 'teams', t.id), {
        id: t.id,
        name: t.name,
        description: t.description,
        is_archived: false,
        created_at: serverTimestamp(),
        updated_at: serverTimestamp(),
      });
      hasWrites = true;
    }
  }

  const posSnap = await getDocs(
    query(collection(db, 'positions'), where('is_archived', '==', false))
  ).catch((err) => handleFirestoreError(err, OperationType.LIST, 'positions'));
  const existingPosIds = new Set(posSnap.docs.map((d) => d.id));

  for (const p of DEFAULT_POSITIONS) {
    if (!existingPosIds.has(p.id)) {
      batch.set(doc(db, 'positions', p.id), {
        id: p.id,
        name: p.name,
        role_level: p.role_level,
        is_system: p.is_system,
        is_archived: false,
        created_at: serverTimestamp(),
        updated_at: serverTimestamp(),
      });
      hasWrites = true;
    }
  }

  if (hasWrites) {
    await batch.commit().catch((err) => handleFirestoreError(err, OperationType.WRITE, 'teams/positions'));
  }
}

export async function bootstrapFirstAdmin(input: {
  username: string;
  password: string;
  display_name: string;
}): Promise<void> {
  if (input.username.includes('@')) {
    throw new Error('กรุณาระบุเฉพาะ Username (ไม่ต้องใส่ @ หรืออีเมล) เช่น admin');
  }
  const { username, authEmail } = resolveLoginIdentifier(input.username);
  const password = input.password ?? '';
  if (password.length < 6) {
    throw new Error('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
  }
  const displayName = input.display_name.trim().slice(0, 120);
  if (!displayName) {
    throw new Error('กรุณาระบุชื่อ-นามสกุลผู้ดูแลระบบ');
  }

  const bootstrapRef = doc(db, 'system_config', 'bootstrap');
  const existingBootstrap = await getDoc(bootstrapRef).catch(() => null);
  if (existingBootstrap?.exists()) {
    throw new Error('ระบบได้ตั้งค่าบัญชี Admin เริ่มต้นไปแล้ว กรุณาเข้าสู่ระบบด้วย Username และ Password');
  }

  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  activeBootstrapPromise = gate;

  let createdUser: User | null = null;
  let bootstrapLocked = false;
  try {
    try {
      const cred = await createUserWithEmailAndPassword(auth, authEmail, password);
      createdUser = cred.user;
    } catch (err) {
      throw mapAuthErrorMessage(err, 'create', username);
    }

    const uid = createdUser.uid;
    const staffId = await sha256Hex(authEmail);

    // Step 1: Atomically lock bootstrap and grant first admin role
    const lockBatch = writeBatch(db);
    lockBatch.set(bootstrapRef, {
      id: 'bootstrap',
      initialized: true,
      initialized_at: serverTimestamp(),
    });
    lockBatch.set(doc(db, 'admins', uid), {
      uid,
      granted_by: uid,
      granted_at: serverTimestamp(),
    });
    await lockBatch.commit();
    bootstrapLocked = true;

    // Step 2: Ensure default teams & positions exist
    await seedDefaultOrgMetadata();

    // Step 3: Create staff_directory & users operational profile
    const profileBatch = writeBatch(db);
    profileBatch.set(doc(db, 'staff_directory', staffId), {
      id: staffId,
      email: authEmail,
      username,
      display_name: displayName,
      position_id: 'pos_admin',
      position_name: 'Admin',
      role: 'admin',
      team_id: 'line_oa',
      team_name: 'Line OA',
      is_active: true,
      linked_uid: uid,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    profileBatch.set(doc(db, 'users', uid), {
      uid,
      staff_id: staffId,
      username,
      display_name: displayName,
      position_id: 'pos_admin',
      position_name: 'Admin',
      role: 'admin',
      team_id: 'line_oa',
      team_name: 'Line OA',
      is_active: true,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    await profileBatch.commit();
  } catch (err) {
    if (createdUser && !bootstrapLocked) {
      await createdUser.delete().catch(() => {});
      await signOut(auth).catch(() => {});
    }
    throw err;
  } finally {
    resolveGate();
    activeBootstrapPromise = null;
  }
}

export async function resolveAuthenticatedUser(firebaseUser: User): Promise<UserPublic> {
  if (activeBootstrapPromise) {
    await activeBootstrapPromise.catch(() => {});
  }

  const uid = firebaseUser.uid;
  const emailLower = (firebaseUser.email ?? '').trim().toLowerCase();

  const existingUserRef = doc(db, 'users', uid);
  const existingUserSnap = await getDoc(existingUserRef).catch((err) =>
    handleFirestoreError(err, OperationType.GET, `users/${uid}`)
  );

  if (existingUserSnap.exists()) {
    const uData = existingUserSnap.data() as Record<string, unknown>;
    if (uData.is_active !== true) {
      throw new Error('บัญชีนี้ถูกปิดการใช้งาน กรุณาติดต่อ Admin');
    }
    const rawUsername = uData.username
      ? String(uData.username)
      : emailLower
        ? emailLower.split('@')[0]
        : '';
    return {
      id: uid,
      uid,
      staff_id: String(uData.staff_id ?? ''),
      username: rawUsername || undefined,
      display_name: String(uData.display_name ?? ''),
      role: (uData.role as RoleLevel) ?? 'agent',
      position_id: String(uData.position_id ?? ''),
      position_name: String(uData.position_name ?? ''),
      team_id: String(uData.team_id ?? ''),
      team_name: String(uData.team_name ?? ''),
      is_active: Boolean(uData.is_active),
      created_at: timestampToIso(uData.created_at),
    };
  }

  // Self-heal if admin grant exists (e.g., interrupted bootstrap)
  const adminSnap = await getDoc(doc(db, 'admins', uid)).catch(() => null);
  if (adminSnap?.exists() && emailLower) {
    await seedDefaultOrgMetadata();
    const staffId = await sha256Hex(emailLower);
    const username = emailLower.split('@')[0].slice(0, 80);
    const displayName = (firebaseUser.displayName ?? username).trim().slice(0, 120) || 'Admin';

    const repairBatch = writeBatch(db);
    repairBatch.set(doc(db, 'staff_directory', staffId), {
      id: staffId,
      email: emailLower,
      username,
      display_name: displayName,
      position_id: 'pos_admin',
      position_name: 'Admin',
      role: 'admin',
      team_id: 'line_oa',
      team_name: 'Line OA',
      is_active: true,
      linked_uid: uid,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    repairBatch.set(existingUserRef, {
      uid,
      staff_id: staffId,
      username,
      display_name: displayName,
      position_id: 'pos_admin',
      position_name: 'Admin',
      role: 'admin',
      team_id: 'line_oa',
      team_name: 'Line OA',
      is_active: true,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    await repairBatch.commit().catch((err) =>
      handleFirestoreError(err, OperationType.CREATE, `users/${uid}`)
    );

    return {
      id: uid,
      uid,
      staff_id: staffId,
      username,
      display_name: displayName,
      role: 'admin',
      position_id: 'pos_admin',
      position_name: 'Admin',
      team_id: 'line_oa',
      team_name: 'Line OA',
      is_active: true,
      created_at: new Date().toISOString(),
    };
  }

  throw new Error('ไม่พบบัญชีผู้ใช้งานนี้ในระบบ กรุณาติดต่อ Admin เพื่อสร้างบัญชีและรหัสผ่านให้คุณ');
}

// ==================== REAL-TIME LISTENERS ====================

export function subscribeTeams(
  onData: (teams: Team[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = 'teams';
  const q = query(collection(db, path), where('is_archived', '==', false));
  return onSnapshot(
    q,
    (snapshot) => {
      const list: Team[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          name: String(data.name ?? ''),
          description: String(data.description ?? ''),
          is_archived: Boolean(data.is_archived),
          created_at: timestampToIso(data.created_at),
          updated_at: timestampToIso(data.updated_at),
        };
      });
      list.sort((a, b) => a.name.localeCompare(b.name, 'th'));
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export function subscribePositions(
  onData: (positions: Position[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = 'positions';
  const q = query(collection(db, path), where('is_archived', '==', false));
  return onSnapshot(
    q,
    (snapshot) => {
      const rank: Record<RoleLevel, number> = { admin: 1, tl: 2, agent: 3 };
      const list: Position[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          name: String(data.name ?? ''),
          role_level: (data.role_level as RoleLevel) ?? 'agent',
          is_system: Boolean(data.is_system),
          is_archived: Boolean(data.is_archived),
          created_at: timestampToIso(data.created_at),
          updated_at: timestampToIso(data.updated_at),
        };
      });
      list.sort((a, b) => rank[a.role_level] - rank[b.role_level] || a.name.localeCompare(b.name, 'th'));
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export function subscribeActiveUsers(
  onData: (users: UserPublic[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = 'users';
  const q = query(collection(db, path), where('is_active', '==', true));
  return onSnapshot(
    q,
    (snapshot) => {
      const list: UserPublic[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          uid: String(data.uid ?? d.id),
          staff_id: String(data.staff_id ?? ''),
          username: data.username ? String(data.username) : undefined,
          display_name: String(data.display_name ?? ''),
          role: (data.role as RoleLevel) ?? 'agent',
          position_id: String(data.position_id ?? ''),
          position_name: String(data.position_name ?? ''),
          team_id: String(data.team_id ?? ''),
          team_name: String(data.team_name ?? ''),
          is_active: Boolean(data.is_active),
          created_at: timestampToIso(data.created_at),
        };
      });
      list.sort((a, b) => a.display_name.localeCompare(b.display_name, 'th'));
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export function subscribeStaffDirectory(
  onData: (staff: StaffEntry[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = 'staff_directory';
  return onSnapshot(
    collection(db, path),
    (snapshot) => {
      const rank: Record<RoleLevel, number> = { admin: 1, tl: 2, agent: 3 };
      const list: StaffEntry[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          email: String(data.email ?? ''),
          username: data.username ? String(data.username) : undefined,
          display_name: String(data.display_name ?? ''),
          position_id: String(data.position_id ?? ''),
          position_name: String(data.position_name ?? ''),
          role: (data.role as RoleLevel) ?? 'agent',
          team_id: String(data.team_id ?? ''),
          team_name: String(data.team_name ?? ''),
          is_active: Boolean(data.is_active),
          linked_uid: String(data.linked_uid ?? ''),
          created_at: timestampToIso(data.created_at),
          updated_at: timestampToIso(data.updated_at),
        };
      });
      list.sort((a, b) => rank[a.role] - rank[b.role] || a.display_name.localeCompare(b.display_name, 'th'));
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export function subscribeMyCaseAcks(
  uid: string,
  onData: (acks: UserCaseAck[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = `users/${uid}/case_acks`;
  const q = query(collection(db, 'users', uid, 'case_acks'), where('user_id', '==', uid));
  return onSnapshot(
    q,
    (snapshot) => {
      const list: UserCaseAck[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          case_id: String(data.case_id ?? ''),
          user_id: String(data.user_id ?? uid),
          ack_stage: (data.ack_stage as AlertStage) ?? 'due_today',
          sla_due_at: String(data.sla_due_at ?? ''),
          ack_at: timestampToIso(data.ack_at),
        };
      });
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export interface RawCaseDoc {
  id: string;
  case_no: string;
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
  last_ack_at: string | null;
  last_ack_by_name: string | null;
  last_ack_level: string | null;
  resolved_at: string | null;
  pending_escalation_id?: string;
  created_at: string;
  updated_at: string;
}

export function subscribeRawCases(
  currentUser: UserPublic,
  onData: (cases: RawCaseDoc[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = 'cases';
  const ref =
    currentUser.role === 'agent'
      ? query(collection(db, path), where('team_id', '==', currentUser.team_id))
      : collection(db, path);

  return onSnapshot(
    ref,
    (snapshot) => {
      const list: RawCaseDoc[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          case_no: String(data.case_no ?? ''),
          shop_id: String(data.shop_id ?? ''),
          issue_summary: String(data.issue_summary ?? ''),
          details: String(data.details ?? ''),
          status: (data.status as CaseStatus) ?? 'todo',
          team_id: String(data.team_id ?? ''),
          team_name: String(data.team_name ?? ''),
          assignee_id: String(data.assignee_id ?? ''),
          assignee_name: String(data.assignee_name ?? ''),
          created_by: String(data.created_by ?? ''),
          sla_due_at: String(data.sla_due_at ?? ''),
          last_ack_at: data.last_ack_at ? String(data.last_ack_at) : null,
          last_ack_by_name: data.last_ack_by_name ? String(data.last_ack_by_name) : null,
          last_ack_level: data.last_ack_level ? String(data.last_ack_level) : null,
          resolved_at: data.resolved_at ? String(data.resolved_at) : null,
          pending_escalation_id: data.pending_escalation_id ? String(data.pending_escalation_id) : '',
          created_at: timestampToIso(data.created_at),
          updated_at: timestampToIso(data.updated_at),
        };
      });
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

// ==================== COMPUTED ENRICHMENT & SUMMARY ====================

export function enrichCasesForUser(
  rawCases: RawCaseDoc[],
  myAcks: UserCaseAck[],
  nowMs: number
): CaseItem[] {
  const ackMap = new Map<string, AlertStage[]>();
  for (const ack of myAcks) {
    const key = `${ack.case_id}:${toLocalDateInput(ack.sla_due_at)}`;
    const list = ackMap.get(key) ?? [];
    list.push(ack.ack_stage);
    ackMap.set(key, list);
  }

  const enriched = rawCases.map((row): CaseItem => {
    const slaState = computeLiveSlaState(row.sla_due_at, row.status, nowMs);
    const alertStage = computeAlertStage(row.sla_due_at, row.status, nowMs);
    const myAckStages = ackMap.get(`${row.id}:${toLocalDateInput(row.sla_due_at)}`) ?? [];

    let needsAck = false;
    if (alertStage === 'due_today') {
      needsAck =
        !myAckStages.includes('due_today') &&
        !myAckStages.includes('overdue') &&
        !myAckStages.includes('due_reached');
    } else if (alertStage === 'overdue') {
      needsAck = !myAckStages.includes('overdue') && !myAckStages.includes('due_reached');
    }

    return {
      ...row,
      sla_state: slaState,
      alert_stage_required: alertStage,
      my_ack_stages: myAckStages,
      needs_ack: needsAck,
      ack_level_required: alertStage,
    };
  });

  enriched.sort((a, b) => {
    if (a.status === 'done' && b.status !== 'done') return 1;
    if (a.status !== 'done' && b.status === 'done') return -1;
    return toLocalDateInput(a.sla_due_at).localeCompare(toLocalDateInput(b.sla_due_at));
  });

  return enriched;
}

export function buildDashboardSummary(
  currentUser: UserPublic,
  cases: CaseItem[],
  teams: Team[],
  nowMs: number
): DashboardSummary {
  const isAgent = currentUser.role === 'agent';
  const teamMap = new Map<string, TeamStat>();
  const scopedTeams = isAgent ? teams.filter((t) => t.id === currentUser.team_id) : teams;

  for (const t of scopedTeams) {
    teamMap.set(t.id, {
      team_id: t.id,
      team_name: t.name,
      total_open: 0,
      todo_count: 0,
      in_progress_count: 0,
      due_today_count: 0,
      overdue_count: 0,
      done_count: 0,
    });
  }

  const assigneeMap = new Map<string, AssigneeStat>();
  let openCases = 0;
  let todoCases = 0;
  let inProgressCases = 0;
  let dueTodayCases = 0;
  let overdueCases = 0;
  let doneCases = 0;
  let unacknowledgedAlerts = 0;

  for (const c of cases) {
    const ts = teamMap.get(c.team_id);
    if (!assigneeMap.has(c.assignee_id)) {
      assigneeMap.set(c.assignee_id, {
        user_id: c.assignee_id,
        display_name: c.assignee_name,
        team_name: c.team_name,
        total_open: 0,
        due_today_count: 0,
        overdue_count: 0,
        done_count: 0,
      });
    }
    const asg = assigneeMap.get(c.assignee_id)!;

    if (c.status === 'done') {
      doneCases++;
      if (ts) ts.done_count++;
      asg.done_count++;
    } else {
      openCases++;
      if (ts) ts.total_open++;
      asg.total_open++;
      if (c.status === 'todo') {
        todoCases++;
        if (ts) ts.todo_count++;
      } else {
        inProgressCases++;
        if (ts) ts.in_progress_count++;
      }

      const liveSla = computeLiveSlaState(c.sla_due_at, c.status, nowMs);
      if (liveSla === 'due_today') {
        dueTodayCases++;
        if (ts) ts.due_today_count++;
        asg.due_today_count++;
      } else if (liveSla === 'overdue') {
        overdueCases++;
        if (ts) ts.overdue_count++;
        asg.overdue_count++;
      }
      if (needsUserAck(c, nowMs)) {
        unacknowledgedAlerts++;
      }
    }
  }

  return {
    scope: isAgent ? 'team' : 'global',
    scope_team_name: isAgent ? currentUser.team_name : null,
    totals: {
      open_cases: openCases,
      todo_cases: todoCases,
      in_progress_cases: inProgressCases,
      due_today_cases: dueTodayCases,
      overdue_cases: overdueCases,
      done_cases: doneCases,
      unacknowledged_alerts: unacknowledgedAlerts,
    },
    team_stats: Array.from(teamMap.values()),
    assignee_stats: Array.from(assigneeMap.values()).sort((a, b) => b.total_open - a.total_open),
    server_time: new Date(nowMs).toISOString(),
  };
}

// ==================== CASE MUTATIONS ====================

export async function createCaseDoc(
  currentUser: UserPublic,
  input: {
    case_no: string;
    shop_id?: string;
    issue_summary: string;
    details: string;
    status: CaseStatus;
    sla_due_at: string;
  },
  existingCases: CaseItem[]
): Promise<void> {
  const rawCaseNo = input.case_no.trim().slice(0, MAX_CASE_LINK_LENGTH);
  const shopId = (input.shop_id ?? '').trim().slice(0, 64);
  const issueSummary = input.issue_summary.trim().slice(0, 300);
  const details = input.details.trim().slice(0, 4000);

  if (!rawCaseNo || !issueSummary || !input.sla_due_at) {
    throw new Error('กรุณากรอกข้อมูลลิงก์เคส, รายละเอียดปัญหา และวันครบกำหนด SLA ให้ครบถ้วน');
  }

  const caseNo = normalizeCaseUrl(rawCaseNo);
  if (!caseNo) {
    throw new Error('กรุณาระบุลิงก์เคส (URL) ที่ถูกต้อง โดยขึ้นต้นด้วย https:// หรือ http:// (ไม่เกิน 1,000 ตัวอักษร)');
  }

  if (existingCases.some((c) => c.case_no.toLowerCase() === caseNo.toLowerCase())) {
    throw new Error('ลิงก์เคสนี้มีอยู่ในระบบแล้ว');
  }

  const newRef = doc(collection(db, 'cases'));
  const resolvedAt = input.status === 'done' ? new Date().toISOString() : '';

  await setDoc(newRef, {
    id: newRef.id,
    case_no: caseNo,
    shop_id: shopId,
    issue_summary: issueSummary,
    details,
    status: input.status,
    team_id: currentUser.team_id,
    team_name: currentUser.team_name,
    assignee_id: currentUser.uid,
    assignee_name: currentUser.display_name.slice(0, 120),
    created_by: currentUser.uid,
    sla_due_at: input.sla_due_at.slice(0, 64),
    last_ack_at: '',
    last_ack_by: '',
    last_ack_by_name: '',
    last_ack_level: '',
    resolved_at: resolvedAt,
    pending_escalation_id: '',
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  }).catch((err) => handleFirestoreError(err, OperationType.CREATE, `cases/${newRef.id}`));
}

export async function updateCaseDoc(
  currentUser: UserPublic,
  editingCase: CaseItem,
  input: {
    case_no?: string;
    shop_id?: string;
    issue_summary?: string;
    details?: string;
    status?: CaseStatus;
    sla_due_at?: string;
    team_id?: string;
    team_name?: string;
    assignee_id?: string;
    assignee_name?: string;
  },
  existingCases: CaseItem[]
): Promise<void> {
  const isAdmin = currentUser.role === 'admin';
  const nextStatus = input.status ?? editingCase.status;
  const resolvedAt =
    nextStatus === 'done' ? (editingCase.resolved_at || new Date().toISOString()) : '';

  const payload: Record<string, unknown> = {
    status: nextStatus,
    sla_due_at: (input.sla_due_at ?? editingCase.sla_due_at).slice(0, 64),
    resolved_at: resolvedAt,
    updated_at: serverTimestamp(),
  };

  if (isAdmin) {
    const rawCaseNo = (input.case_no ?? editingCase.case_no).trim().slice(0, MAX_CASE_LINK_LENGTH);
    if (!rawCaseNo) {
      throw new Error('กรุณาระบุลิงก์เคส (URL)');
    }
    const requiresUrlCheck =
      rawCaseNo !== editingCase.case_no || getSafeCaseUrl(editingCase.case_no) !== null;
    const caseNo = requiresUrlCheck ? normalizeCaseUrl(rawCaseNo) : rawCaseNo;
    if (!caseNo) {
      throw new Error('กรุณาระบุลิงก์เคส (URL) ที่ถูกต้อง โดยขึ้นต้นด้วย https:// หรือ http:// (ไม่เกิน 1,000 ตัวอักษร)');
    }
    if (
      caseNo.toLowerCase() !== editingCase.case_no.toLowerCase() &&
      existingCases.some((c) => c.id !== editingCase.id && c.case_no.toLowerCase() === caseNo.toLowerCase())
    ) {
      throw new Error('ลิงก์เคสนี้มีอยู่ในระบบแล้ว');
    }
    payload.case_no = caseNo;
    payload.shop_id = (input.shop_id ?? editingCase.shop_id).trim().slice(0, 64);
    payload.issue_summary = (input.issue_summary ?? editingCase.issue_summary).trim().slice(0, 300);
    payload.details = (input.details ?? editingCase.details).trim().slice(0, 4000);
  }

  if (isAdmin || currentUser.role === 'tl') {
    if (input.team_id && input.team_name) {
      payload.team_id = input.team_id;
      payload.team_name = input.team_name.slice(0, 80);
    }
    if (input.assignee_id && input.assignee_name) {
      payload.assignee_id = input.assignee_id;
      payload.assignee_name = input.assignee_name.slice(0, 120);
    }
  }

  await updateDoc(doc(db, 'cases', editingCase.id), payload).catch((err) =>
    handleFirestoreError(err, OperationType.UPDATE, `cases/${editingCase.id}`)
  );
}

export async function deleteCaseDoc(caseId: string): Promise<void> {
  const notesSnap = await getDocs(
    query(collection(db, 'cases', caseId, 'internal_notes'), where('case_id', '==', caseId))
  ).catch((err) => handleFirestoreError(err, OperationType.LIST, `cases/${caseId}/internal_notes`));

  const refsToDelete = [doc(db, 'cases', caseId)];
  const attachmentIdsToDelete: string[] = [];

  for (const noteDoc of notesSnap.docs) {
    const noteData = noteDoc.data() as Record<string, unknown>;
    if (Array.isArray(noteData.attachments)) {
      for (const att of noteData.attachments) {
        if (att && typeof att === 'object' && typeof (att as { id?: unknown }).id === 'string') {
          attachmentIdsToDelete.push((att as { id: string }).id);
        }
      }
    }
    const logsSnap = await getDocs(
      query(
        collection(db, 'cases', caseId, 'internal_notes', noteDoc.id, 'edit_logs'),
        where('case_id', '==', caseId),
        where('note_id', '==', noteDoc.id)
      )
    ).catch((err) =>
      handleFirestoreError(err, OperationType.LIST, `cases/${caseId}/internal_notes/${noteDoc.id}/edit_logs`)
    );
    for (const logDoc of logsSnap.docs) {
      refsToDelete.push(logDoc.ref);
    }
    refsToDelete.push(noteDoc.ref);
  }

  const acksSnap = await getDocs(
    query(collection(db, 'cases', caseId, 'acknowledgments'), where('case_id', '==', caseId))
  ).catch((err) => handleFirestoreError(err, OperationType.LIST, `cases/${caseId}/acknowledgments`));
  for (const ackDoc of acksSnap.docs) {
    refsToDelete.push(ackDoc.ref);
  }

  const escLogsSnap = await getDocs(
    query(collection(db, 'cases', caseId, 'escalation_logs'), where('case_id', '==', caseId))
  ).catch((err) => handleFirestoreError(err, OperationType.LIST, `cases/${caseId}/escalation_logs`));
  for (const logDoc of escLogsSnap.docs) {
    refsToDelete.push(logDoc.ref);
  }

  const escSnap = await getDocs(
    query(collection(db, 'case_escalations'), where('case_id', '==', caseId))
  ).catch((err) => handleFirestoreError(err, OperationType.LIST, 'case_escalations'));
  for (const escDoc of escSnap.docs) {
    refsToDelete.push(escDoc.ref);
  }

  for (let i = 0; i < refsToDelete.length; i += 400) {
    const batch = writeBatch(db);
    for (const ref of refsToDelete.slice(i, i + 400)) {
      batch.delete(ref);
    }
    await batch
      .commit()
      .catch((err) => handleFirestoreError(err, OperationType.DELETE, `cases/${caseId}`));
  }

  if (attachmentIdsToDelete.length > 0) {
    await Promise.all(
      attachmentIdsToDelete.map((attId) => deleteServerAttachment(caseId, attId))
    );
  }
}

export async function acknowledgeCaseForUser(
  caseItem: CaseItem,
  currentUser: UserPublic,
  note: string,
  nowMs: number
): Promise<void> {
  const ackStage = computeAlertStage(caseItem.sla_due_at, caseItem.status, nowMs);
  if (!ackStage) return;

  const ackKey = `${caseItem.id}_${ackStage}`;
  const ackHistoryRef = doc(collection(db, 'cases', caseItem.id, 'acknowledgments'));
  const ackAtIso = new Date(nowMs).toISOString();

  const batch = writeBatch(db);
  batch.set(doc(db, 'users', currentUser.uid, 'case_acks', ackKey), {
    id: ackKey,
    case_id: caseItem.id,
    user_id: currentUser.uid,
    ack_stage: ackStage,
    sla_due_at: caseItem.sla_due_at.slice(0, 64),
    ack_at: serverTimestamp(),
  });

  batch.set(ackHistoryRef, {
    id: ackHistoryRef.id,
    case_id: caseItem.id,
    user_id: currentUser.uid,
    user_name: currentUser.display_name.slice(0, 120),
    ack_level: ackStage,
    note: note.trim().slice(0, 500),
    ack_at: serverTimestamp(),
  });

  batch.update(doc(db, 'cases', caseItem.id), {
    last_ack_at: ackAtIso,
    last_ack_by: currentUser.uid,
    last_ack_by_name: currentUser.display_name.slice(0, 120),
    last_ack_level: ackStage,
    updated_at: serverTimestamp(),
  });

  await batch
    .commit()
    .catch((err) => handleFirestoreError(err, OperationType.WRITE, `cases/${caseItem.id}/acknowledge`));
}

export async function acknowledgeCasesBulkForUser(
  targets: CaseItem[],
  currentUser: UserPublic,
  nowMs: number
): Promise<void> {
  const actionable = targets.filter((c) => needsUserAck(c, nowMs));
  if (actionable.length === 0) return;

  const ackAtIso = new Date(nowMs).toISOString();
  const batch = writeBatch(db);

  for (const item of actionable.slice(0, 150)) {
    const ackStage = computeAlertStage(item.sla_due_at, item.status, nowMs);
    if (!ackStage) continue;

    const ackKey = `${item.id}_${ackStage}`;
    const ackHistoryRef = doc(collection(db, 'cases', item.id, 'acknowledgments'));

    batch.set(doc(db, 'users', currentUser.uid, 'case_acks', ackKey), {
      id: ackKey,
      case_id: item.id,
      user_id: currentUser.uid,
      ack_stage: ackStage,
      sla_due_at: item.sla_due_at.slice(0, 64),
      ack_at: serverTimestamp(),
    });

    batch.set(ackHistoryRef, {
      id: ackHistoryRef.id,
      case_id: item.id,
      user_id: currentUser.uid,
      user_name: currentUser.display_name.slice(0, 120),
      ack_level: ackStage,
      note: '',
      ack_at: serverTimestamp(),
    });

    batch.update(doc(db, 'cases', item.id), {
      last_ack_at: ackAtIso,
      last_ack_by: currentUser.uid,
      last_ack_by_name: currentUser.display_name.slice(0, 120),
      last_ack_level: ackStage,
      updated_at: serverTimestamp(),
    });
  }

  await batch
    .commit()
    .catch((err) => handleFirestoreError(err, OperationType.WRITE, 'cases/acknowledge-bulk'));
}

export async function fetchCaseAckHistory(caseId: string): Promise<AckHistoryEntry[]> {
  const path = `cases/${caseId}/acknowledgments`;
  const q = query(collection(db, 'cases', caseId, 'acknowledgments'), where('case_id', '==', caseId));
  const snap = await getDocs(q).catch((err) => handleFirestoreError(err, OperationType.LIST, path));
  const entries: AckHistoryEntry[] = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      case_id: String(data.case_id ?? caseId),
      user_id: String(data.user_id ?? ''),
      user_name: String(data.user_name ?? ''),
      ack_level: String(data.ack_level ?? ''),
      note: String(data.note ?? ''),
      ack_at: timestampToIso(data.ack_at),
    };
  });
  entries.sort((a, b) => new Date(b.ack_at).getTime() - new Date(a.ack_at).getTime());
  return entries;
}

// ==================== INTERNAL NOTES & EDIT LOGS ====================

function sanitizeAttachments(raw: unknown): NoteAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: NoteAttachment[] = [];
  for (const item of raw.slice(0, MAX_NOTE_ATTACHMENTS)) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const id = String(obj.id ?? '').trim();
    const name = String(obj.name ?? '').trim().slice(0, 255);
    const mimeType = String(obj.mime_type ?? 'application/octet-stream').trim().slice(0, 128);
    const sizeBytes = Math.max(0, Math.round(Number(obj.size_bytes ?? 0)));
    const rawKind = String(obj.kind ?? 'file');
    const kind: AttachmentKind =
      rawKind === 'image' || rawKind === 'video' || rawKind === 'file' ? rawKind : 'file';
    const url = String(obj.url ?? '').trim().slice(0, 1024);
    if (!id || !name || !url) continue;
    out.push({ id, name, mime_type: mimeType, size_bytes: sizeBytes, kind, url });
  }
  return out;
}

export function subscribeCaseInternalNotes(
  caseId: string,
  onData: (notes: InternalNote[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = `cases/${caseId}/internal_notes`;
  const q = query(collection(db, 'cases', caseId, 'internal_notes'), where('case_id', '==', caseId));
  return onSnapshot(
    q,
    (snapshot) => {
      const list: InternalNote[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          case_id: String(data.case_id ?? caseId),
          author_id: String(data.author_id ?? ''),
          author_name: String(data.author_name ?? ''),
          author_role: (data.author_role as RoleLevel) ?? 'agent',
          content: String(data.content ?? ''),
          sla_changed: Boolean(data.sla_changed),
          previous_sla_due_at: String(data.previous_sla_due_at ?? ''),
          new_sla_due_at: String(data.new_sla_due_at ?? ''),
          attachments: sanitizeAttachments(data.attachments),
          is_edited: Boolean(data.is_edited),
          last_edited_by: String(data.last_edited_by ?? ''),
          last_edited_by_name: String(data.last_edited_by_name ?? ''),
          last_edit_log_id: String(data.last_edit_log_id ?? ''),
          created_at: timestampToIso(data.created_at),
          updated_at: timestampToIso(data.updated_at),
        };
      });
      list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export async function fetchInternalNoteEditLogs(
  caseId: string,
  noteId: string
): Promise<InternalNoteEditLog[]> {
  const path = `cases/${caseId}/internal_notes/${noteId}/edit_logs`;
  const q = query(
    collection(db, 'cases', caseId, 'internal_notes', noteId, 'edit_logs'),
    where('case_id', '==', caseId),
    where('note_id', '==', noteId)
  );
  const snap = await getDocs(q).catch((err) => handleFirestoreError(err, OperationType.LIST, path));
  const logs: InternalNoteEditLog[] = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      note_id: String(data.note_id ?? noteId),
      case_id: String(data.case_id ?? caseId),
      editor_id: String(data.editor_id ?? ''),
      editor_name: String(data.editor_name ?? ''),
      editor_role: (data.editor_role as RoleLevel) ?? 'agent',
      old_content: String(data.old_content ?? ''),
      new_content: String(data.new_content ?? ''),
      old_sla_due_at: String(data.old_sla_due_at ?? ''),
      new_sla_due_at: String(data.new_sla_due_at ?? ''),
      old_attachments_summary: data.old_attachments_summary
        ? String(data.old_attachments_summary)
        : undefined,
      new_attachments_summary: data.new_attachments_summary
        ? String(data.new_attachments_summary)
        : undefined,
      edited_at: timestampToIso(data.edited_at),
    };
  });
  logs.sort((a, b) => new Date(b.edited_at).getTime() - new Date(a.edited_at).getTime());
  return logs;
}

export async function createInternalNoteDoc(
  currentUser: UserPublic,
  caseItem: CaseItem,
  input: {
    content: string;
    adjustSla: boolean;
    newSlaDueAt?: string;
    attachments?: NoteAttachment[];
  }
): Promise<void> {
  const content = input.content.trim().slice(0, 2000);
  const attachments = sanitizeAttachments(input.attachments ?? []);
  if (!content && attachments.length === 0) {
    throw new Error('กรุณากรอกข้อความ Internal Note หรือแนบไฟล์อย่างน้อย 1 รายการ');
  }

  let prevSla = '';
  let nextSla = '';
  if (input.adjustSla) {
    prevSla = toLocalDateInput(caseItem.sla_due_at) || caseItem.sla_due_at.slice(0, 64);
    nextSla = toLocalDateInput(input.newSlaDueAt ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextSla)) {
      throw new Error('กรุณาระบุวันครบกำหนด SLA ใหม่ให้ถูกต้อง');
    }
    if (nextSla === prevSla) {
      throw new Error('วันครบกำหนด SLA ใหม่ต้องแตกต่างจากวันเดิม');
    }
  }

  const noteRef = doc(collection(db, 'cases', caseItem.id, 'internal_notes'));
  const batch = writeBatch(db);

  batch.set(noteRef, {
    id: noteRef.id,
    case_id: caseItem.id,
    author_id: currentUser.uid,
    author_name: currentUser.display_name.slice(0, 120),
    author_role: currentUser.role,
    content,
    sla_changed: input.adjustSla,
    previous_sla_due_at: prevSla,
    new_sla_due_at: nextSla,
    ...(attachments.length > 0 ? { attachments } : {}),
    is_edited: false,
    last_edited_by: '',
    last_edited_by_name: '',
    last_edit_log_id: '',
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  });

  if (input.adjustSla) {
    batch.update(doc(db, 'cases', caseItem.id), {
      sla_due_at: nextSla,
      updated_at: serverTimestamp(),
    });
  }

  await batch
    .commit()
    .catch((err) => handleFirestoreError(err, OperationType.WRITE, `cases/${caseItem.id}/internal_notes`));
}

export async function updateInternalNoteDoc(
  currentUser: UserPublic,
  caseItem: CaseItem,
  note: InternalNote,
  input: {
    content: string;
    newSlaDueAt?: string;
    attachments?: NoteAttachment[];
  }
): Promise<void> {
  const content = input.content.trim().slice(0, 2000);
  const oldAttachments = sanitizeAttachments(note.attachments ?? []);
  const nextAttachments =
    input.attachments !== undefined ? sanitizeAttachments(input.attachments) : oldAttachments;

  if (!content && nextAttachments.length === 0) {
    throw new Error('กรุณากรอกข้อความ Internal Note หรือแนบไฟล์อย่างน้อย 1 รายการ');
  }

  const nextSla = note.sla_changed
    ? toLocalDateInput(input.newSlaDueAt ?? note.new_sla_due_at)
    : '';
  if (note.sla_changed && !/^\d{4}-\d{2}-\d{2}$/.test(nextSla)) {
    throw new Error('กรุณาระบุวันครบกำหนด SLA ให้ถูกต้อง');
  }

  const attachmentsChanged =
    JSON.stringify(oldAttachments) !== JSON.stringify(nextAttachments);

  if (content === note.content && nextSla === note.new_sla_due_at && !attachmentsChanged) {
    throw new Error('ไม่มีการเปลี่ยนแปลงข้อมูลสำหรับบันทึก');
  }

  const logRef = doc(collection(db, 'cases', caseItem.id, 'internal_notes', note.id, 'edit_logs'));
  const noteRef = doc(db, 'cases', caseItem.id, 'internal_notes', note.id);
  const batch = writeBatch(db);

  batch.set(logRef, {
    id: logRef.id,
    note_id: note.id,
    case_id: caseItem.id,
    editor_id: currentUser.uid,
    editor_name: currentUser.display_name.slice(0, 120),
    editor_role: currentUser.role,
    old_content: note.content,
    new_content: content,
    old_sla_due_at: note.new_sla_due_at,
    new_sla_due_at: nextSla,
    ...(attachmentsChanged
      ? {
          old_attachments_summary: summarizeAttachments(oldAttachments),
          new_attachments_summary: summarizeAttachments(nextAttachments),
        }
      : {}),
    edited_at: serverTimestamp(),
  });

  batch.update(noteRef, {
    content,
    new_sla_due_at: nextSla,
    ...(attachmentsChanged ? { attachments: nextAttachments } : {}),
    is_edited: true,
    last_edited_by: currentUser.uid,
    last_edited_by_name: currentUser.display_name.slice(0, 120),
    last_edit_log_id: logRef.id,
    updated_at: serverTimestamp(),
  });

  if (note.sla_changed && nextSla !== note.new_sla_due_at) {
    batch.update(doc(db, 'cases', caseItem.id), {
      sla_due_at: nextSla,
      updated_at: serverTimestamp(),
    });
  }

  await batch
    .commit()
    .catch((err) =>
      handleFirestoreError(err, OperationType.UPDATE, `cases/${caseItem.id}/internal_notes/${note.id}`)
    );

  // Clean up any removed attachments from backend storage after edit commits
  if (attachmentsChanged) {
    const nextIds = new Set(nextAttachments.map((a) => a.id));
    for (const prev of oldAttachments) {
      if (!nextIds.has(prev.id)) {
        void deleteServerAttachment(caseItem.id, prev.id);
      }
    }
  }
}

export async function deleteInternalNoteDoc(
  caseId: string,
  noteId: string,
  attachments: NoteAttachment[] = []
): Promise<void> {
  const logsSnap = await getDocs(
    query(
      collection(db, 'cases', caseId, 'internal_notes', noteId, 'edit_logs'),
      where('case_id', '==', caseId),
      where('note_id', '==', noteId)
    )
  ).catch((err) =>
    handleFirestoreError(err, OperationType.LIST, `cases/${caseId}/internal_notes/${noteId}/edit_logs`)
  );

  const batch = writeBatch(db);
  for (const logDoc of logsSnap.docs) {
    batch.delete(logDoc.ref);
  }
  batch.delete(doc(db, 'cases', caseId, 'internal_notes', noteId));

  await batch
    .commit()
    .catch((err) =>
      handleFirestoreError(err, OperationType.DELETE, `cases/${caseId}/internal_notes/${noteId}`)
    );

  for (const att of attachments) {
    void deleteServerAttachment(caseId, att.id);
  }
}

// ==================== CASE ESCALATION & HISTORY ====================

function mapEscalationDoc(id: string, data: Record<string, unknown>): CaseEscalation {
  return {
    id,
    case_id: String(data.case_id ?? ''),
    case_no: String(data.case_no ?? ''),
    shop_id: String(data.shop_id ?? ''),
    issue_summary: String(data.issue_summary ?? ''),
    details_preview: String(data.details_preview ?? ''),
    sla_due_at: String(data.sla_due_at ?? ''),
    from_user_id: String(data.from_user_id ?? ''),
    from_user_name: String(data.from_user_name ?? ''),
    from_team_id: String(data.from_team_id ?? ''),
    from_team_name: String(data.from_team_name ?? ''),
    to_user_id: String(data.to_user_id ?? ''),
    to_user_name: String(data.to_user_name ?? ''),
    to_team_id: String(data.to_team_id ?? ''),
    to_team_name: String(data.to_team_name ?? ''),
    note: String(data.note ?? ''),
    status: (data.status as EscalationStatus) ?? 'pending',
    reject_reason: String(data.reject_reason ?? ''),
    sender_ack_done: Boolean(data.sender_ack_done),
    created_at: timestampToIso(data.created_at),
    updated_at: timestampToIso(data.updated_at),
  };
}

export function subscribeIncomingEscalations(
  uid: string,
  onData: (items: CaseEscalation[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = 'case_escalations';
  const q = query(collection(db, path), where('to_user_id', '==', uid));
  return onSnapshot(
    q,
    (snapshot) => {
      const pending = snapshot.docs
        .map((d) => mapEscalationDoc(d.id, d.data()))
        .filter((item) => item.status === 'pending')
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      onData(pending);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export function subscribeRejectedOutgoingEscalations(
  uid: string,
  onData: (items: CaseEscalation[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = 'case_escalations';
  const q = query(collection(db, path), where('from_user_id', '==', uid));
  return onSnapshot(
    q,
    (snapshot) => {
      const rejected = snapshot.docs
        .map((d) => mapEscalationDoc(d.id, d.data()))
        .filter((item) => item.status === 'rejected' && !item.sender_ack_done)
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      onData(rejected);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export function subscribeCaseEscalationLogs(
  caseId: string,
  onData: (logs: CaseEscalationLog[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = `cases/${caseId}/escalation_logs`;
  const q = query(collection(db, 'cases', caseId, 'escalation_logs'), where('case_id', '==', caseId));
  return onSnapshot(
    q,
    (snapshot) => {
      const logs: CaseEscalationLog[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          case_id: String(data.case_id ?? caseId),
          from_user_id: String(data.from_user_id ?? ''),
          from_user_name: String(data.from_user_name ?? ''),
          from_team_id: String(data.from_team_id ?? ''),
          from_team_name: String(data.from_team_name ?? ''),
          to_user_id: String(data.to_user_id ?? ''),
          to_user_name: String(data.to_user_name ?? ''),
          to_team_id: String(data.to_team_id ?? ''),
          to_team_name: String(data.to_team_name ?? ''),
          note: String(data.note ?? ''),
          status: (data.status as EscalationStatus) ?? 'pending',
          reject_reason: String(data.reject_reason ?? ''),
          sender_ack_done: Boolean(data.sender_ack_done),
          sender_ack_at: data.sender_ack_at ? timestampToIso(data.sender_ack_at) : '',
          created_at: timestampToIso(data.created_at),
          updated_at: timestampToIso(data.updated_at),
        };
      });
      logs.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      onData(logs);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export async function createCaseEscalationDoc(
  currentUser: UserPublic,
  caseItem: CaseItem,
  targetUser: UserPublic,
  note: string
): Promise<void> {
  if (caseItem.pending_escalation_id) {
    throw new Error('เคสนี้กำลังรอการตอบรับ Escalate อยู่แล้ว');
  }
  if (targetUser.uid === currentUser.uid) {
    throw new Error('ไม่สามารถส่งต่อเคสให้ตัวเองได้');
  }

  const escRef = doc(collection(db, 'case_escalations'));
  const escLogRef = doc(db, 'cases', caseItem.id, 'escalation_logs', escRef.id);
  const caseRef = doc(db, 'cases', caseItem.id);
  const cleanNote = note.trim().slice(0, 500);
  const slaDue = (toLocalDateInput(caseItem.sla_due_at) || caseItem.sla_due_at).slice(0, 64);

  const batch = writeBatch(db);
  batch.set(escRef, {
    id: escRef.id,
    case_id: caseItem.id,
    case_no: caseItem.case_no.slice(0, MAX_CASE_LINK_LENGTH),
    shop_id: caseItem.shop_id.slice(0, 64),
    issue_summary: caseItem.issue_summary.slice(0, 300),
    details_preview: caseItem.details.slice(0, 4000),
    sla_due_at: slaDue,
    from_user_id: currentUser.uid,
    from_user_name: currentUser.display_name.slice(0, 120),
    from_team_id: currentUser.team_id,
    from_team_name: currentUser.team_name.slice(0, 80),
    to_user_id: targetUser.uid,
    to_user_name: targetUser.display_name.slice(0, 120),
    to_team_id: targetUser.team_id,
    to_team_name: targetUser.team_name.slice(0, 80),
    note: cleanNote,
    status: 'pending',
    reject_reason: '',
    sender_ack_done: false,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  });

  batch.set(escLogRef, {
    id: escRef.id,
    case_id: caseItem.id,
    from_user_id: currentUser.uid,
    from_user_name: currentUser.display_name.slice(0, 120),
    from_team_id: currentUser.team_id,
    from_team_name: currentUser.team_name.slice(0, 80),
    to_user_id: targetUser.uid,
    to_user_name: targetUser.display_name.slice(0, 120),
    to_team_id: targetUser.team_id,
    to_team_name: targetUser.team_name.slice(0, 80),
    note: cleanNote,
    status: 'pending',
    reject_reason: '',
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  });

  batch.update(caseRef, {
    pending_escalation_id: escRef.id,
    updated_at: serverTimestamp(),
  });

  await batch
    .commit()
    .catch((err) => handleFirestoreError(err, OperationType.WRITE, `case_escalations/${escRef.id}`));
}

export async function acceptCaseEscalationDoc(esc: CaseEscalation): Promise<void> {
  const batch = writeBatch(db);
  batch.update(doc(db, 'case_escalations', esc.id), {
    status: 'accepted',
    sender_ack_done: true,
    updated_at: serverTimestamp(),
  });
  batch.update(doc(db, 'cases', esc.case_id, 'escalation_logs', esc.id), {
    status: 'accepted',
    reject_reason: '',
    updated_at: serverTimestamp(),
  });
  batch.update(doc(db, 'cases', esc.case_id), {
    team_id: esc.to_team_id,
    team_name: esc.to_team_name.slice(0, 80),
    assignee_id: esc.to_user_id,
    assignee_name: esc.to_user_name.slice(0, 120),
    pending_escalation_id: '',
    updated_at: serverTimestamp(),
  });

  await batch
    .commit()
    .catch((err) => handleFirestoreError(err, OperationType.UPDATE, `case_escalations/${esc.id}`));
}

export async function rejectCaseEscalationDoc(
  esc: CaseEscalation,
  rejectReason: string
): Promise<void> {
  const cleanReason = rejectReason.trim().slice(0, 500);
  const batch = writeBatch(db);
  batch.update(doc(db, 'case_escalations', esc.id), {
    status: 'rejected',
    reject_reason: cleanReason,
    sender_ack_done: false,
    updated_at: serverTimestamp(),
  });
  batch.update(doc(db, 'cases', esc.case_id, 'escalation_logs', esc.id), {
    status: 'rejected',
    reject_reason: cleanReason,
    updated_at: serverTimestamp(),
  });
  batch.update(doc(db, 'cases', esc.case_id), {
    pending_escalation_id: '',
    updated_at: serverTimestamp(),
  });

  await batch
    .commit()
    .catch((err) => handleFirestoreError(err, OperationType.UPDATE, `case_escalations/${esc.id}`));
}

export async function acknowledgeRejectedEscalationDoc(esc: CaseEscalation): Promise<void> {
  const batch = writeBatch(db);
  batch.update(doc(db, 'case_escalations', esc.id), {
    sender_ack_done: true,
    updated_at: serverTimestamp(),
  });
  batch.update(doc(db, 'cases', esc.case_id, 'escalation_logs', esc.id), {
    sender_ack_done: true,
    sender_ack_at: serverTimestamp(),
  });

  await batch
    .commit()
    .catch((err) => handleFirestoreError(err, OperationType.UPDATE, `case_escalations/${esc.id}`));
}

// ==================== ADMIN MUTATIONS ====================

export async function createStaffMemberDoc(
  currentUser: UserPublic,
  input: {
    username: string;
    password: string;
    display_name: string;
    position: Position;
    team: Team;
  }
): Promise<void> {
  const displayName = input.display_name.trim().slice(0, 120);
  if (!displayName) {
    throw new Error('กรุณาระบุชื่อ-นามสกุลผู้ใช้งาน');
  }
  if (input.username.includes('@')) {
    throw new Error('กรุณาระบุเฉพาะ Username (ไม่ต้องใส่ @ หรืออีเมล) เช่น somchai');
  }

  const { username, authEmail } = resolveLoginIdentifier(input.username);
  const password = input.password ?? '';
  if (password.length < 6) {
    throw new Error('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
  }

  const staffId = await sha256Hex(authEmail);
  const staffRef = doc(db, 'staff_directory', staffId);
  const existing = await getDoc(staffRef).catch((err) =>
    handleFirestoreError(err, OperationType.GET, `staff_directory/${staffId}`)
  );
  if (existing.exists()) {
    throw new Error(`ชื่อผู้ใช้ "${username}" มีอยู่ในระบบแล้ว`);
  }

  const secondaryApp =
    getApps().find((a) => a.name === 'AdminUserCreator') ??
    initializeApp(firebaseConfig, 'AdminUserCreator');
  const secondaryAuth = getAuth(secondaryApp);
  await setPersistence(secondaryAuth, inMemoryPersistence);

  let createdAuthUser: User | null = null;
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, authEmail, password);
    createdAuthUser = cred.user;
  } catch (err) {
    throw mapAuthErrorMessage(err, 'create', username);
  }

  const newUid = createdAuthUser.uid;
  try {
    const batch = writeBatch(db);
    batch.set(staffRef, {
      id: staffId,
      email: authEmail,
      username,
      display_name: displayName,
      position_id: input.position.id,
      position_name: input.position.name.slice(0, 80),
      role: input.position.role_level,
      team_id: input.team.id,
      team_name: input.team.name.slice(0, 80),
      is_active: true,
      linked_uid: newUid,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    batch.set(doc(db, 'users', newUid), {
      uid: newUid,
      staff_id: staffId,
      username,
      display_name: displayName,
      position_id: input.position.id,
      position_name: input.position.name.slice(0, 80),
      role: input.position.role_level,
      team_id: input.team.id,
      team_name: input.team.name.slice(0, 80),
      is_active: true,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    if (input.position.role_level === 'admin') {
      batch.set(doc(db, 'admins', newUid), {
        uid: newUid,
        granted_by: currentUser.uid,
        granted_at: serverTimestamp(),
      });
    }
    await batch.commit();
  } catch (err) {
    await createdAuthUser.delete().catch(() => {});
    handleFirestoreError(err, OperationType.CREATE, `staff_directory/${staffId}`);
  } finally {
    await signOut(secondaryAuth).catch(() => {});
  }
}

export async function updateStaffMemberDoc(
  currentUser: UserPublic,
  staff: StaffEntry,
  input: {
    display_name: string;
    position: Position;
    team: Team;
    is_active: boolean;
  },
  allStaff: StaffEntry[]
): Promise<void> {
  const displayName = input.display_name.trim().slice(0, 120);
  if (!displayName) {
    throw new Error('กรุณาระบุชื่อ-นามสกุลผู้ใช้งาน');
  }

  if (staff.role === 'admin' && (input.position.role_level !== 'admin' || !input.is_active)) {
    const otherActiveAdmins = allStaff.filter(
      (s) => s.id !== staff.id && s.role === 'admin' && s.is_active
    );
    if (otherActiveAdmins.length === 0) {
      throw new Error('ไม่สามารถลดสิทธิ์หรือปิดการใช้งาน Admin คนสุดท้ายได้');
    }
  }

  const batch = writeBatch(db);
  batch.update(doc(db, 'staff_directory', staff.id), {
    display_name: displayName,
    position_id: input.position.id,
    position_name: input.position.name.slice(0, 80),
    role: input.position.role_level,
    team_id: input.team.id,
    team_name: input.team.name.slice(0, 80),
    is_active: input.is_active,
    updated_at: serverTimestamp(),
  });

  if (staff.linked_uid) {
    batch.update(doc(db, 'users', staff.linked_uid), {
      display_name: displayName,
      position_id: input.position.id,
      position_name: input.position.name.slice(0, 80),
      role: input.position.role_level,
      team_id: input.team.id,
      team_name: input.team.name.slice(0, 80),
      is_active: input.is_active,
      updated_at: serverTimestamp(),
    });

    const adminRef = doc(db, 'admins', staff.linked_uid);
    const existingAdminSnap = await getDoc(adminRef).catch((err) =>
      handleFirestoreError(err, OperationType.GET, `admins/${staff.linked_uid}`)
    );

    if (input.position.role_level === 'admin' && input.is_active) {
      if (!existingAdminSnap.exists()) {
        batch.set(adminRef, {
          uid: staff.linked_uid,
          granted_by: currentUser.uid,
          granted_at: serverTimestamp(),
        });
      }
    } else if (staff.linked_uid !== currentUser.uid && existingAdminSnap.exists()) {
      batch.delete(adminRef);
    }
  }

  await batch
    .commit()
    .catch((err) => handleFirestoreError(err, OperationType.UPDATE, `staff_directory/${staff.id}`));
}

export async function deleteStaffMemberDoc(currentUser: UserPublic, staff: StaffEntry): Promise<void> {
  if (staff.linked_uid && staff.linked_uid === currentUser.uid) {
    throw new Error('ไม่สามารถลบบัญชีของตัวเองที่กำลังใช้งานอยู่ได้');
  }
  const batch = writeBatch(db);
  batch.delete(doc(db, 'staff_directory', staff.id));
  if (staff.linked_uid) {
    batch.delete(doc(db, 'users', staff.linked_uid));
    batch.delete(doc(db, 'admins', staff.linked_uid));
  }
  await batch
    .commit()
    .catch((err) => handleFirestoreError(err, OperationType.DELETE, `staff_directory/${staff.id}`));
}

export async function createTeamDoc(
  input: { name: string; description: string },
  existingTeams: Team[]
): Promise<void> {
  const name = input.name.trim().slice(0, 80);
  const description = input.description.trim().slice(0, 300);
  if (!name) {
    throw new Error('กรุณาระบุชื่อทีม / แผนก');
  }
  if (existingTeams.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`ทีม "${name}" มีอยู่ในระบบแล้ว`);
  }

  const newRef = doc(collection(db, 'teams'));
  await setDoc(newRef, {
    id: newRef.id,
    name,
    description,
    is_archived: false,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  }).catch((err) => handleFirestoreError(err, OperationType.CREATE, `teams/${newRef.id}`));
}

export async function deleteTeamDoc(
  team: Team,
  staffList: StaffEntry[],
  cases: CaseItem[]
): Promise<void> {
  const userCnt = staffList.filter((s) => s.team_id === team.id).length;
  const caseCnt = cases.filter((c) => c.team_id === team.id).length;
  if (userCnt > 0 || caseCnt > 0) {
    throw new Error(`ไม่สามารถลบทีมได้ เนื่องจากยังมีสมาชิก (${userCnt}) หรือเคส (${caseCnt}) สังกัดอยู่`);
  }
  await deleteDoc(doc(db, 'teams', team.id)).catch((err) =>
    handleFirestoreError(err, OperationType.DELETE, `teams/${team.id}`)
  );
}

export async function createPositionDoc(
  input: { name: string; role_level: RoleLevel },
  existingPositions: Position[]
): Promise<void> {
  const name = input.name.trim().slice(0, 80);
  if (!name) {
    throw new Error('กรุณาระบุชื่อตำแหน่ง');
  }
  if (existingPositions.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`ตำแหน่ง "${name}" มีอยู่ในระบบแล้ว`);
  }

  const newRef = doc(collection(db, 'positions'));
  await setDoc(newRef, {
    id: newRef.id,
    name,
    role_level: input.role_level,
    is_system: false,
    is_archived: false,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  }).catch((err) => handleFirestoreError(err, OperationType.CREATE, `positions/${newRef.id}`));
}

export async function deletePositionDoc(pos: Position, staffList: StaffEntry[]): Promise<void> {
  if (pos.is_system) {
    throw new Error(`ไม่สามารถลบตำแหน่งหลัก "${pos.name}" ของระบบได้`);
  }
  const userCnt = staffList.filter((s) => s.position_id === pos.id).length;
  if (userCnt > 0) {
    throw new Error(`ไม่สามารถลบตำแหน่ง "${pos.name}" ได้ เนื่องจากมีผู้ใช้งานอยู่ ${userCnt} คน`);
  }
  await deleteDoc(doc(db, 'positions', pos.id)).catch((err) =>
    handleFirestoreError(err, OperationType.DELETE, `positions/${pos.id}`)
  );
}
