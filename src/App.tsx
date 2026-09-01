import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Calendar,
  CalendarDays,
  CalendarRange,
  CalendarX2,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Flame,
  GripVertical,
  ImageDown,
  Lightbulb,
  Link as LinkIcon,
  List,
  MapPin,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Share2,
  Sparkles,
  Trash2,
  UserRound,
  UserRoundPlus,
  Users,
  X,
} from 'lucide-react';
import { api, ApiError } from './api';
import { buildMonthDays, buildWeekDays, dateKey, formatDateTimeInput, startOfWeek } from './calendar';
import { buildPosterModel, isPosterEligible, posterToBlob, renderTopicPoster } from './poster';
import type { Participant, Stats, Topic, TopicSort, TopicStatus } from './types';

type Tab = 'ALL' | TopicStatus;
type ModalKind = 'create' | 'claim' | 'schedule' | 'archive' | 'edit' | 'delete' | 'release' | 'unschedule' | 'unarchive';
type ViewMode = 'list' | 'month' | 'week';

const tabs: { key: Tab; label: string }[] = [
  { key: 'ALL', label: '全部议题' },
  { key: 'OPEN', label: '等待认领' },
  { key: 'CLAIMED', label: '准备中' },
  { key: 'SCHEDULED', label: '已排期' },
  { key: 'ARCHIVED', label: '往期归档' },
];

const statusMeta: Record<TopicStatus, { label: string; className: string }> = {
  OPEN: { label: '等待添柴', className: 'open' },
  CLAIMED: { label: '已被认领', className: 'claimed' },
  SCHEDULED: { label: '已排期', className: 'scheduled' },
  ARCHIVED: { label: '已经归档', className: 'archived' },
};

function formatDate(value: string, withYear = false) {
  return new Intl.DateTimeFormat('zh-CN', {
    ...(withYear ? { year: 'numeric' } : {}),
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function defaultScheduleTime() {
  const date = new Date();
  date.setDate(date.getDate() + ((4 - date.getDay() + 7) % 7 || 7));
  date.setHours(19, 30, 0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function legacyMeetingUrl(room: string | null) {
  return room && /^https?:\/\/\S+$/i.test(room) ? room : null;
}

function topicMeetingUrl(topic: Topic) {
  return topic.meetingUrl ?? legacyMeetingUrl(topic.room);
}

const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useDialogA11y(onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const returnFocusRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const returnFocusKey = returnFocusRef.current?.dataset.focusReturn;
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => {
      (dialog.querySelector<HTMLElement>('[data-initial-focus]') ?? dialog.querySelector<HTMLElement>(focusableSelector) ?? dialog).focus();
    });
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog!.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        dialog!.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      let attempts = 0;
      const restoreFocus = () => {
        const original = returnFocusRef.current;
        const fallback = returnFocusKey ? document.querySelector<HTMLElement>(`[data-focus-return="${CSS.escape(returnFocusKey)}"]`) : null;
        const target = original?.isConnected ? original : fallback;
        if (target) target.focus();
        else if (returnFocusKey && attempts++ < 30) window.requestAnimationFrame(restoreFocus);
      };
      window.requestAnimationFrame(restoreFocus);
    };
  }, []);
  return dialogRef;
}

function FireVisual() {
  return (
    <div className="fire-card" aria-label="围炉夜话的篝火插画">
      <div className="fire-topline"><span>FIRE IS ON</span><b>OPEN TOPICS</b></div>
      <div className="orbit orbit-a" />
      <div className="orbit orbit-b" />
      <span className="float-chip chip-a">Curiosity</span>
      <span className="float-chip chip-b">Connect the dots</span>
      <span className="float-chip chip-c">Demo</span>
      <span className="float-chip chip-d">Unknown</span>
      <div className="sparks">{Array.from({ length: 9 }).map((_, i) => <i key={i} />)}</div>
      <div className="campfire">
        <div className="flame flame-back" />
        <div className="flame flame-main"><div className="flame-core" /></div>
        <div className="log log-a" /><div className="log log-b" />
      </div>
      <div className="fire-caption"><Flame size={15} /><span>好奇是火种，分享让微光成为火焰</span></div>
    </div>
  );
}

function TopicCard({ topic, onAction, onParticipants, onPoster, draggable, reordering, index, total, onDragStart, onDrop, onMove }: {
  topic: Topic;
  onAction: (kind: ModalKind, topic: Topic) => void;
  onParticipants: (topic: Topic) => void;
  onPoster: (topic: Topic) => void;
  draggable: boolean;
  reordering: boolean;
  index: number;
  total: number;
  onDragStart: (id: number) => void;
  onDrop: (id: number) => void;
  onMove: (id: number, direction: -1 | 1) => void;
}) {
  const overdue = topic.status === 'SCHEDULED' && Boolean(topic.scheduledAt) && !isPosterEligible(topic);
  const meta = overdue ? { label: '待归档', className: 'scheduled' } : statusMeta[topic.status];
  const meetingUrl = topicMeetingUrl(topic);
  return (
    <article
      className={`topic-card topic-${meta.className} ${draggable ? 'is-draggable' : ''}`}
      onDragOver={(event) => draggable && !reordering && event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); onDrop(topic.id); }}
    >
      <div className="topic-head">
        <span className={`status-pill ${meta.className}`}><i />{meta.label}</span>
        <div className="topic-head-actions">
          {draggable && <>
            <button className="drag-handle" disabled={reordering} draggable={!reordering} onDragStart={(event) => { event.stopPropagation(); onDragStart(topic.id); }} title="拖动排序" aria-label={`拖动 ${topic.title} 排序`}><GripVertical size={14} /></button>
            <button disabled={reordering || index === 0} onClick={() => onMove(topic.id, -1)} title="上移" aria-label={`将 ${topic.title} 上移`}><ArrowUp size={13} /></button>
            <button disabled={reordering || index === total - 1} onClick={() => onMove(topic.id, 1)} title="下移" aria-label={`将 ${topic.title} 下移`}><ArrowDown size={13} /></button>
          </>}
          <span className="topic-number">#{String(topic.id).padStart(3, '0')}</span>
          <button onClick={() => onAction('edit', topic)} title="编辑议题" aria-label={`编辑 ${topic.title}`}><Pencil size={13} /></button>
          <button className="danger" onClick={() => onAction('delete', topic)} title="删除议题" aria-label={`删除 ${topic.title}`}><Trash2 size={13} /></button>
        </div>
      </div>
      <div className="topic-tags">
        {topic.tags.map((tag) => <span key={tag}>{tag}</span>)}
      </div>
      <h3>{topic.title}</h3>
      <p className="topic-summary">{topic.summary}</p>

      {topic.status === 'SCHEDULED' && topic.scheduledAt && (
        <div className="schedule-box">
          <div><CalendarDays size={16} /><strong>{formatDate(topic.scheduledAt)}</strong></div>
          <div><MapPin size={15} /><span>{legacyMeetingUrl(topic.room) ? '线上会议' : topic.room}</span><Clock3 size={15} /><span>{topic.duration} 分钟</span></div>
          {meetingUrl && <a className="meeting-link" href={meetingUrl} target="_blank" rel="noreferrer"><LinkIcon size={14} />加入会议</a>}
          {overdue && <p className="schedule-overdue">排期已过，请完成归档或编辑后重新安排。</p>}
        </div>
      )}

      {topic.status === 'ARCHIVED' && topic.takeaway && (
        <div className="takeaway"><Lightbulb size={16} /><p><b>炉边余温</b>{topic.takeaway}</p></div>
      )}

      <div className="topic-footer">
        <div className="people">
          <span><UserRound size={14} /> 发起 · {topic.proposer}</span>
          {topic.presenter && <span><Flame size={14} /> 分享 · {topic.presenter}</span>}
          {(topic.status === 'SCHEDULED' || topic.status === 'ARCHIVED') && <span><Users size={14} /> {topic.participantCount} 人报名</span>}
        </div>
        <div className="card-action-group">
          {topic.status === 'OPEN' && <button className="card-action warm" onClick={() => onAction('claim', topic)}>认领议题 <ArrowRight size={15} /></button>}
          {topic.status === 'CLAIMED' && <>
            <button className="card-action subtle" onClick={() => onAction('release', topic)}>重新开放 <RotateCcw size={14} /></button>
            <button className="card-action cyan" onClick={() => onAction('schedule', topic)}>安排分享 <CalendarDays size={15} /></button>
          </>}
          {topic.status === 'SCHEDULED' && <>
            <button className="card-action subtle" onClick={() => onAction('unschedule', topic)}>取消排期 <CalendarX2 size={14} /></button>
            <button className="card-action cyan" data-focus-return={`participants-${topic.id}`} onClick={() => onParticipants(topic)}>报名参加 <Users size={14} /></button>
            {!overdue && <button className="card-action warm" data-focus-return={`poster-${topic.id}`} onClick={() => onPoster(topic)}>生成海报 <ImageDown size={14} /></button>}
            <button className="card-action" onClick={() => onAction('archive', topic)}>完成归档 <Archive size={15} /></button>
          </>}
          {topic.status === 'ARCHIVED' && <>
            <button className="card-action subtle" onClick={() => onAction('unarchive', topic)}>撤销归档 <RotateCcw size={14} /></button>
            <button className="card-action" data-focus-return={`participants-${topic.id}`} onClick={() => onParticipants(topic)}>查看参与 <Users size={14} /></button>
            {topic.materialUrl && <a className="card-action" href={topic.materialUrl} target="_blank" rel="noreferrer">查看资料 <LinkIcon size={15} /></a>}
          </>}
        </div>
      </div>
    </article>
  );
}

function CalendarView({ topics, mode, cursor, onCursorChange, onEdit }: {
  topics: Topic[];
  mode: Exclude<ViewMode, 'list'>;
  cursor: Date;
  onCursorChange: (date: Date) => void;
  onEdit: (topic: Topic) => void;
}) {
  const today = new Date();
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set());
  const scheduledTopics = topics.filter((topic) => topic.scheduledAt);
  const weekStart = startOfWeek(cursor);
  const days = mode === 'month'
    ? buildMonthDays(cursor)
    : buildWeekDays(cursor);
  const rangeEnd = days.at(-1)!;
  const title = mode === 'month'
    ? `${cursor.getFullYear()} 年 ${cursor.getMonth() + 1} 月`
    : `${weekStart.getMonth() + 1}月${weekStart.getDate()}日 — ${rangeEnd.getMonth() + 1}月${rangeEnd.getDate()}日`;

  function changePeriod(direction: number) {
    const next = new Date(cursor);
    if (mode === 'month') next.setMonth(next.getMonth() + direction, 1);
    else next.setDate(next.getDate() + direction * 7);
    onCursorChange(next);
  }

  function eventsForDate(date: Date) {
    const key = dateKey(date);
    return scheduledTopics
      .filter((topic) => topic.scheduledAt && dateKey(new Date(topic.scheduledAt)) === key)
      .sort((a, b) => new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime());
  }

  return (
    <div className={`calendar-shell ${mode}`}>
      <div className="calendar-toolbar">
        <div className="calendar-nav">
          <button onClick={() => changePeriod(-1)} aria-label="上一个周期"><ChevronLeft size={16} /></button>
          <button className="today-button" onClick={() => onCursorChange(new Date())}>今天</button>
          <button onClick={() => changePeriod(1)} aria-label="下一个周期"><ChevronRight size={16} /></button>
        </div>
        <h3>{title}</h3>
        <div className="calendar-legend"><span className="scheduled" />已排期 <span className="archived" />已经归档</div>
      </div>

      {mode === 'month' ? (
        <div className="month-scroll">
          <div className="month-calendar">
            {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((day) => <div className="weekday" key={day}>{day}</div>)}
            {days.map((day) => {
              const events = eventsForDate(day);
              const key = dateKey(day);
              const expanded = expandedDays.has(key);
              const isToday = dateKey(day) === dateKey(today);
              const outside = day.getMonth() !== cursor.getMonth();
              return <div className={`calendar-day ${isToday ? 'today' : ''} ${outside ? 'outside' : ''}`} key={key}>
                <span className="day-number">{day.getDate()}</span>
                <div className="day-events">
                  {events.slice(0, expanded ? events.length : 3).map((topic) => <button key={topic.id} className={`calendar-event ${statusMeta[topic.status].className}`} onClick={() => onEdit(topic)} title={topic.title}>
                    <time>{new Date(topic.scheduledAt!).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
                    <span>{topic.title}</span>
                  </button>)}
                  {events.length > 3 && <button className="day-more" onClick={() => setExpandedDays((current) => {
                    const next = new Set(current);
                    if (next.has(key)) next.delete(key); else next.add(key);
                    return next;
                  })}>{expanded ? '收起' : `还有 ${events.length - 3} 个议题`}</button>}
                </div>
              </div>;
            })}
          </div>
        </div>
      ) : (
        <div className="week-scroll">
          <div className="week-calendar">
            {days.map((day) => {
              const events = eventsForDate(day);
              const isToday = dateKey(day) === dateKey(today);
              return <div className={`week-day ${isToday ? 'today' : ''}`} key={dateKey(day)}>
                <div className="week-day-head"><span>{['周日', '周一', '周二', '周三', '周四', '周五', '周六'][day.getDay()]}</span><strong>{day.getDate()}</strong></div>
                <div className="week-events">
                  {events.length ? events.map((topic) => {
                    const meetingUrl = topicMeetingUrl(topic);
                    return <div key={topic.id} className={`week-event ${statusMeta[topic.status].className}`}>
                      <button className="week-event-main" onClick={() => onEdit(topic)} aria-label={`编辑 ${topic.title}`}>
                        <time>{new Date(topic.scheduledAt!).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
                        <strong>{topic.title}</strong>
                        <span><UserRound size={12} />{topic.presenter ?? '待定'}</span>
                        <span><MapPin size={12} />{legacyMeetingUrl(topic.room) ? '线上会议' : topic.room ?? '地点待定'}</span>
                        <small>{topic.duration ?? 0} 分钟</small>
                      </button>
                      {meetingUrl && <a className="week-join" href={meetingUrl} target="_blank" rel="noreferrer"><LinkIcon size={12} />加入会议</a>}
                    </div>;
                  }) : <p className="no-events">留一晚给未知</p>}
                </div>
              </div>;
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ParticipantsModal({ topic, onClose, onChanged }: {
  topic: Topic;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const canJoin = topic.status === 'SCHEDULED';
  const dialogRef = useDialogA11y(onClose);

  const loadParticipants = useCallback(async () => {
    try {
      setParticipants(await api.participants(topic.id));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '报名名单加载失败');
    } finally {
      setLoading(false);
    }
  }, [topic.id]);

  useEffect(() => { void loadParticipants(); }, [loadParticipants]);

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setSubmitting(true);
    setError('');
    try {
      await api.join(topic.id, String(data.get('name')));
      form.reset();
      await loadParticipants();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : '报名失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  async function leave(participant: Participant) {
    setSubmitting(true);
    setError('');
    try {
      await api.leave(topic.id, participant.id);
      await loadParticipants();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : '取消报名失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div ref={dialogRef} className="modal participants-modal" role="dialog" aria-modal="true" aria-labelledby="participants-title" tabIndex={-1}>
      <button className="modal-close" onClick={onClose} aria-label="关闭"><X size={19} /></button>
      <span className="modal-eyebrow"><Users size={14} /> FIRESIDE GUESTS</span>
      <h2 id="participants-title">{canJoin ? '报名参加围炉' : '本期参与伙伴'}</h2>
      <p className="modal-intro">可以来分享，也可以只守着火光坐一会儿。姓名是公开署名，当前不绑定个人账号。</p>
      <div className="selected-topic"><span>本次议题</span><strong>{topic.title}</strong></div>
      {canJoin && <form className="join-form" onSubmit={join}>
        <label>你的名字<input name="name" required maxLength={30} placeholder="怎么称呼你" autoFocus data-initial-focus /></label>
        <button className="submit-btn" disabled={submitting} type="submit">{submitting ? '正在处理…' : '确认报名'}{!submitting && <ChevronRight size={17} />}</button>
      </form>}
      <div className="participant-list" aria-live="polite">
        <div className="participant-list-head"><b>参与名单</b><span>{participants.length} 人</span></div>
        {loading ? <p>正在靠近炉火…</p> : participants.length === 0 ? <p>还没有人报名，成为第一位围炉伙伴吧。</p> : participants.map((participant) => <div className="participant-row" key={participant.id}>
          <span><UserRound size={14} />{participant.name}</span>
          {canJoin && <button disabled={submitting} onClick={() => void leave(participant)} aria-label={`取消 ${participant.name} 的报名`}>取消报名</button>}
        </div>)}
      </div>
      {error && <div className="form-error">{error}</div>}
    </div>
  </div>;
}

function PosterModal({ topic, onClose }: { topic: Topic; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dialogRef = useDialogA11y(onClose);
  const [attempt, setAttempt] = useState(0);
  const [posterBlob, setPosterBlob] = useState<Blob | null>(null);
  const [posterUrl, setPosterUrl] = useState('');
  const [generating, setGenerating] = useState(true);
  const [canShare, setCanShare] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const modelResult = useMemo(() => {
    try {
      return { model: buildPosterModel(topic, window.location.origin), error: '' };
    } catch (err) {
      return { model: null, error: err instanceof Error ? err.message : '海报信息不完整' };
    }
  }, [topic]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';
    setGenerating(true);
    setPosterBlob(null);
    setPosterUrl('');
    setCanShare(false);
    setNotice('');
    setError(modelResult.error);
    if (!modelResult.model) {
      setGenerating(false);
      return;
    }
    void (async () => {
      try {
        await document.fonts?.ready;
        if (!canvasRef.current || cancelled) return;
        renderTopicPoster(canvasRef.current, modelResult.model!);
        const blob = await posterToBlob(canvasRef.current);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        const file = new File([blob], modelResult.model!.filename, { type: 'image/png' });
        setPosterBlob(blob);
        setPosterUrl(objectUrl);
        setCanShare(Boolean(navigator.canShare?.({ files: [file] })));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '海报生成失败，请重试');
      } finally {
        if (!cancelled) setGenerating(false);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attempt, modelResult]);

  function downloadPoster() {
    if (!posterUrl || !modelResult.model) return;
    const anchor = document.createElement('a');
    anchor.href = posterUrl;
    anchor.download = modelResult.model.filename;
    anchor.click();
  }

  async function sharePoster() {
    if (!posterBlob || !modelResult.model) return;
    try {
      const file = new File([posterBlob], modelResult.model.filename, { type: 'image/png' });
      await navigator.share({ title: `围炉夜话 · ${modelResult.model.title}`, files: [file] });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setNotice('分享没有完成，你仍可以下载或长按图片保存。');
    }
  }

  const model = modelResult.model;
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div ref={dialogRef} className="modal poster-modal" role="dialog" aria-modal="true" aria-labelledby="poster-title" tabIndex={-1}>
      <button className="modal-close" onClick={onClose} aria-label="关闭"><X size={19} /></button>
      <span className="modal-eyebrow"><ImageDown size={14} /> FIRESIDE POSTER</span>
      <h2 id="poster-title">宣讲海报已为你备好</h2>
      <p className="modal-intro">使用最新排期在本地生成；线上会议链接与凭证不会出现在海报中。</p>
      <div className="poster-layout">
        <div className="poster-preview" aria-live="polite">
          <canvas ref={canvasRef} className="poster-canvas-source" aria-hidden="true" />
          {generating && <div className="poster-status"><Flame className="loading-flame" /><span>正在举起火炬…</span></div>}
          {!generating && posterUrl && model && <img src={posterUrl} alt={`围炉夜话宣讲海报：${model.title}，${model.date} ${model.time}`} />}
          {!generating && error && <div className="poster-status error"><span>{error}</span><button onClick={() => setAttempt((value) => value + 1)}>重新生成</button></div>}
        </div>
        <div className="poster-side">
          {model && <div className="poster-summary">
            <span>即将开讲</span>
            <strong>{model.title}</strong>
            <p>{model.date}<br />{model.time}</p>
            <p>分享人 · {model.presenter}<br />{model.location}</p>
          </div>}
          <div className="poster-actions">
            <button className="submit-btn" disabled={!posterUrl || generating} onClick={downloadPoster}><Download size={16} />下载 PNG</button>
            {canShare && <button className="poster-share" disabled={!posterBlob || generating} onClick={() => void sharePoster()}><Share2 size={16} />分享 / 保存</button>}
          </div>
          <p className="poster-save-hint">手机端可长按左侧图片保存；支持文件分享时也可直接发送给伙伴。</p>
          {notice && <div className="form-error" role="status">{notice}</div>}
        </div>
      </div>
    </div>
  </div>;
}

function Modal({ kind, topic, onClose, onComplete, onConflict }: {
  kind: ModalKind;
  topic: Topic | null;
  onClose: () => void;
  onComplete: (message: string) => void;
  onConflict?: (message: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useDialogA11y(onClose);
  const copy = {
    create: { eyebrow: 'ADD A SPARK', title: '发起一个新议题', intro: '不必是完整答案，一个真实的问题就足够成为火种。' },
    claim: { eyebrow: 'PICK UP THE TORCH', title: '认领这个议题', intro: '认领不是承诺成为专家，只是愿意比昨晚多探索一点。' },
    schedule: { eyebrow: 'SAVE THE DATE', title: '安排炉边分享', intro: '选一个大家方便靠近炉火的时间。' },
    archive: { eyebrow: 'KEEP THE EMBERS', title: '沉淀本期收获', intro: '留下一点余温，让后来的人也能顺着线索继续探索。' },
    release: { eyebrow: 'PASS THE TORCH', title: '重新开放认领？', intro: '分享人退出后，这个议题会重新等待伙伴接过火炬。' },
    unschedule: { eyebrow: 'CHANGE OF PLAN', title: '取消这次排期？', intro: '议题会回到准备中，可以稍后重新安排时间。' },
    unarchive: { eyebrow: 'RESTORE THE FIRE', title: '撤销这次归档？', intro: '议题会恢复为已排期，原排期保留，归档内容将被清空。' },
    edit: { eyebrow: 'TEND THE FIRE', title: '编辑议题', intro: '更新议题信息，让每一位围炉伙伴看到准确的线索。' },
    delete: { eyebrow: 'REMOVE A SPARK', title: '删除这个议题？', intro: '删除后，相关的认领、排期与归档信息也会永久消失。' },
  }[kind];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      if (kind === 'create') {
        const proposer = String(data.get('proposer'));
        const selfPresent = data.get('publishIntent') === 'self';
        await api.create({
          title: String(data.get('title')),
          summary: String(data.get('summary')),
          proposer,
          ...(selfPresent ? { presenter: proposer } : {}),
          tags: String(data.get('tags')).split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
        });
        onComplete(selfPresent ? '议题已发布并由你分享，接下来可以安排时间' : '新火种已放到炉边，等待同伴认领');
      } else if (kind === 'claim' && topic) {
        await api.claim(topic.id, String(data.get('presenter')));
        onComplete('认领成功，期待你把好奇变成一次分享');
      } else if (kind === 'schedule' && topic) {
        await api.schedule(topic.id, {
          scheduledAt: new Date(String(data.get('scheduledAt'))).toISOString(),
          duration: Number(data.get('duration')),
          room: String(data.get('room')),
          meetingUrl: String(data.get('meetingUrl')),
        });
        onComplete('排期完成，炉边已经为这次分享留好位置');
      } else if (kind === 'archive' && topic) {
        await api.archive(topic.id, {
          takeaway: String(data.get('takeaway')),
          materialUrl: String(data.get('materialUrl')),
        });
        onComplete('议题已归档，这簇火光被好好保存了');
      } else if (kind === 'release' && topic) {
        await api.release(topic.id);
        onComplete('议题已重新开放认领');
      } else if (kind === 'unschedule' && topic) {
        await api.unschedule(topic.id);
        onComplete('排期已取消，议题回到准备中');
      } else if (kind === 'unarchive' && topic) {
        await api.unarchive(topic.id);
        onComplete('归档已撤销，议题恢复为已排期');
      } else if (kind === 'edit' && topic) {
        const payload: Parameters<typeof api.update>[1] = {
          title: String(data.get('title')),
          summary: String(data.get('summary')),
          proposer: String(data.get('proposer')),
          tags: String(data.get('tags')).split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
        };
        if (data.has('presenter')) payload.presenter = String(data.get('presenter'));
        if (data.has('scheduledAt')) payload.scheduledAt = new Date(String(data.get('scheduledAt'))).toISOString();
        if (data.has('duration')) payload.duration = Number(data.get('duration'));
        if (data.has('room')) payload.room = String(data.get('room'));
        if (data.has('meetingUrl')) payload.meetingUrl = String(data.get('meetingUrl'));
        if (data.has('takeaway')) payload.takeaway = String(data.get('takeaway'));
        if (data.has('materialUrl')) payload.materialUrl = String(data.get('materialUrl'));
        await api.update(topic.id, payload);
        onComplete('议题信息已更新');
      } else if (kind === 'delete' && topic) {
        await api.remove(topic.id);
        onComplete('议题已删除');
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && onConflict) {
        onConflict(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : '提交失败，请稍后重试');
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1}>
        <button className="modal-close" onClick={onClose} aria-label="关闭"><X size={19} /></button>
        <span className="modal-eyebrow"><Sparkles size={14} />{copy.eyebrow}</span>
        <h2 id="modal-title">{copy.title}</h2>
        <p className="modal-intro">{copy.intro}</p>
        {topic && <div className="selected-topic"><span>本次议题</span><strong>{topic.title}</strong></div>}

        <form onSubmit={submit}>
          {kind === 'create' && <>
            <label>议题标题<input name="title" required maxLength={80} placeholder="最近有什么让你停下来多看了一眼？" autoFocus data-initial-focus /></label>
            <label>一句话简介<textarea name="summary" required maxLength={500} rows={4} placeholder="它为什么值得一起聊聊？你想从哪里开始探索？" /></label>
            <div className="form-row">
              <label>你的名字<input name="proposer" required maxLength={30} placeholder="怎么称呼你" /></label>
              <label>标签（最多 5 个）<input name="tags" maxLength={100} placeholder="AI, 产品, Demo" /></label>
            </div>
            <fieldset className="intent-options">
              <legend>发布后由谁分享？</legend>
              <label><input type="radio" name="publishIntent" value="open" defaultChecked /><span><b>征集分享人</b><small>先发布问题，邀请伙伴接过火炬</small></span></label>
              <label><input type="radio" name="publishIntent" value="self" /><span><b>我来分享</b><small>发布后直接进入准备中，不再重复认领</small></span></label>
            </fieldset>
          </>}
          {kind === 'claim' && <label>认领人<input name="presenter" required maxLength={30} placeholder="你的名字" autoFocus data-initial-focus /></label>}
          {kind === 'schedule' && <>
            <label>分享时间<input name="scheduledAt" type="datetime-local" required defaultValue={defaultScheduleTime()} autoFocus data-initial-focus /></label>
            <div className="form-row">
              <label>时长（分钟）<input name="duration" type="number" required min={10} max={240} defaultValue={40} /></label>
              <label>地点 / 参与说明<input name="room" required maxLength={60} defaultValue="围炉会议室" /></label>
            </div>
            <label>线上会议链接（选填）<input name="meetingUrl" type="url" maxLength={2048} placeholder="https://" /></label>
          </>}
          {kind === 'archive' && <>
            <label>本期最值得留下的收获<textarea name="takeaway" required maxLength={1000} rows={5} placeholder="用几句话记下结论、共识或仍待探索的问题……" autoFocus data-initial-focus /></label>
            <label>资料链接（选填）<input name="materialUrl" type="url" placeholder="https://" /></label>
          </>}
          {kind === 'edit' && topic && <>
            <label>议题标题<input name="title" required maxLength={80} defaultValue={topic.title} autoFocus data-initial-focus /></label>
            <label>一句话简介<textarea name="summary" required maxLength={500} rows={4} defaultValue={topic.summary} /></label>
            <div className="form-row">
              <label>发起人<input name="proposer" required maxLength={30} defaultValue={topic.proposer} /></label>
              <label>标签（最多 5 个）<input name="tags" maxLength={100} defaultValue={topic.tags.join(', ')} /></label>
            </div>
            {topic.status !== 'OPEN' && <label>分享人<input name="presenter" required maxLength={30} defaultValue={topic.presenter ?? ''} /></label>}
            {(topic.status === 'SCHEDULED' || topic.status === 'ARCHIVED') && <>
              <label>分享时间<input name="scheduledAt" type="datetime-local" required defaultValue={formatDateTimeInput(topic.scheduledAt)} /></label>
              <div className="form-row">
                <label>时长（分钟）<input name="duration" type="number" required min={10} max={240} defaultValue={topic.duration ?? 40} /></label>
                <label>地点 / 参与说明<input name="room" required maxLength={60} defaultValue={legacyMeetingUrl(topic.room) ? '线上会议' : topic.room ?? ''} /></label>
              </div>
              <label>线上会议链接（选填）<input name="meetingUrl" type="url" maxLength={2048} defaultValue={topicMeetingUrl(topic) ?? ''} placeholder="https://" /></label>
            </>}
            {topic.status === 'ARCHIVED' && <>
              <label>本期收获<textarea name="takeaway" required maxLength={1000} rows={4} defaultValue={topic.takeaway ?? ''} /></label>
              <label>资料链接（选填）<input name="materialUrl" type="url" defaultValue={topic.materialUrl ?? ''} placeholder="https://" /></label>
            </>}
          </>}
          {kind === 'delete' && topic && <div className="delete-warning"><Trash2 size={19} /><p><strong>{topic.title}</strong><span>此操作不可撤销，请确认是否继续。</span></p></div>}
          {kind === 'release' && topic && <div className="delete-warning neutral"><RotateCcw size={19} /><p><strong>{topic.title}</strong><span>分享人署名会被清空，议题内容继续保留。</span></p></div>}
          {kind === 'unschedule' && topic && <div className="delete-warning neutral"><CalendarX2 size={19} /><p><strong>{topic.title}</strong><span>日历事件与现有报名会被移除，分享人和议题内容继续保留。</span></p></div>}
          {kind === 'unarchive' && topic && <div className="delete-warning neutral"><RotateCcw size={19} /><p><strong>{topic.title}</strong><span>原排期继续保留；收获摘要、资料链接和归档时间会被清空。</span></p></div>}
          {error && <div className="form-error">{error}</div>}
          <button className={`submit-btn ${kind === 'delete' ? 'delete-submit' : ''}`} disabled={submitting} type="submit">
            {submitting ? '正在处理…' : kind === 'create' ? '发布议题' : kind === 'claim' ? '确认认领' : kind === 'schedule' ? '确认排期' : kind === 'archive' ? '完成归档' : kind === 'release' ? '重新开放认领' : kind === 'unschedule' ? '确认取消排期' : kind === 'unarchive' ? '确认撤销归档' : kind === 'edit' ? '保存修改' : '确认删除'}
            {!submitting && <ChevronRight size={17} />}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [stats, setStats] = useState<Stats>({ open: 0, claimed: 0, scheduled: 0, archived: 0, nextTopic: null });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<Tab>('ALL');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<TopicSort>('manual');
  const [loadedSort, setLoadedSort] = useState<TopicSort | null>(null);
  const [orderVersion, setOrderVersion] = useState(0);
  const [reordering, setReordering] = useState(false);
  const reorderInFlight = useRef(false);
  const topicRequestId = useRef(0);
  const statsRequestId = useRef(0);
  const activeSort = useRef<TopicSort>('manual');
  const [view, setView] = useState<ViewMode>('list');
  const [calendarCursor, setCalendarCursor] = useState(new Date());
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [liveMessage, setLiveMessage] = useState('');
  const [modal, setModal] = useState<{ kind: ModalKind; topic: Topic | null } | null>(null);
  const [participantsTopic, setParticipantsTopic] = useState<Topic | null>(null);
  const [posterTopic, setPosterTopic] = useState<Topic | null>(null);
  const [toast, setToast] = useState('');

  const loadTopics = useCallback(async (requestedSort: TopicSort) => {
    const requestId = ++topicRequestId.current;
    setLoading(true);
    setLoadedSort(null);
    try {
      const topicData = await api.topics(requestedSort);
      if (requestId !== topicRequestId.current || requestedSort !== activeSort.current) return false;
      setTopics(topicData.topics);
      setOrderVersion(topicData.orderVersion);
      setLoadedSort(requestedSort);
      setLoadError('');
      return true;
    } catch (error) {
      if (requestId !== topicRequestId.current || requestedSort !== activeSort.current) return false;
      setLoadError(error instanceof Error ? error.message : '炉火暂时熄灭了');
      return false;
    } finally {
      if (requestId === topicRequestId.current && requestedSort === activeSort.current) setLoading(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    const requestId = ++statsRequestId.current;
    try {
      const statData = await api.stats();
      if (requestId === statsRequestId.current) setStats(statData);
    } catch {
      // 统计卡片保留最近一次成功结果，不干扰议题列表的加载与排序来源。
    }
  }, []);

  const load = useCallback(async () => {
    await Promise.all([loadTopics(sort), loadStats()]);
  }, [loadStats, loadTopics, sort]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const visibleTopics = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return topics.filter((topic) => {
      const matchesTab = tab === 'ALL' || topic.status === tab;
      const matchesSearch = !keyword || [topic.title, topic.summary, topic.proposer, topic.presenter ?? '', ...topic.tags].join(' ').toLowerCase().includes(keyword);
      return matchesTab && matchesSearch;
    });
  }, [search, tab, topics]);

  function openAction(kind: ModalKind, topic: Topic | null = null) { setModal({ kind, topic }); }
  async function complete(message: string) {
    setModal(null);
    setToast(message);
    await load();
  }
  async function resolveConflict(message: string) {
    setModal(null);
    setToast(`${message}，已同步最新状态`);
    await load();
  }
  function scrollToTopics() { document.querySelector('#topics')?.scrollIntoView({ behavior: 'smooth' }); }
  function showTopicView(nextTab: Tab, nextView: ViewMode = 'list', keyword = '') {
    setTab(nextTab);
    setView(nextView);
    setSearch(keyword);
    if (nextView === 'week') setCalendarCursor(new Date());
    window.requestAnimationFrame(scrollToTopics);
  }
  function changeSort(nextSort: TopicSort) {
    activeSort.current = nextSort;
    topicRequestId.current += 1;
    setLoadedSort(null);
    setLoading(true);
    setSort(nextSort);
  }
  const canManualReorder = view === 'list' && sort === 'manual' && loadedSort === 'manual' && !loading && tab === 'ALL' && !search.trim();

  async function persistOrder(next: Topic[], previous: Topic[], moved: Topic) {
    if (reorderInFlight.current) return;
    reorderInFlight.current = true;
    setReordering(true);
    setTopics(next);
    setLiveMessage('正在保存议题顺序');
    try {
      const nextVersion = await api.reorder(next.map((topic) => topic.id), orderVersion);
      setOrderVersion(nextVersion);
      const position = next.findIndex((topic) => topic.id === moved.id) + 1;
      setLiveMessage(`${moved.title} 已移动到第 ${position} 位`);
    } catch (error) {
      setTopics(previous);
      try {
        const synced = await loadTopics('manual');
        setLiveMessage(synced ? '已同步服务端最新议题顺序' : '排序保存失败，已恢复操作前顺序');
      } catch {
        setLiveMessage('排序保存失败，已恢复操作前顺序');
      }
      const prefix = error instanceof ApiError && error.status === 409 ? '顺序发生冲突，已同步最新结果' : '排序保存失败，已同步服务端结果';
      setToast(error instanceof Error ? `${prefix}：${error.message}` : prefix);
    } finally {
      reorderInFlight.current = false;
      setReordering(false);
    }
  }

  function moveTopic(id: number, direction: -1 | 1) {
    if (!canManualReorder || reorderInFlight.current) return;
    const from = topics.findIndex((topic) => topic.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= topics.length) return;
    const previous = [...topics];
    const next = [...topics];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    void persistOrder(next, previous, moved);
  }

  function dropTopic(targetId: number) {
    if (!canManualReorder || reorderInFlight.current || draggedId === null || draggedId === targetId) return setDraggedId(null);
    const from = topics.findIndex((topic) => topic.id === draggedId);
    const to = topics.findIndex((topic) => topic.id === targetId);
    if (from < 0 || to < 0) return setDraggedId(null);
    const previous = [...topics];
    const next = [...topics];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setDraggedId(null);
    void persistOrder(next, previous, moved);
  }

  return <>
    <header className="nav shell">
      <a className="brand" href="#top"><span className="brand-mark"><Flame size={18} /></span><span>围炉夜话</span><i>FIRESIDE</i></a>
      <nav>
        <button onClick={scrollToTopics}>议题广场</button>
        <button onClick={() => showTopicView('SCHEDULED', 'week')}>本周排期</button>
        <button className="nav-cta" onClick={() => openAction('create')}><Plus size={16} /> 发起议题</button>
      </nav>
    </header>

    <main id="top">
      <section className="hero shell">
        <div className="hero-copy">
          <div className="eyebrow"><span className="pulse" />WEEKLY · AI FIRESIDE CHAT</div>
          <h1>围炉<span>夜话</span></h1>
          <p className="english">CURIOSITY IN. KNOWLEDGE OUT.</p>
          <div className="hero-poem"><p>好奇，是火种。</p><p>关注，是柴薪。</p><strong>分享，让微光成为火焰。</strong></div>
          <h2>每周一晚，<em>为彼此的好奇添一把柴。</em></h2>
          <p className="hero-desc">把最近让你停下来多看一眼的东西，带到炉边来。可以自己举起火炬，也可以邀请同伴接力；这里不做培训，不做汇报。</p>
          <div className="hero-actions">
            <button className="primary-button" onClick={() => openAction('create')}><Plus size={18} /> 添一把柴</button>
            <button className="ghost-button" onClick={scrollToTopics}>看看大家在聊什么 <ArrowRight size={17} /></button>
          </div>
          <p className="tiny-note"><span /> 你可以添柴，也可以只是守着火光坐一会儿。</p>
        </div>
        <FireVisual />
      </section>

      <section className="stats-wrap">
        <div className="stats shell">
          <button className="stat-link" onClick={() => showTopicView('OPEN')}><span>等待认领</span><strong>{String(stats.open).padStart(2, '0')}</strong><small>簇等待接力的火种</small></button>
          <button className="stat-link" onClick={() => showTopicView('CLAIMED')}><span>准备中</span><strong>{String(stats.claimed).padStart(2, '0')}</strong><small>位伙伴正在探索</small></button>
          <button className="stat-link" onClick={() => showTopicView('SCHEDULED')}><span>已排期</span><strong>{String(stats.scheduled).padStart(2, '0')}</strong><small>场炉边分享</small></button>
          <button className="stat-link" onClick={() => showTopicView('ARCHIVED')}><span>知识归档</span><strong>{String(stats.archived).padStart(2, '0')}</strong><small>份余温被保存</small></button>
          <button className="next-fire stat-link" disabled={!stats.nextTopic} onClick={() => stats.nextTopic && showTopicView('SCHEDULED', 'list', stats.nextTopic.title)}>
            <span>NEXT FIRESIDE</span>
            {stats.nextTopic ? <><strong>{stats.nextTopic.scheduledAt && formatDate(stats.nextTopic.scheduledAt)}</strong><small>{stats.nextTopic.title}</small></> : <><strong>等待排期</strong><small>认领一个议题，点燃下一炉</small></>}
          </button>
        </div>
      </section>

      <section className="topics-section shell" id="topics">
        <div className="section-heading">
          <div><p className="section-kicker">TOPIC COMMONS · 议题广场</p><h2>炉边正在发生什么</h2></div>
          <p>可以自己举起火炬，也可以邀请同伴接力。<br />从零散的兴趣，走向一次共同探索。</p>
        </div>
        <div className="topic-toolbar">
          <div className="tabs">
            {tabs.map((item) => <button key={item.key} className={tab === item.key ? 'active' : ''} onClick={() => setTab(item.key)}>{item.label}</button>)}
          </div>
          <label className="search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索议题、标签或分享人" /></label>
        </div>

        <div className="view-sort-bar">
          <div className="view-switch" aria-label="议题视图">
            <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><List size={15} />列表</button>
            <button className={view === 'month' ? 'active' : ''} onClick={() => setView('month')}><Calendar size={15} />月历</button>
            <button className={view === 'week' ? 'active' : ''} onClick={() => setView('week')}><CalendarRange size={15} />周历</button>
          </div>
          <div className="sort-control">
            {view === 'list' && <label>排序方式
              <select value={sort} disabled={reordering} onChange={(event) => changeSort(event.target.value as TopicSort)}>
                <option value="manual">手动排序</option>
                <option value="newest">最新创建</option>
                <option value="oldest">最早创建</option>
                <option value="schedule">排期时间</option>
                <option value="status">议题状态</option>
              </select>
            </label>}
            {view === 'list' && sort === 'manual' && !canManualReorder && <span className="sort-hint">{loading || loadedSort !== 'manual' ? '正在加载可排序快照…' : '清除搜索并切回“全部议题”后可手动排序'}</span>}
            {reordering && <span className="sort-saving">正在保存顺序…</span>}
          </div>
        </div>

        {loading ? <div className="empty-state"><Flame className="loading-flame" /><h3>正在点燃炉火…</h3></div>
          : loadError ? <div className="empty-state"><h3>{loadError}</h3><button onClick={() => void load()}>重新连接</button></div>
          : visibleTopics.length && view === 'list' ? <div className="topic-grid">{visibleTopics.map((topic, index) => <TopicCard
              key={topic.id}
              topic={topic}
              index={index}
              total={visibleTopics.length}
              onAction={openAction}
              onParticipants={setParticipantsTopic}
              onPoster={setPosterTopic}
              draggable={canManualReorder}
              reordering={reordering}
              onDragStart={(id) => { if (!reorderInFlight.current) setDraggedId(id); }}
              onDrop={dropTopic}
              onMove={moveTopic}
            />)}</div>
          : visibleTopics.length && view !== 'list' ? <CalendarView topics={visibleTopics} mode={view} cursor={calendarCursor} onCursorChange={setCalendarCursor} onEdit={(topic) => openAction('edit', topic)} />
          : <div className="empty-state"><Lightbulb /><h3>这里还没有火种</h3><p>换个筛选条件，或者成为第一个发起议题的人。</p><button onClick={() => openAction('create')}>发起议题</button></div>}
        <p className="sr-only" aria-live="polite">{liveMessage}</p>
      </section>

      <section className="how-wrap" id="how">
        <div className="shell">
          <div className="section-heading compact"><div><p className="section-kicker">HOW IT WORKS · 如何围炉</p><h2>从一点好奇，到一束火光</h2></div><p>没有复杂流程，也没有专家门槛。</p></div>
          <div className="flow-grid">
            <button onClick={() => openAction('create')}><span>01</span><i><Lightbulb /></i><h3>创建议题</h3><p>留下一个真问题，告诉大家它为什么让你好奇。</p></button>
            <button onClick={() => showTopicView('OPEN')}><span>02</span><i><UserRoundPlus /></i><h3>认领议题</h3><p>愿意多走一步的人接过火炬，开始做些探索。</p></button>
            <button onClick={() => showTopicView('CLAIMED')}><span>03</span><i><CalendarDays /></i><h3>议题排期</h3><p>约定时间与地点，为共同讨论留出一个晚上。</p></button>
            <button onClick={() => showTopicView('SCHEDULED', 'week')}><span>04</span><i><Users /></i><h3>报名围炉</h3><p>查看本周排期，报名旁听或进入线上会议。</p></button>
            <button onClick={() => showTopicView('ARCHIVED')}><span>05</span><i><Archive /></i><h3>沉淀归档</h3><p>记下收获与线索，让火光继续传给后来的人。</p></button>
          </div>
        </div>
      </section>

      <section className="manifesto shell">
        <div>
          <p className="section-kicker">THE TONE · 我们的基调</p>
          <h2>知识不会因为被收藏而发光，<br />它要被看见、被追问、<br /><span>被讲给另一个人听。</span></h2>
        </div>
        <div className="principles">
          <article><strong>不是任务</strong><p>完全自愿。可以分享，也可以只听。</p></article>
          <article><strong>不是考试</strong><p>可以带着半成品和没想明白的东西来。</p></article>
          <article><strong>不等专家</strong><p>认领的人，只需要比昨晚多查一点。</p></article>
        </div>
      </section>

      <section className="closing shell">
        <div className="closing-glow" />
        <p className="section-kicker">KEEP THE FIRE BURNING</p>
        <h2>今晚，你想为哪一份好奇<br /><span>添一把柴？</span></h2>
        <p>一个问题不必宏大，一次分享也不必完美。<br />只要有人愿意把注意力投向未知，炉火就不会熄灭。</p>
        <button className="primary-button large" onClick={() => openAction('create')}><Flame size={20} /> 发起我的议题</button>
      </section>
    </main>

    <footer className="shell"><div className="brand muted"><span className="brand-mark"><Flame size={16} /></span><span>围炉夜话</span></div><p>Curiosity is the spark. Sharing keeps it alive.</p><span>团队共创 · 公开浏览</span></footer>

    {modal && <Modal kind={modal.kind} topic={modal.topic} onClose={() => setModal(null)} onComplete={(message) => void complete(message)} onConflict={(message) => void resolveConflict(message)} />}
    {participantsTopic && <ParticipantsModal topic={participantsTopic} onClose={() => setParticipantsTopic(null)} onChanged={() => void load()} />}
    {posterTopic && <PosterModal topic={posterTopic} onClose={() => setPosterTopic(null)} />}
    {toast && <div className="toast"><span><Check size={15} /></span>{toast}</div>}
  </>;
}
