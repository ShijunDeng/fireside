import type { Participant, Stats, Topic, TopicSort } from './types';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

const writeKeyStorage = 'fireside-write-key';
let unauthorizedHandler: (() => void) | null = null;

export function getWriteKey() {
  return sessionStorage.getItem(writeKeyStorage) ?? '';
}

export function saveWriteKey(value: string) {
  sessionStorage.setItem(writeKeyStorage, value);
}

export function clearWriteKey() {
  sessionStorage.removeItem(writeKeyStorage);
}

export function onUnauthorized(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

async function readBody<T>(response: Response, notifyUnauthorized = true): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && notifyUnauthorized) {
      clearWriteKey();
      unauthorizedHandler?.();
    }
    throw new ApiError(body.message ?? '请求失败，请稍后再试', response.status, body.code);
  }
  return body as T;
}

async function request<T>(url: string, options?: RequestInit, requiresAccess = options?.method !== undefined && options.method !== 'GET') {
  const headers = new Headers(options?.headers);
  if (options?.body) headers.set('Content-Type', 'application/json');
  if (requiresAccess) {
    const key = getWriteKey();
    if (key) headers.set('X-Fireside-Write-Key', key);
  }
  const response = await fetch(url, {
    ...options,
    headers,
  });
  return readBody<T>(response);
}

export const api = {
  access: () => request<{ enabled: boolean }>('/api/access'),
  verifyAccess: async (key: string) => {
    const response = await fetch('/api/access/verify', { method: 'POST', headers: { 'X-Fireside-Write-Key': key } });
    await readBody<void>(response, false);
  },
  topics: async (sort: TopicSort = 'manual') => {
    const response = await fetch(`/api/topics?sort=${sort}`);
    return {
      topics: await readBody<Topic[]>(response),
      orderVersion: Number(response.headers.get('X-Order-Version') ?? 0),
    };
  },
  stats: () => request<Stats>('/api/stats'),
  create: (data: { title: string; summary: string; proposer: string; presenter?: string; tags: string[] }) =>
    request<Topic>('/api/topics', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<Pick<Topic, 'title' | 'summary' | 'proposer' | 'presenter' | 'tags' | 'scheduledAt' | 'duration' | 'room' | 'meetingUrl' | 'takeaway' | 'materialUrl'>>) =>
    request<Topic>(`/api/topics/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  remove: (id: number) => request<void>(`/api/topics/${id}`, { method: 'DELETE' }),
  reorder: async (orderedIds: number[], baseVersion: number) => {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const key = getWriteKey();
    if (key) headers.set('X-Fireside-Write-Key', key);
    const response = await fetch('/api/topics/reorder', {
      method: 'POST',
      headers,
      body: JSON.stringify({ orderedIds, baseVersion }),
    });
    await readBody<void>(response);
    return Number(response.headers.get('X-Order-Version') ?? baseVersion + 1);
  },
  claim: (id: number, presenter: string) =>
    request<Topic>(`/api/topics/${id}/claim`, { method: 'POST', body: JSON.stringify({ presenter }) }),
  release: (id: number) => request<Topic>(`/api/topics/${id}/release`, { method: 'POST', body: JSON.stringify({}) }),
  schedule: (id: number, data: { scheduledAt: string; duration: number; room: string; meetingUrl: string }) =>
    request<Topic>(`/api/topics/${id}/schedule`, { method: 'POST', body: JSON.stringify(data) }),
  unschedule: (id: number) => request<Topic>(`/api/topics/${id}/unschedule`, { method: 'POST', body: JSON.stringify({}) }),
  archive: (id: number, data: { takeaway: string; materialUrl: string }) =>
    request<Topic>(`/api/topics/${id}/archive`, { method: 'POST', body: JSON.stringify(data) }),
  unarchive: (id: number) => request<Topic>(`/api/topics/${id}/unarchive`, { method: 'POST', body: JSON.stringify({}) }),
  meetingAccess: (id: number) => request<{ meetingUrl: string }>(`/api/topics/${id}/meeting-access`, undefined, true),
  participants: (id: number) => request<Participant[]>(`/api/topics/${id}/participants`, undefined, true),
  join: (id: number, name: string) => request<Participant>(`/api/topics/${id}/participants`, { method: 'POST', body: JSON.stringify({ name }) }),
  leave: (id: number, participantId: number) => request<void>(`/api/topics/${id}/participants/${participantId}`, { method: 'DELETE' }),
};
