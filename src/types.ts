export type TopicStatus = 'OPEN' | 'CLAIMED' | 'SCHEDULED' | 'ARCHIVED';

export interface Topic {
  id: number;
  title: string;
  summary: string;
  proposer: string;
  presenter: string | null;
  tags: string[];
  status: TopicStatus;
  scheduledAt: string | null;
  duration: number | null;
  room: string | null;
  takeaway: string | null;
  materialUrl: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface Stats {
  open: number;
  scheduled: number;
  archived: number;
  nextTopic: Topic | null;
}
