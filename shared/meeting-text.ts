export type MeetingSensitiveSpan = {
  start: number;
  end: number;
  kind: 'url' | 'credential';
};

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s,，。;；、！？"'<>]+/giu;
const LABELED_CREDENTIAL_PATTERN = /会议\s*(?:密码|号码|号|码)|入会\s*(?:号码|号|码|密码|口令)|密码(?!学)|口令|(?<![A-Za-z0-9_])meeting\s+(?:id|number|code)(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?:passcode|password|pwd|pin)(?![A-Za-z0-9_])/giu;
const PROVIDER_PATTERN = /腾讯会议|zoom|teams|飞书会议/giu;
const VALUE_SEPARATOR = /[:：=＝#＃]/u;
const VALUE_CHARACTER = /[\p{L}\p{N}]/u;
const DIRECT_VALUE_CHARACTER = /[A-Za-z0-9_-]/u;
const DIGIT = /\p{N}/u;
const MEETING_ID_CHARACTER = /[\p{N}\p{Zs}\t\-–—]/u;
const HARD_TERMINATORS = new Set(Array.from(',，。;；、!！?？)）]】}|'));
const SENTENCE_END = /[.．!?！？]/u;
const CREDENTIAL_BRACKET_PAIRS = new Map([
  ['(', ')'],
  ['（', '）'],
  ['[', ']'],
  ['【', '】'],
  ['〔', '〕'],
]);
const URL_BRACKET_PAIRS = new Map([
  ...CREDENTIAL_BRACKET_PAIRS,
  ['{', '}'],
]);
const URL_BRACKET_OPENERS = new Set(URL_BRACKET_PAIRS.keys());
const URL_BRACKET_CLOSERS = new Set(URL_BRACKET_PAIRS.values());

function trimUrlEnd(value: string) {
  const stack: string[] = [];
  let end = value.length;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (URL_BRACKET_OPENERS.has(character)) {
      stack.push(character);
      continue;
    }
    if (!URL_BRACKET_CLOSERS.has(character)) continue;
    const opening = stack.at(-1);
    if (opening && URL_BRACKET_PAIRS.get(opening) === character) {
      stack.pop();
      continue;
    }
    end = index;
    break;
  }
  while (end > 0 && SENTENCE_END.test(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

function urlSpans(value: string) {
  const spans: MeetingSensitiveSpan[] = [];
  for (const match of value.matchAll(URL_PATTERN)) {
    const raw = trimUrlEnd(match[0]);
    if (!raw || match.index === undefined) continue;
    spans.push({ start: match.index, end: match.index + raw.length, kind: 'url' });
  }
  return spans;
}

function insideSpan(index: number, spans: MeetingSensitiveSpan[]) {
  return spans.some(({ start, end }) => index >= start && index < end);
}

function valueStart(value: string, markerEnd: number) {
  let index = markerEnd;
  let hasBoundary = false;
  while (index < value.length && /\s/u.test(value[index])) {
    hasBoundary = true;
    index += 1;
  }
  if (index < value.length && VALUE_SEPARATOR.test(value[index])) {
    hasBoundary = true;
    index += 1;
    while (index < value.length && /\s/u.test(value[index])) index += 1;
  }
  const opening = value[index];
  const closing = CREDENTIAL_BRACKET_PAIRS.get(opening);
  if (closing) {
    hasBoundary = true;
    index += 1;
    while (index < value.length && /\s/u.test(value[index])) index += 1;
  }
  return { index, hasBoundary, opening: closing ? opening : null, closing: closing ?? null };
}

function trimPayloadEnd(value: string, start: number, end: number) {
  while (end > start && /\s/u.test(value[end - 1])) end -= 1;
  return end;
}

function pairedValueEnd(value: string, start: number, opening: string, closing: string) {
  let depth = 1;
  for (let end = start; end < value.length; end += 1) {
    if (value[end] === opening) depth += 1;
    else if (value[end] === closing) {
      depth -= 1;
      if (depth === 0) return end + 1;
    }
  }
  return 0;
}

function credentialEnd(value: string, start: number, opening: string | null, closing: string | null) {
  if (opening && closing) {
    const pairedEnd = pairedValueEnd(value, start, opening, closing);
    if (pairedEnd) return pairedEnd;
  }
  let end = start;
  while (end < value.length && !HARD_TERMINATORS.has(value[end])) end += 1;
  return trimPayloadEnd(value, start, end);
}

function providerCredentialEnd(value: string, start: number, opening: string | null, closing: string | null) {
  if (opening && closing) {
    const pairedEnd = pairedValueEnd(value, start, opening, closing);
    if (!pairedEnd) return start;
    const digits = Array.from(value.slice(start, pairedEnd - 1)).filter((character) => DIGIT.test(character)).length;
    return digits >= 5 ? pairedEnd : start;
  }
  let end = start;
  let digits = 0;
  while (end < value.length && MEETING_ID_CHARACTER.test(value[end])) {
    if (DIGIT.test(value[end])) digits += 1;
    end += 1;
  }
  end = trimPayloadEnd(value, start, end);
  return digits >= 5 ? end : start;
}

function isNumericMeetingLabel(label: string) {
  return /^(?:会议\s*(?:号码|号|码)|入会\s*(?:号码|号)|meeting\s+(?:id|number|code))$/iu.test(label);
}

function numericMeetingCredentialEnd(value: string, start: number) {
  let end = start;
  let digits = 0;
  let lastDigitEnd = start;
  while (end < value.length && MEETING_ID_CHARACTER.test(value[end])) {
    if (DIGIT.test(value[end])) {
      digits += 1;
      lastDigitEnd = end + 1;
    }
    end += 1;
  }
  if (!digits) return 0;
  if (end < value.length && !/[\r\n]/u.test(value[end])) {
    const separator = value.slice(lastDigitEnd, end);
    if (!/[\p{Zs}\t]/u.test(separator)) return 0;
  }
  return lastDigitEnd;
}

function labeledCredentialSpans(value: string, urls: MeetingSensitiveSpan[]) {
  const spans: MeetingSensitiveSpan[] = [];
  for (const match of value.matchAll(LABELED_CREDENTIAL_PATTERN)) {
    if (match.index === undefined || insideSpan(match.index, urls)) continue;
    const markerEnd = match.index + match[0].length;
    const start = valueStart(value, markerEnd);
    if (start.index >= value.length) continue;
    if (!start.hasBoundary && !DIRECT_VALUE_CHARACTER.test(value[start.index])) continue;
    const numericEnd = !start.opening && isNumericMeetingLabel(match[0]) && DIGIT.test(value[start.index])
      ? numericMeetingCredentialEnd(value, start.index)
      : 0;
    const end = numericEnd || credentialEnd(value, start.index, start.opening, start.closing);
    if (end <= start.index || !VALUE_CHARACTER.test(value.slice(start.index, end))) continue;
    spans.push({ start: match.index, end, kind: 'credential' });
  }
  return spans;
}

function providerCredentialSpans(value: string, urls: MeetingSensitiveSpan[]) {
  const spans: MeetingSensitiveSpan[] = [];
  for (const match of value.matchAll(PROVIDER_PATTERN)) {
    if (match.index === undefined || insideSpan(match.index, urls)) continue;
    const markerEnd = match.index + match[0].length;
    const start = valueStart(value, markerEnd);
    if (!start.hasBoundary) continue;
    const end = providerCredentialEnd(value, start.index, start.opening, start.closing);
    if (end > start.index) spans.push({ start: match.index, end, kind: 'credential' });
  }
  return spans;
}

function mergeSpans(spans: MeetingSensitiveSpan[]) {
  const ordered = [...spans].sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: MeetingSensitiveSpan[] = [];
  for (const span of ordered) {
    const previous = merged.at(-1);
    if (!previous || span.start > previous.end) {
      merged.push({ ...span });
      continue;
    }
    previous.end = Math.max(previous.end, span.end);
    if (previous.kind !== span.kind) previous.kind = 'credential';
  }
  return merged;
}

export function findMeetingSensitiveSpans(value: string) {
  const urls = urlSpans(value);
  return mergeSpans([
    ...urls,
    ...labeledCredentialSpans(value, urls),
    ...providerCredentialSpans(value, urls),
  ]);
}

export function containsMeetingSensitiveText(value: string | null | undefined) {
  return Boolean(value && findMeetingSensitiveSpans(value).length);
}

export function redactMeetingSensitiveText(value: string) {
  const spans = findMeetingSensitiveSpans(value);
  if (!spans.length) return value;
  let output = '';
  let cursor = 0;
  for (const span of spans) {
    output += value.slice(cursor, span.start);
    output += span.kind === 'url' ? '[链接已隐藏]' : '[凭证已隐藏]';
    cursor = span.end;
  }
  return output + value.slice(cursor);
}

export function extractMeetingUrl(value: string | null | undefined) {
  if (!value) return null;
  for (const span of urlSpans(value)) {
    const candidate = value.slice(span.start, span.end);
    const normalized = /^www\./i.test(candidate) ? `https://${candidate}` : candidate;
    try {
      const url = new URL(normalized);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
    } catch {
      // Continue in case a later URL-like span is valid.
    }
  }
  return null;
}
