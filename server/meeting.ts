const MEETING_URL_PATTERN = /(?:https?:\/\/|www\.)[^\s，。；;、"'<>（）()\[\]{}]+/iu;
const MEETING_CREDENTIAL_PATTERN = /(?:会议\s*(?:号码|号|码)|会议密码|入会(?:码|密码)|passcode|pwd)\s*[:：=]?\s*(?=[\p{L}\p{N}_-])|(?:密码|口令)(?!学)\s*[:：=]?\s*(?=[\p{L}\p{N}_-])|(?:腾讯会议|zoom|teams|飞书会议)\s*(?:会议)?\s*(?:号码|号|码)?\s*[:：=]?\s*(?=\d[\d\s-]{4,})/iu;

export type MeetingRoomAnalysis = {
  sensitive: boolean;
  meetingUrl: string | null;
  publicRoom: string;
};

export function extractMeetingUrl(value: string | null | undefined) {
  const match = value?.match(MEETING_URL_PATTERN)?.[0];
  if (!match) return null;
  const normalized = /^www\./i.test(match) ? `https://${match}` : match;
  try {
    const url = new URL(normalized);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function analyzeMeetingRoom(value: string | null | undefined): MeetingRoomAnalysis {
  const room = value?.trim() ?? '';
  const meetingUrl = extractMeetingUrl(room);
  const sensitive = Boolean(meetingUrl || MEETING_CREDENTIAL_PATTERN.test(room));
  return {
    sensitive,
    meetingUrl,
    publicRoom: meetingUrl ? '线上会议' : sensitive ? '线上参与信息已隐藏' : room,
  };
}
