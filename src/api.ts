import type { ActivityPhase, Participant, Stats, Topic, TopicSort } from './types';

export type ScheduleConflict = Pick<Topic, 'id' | 'title' | 'scheduledAt' | 'duration'> & {
  scheduledAt: string;
  duration: number;
};

export type ParticipantMutation<T = void> = {
  result: T;
  topicRevision: number;
  participantCount: number;
};

export type ParticipantRead = {
  participants: Participant[];
  topicRevision: number;
  participantCount: number;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public phase?: ActivityPhase,
    public retryAfter?: number,
    public conflicts?: ScheduleConflict[],
  ) {
    super(message);
  }
}

const legacyWriteKeyStorage = 'fireside-write-key';
export const collaborationSessionStorage = 'fireside-collaboration-session-v1';
let unauthorizedHandler: (() => void) | null = null;

function removeLegacyWriteKey() {
  sessionStorage.removeItem(legacyWriteKeyStorage);
}

export function getCollaborationSession() {
  removeLegacyWriteKey();
  return sessionStorage.getItem(collaborationSessionStorage) ?? '';
}

export function saveCollaborationSession(value: string) {
  removeLegacyWriteKey();
  sessionStorage.setItem(collaborationSessionStorage, value);
}

export function clearCollaborationSession() {
  removeLegacyWriteKey();
  sessionStorage.removeItem(collaborationSessionStorage);
}

export function onUnauthorized(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

async function readBody<T>(response: Response, notifyUnauthorized = true): Promise<T> {
  const body = await response.json().catch(() => ({})) as {
    message?: string;
    code?: string;
    phase?: ActivityPhase;
    retryAfterSeconds?: number;
    conflicts?: ScheduleConflict[];
  };
  if (!response.ok) {
    if (response.status === 401 && body.code === 'ACCESS_SESSION_REQUIRED' && notifyUnauthorized) {
      clearCollaborationSession();
      unauthorizedHandler?.();
    }
    const retryAfterHeader = Number(response.headers.get('Retry-After'));
    const retryAfterCandidate = body.retryAfterSeconds ?? retryAfterHeader;
    const retryAfter = Number.isFinite(retryAfterCandidate) && retryAfterCandidate > 0
      ? Math.ceil(retryAfterCandidate)
      : undefined;
    throw new ApiError(body.message ?? '请求失败，请稍后再试', response.status, body.code, body.phase, retryAfter, body.conflicts);
  }
  return body as T;
}

async function request<T>(url: string, options?: RequestInit, requiresAccess = options?.method !== undefined && options.method !== 'GET') {
  const headers = new Headers(options?.headers);
  if (options?.body) headers.set('Content-Type', 'application/json');
  if (requiresAccess) {
    const session = getCollaborationSession();
    if (session) headers.set('X-Fireside-Session', session);
  }
  const response = await fetch(url, {
    ...options,
    headers,
  });
  return readBody<T>(response);
}

async function participantMutationRequest<T>(url: string, options: RequestInit): Promise<ParticipantMutation<T>> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  const session = getCollaborationSession();
  if (session) headers.set('X-Fireside-Session', session);
  const response = await fetch(url, { ...options, headers });
  const result = await readBody<T>(response);
  const projection = participantProjectionHeaders(response);
  if (!projection) {
    throw new ApiError('报名已经提交，但服务器未返回完整同步版本；请刷新页面确认结果', 502, 'INVALID_PARTICIPANT_MUTATION_METADATA');
  }
  return { result, ...projection };
}

function participantProjectionHeaders(response: Response) {
  const revisionMatch = response.headers.get('ETag')?.match(/^"([1-9]\d*)"$/);
  const participantCountText = response.headers.get('X-Fireside-Participant-Count');
  const topicRevision = revisionMatch ? Number(revisionMatch[1]) : Number.NaN;
  const participantCount = participantCountText !== null && /^(0|[1-9]\d*)$/.test(participantCountText)
    ? Number(participantCountText)
    : Number.NaN;
  return Number.isSafeInteger(topicRevision) && Number.isSafeInteger(participantCount)
    ? { topicRevision, participantCount }
    : null;
}

function revisionHeaders(revision: number) {
  return { 'If-Match': `"${revision}"` };
}

export function encodeWriteKeyHeader(key: string) {
  const bytes = new TextEncoder().encode(key);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export const api = {
  access: () => request<{ enabled: boolean }>('/api/access'),
  verifyAccess: async (key: string) => {
    const response = await fetch('/api/access/verify', {
      method: 'POST',
      headers: {
        'X-Fireside-Write-Key': encodeWriteKeyHeader(key),
        'X-Fireside-Write-Key-Encoding': 'base64url-utf8-v1',
      },
    });
    return readBody<{ sessionToken: string; expiresAt: string }>(response, false);
  },
  accessSession: async () => {
    const headers = new Headers();
    const session = getCollaborationSession();
    if (session) headers.set('X-Fireside-Session', session);
    const response = await fetch('/api/access/session', { headers, cache: 'no-store' });
    return readBody<{ valid: true; expiresAt: string }>(response, false);
  },
  topics: async (sort: TopicSort = 'manual') => {
    const response = await fetch(`/api/topics?sort=${sort}`);
    return {
      topics: await readBody<Topic[]>(response),
      orderVersion: Number(response.headers.get('X-Order-Version') ?? 0),
    };
  },
  topic: async (id: number) => {
    const response = await fetch(`/api/topics/${id}`, { cache: 'no-store' });
    return readBody<Topic>(response, false);
  },
  stats: () => request<Stats>('/api/stats'),
  create: (data: { title: string; summary: string; proposer: string; presenter?: string; tags: string[] }) =>
    request<Topic>('/api/topics', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, revision: number, data: Partial<Pick<Topic, 'title' | 'summary' | 'proposer' | 'presenter' | 'tags' | 'scheduledAt' | 'duration' | 'room' | 'meetingUrl' | 'takeaway' | 'materialUrl'>>) =>
    request<Topic>(`/api/topics/${id}`, { method: 'PATCH', headers: revisionHeaders(revision), body: JSON.stringify(data) }),
  remove: (id: number, revision: number) => request<void>(`/api/topics/${id}`, { method: 'DELETE', headers: revisionHeaders(revision) }),
  reorder: async (orderedIds: number[], baseVersion: number) => {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const session = getCollaborationSession();
    if (session) headers.set('X-Fireside-Session', session);
    const response = await fetch('/api/topics/reorder', {
      method: 'POST',
      headers,
      body: JSON.stringify({ orderedIds, baseVersion }),
    });
    await readBody<void>(response);
    return Number(response.headers.get('X-Order-Version') ?? baseVersion + 1);
  },
  claim: (id: number, revision: number, presenter: string) =>
    request<Topic>(`/api/topics/${id}/claim`, { method: 'POST', headers: revisionHeaders(revision), body: JSON.stringify({ presenter }) }),
  release: (id: number, revision: number) => request<Topic>(`/api/topics/${id}/release`, { method: 'POST', headers: revisionHeaders(revision), body: JSON.stringify({}) }),
  schedule: (id: number, revision: number, data: { scheduledAt: string; duration: number; room: string; meetingUrl: string }) =>
    request<Topic>(`/api/topics/${id}/schedule`, { method: 'POST', headers: revisionHeaders(revision), body: JSON.stringify(data) }),
  unschedule: (id: number, revision: number) => request<Topic>(`/api/topics/${id}/unschedule`, { method: 'POST', headers: revisionHeaders(revision), body: JSON.stringify({}) }),
  archive: (id: number, revision: number, data: { takeaway: string; materialUrl: string }) =>
    request<Topic>(`/api/topics/${id}/archive`, { method: 'POST', headers: revisionHeaders(revision), body: JSON.stringify(data) }),
  unarchive: (id: number, revision: number) => request<Topic>(`/api/topics/${id}/unarchive`, { method: 'POST', headers: revisionHeaders(revision), body: JSON.stringify({}) }),
  meetingAccess: async (id: number) => {
    const headers = new Headers();
    const session = getCollaborationSession();
    if (session) headers.set('X-Fireside-Session', session);
    const response = await fetch(`/api/topics/${id}/meeting-access`, { headers, cache: 'no-store' });
    const result = await readBody<{ meetingUrl: string }>(response);
    const revisionMatch = response.headers.get('ETag')?.match(/^"([1-9]\d*)"$/);
    const topicRevision = revisionMatch ? Number(revisionMatch[1]) : Number.NaN;
    if (!Number.isSafeInteger(topicRevision)) {
      throw new ApiError('会议入口已读取，但服务器未返回一致的议题版本；请重新读取会议入口', 502, 'INVALID_MEETING_ACCESS_METADATA');
    }
    return { ...result, topicRevision };
  },
  unscheduleImpact: (id: number) => request<{ topic: Topic; participants: Participant[] }>(`/api/topics/${id}/unschedule-impact`, undefined, true),
  participants: async (id: number): Promise<ParticipantRead> => {
    const headers = new Headers();
    const session = getCollaborationSession();
    if (session) headers.set('X-Fireside-Session', session);
    const response = await fetch(`/api/topics/${id}/participants`, { headers, cache: 'no-store' });
    const participants = await readBody<Participant[]>(response);
    const projection = participantProjectionHeaders(response);
    if (!projection || projection.participantCount !== participants.length) {
      throw new ApiError('名单已读取，但服务器未返回一致的议题版本；请重新读取名单', 502, 'INVALID_PARTICIPANT_READ_METADATA');
    }
    return { participants, ...projection };
  },
  join: (id: number, name: string) => participantMutationRequest<Participant>(`/api/topics/${id}/participants`, { method: 'POST', body: JSON.stringify({ name }) }),
  leave: (id: number, participantId: number) => participantMutationRequest<void>(`/api/topics/${id}/participants/${participantId}`, { method: 'DELETE' }),
};
