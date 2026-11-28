import { auth } from './firebase.ts';
import type { TeamWebhookConfig, WebhookEventType } from '../types.ts';

export const DEFAULT_WEBHOOK_EVENTS: WebhookEventType[] = [
  'escalation',
  'mention',
  'sla_due',
  'sla_overdue',
];

export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  escalation: 'ส่งต่อเคส (Escalate)',
  mention: 'ถูก @Mention',
  sla_due: 'เคสถึงกำหนด SLA (วันนี้)',
  sla_overdue: 'เคสเกินกำหนด SLA',
};

async function getBearerHeaders(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('กรุณาเข้าสู่ระบบใหม่ก่อนทำรายการ');
  }
  const token = await user.getIdToken();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export async function fetchAdminTeamWebhooks(): Promise<TeamWebhookConfig[]> {
  const headers = await getBearerHeaders();
  const resp = await fetch('/api/admin/webhooks', { headers });
  const data = (await resp.json().catch(() => ({}))) as {
    webhooks?: TeamWebhookConfig[];
    error?: string;
  };
  if (!resp.ok) {
    throw new Error(data.error || 'ไม่สามารถโหลดการตั้งค่า Webhook ได้');
  }
  return Array.isArray(data.webhooks) ? data.webhooks : [];
}

export async function saveAdminTeamWebhook(
  teamId: string,
  input: {
    webhook_url?: string;
    enabled: boolean;
    events: WebhookEventType[];
  }
): Promise<TeamWebhookConfig> {
  const headers = await getBearerHeaders();
  const resp = await fetch(`/api/admin/webhooks/${encodeURIComponent(teamId)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(input),
  });
  const data = (await resp.json().catch(() => ({}))) as {
    webhook?: TeamWebhookConfig;
    error?: string;
  };
  if (!resp.ok || !data.webhook) {
    throw new Error(data.error || 'ไม่สามารถบันทึกการตั้งค่า Webhook ได้');
  }
  return data.webhook;
}

export async function deleteAdminTeamWebhook(teamId: string): Promise<void> {
  const headers = await getBearerHeaders();
  const resp = await fetch(`/api/admin/webhooks/${encodeURIComponent(teamId)}`, {
    method: 'DELETE',
    headers,
  });
  const data = (await resp.json().catch(() => ({}))) as { error?: string };
  if (!resp.ok) {
    throw new Error(data.error || 'ไม่สามารถลบ Webhook ได้');
  }
}

export async function testAdminTeamWebhook(
  teamId: string,
  teamName: string
): Promise<{ ok: boolean; webhook?: TeamWebhookConfig; error?: string }> {
  const headers = await getBearerHeaders();
  const resp = await fetch(`/api/admin/webhooks/${encodeURIComponent(teamId)}/test`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ teamName }),
  });
  const data = (await resp.json().catch(() => ({}))) as {
    ok?: boolean;
    webhook?: TeamWebhookConfig;
    error?: string;
  };
  if (!resp.ok && !data.error) {
    return { ok: false, error: 'ไม่สามารถทดสอบส่ง Webhook ได้' };
  }
  return {
    ok: Boolean(data.ok),
    webhook: data.webhook,
    error: data.error,
  };
}

export interface DispatchWebhookPayload {
  eventType: WebhookEventType;
  teamIds: string[];
  dedupKey?: string;
  caseId: string;
  caseNo: string;
  caseUrl?: string;
  issueSummary: string;
  slaDueAt?: string;
  actorName?: string;
  notePreview?: string;
  extraInfo?: string;
}

export async function dispatchTeamWebhook(payload: DispatchWebhookPayload): Promise<void> {
  const user = auth.currentUser;
  if (!user || payload.teamIds.length === 0) return;
  try {
    const token = await user.getIdToken();
    await fetch('/api/webhooks/dispatch', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Non-blocking: external webhook failure must never disrupt core CRM workflow
  }
}
