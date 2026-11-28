import type { Team, UserPublic } from '../types.ts';

export const MAX_NOTE_MENTIONS = 10;
export const MAX_CASE_MENTIONS = 20;

export interface ActiveMentionQuery {
  startIndex: number;
  endIndex: number;
  query: string;
}

export type MentionCandidate =
  | {
      kind: 'team';
      id: string;
      team: Team;
      memberCount: number;
    }
  | {
      kind: 'user';
      id: string;
      user: UserPublic;
    };

/**
 * Detects an active `@query` right before the caret position in an Internal Note textarea.
 */
export function detectActiveMentionQuery(
  text: string,
  caretPos: number
): ActiveMentionQuery | null {
  const safePos = Math.max(0, Math.min(caretPos, text.length));
  const beforeCaret = text.slice(0, safePos);
  const atIndex = beforeCaret.lastIndexOf('@');
  if (atIndex === -1) return null;

  // `@` must be at the start of text or preceded by whitespace/opening bracket
  if (atIndex > 0 && !/[\s(\[{]/.test(beforeCaret[atIndex - 1])) {
    return null;
  }

  const rawQuery = beforeCaret.slice(atIndex + 1);
  // Stop matching across newlines or excessively long segments
  if (rawQuery.includes('\n') || rawQuery.length > 40) {
    return null;
  }

  return {
    startIndex: atIndex,
    endIndex: safePos,
    query: rawQuery,
  };
}

export function filterMentionCandidates(
  users: UserPublic[],
  query: string,
  excludeUid?: string
): UserPublic[] {
  const q = query.trim().toLowerCase();
  const candidates = users.filter((u) => u.is_active && u.uid !== excludeUid);

  const matched = q
    ? candidates.filter(
        (u) =>
          u.display_name.toLowerCase().includes(q) ||
          (u.username ?? '').toLowerCase().includes(q) ||
          u.team_name.toLowerCase().includes(q) ||
          u.position_name.toLowerCase().includes(q)
      )
    : candidates;

  return matched
    .slice()
    .sort((a, b) => {
      if (q) {
        const aStarts =
          a.display_name.toLowerCase().startsWith(q) ||
          (a.username ?? '').toLowerCase().startsWith(q);
        const bStarts =
          b.display_name.toLowerCase().startsWith(q) ||
          (b.username ?? '').toLowerCase().startsWith(q);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
      }
      return a.display_name.localeCompare(b.display_name, 'th');
    })
    .slice(0, 8);
}

export function filterCombinedMentionCandidates(
  users: UserPublic[],
  teams: Team[],
  query: string,
  excludeUid?: string
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  const activeUsers = users.filter((u) => u.is_active);
  const memberCountByTeam = new Map<string, number>();
  for (const u of activeUsers) {
    memberCountByTeam.set(u.team_id, (memberCountByTeam.get(u.team_id) ?? 0) + 1);
  }

  const activeTeams = teams.filter((t) => !t.is_archived);
  const matchedTeams = (
    q
      ? q === 'team' || q === 'ทีม'
        ? activeTeams
        : activeTeams.filter(
            (t) =>
              t.name.toLowerCase().includes(q) ||
              t.id.toLowerCase().includes(q) ||
              t.name.replace(/\s+/g, '').toLowerCase().includes(q) ||
              t.description.toLowerCase().includes(q)
          )
      : activeTeams
  )
    .slice()
    .sort((a, b) => {
      if (q) {
        const aStarts = a.name.toLowerCase().startsWith(q) || a.id.toLowerCase().startsWith(q);
        const bStarts = b.name.toLowerCase().startsWith(q) || b.id.toLowerCase().startsWith(q);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
      }
      return a.name.localeCompare(b.name, 'th');
    })
    .slice(0, 5)
    .map(
      (team): MentionCandidate => ({
        kind: 'team',
        id: `team:${team.id}`,
        team,
        memberCount: memberCountByTeam.get(team.id) ?? 0,
      })
    );

  const matchedUsers = filterMentionCandidates(users, query, excludeUid)
    .slice(0, 7)
    .map(
      (user): MentionCandidate => ({
        kind: 'user',
        id: `user:${user.uid}`,
        user,
      })
    );

  return [...matchedTeams, ...matchedUsers];
}

export function getMentionTokensForUser(user: UserPublic): string[] {
  const tokens: string[] = [];
  const name = user.display_name.trim();
  if (name) tokens.push(`@${name}`);
  const username = user.username?.trim();
  if (username) tokens.push(`@${username}`);
  return tokens;
}

export function getMentionTokensForTeam(team: Team): string[] {
  const tokens: string[] = [];
  const name = team.name.trim();
  if (name) {
    tokens.push(`@${name}`);
    const compact = name.replace(/\s+/g, '');
    if (compact !== name) tokens.push(`@${compact}`);
    const underscored = name.replace(/\s+/g, '_');
    if (underscored !== name && underscored !== compact) tokens.push(`@${underscored}`);
  }
  const id = team.id.trim();
  if (id && id.length <= 32 && /^[a-z0-9_-]+$/i.test(id)) {
    tokens.push(`@${id}`);
  }
  return Array.from(new Set(tokens));
}

function isBoundaryBefore(text: string, index: number): boolean {
  return index === 0 || /[\s(\[{,.;:!?]/.test(text[index - 1]);
}

function isBoundaryAfter(text: string, endIndex: number): boolean {
  return endIndex >= text.length || /[\s)\]}.,;:!?]/.test(text[endIndex]);
}

type TokenPair =
  | { token: string; lowerToken: string; kind: 'user'; user: UserPublic }
  | { token: string; lowerToken: string; kind: 'team'; team: Team };

function buildSortedTokenPairs(
  users: UserPublic[],
  teams: Team[],
  options?: { onlyActiveUsers?: boolean; excludeUid?: string }
): TokenPair[] {
  const pairs: TokenPair[] = [];

  for (const team of teams) {
    if (team.is_archived) continue;
    for (const token of getMentionTokensForTeam(team)) {
      pairs.push({ token, lowerToken: token.toLowerCase(), kind: 'team', team });
    }
  }

  for (const user of users) {
    if (options?.onlyActiveUsers && !user.is_active) continue;
    if (options?.excludeUid && user.uid === options.excludeUid) continue;
    for (const token of getMentionTokensForUser(user)) {
      pairs.push({ token, lowerToken: token.toLowerCase(), kind: 'user', user });
    }
  }

  // Longer tokens match first; on equal length, prioritize team names like @call before partial matches
  pairs.sort((a, b) => {
    const lenDiff = b.token.length - a.token.length;
    if (lenDiff !== 0) return lenDiff;
    if (a.kind !== b.kind) return a.kind === 'team' ? -1 : 1;
    return 0;
  });

  return pairs;
}

/**
 * Extracts both individual active users and teams referenced via `@name` / `@username` / `@team` in note text.
 */
export function resolveMentionTargetsFromText(
  text: string,
  users: UserPublic[],
  teams: Team[],
  excludeUid?: string
): { users: UserPublic[]; teams: Team[] } {
  if (!text || !text.includes('@')) {
    return { users: [], teams: [] };
  }

  const lowerText = text.toLowerCase();
  const pairs = buildSortedTokenPairs(users, teams, {
    onlyActiveUsers: true,
    excludeUid,
  });

  const foundUsers = new Map<string, { index: number; user: UserPublic }>();
  const foundTeams = new Map<string, { index: number; team: Team }>();
  const occupiedRanges: Array<[number, number]> = [];

  for (const pair of pairs) {
    let searchFrom = 0;
    while (searchFrom < lowerText.length) {
      const idx = lowerText.indexOf(pair.lowerToken, searchFrom);
      if (idx === -1) break;
      const end = idx + pair.lowerToken.length;
      const overlaps = occupiedRanges.some(([s, e]) => idx < e && end > s);
      if (!overlaps && isBoundaryBefore(text, idx) && isBoundaryAfter(text, end)) {
        occupiedRanges.push([idx, end]);
        if (pair.kind === 'user') {
          if (!foundUsers.has(pair.user.uid)) {
            foundUsers.set(pair.user.uid, { index: idx, user: pair.user });
          }
        } else {
          if (!foundTeams.has(pair.team.id)) {
            foundTeams.set(pair.team.id, { index: idx, team: pair.team });
          }
        }
        break;
      }
      searchFrom = idx + 1;
    }
  }

  return {
    users: Array.from(foundUsers.values())
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.user)
      .slice(0, MAX_NOTE_MENTIONS),
    teams: Array.from(foundTeams.values())
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.team)
      .slice(0, MAX_NOTE_MENTIONS),
  };
}

/**
 * Extracts active users referenced via `@display_name` or `@username` in note text.
 */
export function resolveMentionedUsersFromText(
  text: string,
  users: UserPublic[],
  excludeUid?: string
): UserPublic[] {
  return resolveMentionTargetsFromText(text, users, [], excludeUid).users;
}

export interface MentionSegment {
  text: string;
  user?: UserPublic;
  team?: Team;
}

/**
 * Splits note text into plain and highlighted `@Mention` (user or team) segments for safe JSX rendering.
 */
export function splitNoteContentWithMentions(
  text: string,
  users: UserPublic[],
  teams: Team[] = []
): MentionSegment[] {
  if (!text || !text.includes('@') || (users.length === 0 && teams.length === 0)) {
    return [{ text }];
  }

  const lowerText = text.toLowerCase();
  const pairs = buildSortedTokenPairs(users, teams);

  const matches: Array<{ start: number; end: number; user?: UserPublic; team?: Team }> = [];

  for (const pair of pairs) {
    let searchFrom = 0;
    while (searchFrom < lowerText.length) {
      const idx = lowerText.indexOf(pair.lowerToken, searchFrom);
      if (idx === -1) break;
      const end = idx + pair.lowerToken.length;
      const overlaps = matches.some((m) => idx < m.end && end > m.start);
      if (!overlaps && isBoundaryBefore(text, idx) && isBoundaryAfter(text, end)) {
        matches.push(
          pair.kind === 'user'
            ? { start: idx, end, user: pair.user }
            : { start: idx, end, team: pair.team }
        );
      }
      searchFrom = end;
    }
  }

  if (matches.length === 0) {
    return [{ text }];
  }

  matches.sort((a, b) => a.start - b.start);

  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) {
      segments.push({ text: text.slice(cursor, m.start) });
    }
    segments.push({
      text: text.slice(m.start, m.end),
      user: m.user,
      team: m.team,
    });
    cursor = m.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor) });
  }

  return segments;
}

export function removeMentionTokensFromText(text: string, tokens: string[]): string {
  const sorted = tokens
    .map((t) => t.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  let next = text;
  for (const token of sorted) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(^|[\\s(\\[{,.;:!?])${escaped}(?=$|[\\s)\\]}.,;:!?])`, 'gi');
    next = next.replace(regex, '$1');
  }
  return next.replace(/ {2,}/g, ' ').replace(/^ /gm, '');
}
