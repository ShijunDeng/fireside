import type { ActivityPhase, Participant, Stats, Topic, TopicSort } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public phase?: ActivityPhase,
    public retryAfter?: number,
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
    throw new ApiError(body.message ?? '请求失败，请稍后再试', response.status, body.code, body.phase, retryAfter);
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

function revisionHeaders(revision: number) {
  return { 'If-Match': `"${revision}"` };
}

export const api = {
  access: () => request<{ enabled: boolean }>('/api/access'),
  verifyAccess: async (key: string) => {
    const response = await fetch('/api/access/verify', { method: 'POST', headers: { 'X-Fireside-Write-Key': key } });
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
  meetingAccess: (id: number) => request<{ meetingUrl: string }>(`/api/topics/${id}/meeting-access`, undefined, true),
  participants: (id: number) => request<Participant[]>(`/api/topics/${id}/participants`, undefined, true),
  join: (id: number, name: string) => request<Participant>(`/api/topics/${id}/participants`, { method: 'POST', body: JSON.stringify({ name }) }),
  leave: (id: number, participantId: number) => request<void>(`/api/topics/${id}/participants/${participantId}`, { method: 'DELETE' }),
};
