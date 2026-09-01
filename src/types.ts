export type TopicStatus = 'OPEN' | 'CLAIMED' | 'SCHEDULED' | 'ARCHIVED';

export interface Topic {
  id: number;
  position: number;
  title: string;
  summary: string;
  proposer: string;
  presenter: string | null;
  tags: string[];
  status: TopicStatus;
  scheduledAt: string | null;
  duration: number | null;
  room: string | null;
  meetingUrl: string | null;
  participantCount: number;
  takeaway: string | null;
  materialUrl: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface Participant {
  id: number;
  topicId: number;
  name: string;
  createdAt: string;
}

export type TopicSort = 'manual' | 'newest' | 'oldest' | 'schedule' | 'status';

export interface Stats {
  open: number;
  claimed: number;
  scheduled: number;
  archived: number;
  nextTopic: Topic | null;
}
