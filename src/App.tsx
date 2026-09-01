import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
  Clock3,
  Flame,
  Github,
  Lightbulb,
  Link as LinkIcon,
  MapPin,
  Plus,
  Search,
  Sparkles,
  UserRound,
  UserRoundPlus,
  Users,
  X,
} from 'lucide-react';
import { api } from './api';
import type { Stats, Topic, TopicStatus } from './types';

type Tab = 'ALL' | TopicStatus;
type ModalKind = 'create' | 'claim' | 'schedule' | 'archive';

const tabs: { key: Tab; label: string }[] = [
  { key: 'ALL', label: '全部议题' },
  { key: 'OPEN', label: '等待认领' },
  { key: 'CLAIMED', label: '准备中' },
  { key: 'SCHEDULED', label: '近期排期' },
  { key: 'ARCHIVED', label: '往期归档' },
];

const statusMeta: Record<TopicStatus, { label: string; className: string }> = {
  OPEN: { label: '等待添柴', className: 'open' },
  CLAIMED: { label: '已被认领', className: 'claimed' },
  SCHEDULED: { label: '即将开讲', className: 'scheduled' },
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

function TopicCard({ topic, onAction }: { topic: Topic; onAction: (kind: ModalKind, topic: Topic) => void }) {
  const meta = statusMeta[topic.status];
  return (
    <article className={`topic-card topic-${meta.className}`}>
      <div className="topic-head">
        <span className={`status-pill ${meta.className}`}><i />{meta.label}</span>
        <span className="topic-number">#{String(topic.id).padStart(3, '0')}</span>
      </div>
      <div className="topic-tags">
        {topic.tags.map((tag) => <span key={tag}>{tag}</span>)}
      </div>
      <h3>{topic.title}</h3>
      <p className="topic-summary">{topic.summary}</p>

      {topic.status === 'SCHEDULED' && topic.scheduledAt && (
        <div className="schedule-box">
          <div><CalendarDays size={16} /><strong>{formatDate(topic.scheduledAt)}</strong></div>
          <div><MapPin size={15} /><span>{topic.room}</span><Clock3 size={15} /><span>{topic.duration} 分钟</span></div>
        </div>
      )}

      {topic.status === 'ARCHIVED' && topic.takeaway && (
        <div className="takeaway"><Lightbulb size={16} /><p><b>炉边余温</b>{topic.takeaway}</p></div>
      )}

      <div className="topic-footer">
        <div className="people">
          <span><UserRound size={14} /> 发起 · {topic.proposer}</span>
          {topic.presenter && <span><Flame size={14} /> 分享 · {topic.presenter}</span>}
        </div>
        {topic.status === 'OPEN' && <button className="card-action warm" onClick={() => onAction('claim', topic)}>认领议题 <ArrowRight size={15} /></button>}
        {topic.status === 'CLAIMED' && <button className="card-action cyan" onClick={() => onAction('schedule', topic)}>安排分享 <CalendarDays size={15} /></button>}
        {topic.status === 'SCHEDULED' && <button className="card-action" onClick={() => onAction('archive', topic)}>完成归档 <Archive size={15} /></button>}
        {topic.status === 'ARCHIVED' && topic.materialUrl && <a className="card-action" href={topic.materialUrl} target="_blank" rel="noreferrer">查看资料 <LinkIcon size={15} /></a>}
      </div>
    </article>
  );
}

function Modal({ kind, topic, onClose, onComplete }: {
  kind: ModalKind;
  topic: Topic | null;
  onClose: () => void;
  onComplete: (message: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const copy = {
    create: { eyebrow: 'ADD A SPARK', title: '发起一个新议题', intro: '不必是完整答案，一个真实的问题就足够成为火种。' },
    claim: { eyebrow: 'PICK UP THE TORCH', title: '认领这个议题', intro: '认领不是承诺成为专家，只是愿意比昨晚多探索一点。' },
    schedule: { eyebrow: 'SAVE THE DATE', title: '安排炉边分享', intro: '选一个大家方便靠近炉火的时间。' },
    archive: { eyebrow: 'KEEP THE EMBERS', title: '沉淀本期收获', intro: '留下一点余温，让后来的人也能顺着线索继续探索。' },
  }[kind];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      if (kind === 'create') {
        await api.create({
          title: String(data.get('title')),
          summary: String(data.get('summary')),
          proposer: String(data.get('proposer')),
          tags: String(data.get('tags')).split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 5),
        });
        onComplete('新火种已放到炉边，等待同伴认领');
      } else if (kind === 'claim' && topic) {
        await api.claim(topic.id, String(data.get('presenter')));
        onComplete('认领成功，期待你把好奇变成一次分享');
      } else if (kind === 'schedule' && topic) {
        await api.schedule(topic.id, {
          scheduledAt: new Date(String(data.get('scheduledAt'))).toISOString(),
          duration: Number(data.get('duration')),
          room: String(data.get('room')),
        });
        onComplete('排期完成，炉边已经为这次分享留好位置');
      } else if (kind === 'archive' && topic) {
        await api.archive(topic.id, {
          takeaway: String(data.get('takeaway')),
          materialUrl: String(data.get('materialUrl')),
        });
        onComplete('议题已归档，这簇火光被好好保存了');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败，请稍后重试');
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <button className="modal-close" onClick={onClose} aria-label="关闭"><X size={19} /></button>
        <span className="modal-eyebrow"><Sparkles size={14} />{copy.eyebrow}</span>
        <h2 id="modal-title">{copy.title}</h2>
        <p className="modal-intro">{copy.intro}</p>
        {topic && <div className="selected-topic"><span>本次议题</span><strong>{topic.title}</strong></div>}

        <form onSubmit={submit}>
          {kind === 'create' && <>
            <label>议题标题<input name="title" required maxLength={80} placeholder="最近有什么让你停下来多看了一眼？" autoFocus /></label>
            <label>一句话简介<textarea name="summary" required maxLength={500} rows={4} placeholder="它为什么值得一起聊聊？你想从哪里开始探索？" /></label>
            <div className="form-row">
              <label>你的名字<input name="proposer" required maxLength={30} placeholder="怎么称呼你" /></label>
              <label>标签<input name="tags" maxLength={100} placeholder="AI, 产品, Demo" /></label>
            </div>
          </>}
          {kind === 'claim' && <label>认领人<input name="presenter" required maxLength={30} placeholder="你的名字" autoFocus /></label>}
          {kind === 'schedule' && <>
            <label>分享时间<input name="scheduledAt" type="datetime-local" required defaultValue={defaultScheduleTime()} autoFocus /></label>
            <div className="form-row">
              <label>时长（分钟）<input name="duration" type="number" required min={10} max={240} defaultValue={40} /></label>
              <label>地点 / 会议链接<input name="room" required maxLength={60} defaultValue="围炉会议室" /></label>
            </div>
          </>}
          {kind === 'archive' && <>
            <label>本期最值得留下的收获<textarea name="takeaway" required maxLength={1000} rows={5} placeholder="用几句话记下结论、共识或仍待探索的问题……" autoFocus /></label>
            <label>资料链接（选填）<input name="materialUrl" type="url" placeholder="https://" /></label>
          </>}
          {error && <div className="form-error">{error}</div>}
          <button className="submit-btn" disabled={submitting} type="submit">
            {submitting ? '正在添柴…' : kind === 'create' ? '发布议题' : kind === 'claim' ? '确认认领' : kind === 'schedule' ? '确认排期' : '完成归档'}
            {!submitting && <ChevronRight size={17} />}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [stats, setStats] = useState<Stats>({ open: 0, scheduled: 0, archived: 0, nextTopic: null });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<Tab>('ALL');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<{ kind: ModalKind; topic: Topic | null } | null>(null);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    try {
      const [topicData, statData] = await Promise.all([api.topics(), api.stats()]);
      setTopics(topicData);
      setStats(statData);
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '炉火暂时熄灭了');
    } finally {
      setLoading(false);
    }
  }, []);

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
  function scrollToTopics() { document.querySelector('#topics')?.scrollIntoView({ behavior: 'smooth' }); }

  return <>
    <header className="nav shell">
      <a className="brand" href="#top"><span className="brand-mark"><Flame size={18} /></span><span>围炉夜话</span><i>FIRESIDE</i></a>
      <nav>
        <button onClick={scrollToTopics}>议题广场</button>
        <button onClick={() => { setTab('SCHEDULED'); scrollToTopics(); }}>本周排期</button>
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
          <p className="hero-desc">把最近让你停下来多看一眼的东西，带到炉边来。这里不做培训，不做汇报；可以带着半成品、疑问和没想明白的东西来。</p>
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
          <div><span>等待认领</span><strong>{String(stats.open).padStart(2, '0')}</strong><small>簇好奇的火种</small></div>
          <div><span>近期排期</span><strong>{String(stats.scheduled).padStart(2, '0')}</strong><small>场炉边分享</small></div>
          <div><span>知识归档</span><strong>{String(stats.archived).padStart(2, '0')}</strong><small>份余温被保存</small></div>
          <div className="next-fire">
            <span>NEXT FIRESIDE</span>
            {stats.nextTopic ? <><strong>{stats.nextTopic.scheduledAt && formatDate(stats.nextTopic.scheduledAt)}</strong><small>{stats.nextTopic.title}</small></> : <><strong>等待排期</strong><small>认领一个议题，点燃下一炉</small></>}
          </div>
        </div>
      </section>

      <section className="topics-section shell" id="topics">
        <div className="section-heading">
          <div><p className="section-kicker">TOPIC COMMONS · 议题广场</p><h2>炉边正在发生什么</h2></div>
          <p>一个人提出问题，另一个人接过火炬。<br />从零散的兴趣，走向一次共同探索。</p>
        </div>
        <div className="topic-toolbar">
          <div className="tabs">
            {tabs.map((item) => <button key={item.key} className={tab === item.key ? 'active' : ''} onClick={() => setTab(item.key)}>{item.label}</button>)}
          </div>
          <label className="search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索议题、标签或分享人" /></label>
        </div>

        {loading ? <div className="empty-state"><Flame className="loading-flame" /><h3>正在点燃炉火…</h3></div>
          : loadError ? <div className="empty-state"><h3>{loadError}</h3><button onClick={() => void load()}>重新连接</button></div>
          : visibleTopics.length ? <div className="topic-grid">{visibleTopics.map((topic) => <TopicCard key={topic.id} topic={topic} onAction={openAction} />)}</div>
          : <div className="empty-state"><Lightbulb /><h3>这里还没有火种</h3><p>换个筛选条件，或者成为第一个发起议题的人。</p><button onClick={() => openAction('create')}>发起议题</button></div>}
      </section>

      <section className="how-wrap" id="how">
        <div className="shell">
          <div className="section-heading compact"><div><p className="section-kicker">HOW IT WORKS · 如何围炉</p><h2>从一点好奇，到一束火光</h2></div><p>没有复杂流程，也没有专家门槛。</p></div>
          <div className="flow-grid">
            <div><span>01</span><i><Lightbulb /></i><h3>创建议题</h3><p>留下一个真问题，告诉大家它为什么让你好奇。</p></div>
            <div><span>02</span><i><UserRoundPlus /></i><h3>认领议题</h3><p>愿意多走一步的人接过火炬，开始做些探索。</p></div>
            <div><span>03</span><i><CalendarDays /></i><h3>议题排期</h3><p>约定时间与地点，为共同讨论留出一个晚上。</p></div>
            <div><span>04</span><i><Users /></i><h3>围炉分享</h3><p>带着发现、Demo 或未解的问题来到炉边。</p></div>
            <div><span>05</span><i><Archive /></i><h3>沉淀归档</h3><p>记下收获与线索，让火光继续传给后来的人。</p></div>
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

    <footer className="shell"><div className="brand muted"><span className="brand-mark"><Flame size={16} /></span><span>围炉夜话</span></div><p>Curiosity is the spark. Sharing keeps it alive.</p><a href="https://github.com/ShijunDeng/fireside" target="_blank" rel="noreferrer"><Github size={16} /> GitHub Repository</a></footer>

    {modal && <Modal kind={modal.kind} topic={modal.topic} onClose={() => setModal(null)} onComplete={(message) => void complete(message)} />}
    {toast && <div className="toast"><span><Check size={15} /></span>{toast}</div>}
  </>;
}
