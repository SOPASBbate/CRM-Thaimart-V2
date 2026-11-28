const OPTIN_STORAGE_KEY = 'crmdesk_browser_notif_optin';
const BASE_DOCUMENT_TITLE = 'CRM Desk — ระบบติดตามเคสและ SLA';

export type BrowserNotifPermission = NotificationPermission | 'unsupported';

export interface BrowserNotificationState {
  supported: boolean;
  permission: BrowserNotifPermission;
  enabled: boolean;
}

export function isBrowserNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getBrowserNotificationState(): BrowserNotificationState {
  if (!isBrowserNotificationSupported()) {
    return { supported: false, permission: 'unsupported', enabled: false };
  }
  const permission = Notification.permission;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(OPTIN_STORAGE_KEY);
  } catch {
    stored = null;
  }
  // If granted and user hasn't explicitly paused, treat as enabled
  const enabled = permission === 'granted' && stored !== '0';
  return { supported: true, permission, enabled };
}

export function setBrowserNotificationOptIn(enabled: boolean): BrowserNotificationState {
  if (!isBrowserNotificationSupported()) {
    return { supported: false, permission: 'unsupported', enabled: false };
  }
  try {
    window.localStorage.setItem(OPTIN_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore storage quota errors
  }
  return getBrowserNotificationState();
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationState> {
  if (!isBrowserNotificationSupported()) {
    return { supported: false, permission: 'unsupported', enabled: false };
  }
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    return setBrowserNotificationOptIn(true);
  }
  return getBrowserNotificationState();
}

export function isWindowInBackground(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'hidden' || !document.hasFocus();
}

export function sendBrowserNotification(options: {
  title: string;
  body: string;
  tag: string;
  requireInteraction?: boolean;
  onClick?: () => void;
}): boolean {
  const state = getBrowserNotificationState();
  if (!state.supported || state.permission !== 'granted' || !state.enabled) {
    return false;
  }

  try {
    const notif = new Notification(options.title, {
      body: options.body,
      tag: options.tag,
      requireInteraction: options.requireInteraction ?? false,
    });

    notif.onclick = () => {
      try {
        window.focus();
      } catch {
        // ignore focus restriction
      }
      notif.close();
      options.onClick?.();
    };
    return true;
  } catch {
    return false;
  }
}

export function updateDocumentAlertTitle(attentionCount: number): void {
  if (typeof document === 'undefined') return;
  document.title =
    attentionCount > 0 ? `(${attentionCount}) ${BASE_DOCUMENT_TITLE}` : BASE_DOCUMENT_TITLE;
}
