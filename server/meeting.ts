import {
  containsMeetingSensitiveText,
  extractMeetingUrl,
} from '../shared/meeting-text.js';

export { extractMeetingUrl } from '../shared/meeting-text.js';

export type MeetingRoomAnalysis = {
  sensitive: boolean;
  meetingUrl: string | null;
  publicRoom: string;
};

export function analyzeMeetingRoom(value: string | null | undefined): MeetingRoomAnalysis {
  const room = value?.trim() ?? '';
  const meetingUrl = extractMeetingUrl(room);
  const sensitive = containsMeetingSensitiveText(room);
  return {
    sensitive,
    meetingUrl,
    publicRoom: meetingUrl ? '线上会议' : sensitive ? '线上参与信息已隐藏' : room,
  };
}
