import type { Stats, Topic, TopicSort } from './types';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options?.body ? { 'Content-Type': 'application/json' } : {}), ...options?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? '请求失败，请稍后再试');
  return body as T;
}

export const api = {
  topics: (sort: TopicSort = 'manual') => request<Topic[]>(`/api/topics?sort=${sort}`),
  stats: () => request<Stats>('/api/stats'),
  create: (data: { title: string; summary: string; proposer: string; tags: string[] }) =>
    request<Topic>('/api/topics', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<Pick<Topic, 'title' | 'summary' | 'proposer' | 'presenter' | 'tags' | 'scheduledAt' | 'duration' | 'room' | 'takeaway' | 'materialUrl'>>) =>
    request<Topic>(`/api/topics/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  remove: (id: number) => request<void>(`/api/topics/${id}`, { method: 'DELETE' }),
  reorder: (orderedIds: number[]) => request<void>('/api/topics/reorder', { method: 'POST', body: JSON.stringify({ orderedIds }) }),
  claim: (id: number, presenter: string) =>
    request<Topic>(`/api/topics/${id}/claim`, { method: 'POST', body: JSON.stringify({ presenter }) }),
  schedule: (id: number, data: { scheduledAt: string; duration: number; room: string }) =>
    request<Topic>(`/api/topics/${id}/schedule`, { method: 'POST', body: JSON.stringify(data) }),
  archive: (id: number, data: { takeaway: string; materialUrl: string }) =>
    request<Topic>(`/api/topics/${id}/archive`, { method: 'POST', body: JSON.stringify(data) }),
};
