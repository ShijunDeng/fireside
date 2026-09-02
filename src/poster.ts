import type { Topic } from './types';
import { containsMeetingSensitiveText, redactMeetingSensitiveText } from '../shared/meeting-text';
import { BUSINESS_TIME_ZONE, businessDateKey, formatBusinessTime } from '../shared/schedule';

const POSTER_WIDTH = 1080;
const POSTER_HEIGHT = 1440;
const FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif';

export interface PosterModel {
  topicId: number;
  title: string;
  summary: string;
  date: string;
  time: string;
  dateKey: string;
  timeKey: string;
  programLabel: string;
  presenter: string;
  duration: string;
  location: string;
  tags: string[];
  source: string;
  filename: string;
}

export interface PosterProgramContext {
  /** One-based position in the confirmed same-day schedule. */
  position: number;
  total: number;
}

export interface PosterRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PosterTextBlock {
  x: number;
  y: number;
  fontSize: number;
  lineHeight: number;
  lines: string[];
  bounds: PosterRect;
}

export interface PosterTagLayout {
  text: string;
  bounds: PosterRect;
  textMaxWidth: number;
}

export interface PosterLayout {
  program: {
    bounds: PosterRect;
    labelText: string;
    labelFontSize: number;
    labelMaxWidth: number;
    topicText: string;
  };
  title: PosterTextBlock;
  summary: PosterTextBlock;
  info: PosterRect;
  presenterText: string;
  presenterMaxWidth: number;
  durationText: string;
  locationLines: string[];
  tags: PosterTagLayout[];
  tagRegion: PosterRect;
  footer: PosterRect;
  sourceText: string;
}

export type PosterTextMeasure = (fontSize: number, value: string, fontWeight?: number) => number;

function formatParts(value: string) {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  const time = formatBusinessTime(value);
  return {
    date: `${parts.year}年${parts.month}月${parts.day}日 · ${parts.weekday}`,
    time,
    dateKey: businessDateKey(value).replaceAll('-', ''),
    timeKey: time.slice(0, 5).replace(':', ''),
  };
}

export function sanitizePosterText(value: string) {
  return redactMeetingSensitiveText(value);
}

export function isPosterEligible(topic: Topic, now = new Date()) {
  return topic.status === 'SCHEDULED'
    && Boolean(topic.scheduledAt)
    && new Date(topic.scheduledAt!).getTime() > now.getTime();
}

export function posterLocation(topic: Topic) {
  const room = topic.room?.trim() || '';
  if (topic.meetingUrl || topic.hasMeetingUrl) {
    return room && !containsMeetingSensitiveText(room)
      ? `${sanitizePosterText(room)} · 线上参与 · 会议链接请在议题广场获取`
      : '线上参与 · 会议链接请在议题广场获取';
  }
  if (room && containsMeetingSensitiveText(room)) {
    return '线上参与 · 会议链接请在议题广场获取';
  }
  return sanitizePosterText(room) || '地点待定';
}

export function posterProgramLabel(context?: PosterProgramContext) {
  if (!context
    || !Number.isSafeInteger(context.position)
    || !Number.isSafeInteger(context.total)
    || context.total < 2
    || context.position < 1
    || context.position > context.total) {
    return '即将开讲';
  }
  return `当日第 ${context.position} / ${context.total} 场`;
}

export function posterFilename(dateKeyValue: string, timeKeyValue: string, topicId: number, title: string) {
  const safeTitle = Array.from(sanitizePosterText(title)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-'))
    .slice(0, 36)
    .join('') || '炉边分享';
  return `围炉夜话-${dateKeyValue}-${timeKeyValue}-${topicId}-${safeTitle}.png`;
}

export function buildPosterModel(topic: Topic, origin: string, now = new Date(), programContext?: PosterProgramContext): PosterModel {
  if (!isPosterEligible(topic, now)) {
    throw new Error('排期已过，请先改期或归档');
  }
  if (!topic.scheduledAt || !topic.presenter || !topic.duration) {
    throw new Error('只有信息完整的已排期议题可以生成海报');
  }
  const formatted = formatParts(topic.scheduledAt);
  const safeTitle = sanitizePosterText(topic.title);
  return {
    topicId: topic.id,
    title: safeTitle,
    summary: sanitizePosterText(topic.summary),
    date: formatted.date,
    time: formatted.time,
    dateKey: formatted.dateKey,
    timeKey: formatted.timeKey,
    programLabel: posterProgramLabel(programContext),
    presenter: sanitizePosterText(topic.presenter),
    duration: `${topic.duration} 分钟`,
    location: posterLocation(topic),
    tags: topic.tags.slice(0, 5).map(sanitizePosterText),
    source: origin.replace(/^https?:\/\//, '').replace(/\/$/, '') || '围炉夜话议题广场',
    filename: posterFilename(formatted.dateKey, formatted.timeKey, topic.id, safeTitle),
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

export function fitPosterTitle(
  title: string,
  measure: (fontSize: number, value: string) => number,
  maxHeight = Number.POSITIVE_INFINITY,
) {
  for (let size = 76; size >= 48; size -= 4) {
    const lines = wrapPosterText(title, (value) => measure(size, value), 880, 5);
    const hidden = lines.at(-1)?.endsWith('…');
    const lineHeight = Math.round(size * 1.24);
    if (lines.length * lineHeight <= maxHeight && (!hidden || size === 48)) {
      return { size, lines, lineHeight };
    }
  }
  throw new Error('海报标题没有足够的可用布局空间');
}

export function ellipsizePosterText(text: string, measure: (value: string) => number, maxWidth: number) {
  if (measure(text) <= maxWidth) return text;
  const chars = Array.from(text);
  while (chars.length && measure(`${chars.join('')}…`) > maxWidth) chars.pop();
  return chars.length ? `${chars.join('').trimEnd()}…` : '…';
}

export function buildPosterLayout(model: PosterModel, measure: PosterTextMeasure): PosterLayout {
  const programBounds = { x: 674, y: 92, width: 314, height: 78 };
  const programLabelMaxWidth = programBounds.width - 36;
  let programLabelFontSize = 22;
  while (programLabelFontSize > 16 && measure(programLabelFontSize, model.programLabel, 800) > programLabelMaxWidth) {
    programLabelFontSize -= 1;
  }
  const contentX = 96;
  const contentWidth = 888;
  const titleTop = 228;
  const summaryLineHeight = 48;
  const summaryLines = wrapPosterText(model.summary, (value) => measure(30, value, 400), 880, 3);
  const summaryHeight = summaryLines.length * summaryLineHeight;
  const infoHeight = 290;
  const tagHeight = 46;
  const tagRegionHeight = model.tags.length ? tagHeight : 0;
  const footerTop = 1216;
  const minimumBlockGap = 20;
  const titleToSummaryGap = 24;
  const summaryToInfoGap = 30;
  const infoToTagsGap = 28;
  const maximumInfoTop = footerTop
    - minimumBlockGap
    - tagRegionHeight
    - infoToTagsGap
    - infoHeight;
  const maximumTitleHeight = maximumInfoTop
    - summaryToInfoGap
    - summaryHeight
    - titleToSummaryGap
    - titleTop;
  const title = fitPosterTitle(
    model.title,
    (fontSize, value) => measure(fontSize, value, 900),
    maximumTitleHeight,
  );
  const titleBounds = {
    x: contentX,
    y: titleTop,
    width: 880,
    height: title.lines.length * title.lineHeight,
  };
  const titleBlock: PosterTextBlock = {
    x: contentX,
    y: titleTop + title.size,
    fontSize: title.size,
    lineHeight: title.lineHeight,
    lines: title.lines,
    bounds: titleBounds,
  };

  const summaryTop = titleBounds.y + titleBounds.height + titleToSummaryGap;
  const summaryBlock: PosterTextBlock = {
    x: 98,
    y: summaryTop + 30,
    fontSize: 30,
    lineHeight: summaryLineHeight,
    lines: summaryLines,
    bounds: { x: 98, y: summaryTop, width: 880, height: summaryHeight },
  };

  const summaryBottom = summaryBlock.bounds.y + summaryBlock.bounds.height;
  const info: PosterRect = {
    x: 94,
    y: Math.max(700, summaryBottom + summaryToInfoGap),
    width: 892,
    height: infoHeight,
  };
  const presenterMaxWidth = 470;
  const presenterText = ellipsizePosterText(
    `分享人  ${model.presenter}`,
    (value) => measure(25, value, 600),
    presenterMaxWidth,
  );
  const durationText = `时长  ${model.duration}`;
  const locationLines = wrapPosterText(model.location, (value) => measure(24, value, 600), 790, 2);

  const tagGap = 12;
  const tagTop = info.y + info.height + infoToTagsGap;
  const tagCount = model.tags.length;
  const tagWidth = tagCount
    ? Math.min(210, (contentWidth - tagGap * (tagCount - 1)) / tagCount)
    : 0;
  const tags = model.tags.map((tag, index) => {
    const textMaxWidth = Math.max(1, tagWidth - 32);
    return {
      text: ellipsizePosterText(tag, (value) => measure(20, value, 700), textMaxWidth),
      bounds: { x: contentX + index * (tagWidth + tagGap), y: tagTop, width: tagWidth, height: tagHeight },
      textMaxWidth,
    };
  });
  const tagRegion: PosterRect = { x: contentX, y: tagTop, width: contentWidth, height: tagCount ? tagHeight : 0 };
  const footer: PosterRect = { x: contentX, y: footerTop, width: contentWidth, height: 124 };
  const sourceText = ellipsizePosterText(model.source, (value) => measure(20, value, 500), 330);

  return {
    program: {
      bounds: programBounds,
      labelText: ellipsizePosterText(
        model.programLabel,
        (value) => measure(programLabelFontSize, value, 800),
        programLabelMaxWidth,
      ),
      labelFontSize: programLabelFontSize,
      labelMaxWidth: programLabelMaxWidth,
      topicText: `议题 #${String(model.topicId).padStart(3, '0')}`,
    },
    title: titleBlock,
    summary: summaryBlock,
    info,
    presenterText,
    presenterMaxWidth,
    durationText,
    locationLines,
    tags,
    tagRegion,
    footer,
    sourceText,
  };
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

  const layout = buildPosterLayout(model, (size, value, weight = 400) => {
    context.font = `${weight} ${size}px ${FONT_STACK}`;
    return context.measureText(value).width;
  });
  roundedRect(
    context,
    layout.program.bounds.x,
    layout.program.bounds.y,
    layout.program.bounds.width,
    layout.program.bounds.height,
    layout.program.bounds.height / 2,
  );
  context.fillStyle = 'rgba(255,176,90,.10)';
  context.fill();
  context.strokeStyle = 'rgba(255,176,90,.32)';
  context.stroke();
  context.fillStyle = '#ffc98a';
  context.font = `800 ${layout.program.labelFontSize}px ${FONT_STACK}`;
  context.textAlign = 'center';
  context.fillText(
    layout.program.labelText,
    layout.program.bounds.x + layout.program.bounds.width / 2,
    layout.program.bounds.y + 32,
  );
  context.fillStyle = '#a49a8f';
  context.font = `700 16px ${FONT_STACK}`;
  context.fillText(
    layout.program.topicText,
    layout.program.bounds.x + layout.program.bounds.width / 2,
    layout.program.bounds.y + 59,
  );
  context.textAlign = 'left';

  context.fillStyle = '#fff5e8';
  context.font = `900 ${layout.title.fontSize}px ${FONT_STACK}`;
  drawTextLines(context, layout.title.lines, layout.title.x, layout.title.y, layout.title.lineHeight);

  context.font = `400 30px ${FONT_STACK}`;
  context.fillStyle = '#aaa49a';
  drawTextLines(context, layout.summary.lines, layout.summary.x, layout.summary.y, layout.summary.lineHeight);

  roundedRect(context, layout.info.x, layout.info.y, layout.info.width, layout.info.height, 28);
  context.fillStyle = 'rgba(255,255,255,.045)';
  context.fill();
  context.strokeStyle = 'rgba(122,217,255,.16)';
  context.stroke();

  context.fillStyle = '#7ad9ff';
  context.font = `800 32px ${FONT_STACK}`;
  context.fillText(model.date, 140, layout.info.y + 58);
  context.fillStyle = '#f6f3ee';
  context.font = `900 54px ${FONT_STACK}`;
  context.fillText(model.time, 140, layout.info.y + 118);
  context.strokeStyle = 'rgba(255,255,255,.10)';
  context.beginPath(); context.moveTo(140, layout.info.y + 144); context.lineTo(940, layout.info.y + 144); context.stroke();
  context.font = `600 25px ${FONT_STACK}`;
  context.fillStyle = '#d8d2c9';
  context.fillText(layout.presenterText, 140, layout.info.y + 194);
  context.fillText(layout.durationText, 690, layout.info.y + 194);
  context.fillStyle = '#ffc98a';
  context.font = `600 24px ${FONT_STACK}`;
  drawTextLines(context, layout.locationLines, 140, layout.info.y + 242, 30);

  context.font = `700 20px ${FONT_STACK}`;
  for (const tag of layout.tags) {
    roundedRect(context, tag.bounds.x, tag.bounds.y, tag.bounds.width, tag.bounds.height, 23);
    context.fillStyle = 'rgba(255,176,90,.07)'; context.fill();
    context.strokeStyle = 'rgba(255,176,90,.18)'; context.stroke();
    context.fillStyle = '#d7b489'; context.textAlign = 'center';
    context.fillText(tag.text, tag.bounds.x + tag.bounds.width / 2, tag.bounds.y + 30);
  }
  context.textAlign = 'left';

  context.fillStyle = '#f3d0a7';
  context.font = `900 38px ${FONT_STACK}`;
  context.fillText('为彼此的好奇添一把柴。', layout.footer.x, layout.footer.y + 50);
  context.fillStyle = '#74777d';
  context.font = `500 20px ${FONT_STACK}`;
  context.fillText('详情与报名，请前往围炉夜话议题广场', layout.footer.x, layout.footer.y + 104);
  context.textAlign = 'right';
  context.fillText(layout.sourceText, layout.footer.x + layout.footer.width, layout.footer.y + 104);
  context.textAlign = 'left';
}

export function posterToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG 生成失败，请重试')), 'image/png');
  });
}
