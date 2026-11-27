export const MAX_CASE_LINK_LENGTH = 1000;

/**
 * Validates that a case link string is a safe http/https URL within length limits.
 * Prevents javascript:, data:, or malformed protocol injection when rendering anchors.
 */
export function getSafeCaseUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_CASE_LINK_LENGTH) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname)) {
      return trimmed;
    }
    return null;
  } catch {
    return null;
  }
}

export function normalizeCaseUrl(raw: string): string | null {
  return getSafeCaseUrl(raw);
}

export interface CaseLinkDisplay {
  label: string;
  url: string | null;
}

/**
 * Resolves the display label (case_no) and destination URL (case_url).
 * Supports legacy records where the URL was stored directly inside case_no.
 */
export function resolveCaseLinkDisplay(
  caseNo: string | undefined | null,
  caseUrl?: string | undefined | null
): CaseLinkDisplay {
  const trimmedNo = (caseNo ?? '').trim();
  const safeExplicitUrl = getSafeCaseUrl(caseUrl);
  const safeNoAsUrl = getSafeCaseUrl(trimmedNo);

  if (safeExplicitUrl) {
    return {
      label: safeNoAsUrl ? 'ลิงก์ไปที่เคส' : trimmedNo || 'ลิงก์ไปที่เคส',
      url: safeExplicitUrl,
    };
  }

  if (safeNoAsUrl) {
    return {
      label: 'ลิงก์ไปที่เคส',
      url: safeNoAsUrl,
    };
  }

  return {
    label: trimmedNo || '-',
    url: null,
  };
}

