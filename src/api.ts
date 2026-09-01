import type { Stats, Topic, TopicSort } from './types';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function readBody<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.message ?? '请求失败，请稍后再试', response.status);
  return body as T;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options?.body ? { 'Content-Type': 'application/json' } : {}), ...options?.headers },
  });
  return readBody<T>(response);
}

export const api = {
  topics: async (sort: TopicSort = 'manual') => {
    const response = await fetch(`/api/topics?sort=${sort}`);
    return {
      topics: await readBody<Topic[]>(response),
      orderVersion: Number(response.headers.get('X-Order-Version') ?? 0),
    };
  },
  stats: () => request<Stats>('/api/stats'),
  create: (data: { title: string; summary: string; proposer: string; tags: string[] }) =>
    request<Topic>('/api/topics', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<Pick<Topic, 'title' | 'summary' | 'proposer' | 'presenter' | 'tags' | 'scheduledAt' | 'duration' | 'room' | 'takeaway' | 'materialUrl'>>) =>
    request<Topic>(`/api/topics/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  remove: (id: number) => request<void>(`/api/topics/${id}`, { method: 'DELETE' }),
  reorder: async (orderedIds: number[], baseVersion: number) => {
    const response = await fetch('/api/topics/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds, baseVersion }),
    });
    await readBody<void>(response);
    return Number(response.headers.get('X-Order-Version') ?? baseVersion + 1);
  },
  claim: (id: number, presenter: string) =>
    request<Topic>(`/api/topics/${id}/claim`, { method: 'POST', body: JSON.stringify({ presenter }) }),
  schedule: (id: number, data: { scheduledAt: string; duration: number; room: string }) =>
    request<Topic>(`/api/topics/${id}/schedule`, { method: 'POST', body: JSON.stringify(data) }),
  archive: (id: number, data: { takeaway: string; materialUrl: string }) =>
    request<Topic>(`/api/topics/${id}/archive`, { method: 'POST', body: JSON.stringify(data) }),
};
