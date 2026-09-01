import type { Topic } from './types';

const POSTER_WIDTH = 1080;
const POSTER_HEIGHT = 1440;
const FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif';
const ONLINE_PATTERN = /https?:\/\/|www\.|zoom|teams|腾讯会议|飞书|lark|会议号|会议码|密码|passcode/i;
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s，。；;]+/giu;
const CREDENTIAL_PATTERN = /(?:会议号|会议码|密码|passcode)\s*[:：]?\s*[\w-]+/giu;

export interface PosterModel {
  title: string;
  summary: string;
  date: string;
  time: string;
  dateKey: string;
  presenter: string;
  duration: string;
  location: string;
  tags: string[];
  source: string;
  filename: string;
}

function formatParts(value: string) {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}年${parts.month}月${parts.day}日 · ${parts.weekday}`,
    time: `${parts.hour}:${parts.minute} 北京时间`,
    dateKey: `${parts.year}${parts.month.replace(/\D/g, '').padStart(2, '0')}${parts.day.padStart(2, '0')}`,
  };
}

export function sanitizePosterText(value: string) {
  return value
    .replace(URL_PATTERN, '[链接已隐藏]')
    .replace(CREDENTIAL_PATTERN, '[凭证已隐藏]');
}

export function isPosterEligible(topic: Topic, now = new Date()) {
  return topic.status === 'SCHEDULED'
    && Boolean(topic.scheduledAt)
    && new Date(topic.scheduledAt!).getTime() > now.getTime();
}

export function posterLocation(topic: Topic) {
  const room = topic.room?.trim() || '';
  if (topic.meetingUrl || topic.hasMeetingUrl) {
    return room && !ONLINE_PATTERN.test(room)
      ? `${sanitizePosterText(room)} · 线上参与 · 会议链接请在议题广场获取`
      : '线上参与 · 会议链接请在议题广场获取';
  }
  if (room && ONLINE_PATTERN.test(room)) {
    return '线上参与 · 会议链接请在议题广场获取';
  }
  return sanitizePosterText(room) || '地点待定';
}

export function posterFilename(dateKeyValue: string, title: string) {
  const safeTitle = Array.from(title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-'))
    .slice(0, 36)
    .join('') || '炉边分享';
  return `围炉夜话-${dateKeyValue}-${safeTitle}.png`;
}

export function buildPosterModel(topic: Topic, origin: string, now = new Date()): PosterModel {
  if (!isPosterEligible(topic, now)) {
    throw new Error('排期已过，请先改期或归档');
  }
  if (!topic.scheduledAt || !topic.presenter || !topic.duration) {
    throw new Error('只有信息完整的已排期议题可以生成海报');
  }
  const formatted = formatParts(topic.scheduledAt);
  const safeTitle = sanitizePosterText(topic.title);
  return {
    title: safeTitle,
    summary: sanitizePosterText(topic.summary),
    date: formatted.date,
    time: formatted.time,
    dateKey: formatted.dateKey,
    presenter: sanitizePosterText(topic.presenter),
    duration: `${topic.duration} 分钟`,
    location: posterLocation(topic),
    tags: topic.tags.slice(0, 5).map(sanitizePosterText),
    source: origin.replace(/^https?:\/\//, '').replace(/\/$/, '') || '围炉夜话议题广场',
    filename: posterFilename(formatted.dateKey, safeTitle),
  };
}

export function wrapPosterText(text: string, measure: (value: string) => number, maxWidth: number, maxLines: number) {
  const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh-CN', { granularity: 'word' })
    : null;
  const segments = segmenter
    ? Array.from(segmenter.segment(text.trim()), ({ segment }) => segment)
    : Array.from(text.trim());
  const lines: string[] = [];
  let current = '';
  let truncated = false;
  outer: for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    let pending = segments[segmentIndex];
    while (pending) {
      if (measure(current + pending) <= maxWidth) {
        current += pending;
        break;
      }
      if (current) {
        lines.push(current.trimEnd());
        current = '';
        pending = pending.trimStart();
        if (lines.length === maxLines) {
          truncated = true;
          break outer;
        }
        continue;
      }
      const chars = Array.from(pending);
      let chunk = '';
      let count = 0;
      while (count < chars.length && measure(chunk + chars[count]) <= maxWidth) {
        chunk += chars[count];
        count += 1;
      }
      if (!chunk) {
        chunk = chars[0];
        count = 1;
      }
      lines.push(chunk.trimEnd());
      pending = chars.slice(count).join('');
      if (lines.length === maxLines) {
        truncated = Boolean(pending) || segmentIndex < segments.length - 1;
        break outer;
      }
    }
  }
  if (lines.length < maxLines && current) lines.push(current.trimEnd());
  else if (current) truncated = true;
  if (truncated && lines.length) {
    let last = lines.at(-1)!;
    while (last && measure(`${last}…`) > maxWidth) last = Array.from(last).slice(0, -1).join('');
    lines[lines.length - 1] = `${last.trimEnd()}…`;
  }
  return lines;
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function drawTextLines(context: CanvasRenderingContext2D, lines: string[], x: number, y: number, lineHeight: number) {
  lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight));
}

export function fitPosterTitle(title: string, measure: (fontSize: number, value: string) => number) {
  for (let size = 76; size >= 48; size -= 4) {
    const lines = wrapPosterText(title, (value) => measure(size, value), 880, 5);
    const hidden = lines.at(-1)?.endsWith('…');
    if (!hidden || size === 48) return { size, lines, lineHeight: Math.round(size * 1.24) };
  }
  return { size: 48, lines: [title], lineHeight: 60 };
}

export function renderTopicPoster(canvas: HTMLCanvasElement, model: PosterModel) {
  canvas.width = POSTER_WIDTH;
  canvas.height = POSTER_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法创建海报画布');

  const background = context.createLinearGradient(0, 0, 0, POSTER_HEIGHT);
  background.addColorStop(0, '#080a0d');
  background.addColorStop(.56, '#11141a');
  background.addColorStop(1, '#090b0e');
  context.fillStyle = background;
  context.fillRect(0, 0, POSTER_WIDTH, POSTER_HEIGHT);

  context.strokeStyle = 'rgba(255,255,255,.035)';
  context.lineWidth = 1;
  for (let x = 0; x <= POSTER_WIDTH; x += 48) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, POSTER_HEIGHT); context.stroke(); }
  for (let y = 0; y <= POSTER_HEIGHT; y += 48) { context.beginPath(); context.moveTo(0, y); context.lineTo(POSTER_WIDTH, y); context.stroke(); }

  const glow = context.createRadialGradient(820, 300, 0, 820, 300, 520);
  glow.addColorStop(0, 'rgba(255,116,74,.18)');
  glow.addColorStop(1, 'rgba(255,116,74,0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, POSTER_WIDTH, 820);

  context.save();
  context.translate(95, 94);
  context.fillStyle = '#ff8f55';
  context.beginPath();
  context.moveTo(24, 0); context.bezierCurveTo(56, 38, 61, 70, 30, 93); context.bezierCurveTo(-2, 78, -8, 42, 24, 0); context.fill();
  context.fillStyle = '#ffd27a';
  context.beginPath();
  context.moveTo(25, 42); context.bezierCurveTo(42, 61, 40, 78, 26, 86); context.bezierCurveTo(12, 77, 10, 59, 25, 42); context.fill();
  context.restore();

  context.fillStyle = '#f6f3ee';
  context.font = `900 31px ${FONT_STACK}`;
  context.fillText('围炉夜话', 162, 132);
  context.fillStyle = '#8d929b';
  context.font = `700 17px ${FONT_STACK}`;
  context.letterSpacing = '3px';
  context.fillText('WEEKLY · AI FIRESIDE CHAT', 162, 166);
  context.letterSpacing = '0px';

  roundedRect(context, 778, 93, 210, 62, 31);
  context.fillStyle = 'rgba(255,176,90,.10)';
  context.fill();
  context.strokeStyle = 'rgba(255,176,90,.32)';
  context.stroke();
  context.fillStyle = '#ffc98a';
  context.font = `800 24px ${FONT_STACK}`;
  context.textAlign = 'center';
  context.fillText('即 将 开 讲', 883, 133);
  context.textAlign = 'left';

  const title = fitPosterTitle(model.title, (size, value) => {
    context.font = `900 ${size}px ${FONT_STACK}`;
    return context.measureText(value).width;
  });
  context.fillStyle = '#fff5e8';
  context.font = `900 ${title.size}px ${FONT_STACK}`;
  drawTextLines(context, title.lines, 96, 300, title.lineHeight);
  const titleBottom = 300 + title.lines.length * title.lineHeight;

  context.font = `400 30px ${FONT_STACK}`;
  context.fillStyle = '#aaa49a';
  const summary = wrapPosterText(model.summary, (value) => context.measureText(value).width, 880, 3);
  drawTextLines(context, summary, 98, titleBottom + 56, 48);

  const infoTop = Math.max(760, titleBottom + 250);
  roundedRect(context, 94, infoTop, 892, 310, 28);
  context.fillStyle = 'rgba(255,255,255,.045)';
  context.fill();
  context.strokeStyle = 'rgba(122,217,255,.16)';
  context.stroke();

  context.fillStyle = '#7ad9ff';
  context.font = `800 32px ${FONT_STACK}`;
  context.fillText(model.date, 140, infoTop + 66);
  context.fillStyle = '#f6f3ee';
  context.font = `900 54px ${FONT_STACK}`;
  context.fillText(model.time, 140, infoTop + 130);
  context.strokeStyle = 'rgba(255,255,255,.10)';
  context.beginPath(); context.moveTo(140, infoTop + 160); context.lineTo(940, infoTop + 160); context.stroke();
  context.font = `600 25px ${FONT_STACK}`;
  context.fillStyle = '#d8d2c9';
  context.fillText(`分享人  ${model.presenter}`, 140, infoTop + 212);
  context.fillText(`时长  ${model.duration}`, 650, infoTop + 212);
  context.fillStyle = '#ffc98a';
  context.font = `600 24px ${FONT_STACK}`;
  const location = wrapPosterText(model.location, (value) => context.measureText(value).width, 790, 2);
  drawTextLines(context, location, 140, infoTop + 263, 34);

  let tagX = 96;
  const tagY = infoTop + 352;
  context.font = `700 20px ${FONT_STACK}`;
  for (const tag of model.tags) {
    const width = Math.min(210, context.measureText(tag).width + 40);
    if (tagX + width > 984) break;
    roundedRect(context, tagX, tagY, width, 46, 23);
    context.fillStyle = 'rgba(255,176,90,.07)'; context.fill();
    context.strokeStyle = 'rgba(255,176,90,.18)'; context.stroke();
    context.fillStyle = '#d7b489'; context.textAlign = 'center'; context.fillText(tag, tagX + width / 2, tagY + 30);
    tagX += width + 12;
  }
  context.textAlign = 'left';

  context.fillStyle = '#f3d0a7';
  context.font = `900 38px ${FONT_STACK}`;
  context.fillText('为彼此的好奇添一把柴。', 96, 1266);
  context.fillStyle = '#74777d';
  context.font = `500 20px ${FONT_STACK}`;
  context.fillText('详情与报名，请前往围炉夜话议题广场', 96, 1320);
  context.textAlign = 'right';
  context.fillText(model.source, 984, 1320);
  context.textAlign = 'left';
}

export function posterToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG 生成失败，请重试')), 'image/png');
  });
}
