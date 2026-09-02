import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { buildWeekDays } from '../src/calendar';

const writeKey = '松风明月共围炉';
const legacyWriteKeyStorage = 'fireside-write-key';
const collaborationSessionStorage = 'fireside-collaboration-session-v1';
let collaborationSession = '';
let baselineTopicIds = new Set<number>();
const sessionHeaders = () => ({ 'X-Fireside-Session': collaborationSession });
const revisionHeaders = (revision: number) => ({ ...sessionHeaders(), 'If-Match': `"${revision}"` });

async function issueSession(request: APIRequestContext, key = writeKey) {
  const response = await request.post('/api/access/verify', { headers: {
    'X-Fireside-Write-Key': Buffer.from(key, 'utf8').toString('base64url'),
    'X-Fireside-Write-Key-Encoding': 'base64url-utf8-v1',
  } });
  expect(response.status()).toBe(200);
  const body = await response.json() as { sessionToken: string; expiresAt: string };
  expect(body.sessionToken).toMatch(/^v1\./);
  expect(Number.isFinite(Date.parse(body.expiresAt))).toBe(true);
  return body.sessionToken;
}

async function latestTopic(request: APIRequestContext, id: number) {
  const response = await request.get(`/api/topics/${id}`);
  if (!response.ok()) throw new Error(`Failed to read topic ${id}: ${response.status()}`);
  return response.json() as Promise<{ id: number; revision: number; title: string; status: 'OPEN' | 'CLAIMED' | 'SCHEDULED' | 'ARCHIVED' }>;
}

async function deleteLatestTopic(request: APIRequestContext, id: number) {
  let topic = await latestTopic(request, id);
  if (topic.status === 'ARCHIVED') {
    const unarchived = await request.post(`/api/topics/${id}/unarchive`, { headers: revisionHeaders(topic.revision), data: {} });
    if (unarchived.status() !== 200) throw new Error(`Failed to unarchive topic ${id}: ${unarchived.status()}`);
    topic = await unarchived.json();
  }
  if (topic.status === 'SCHEDULED') {
    const unscheduled = await request.post(`/api/topics/${id}/unschedule`, { headers: revisionHeaders(topic.revision), data: {} });
    if (unscheduled.status() !== 200) throw new Error(`Failed to unschedule topic ${id}: ${unscheduled.status()}`);
    topic = await unscheduled.json();
  }
  const response = await request.delete(`/api/topics/${id}`, { headers: revisionHeaders(topic.revision) });
  if (response.status() !== 204) throw new Error(`Failed to delete topic ${id}: ${response.status()}`);
}

type PhaseTopic = {
  id: number;
  revision: number;
  title: string;
  summary: string;
  proposer: string;
  presenter: string | null;
  tags: string[];
  status: 'OPEN' | 'CLAIMED' | 'SCHEDULED' | 'ARCHIVED';
  scheduledAt: string | null;
  duration: number | null;
  room: string | null;
  meetingUrl: string | null;
  hasMeetingUrl: boolean;
  participantCount: number;
  takeaway: string | null;
  materialUrl: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

async function readPhaseTopic(request: APIRequestContext, id: number) {
  const response = await request.get(`/api/topics/${id}`);
  if (!response.ok()) throw new Error(`Failed to read topic ${id}: ${response.status()}`);
  return response.json() as Promise<PhaseTopic>;
}

async function createScheduledPhaseTopic(request: APIRequestContext, data: {
  title: string;
  scheduledAt: string;
  meetingUrl?: string;
}) {
  const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
    title: data.title,
    summary: '活动阶段浏览器验收夹具。',
    proposer: '阶段测试',
    presenter: '阶段测试',
    tags: ['阶段'],
  } });
  expect(created.status()).toBe(201);
  const topic = await created.json() as PhaseTopic;
  const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, {
    headers: revisionHeaders(topic.revision),
    data: {
      scheduledAt: data.scheduledAt,
      duration: 10,
      room: '阶段测试会议室',
      meetingUrl: data.meetingUrl ?? '',
    },
  });
  expect(scheduled.status()).toBe(200);
  return scheduled.json() as Promise<PhaseTopic>;
}

async function cleanupPhaseTopics(request: APIRequestContext, ids: number[]) {
  const results = await Promise.allSettled(ids.map((id) => deleteLatestTopic(request, id)));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

async function expectCollaborationState(page: Page, label: '确认协作…' | '退出协作' | '解锁协作', disabled = false) {
  const desktopControl = page.locator('.desktop-nav').getByRole('button', { name: label, exact: true });
  if (!await page.getByRole('button', { name: '菜单', exact: true }).isVisible()) {
    await expect(desktopControl).toBeVisible();
    if (disabled) await expect(desktopControl).toBeDisabled();
    return;
  }
  await page.getByRole('button', { name: '菜单', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '去哪里添柴？' });
  const control = menu.getByRole('button', { name: label, exact: true });
  await expect(control).toBeVisible();
  if (disabled) await expect(control).toBeDisabled();
  await menu.getByRole('button', { name: '关闭菜单' }).click();
}

async function clickCollaborationState(page: Page, label: '退出协作' | '解锁协作') {
  const desktopControl = page.locator('.desktop-nav').getByRole('button', { name: label, exact: true });
  if (!await page.getByRole('button', { name: '菜单', exact: true }).isVisible()) {
    await desktopControl.click();
    return;
  }
  await page.getByRole('button', { name: '菜单', exact: true }).click();
  await page.getByRole('dialog', { name: '去哪里添柴？' }).getByRole('button', { name: label, exact: true }).click();
}

async function expectNavigationState(page: Page, label: string, targetSelector: '#topics h2' | '#how h2', useMenu: boolean) {
  const target = page.locator(targetSelector);
  await expect(target).toBeFocused();
  await expect.poll(async () => page.evaluate((selector) => {
    const heading = document.querySelector<HTMLElement>(selector);
    const header = document.querySelector<HTMLElement>('.site-header');
    return heading && header ? Math.round(heading.getBoundingClientRect().top - header.getBoundingClientRect().bottom) : -1;
  }, targetSelector)).toBeGreaterThanOrEqual(8);

  if (useMenu) {
    await page.getByRole('button', { name: '菜单', exact: true }).click();
    const menu = page.getByRole('dialog', { name: '去哪里添柴？' });
    const current = menu.locator('nav button[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText(label);
    await menu.getByRole('button', { name: '关闭菜单' }).click();
  } else {
    const current = page.locator('.desktop-nav button[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText(label);
  }
}

async function expectNavigationArrival(page: Page, label: string, targetSelector: '#topics h2' | '#how h2', useMenu: boolean) {
  if (useMenu) {
    await page.getByRole('button', { name: '菜单', exact: true }).click();
    const menu = page.getByRole('dialog', { name: '去哪里添柴？' });
    await menu.getByRole('button', { name: label, exact: true }).click();
    await expect(menu).toHaveCount(0);
  } else {
    await page.locator('.desktop-nav').getByRole('button', { name: label, exact: true }).click();
  }
  await expectNavigationState(page, label, targetSelector, useMenu);
}

test.describe('议题管理工作台', () => {
  test.beforeAll(async ({ request }) => {
    collaborationSession = await issueSession(request);
    const baseline = await request.get('/api/topics');
    expect(baseline.status()).toBe(200);
    baselineTopicIds = new Set((await baseline.json() as { id: number }[]).map(({ id }) => id));
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(({ session, legacyKey, sessionKey }) => {
      sessionStorage.setItem(legacyKey, 'legacy-raw-key-must-be-removed');
      if (localStorage.getItem('e2e-force-locked') !== '1') sessionStorage.setItem(sessionKey, session);
    }, { session: collaborationSession, legacyKey: legacyWriteKeyStorage, sessionKey: collaborationSessionStorage });
  });
  test.afterEach(async ({ request }) => {
    const response = await request.get('/api/topics');
    expect(response.status()).toBe(200);
    const extras = (await response.json() as { id: number }[])
      .map(({ id }) => id)
      .filter((id) => !baselineTopicIds.has(id));
    await cleanupPhaseTopics(request, extras);
    const remaining = await request.get('/api/topics');
    expect(remaining.status()).toBe(200);
    expect((await remaining.json() as { id: number }[]).filter(({ id }) => !baselineTopicIds.has(id))).toEqual([]);
  });
  test('在月历和周历中展示排期，并先从事件进入公开活动详情', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '月历' }).click();
    await expect(page.locator('.calendar-day')).toHaveCount(42);
    const monthEvent = page.locator('.calendar-event').filter({ hasText: '把一个模糊想法做成可用 Demo' });
    await expect(monthEvent).toBeVisible();
    await monthEvent.click();
    const activityDialog = page.getByRole('dialog', { name: '把一个模糊想法做成可用 Demo' });
    await expect(activityDialog.getByRole('heading', { name: '把一个模糊想法做成可用 Demo' })).toBeVisible();
    await expect(activityDialog.getByRole('button', { name: /删除/ })).toHaveCount(0);
    await page.getByRole('button', { name: '编辑维护' }).click();
    await expect(page.getByRole('heading', { name: '编辑议题' })).toBeVisible();
    await expect(page.getByLabel('分享时间')).toHaveValue(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    await page.getByRole('dialog', { name: '编辑议题' }).getByRole('button', { name: '关闭' }).click();
    await page.getByRole('dialog', { name: '把一个模糊想法做成可用 Demo' }).getByRole('button', { name: '关闭' }).click();

    await page.getByRole('button', { name: '周历' }).click();
    await expect(page.locator('.week-day')).toHaveCount(7);
    await expect(page.locator('.week-event').filter({ hasText: '把一个模糊想法做成可用 Demo' })).toBeVisible();
  });

  test('顶部“本周活动”进入当前周，而不是普通列表筛选', async ({ page }, testInfo) => {
    await page.goto('/');
    if (testInfo.project.name === 'mobile') {
      await page.getByRole('button', { name: '菜单', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '本周活动', exact: true }).click();
    } else {
      await page.getByRole('button', { name: '本周活动', exact: true }).click();
    }
    await expect(page.getByRole('button', { name: '周历' })).toHaveClass(/active/);
    await expect(page.getByRole('button', { name: '已排期', exact: true })).toHaveClass(/active/);
    await expect(page.locator('.week-calendar')).toBeVisible();
  });

  test('五个任务导航落点避开吸顶栏，焦点与当前项保持一致', async ({ page }, testInfo) => {
    await page.goto('/');
    const useMenu = testInfo.project.name === 'mobile';
    const destinations = [
      ['议题广场', '#topics h2'],
      ['本周活动', '#topics h2'],
      ['待归档', '#topics h2'],
      ['往期回顾', '#topics h2'],
      ['如何参与', '#how h2'],
    ] as const;
    for (const [label, target] of destinations) await expectNavigationArrival(page, label, target, useMenu);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('关键业务文字在桌面、平板和移动视口满足可读字号层级', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', '由桌面浏览器依次覆盖全部目标视口');
    test.setTimeout(60_000);
    const viewports = [
      { width: 1440, height: 1000, copy: 13, meta: 12 },
      { width: 820, height: 1000, copy: 13, meta: 12 },
      { width: 393, height: 852, copy: 14, meta: 13 },
      { width: 320, height: 800, copy: 14, meta: 13 },
    ];
    const fontSize = (selector: string) => page.locator(selector).first().evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto('/');
      const lifecycleSizes = await page.locator('.stats .stat-link:not(.next-fire) > span').evaluateAll((elements) => elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)));
      expect(lifecycleSizes).toHaveLength(4);
      expect(lifecycleSizes.every((size) => size >= 14)).toBe(true);
      expect((await page.locator('.tabs button').evaluateAll((elements) => elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)))).every((size) => size >= 14)).toBe(true);
      expect(await fontSize('.status-pill')).toBeGreaterThanOrEqual(14);
      expect(await fontSize('.card-action')).toBeGreaterThanOrEqual(14);
      expect(await fontSize('.search input')).toBeGreaterThanOrEqual(14);
      expect(await fontSize('footer nav button')).toBeGreaterThanOrEqual(14);
      expect((await page.locator('.hero-actions button, .closing-actions button').evaluateAll((elements) => elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)))).every((size) => size >= 14)).toBe(true);
      if (viewport.width > 1000) {
        expect((await page.locator('.desktop-nav button').evaluateAll((elements) => elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)))).every((size) => size >= 14)).toBe(true);
      }
      await page.locator('.tabs').getByRole('button', { name: '等待认领', exact: true }).click();
      expect(await fontSize('.result-context button')).toBeGreaterThanOrEqual(14);
      await page.locator('.result-context').getByRole('button', { name: '清除条件' }).click();

      await page.getByRole('button', { name: '月历', exact: true }).click();
      expect(await fontSize('.calendar-event')).toBeGreaterThanOrEqual(viewport.copy);
      expect(await fontSize('.calendar-event i')).toBeGreaterThanOrEqual(viewport.meta);
      if (viewport.width <= 393) {
        for (const view of ['月历', '周历'] as const) {
          await page.getByRole('button', { name: view, exact: true }).click();
          for (const label of ['上一个周期', '下一个周期']) {
            const bounds = await page.getByRole('button', { name: label }).boundingBox();
            expect(bounds, `${viewport.width}px ${view}的${label}不应被压缩`).not.toBeNull();
            expect(bounds!.width).toBeGreaterThanOrEqual(44);
            expect(bounds!.height).toBeGreaterThanOrEqual(44);
          }
        }
      }

      await page.locator('.hero-actions .primary-button').click();
      const createDialog = page.getByRole('dialog', { name: '发起一个新议题' });
      expect(await createDialog.locator('label').first().evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(viewport.copy);
      expect(await createDialog.locator('.intent-options small').first().evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
      expect(await createDialog.getByRole('button', { name: '发布议题' }).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
      await createDialog.getByRole('button', { name: '关闭' }).click();

      const overflow = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      expect(overflow.document).toBeLessThanOrEqual(0);
      expect(overflow.body).toBeLessThanOrEqual(0);
    }
  });

  test('页脚业务导航复用同一落点、焦点和当前态', async ({ page }, testInfo) => {
    await page.goto('/');
    const globalNavigationControls = [
      page.locator('header .brand'),
      page.locator('footer .brand'),
      ...await page.locator('footer nav button').all(),
    ];
    for (const control of globalNavigationControls) {
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    const useMenu = testInfo.project.name === 'mobile';
    const destinations = [
      ['议题', '议题广场', '#topics h2'],
      ['活动', '本周活动', '#topics h2'],
      ['往期', '往期回顾', '#topics h2'],
      ['如何参与', '如何参与', '#how h2'],
    ] as const;
    for (const [footerLabel, currentLabel, target] of destinations) {
      await page.locator('footer').getByRole('button', { name: footerLabel, exact: true }).click();
      await expectNavigationState(page, currentLabel, target, useMenu);
    }
    await page.locator('.flow-grid > button').filter({ hasText: '认领议题' }).click();
    await expect(page.locator('#topics h2')).toBeFocused();
    if (useMenu) {
      await page.getByRole('button', { name: '菜单', exact: true }).click();
      const menu = page.getByRole('dialog', { name: '去哪里添柴？' });
      await expect(menu.locator('nav button[aria-current="page"]')).toHaveCount(0);
      await menu.getByRole('button', { name: '关闭菜单' }).click();
    } else {
      await expect(page.locator('.desktop-nav button[aria-current="page"]')).toHaveCount(0);
    }
  });

  test('减少动态效果时任务导航不执行平滑滚动', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', '媒体偏好只需在桌面项目验证一次');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.locator('.desktop-nav').getByRole('button', { name: '如何参与', exact: true }).click();
    await expect(page.locator('#how h2')).toBeFocused();
    const settledPosition = await page.evaluate(() => window.scrollY);
    await page.waitForTimeout(100);
    expect(Math.abs(await page.evaluate(() => window.scrollY) - settledPosition)).toBeLessThanOrEqual(1);
  });

  test('移动周历定位今天，核心控件可触达且页面不横向溢出', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', '本用例验证 Pixel 7 的日期定位和触控尺寸');
    await page.goto('/');
    await page.getByRole('button', { name: '周历' }).click();
    const scroll = page.locator('.week-scroll');
    const today = page.locator('.week-day.today');
    await expect(today).toBeVisible();
    await expect.poll(async () => scroll.evaluate((element) => ({ left: element.scrollLeft, width: element.clientWidth }))).not.toEqual({ left: 0, width: 0 });
    const calendarBounds = await scroll.boundingBox();
    const todayBounds = await today.boundingBox();
    expect(calendarBounds).not.toBeNull();
    expect(todayBounds).not.toBeNull();
    expect(todayBounds!.x).toBeGreaterThanOrEqual(calendarBounds!.x - 4);
    expect(todayBounds!.x).toBeLessThan(calendarBounds!.x + calendarBounds!.width);
    expect(todayBounds!.x + todayBounds!.width).toBeLessThanOrEqual(calendarBounds!.x + calendarBounds!.width + 4);

    const coreControls = [
      page.getByRole('button', { name: '菜单', exact: true }),
      page.getByRole('button', { name: '列表', exact: true }),
      page.getByRole('button', { name: '月历', exact: true }),
      page.getByRole('button', { name: '周历', exact: true }),
      page.getByRole('button', { name: '今天', exact: true }),
      page.getByRole('button', { name: '上一个周期' }),
      page.getByRole('button', { name: '下一个周期' }),
    ];
    for (const control of coreControls) {
      const bounds = await control.boundingBox();
      expect(bounds, `控件 ${await control.getAttribute('aria-label') ?? await control.textContent()} 应可触达`).not.toBeNull();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('平板与手机月历的今天完整可见且活动入口不小于44px', async ({ page, request }, testInfo) => {
    if (testInfo.project.name === 'chromium') await page.setViewportSize({ width: 820, height: 1180 });
    const title = `月历今日可达-${testInfo.project.name}-${Date.now()}`;
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title,
      summary: '点今天后必须直接看见周日与其中的活动入口。',
      proposer: '日历验收',
      presenter: '日历验收',
      tags: ['日历'],
    } });
    expect(created.status()).toBe(201);
    const topic = await created.json() as PhaseTopic;
    const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, {
      headers: revisionHeaders(topic.revision),
      data: { scheduledAt: '2036-09-07T11:00:00.000Z', duration: 30, room: '周日围炉室', meetingUrl: '' },
    });
    expect(scheduled.status()).toBe(200);

    try {
      await page.clock.install({ time: new Date('2036-09-07T04:00:00.000Z') });
      await page.goto('/');
      await page.getByRole('button', { name: '月历', exact: true }).click();
      await page.getByRole('button', { name: '上一个周期' }).click();
      await expect(page.locator('.calendar-toolbar h3')).toContainText('2036 年 8 月');
      await page.getByRole('button', { name: '今天', exact: true }).click();
      await page.clock.runFor(1_000);

      const monthScroll = page.locator('.month-scroll');
      const today = page.locator('.calendar-day.today');
      await expect(today).toBeVisible();
      await expect.poll(async () => {
        const container = await monthScroll.boundingBox();
        const cell = await today.boundingBox();
        return Boolean(container && cell
          && cell.x >= container.x - 4
          && cell.x + cell.width <= container.x + container.width + 4);
      }).toBe(true);
      const eventBounds = await page.locator('.calendar-event').filter({ hasText: title }).boundingBox();
      expect(eventBounds).not.toBeNull();
      expect(eventBounds!.width).toBeGreaterThanOrEqual(44);
      expect(eventBounds!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('平板宽度使用完整移动菜单，月历和周历最右列可达且页面不横向溢出', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', '只需在桌面浏览器项目中切换一次 820px 视口');
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto('/');
    for (const control of [page.locator('header .brand'), page.locator('footer .brand'), ...await page.locator('footer nav button').all()]) {
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByRole('button', { name: '菜单', exact: true })).toBeVisible();
    const destinations = [
      ['议题广场', '#topics h2'],
      ['本周活动', '#topics h2'],
      ['待归档', '#topics h2'],
      ['往期回顾', '#topics h2'],
      ['如何参与', '#how h2'],
    ] as const;
    for (const [label, target] of destinations) await expectNavigationArrival(page, label, target, true);

    await expectNavigationArrival(page, '议题广场', '#topics h2', true);
    await page.getByRole('button', { name: '月历', exact: true }).click();
    const monthScroll = page.locator('.month-scroll');
    await expect(monthScroll).toBeVisible();
    const monthMetrics = await monthScroll.evaluate((element) => {
      const style = getComputedStyle(element);
      element.scrollLeft = element.scrollWidth;
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        scrollLeft: element.scrollLeft,
        overflowX: style.overflowX,
      };
    });
    expect(monthMetrics.scrollWidth).toBeGreaterThan(monthMetrics.clientWidth);
    expect(monthMetrics.scrollLeft).toBeGreaterThan(0);
    expect(monthMetrics.overflowX).toBe('auto');
    const monthBounds = await monthScroll.boundingBox();
    const lastMonthDayBounds = await page.locator('.month-calendar .calendar-day').last().boundingBox();
    expect(monthBounds).not.toBeNull();
    expect(lastMonthDayBounds).not.toBeNull();
    expect(lastMonthDayBounds!.x + lastMonthDayBounds!.width).toBeLessThanOrEqual(monthBounds!.x + monthBounds!.width + 1);

    await page.getByRole('button', { name: '周历', exact: true }).click();
    const weekScroll = page.locator('.week-scroll');
    await expect(weekScroll).toBeVisible();
    const weekMetrics = await weekScroll.evaluate((element) => {
      const style = getComputedStyle(element);
      element.scrollLeft = element.scrollWidth;
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        scrollLeft: element.scrollLeft,
        overflowX: style.overflowX,
      };
    });
    expect(weekMetrics.scrollWidth).toBeGreaterThan(weekMetrics.clientWidth);
    expect(weekMetrics.scrollLeft).toBeGreaterThan(0);
    expect(weekMetrics.overflowX).toBe('auto');
    const weekBounds = await weekScroll.boundingBox();
    const lastWeekDayBounds = await page.locator('.week-calendar .week-day').last().boundingBox();
    expect(weekBounds).not.toBeNull();
    expect(lastWeekDayBounds).not.toBeNull();
    expect(lastWeekDayBounds!.x + lastWeekDayBounds!.width).toBeLessThanOrEqual(weekBounds!.x + weekBounds!.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('完成创建、编辑和删除', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '往期归档', exact: true }).click();
    await page.getByPlaceholder('搜索议题、标签或分享人').fill('隐藏新议题的旧条件');
    await page.getByRole('button', { name: '月历', exact: true }).click();
    await page.getByRole('button', { name: /发起议题/ }).first().click();
    await page.getByLabel('议题标题').fill('浏览器 CRUD 验收议题');
    await page.getByLabel('一句话简介').fill('验证创建、修改与删除能够在同一工作台完成。');
    await page.getByLabel('你的名字').fill('Playwright');
    await page.getByLabel('标签').fill('E2E, CRUD');
    await page.getByRole('button', { name: '发布议题' }).click();
    const card = page.getByRole('article').filter({ hasText: '浏览器 CRUD 验收议题' });
    await expect(card).toBeVisible();
    await expect(page.getByRole('button', { name: '等待认领', exact: true })).toHaveClass(/active/);
    await expect(page.getByRole('button', { name: '列表', exact: true })).toHaveClass(/active/);
    await expect(page.getByPlaceholder('搜索议题、标签或分享人')).toHaveValue('');
    await expect(card).toBeFocused();
    await page.waitForTimeout(1_200);
    await expect(card).toBeFocused();

    await card.getByRole('button', { name: '编辑 浏览器 CRUD 验收议题', exact: true }).click();
    await page.getByLabel('议题标题').fill('已更新的 CRUD 验收议题');
    await page.getByRole('button', { name: '保存修改' }).click();
    const updatedCard = page.getByRole('article').filter({ hasText: '已更新的 CRUD 验收议题' });
    await expect(updatedCard).toBeVisible();
    const updatedEdit = updatedCard.getByRole('button', { name: '编辑 已更新的 CRUD 验收议题', exact: true });
    await expect(updatedEdit).toBeFocused();
    await page.waitForTimeout(1_200);
    await expect(updatedEdit).toBeFocused();

    await updatedCard.getByRole('button', { name: /删除/ }).click();
    await expect(page.getByText('删除只适用于误建或重复议题。议题内容将永久移除，此操作不可撤销。')).toBeVisible();
    const cancelDelete = page.getByRole('button', { name: '取消', exact: true });
    await expect(cancelDelete).toBeFocused();
    await cancelDelete.click();
    await expect(updatedCard.getByRole('button', { name: /删除/ })).toBeFocused();
    await updatedCard.getByRole('button', { name: /删除/ }).click();
    await Promise.all([
      page.waitForResponse((response) => response.request().method() === 'DELETE' && response.status() === 204),
      page.getByRole('button', { name: '确认永久删除' }).click(),
    ]);
    await expect(page.getByRole('heading', { name: '删除这个议题？' })).toHaveCount(0);
    await expect(updatedCard).toHaveCount(0);
    await expect(page.locator('#topics h2')).toBeFocused();
  });

  test('业务写入成功后列表同步失败仍保留创建、编辑和状态结果', async ({ page, request }, testInfo) => {
    const title = `成功后同步韧性-${testInfo.project.name}-${Date.now()}`;
    let failNextTopicsRead = false;
    let blockedReads = 0;
    await page.route('**/api/topics?sort=*', async (route) => {
      if (!failNextTopicsRead) return route.continue();
      failNextTopicsRead = false;
      blockedReads += 1;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'TEMPORARY_SYNC_FAILURE', message: '模拟成功后的列表同步失败' }),
      });
    });

    let topicId = 0;
    try {
      await page.goto('/');
      await page.getByRole('button', { name: /发起议题/ }).first().click();
      await page.getByLabel('议题标题').fill(title);
      await page.getByLabel('一句话简介').fill('成功响应必须先成为稳定的页面事实。');
      await page.getByLabel('你的名字').fill('同步韧性测试');
      const createdResponse = page.waitForResponse((response) => response.url().endsWith('/api/topics')
        && response.request().method() === 'POST' && response.status() === 201);
      failNextTopicsRead = true;
      await page.getByRole('button', { name: '发布议题' }).click();
      const created = await (await createdResponse).json() as PhaseTopic;
      topicId = created.id;
      let card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await expect(card).toBeVisible();
      await expect(card).toBeFocused();
      await expect(page.getByText(/结果已保存，列表同步暂时失败/)).toBeVisible();
      await expect(page.getByText('模拟成功后的列表同步失败')).toHaveCount(0);

      await card.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
      const updatedSummary = '写入成功后即使校正读取暂时失败，这段新简介也不能消失。';
      await page.getByLabel('一句话简介').fill(updatedSummary);
      failNextTopicsRead = true;
      await page.getByRole('button', { name: '保存修改' }).click();
      card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await expect(card).toContainText(updatedSummary);
      await expect(card.getByRole('button', { name: `编辑 ${title}`, exact: true })).toBeFocused();
      await expect(page.getByText(/结果已保存，列表同步暂时失败/)).toBeVisible();

      await card.getByRole('button', { name: '认领议题' }).click();
      const claimDialog = page.getByRole('dialog', { name: '认领这个议题' });
      await claimDialog.getByLabel('认领人').fill('同步后接棒人');
      failNextTopicsRead = true;
      await claimDialog.getByRole('button', { name: '确认认领' }).click();
      const transition = page.getByRole('dialog', { name: '安排炉边分享' });
      await expect(transition).toContainText('认领已经保存');
      await expect(page.getByText(/结果已保存，列表同步暂时失败/)).toBeVisible();
      await transition.getByRole('button', { name: '关闭' }).click();
      await expect(card).toContainText('已被认领');
      await expect(card).toContainText('同步后接棒人');
      await expect(card).toBeFocused();

      await card.getByRole('button', { name: /删除/ }).click();
      failNextTopicsRead = true;
      await Promise.all([
        page.waitForResponse((response) => response.request().method() === 'DELETE' && response.status() === 204),
        page.getByRole('button', { name: '确认永久删除' }).click(),
      ]);
      await expect(card).toHaveCount(0);
      await expect(page.locator('#topics h2')).toBeFocused();
      await expect(page.getByText(/结果已保存，列表同步暂时失败/)).toBeVisible();
      await expect(page.getByText('模拟成功后的列表同步失败')).toHaveCount(0);
      expect(blockedReads).toBe(4);
      topicId = 0;
    } finally {
      await page.unroute('**/api/topics?sort=*');
      if (topicId) await deleteLatestTopic(request, topicId);
    }
  });

  test('已有报名的活动改期先确认影响，保留名单且冲突后必须重新确认', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `改期通知确认-${marker}`;
    const remoteTitle = `远端已更新-${marker}`;
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title,
      summary: '已有报名伙伴时，修改活动安排必须确认线下通知责任。',
      proposer: '改期协调者',
      presenter: '改期协调者',
      tags: ['改期'],
    } });
    expect(created.status()).toBe(201);
    const topic = await created.json() as PhaseTopic;
    try {
    const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, {
      headers: revisionHeaders(topic.revision),
      data: {
        scheduledAt: new Date(Date.now() + 300 * 86_400_000).toISOString(),
        duration: 30,
        room: '原围炉会议室',
        meetingUrl: 'https://meet.example.test/original?passcode=must-stay-hidden',
      },
    });
    expect(scheduled.status()).toBe(200);
    const joined = await request.post(`/api/topics/${topic.id}/participants`, {
      headers: sessionHeaders(),
      data: { name: `报名伙伴-${marker}` },
    });
    expect(joined.status()).toBe(201);

    let browserPatchCount = 0;
    page.on('request', (requestEvent) => {
      if (requestEvent.method() === 'PATCH' && new URL(requestEvent.url()).pathname === `/api/topics/${topic.id}`) browserPatchCount += 1;
    });

      await page.goto('/');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await expect(card).toContainText('1 人报名');
      await card.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
      let dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '编辑议题' }) });
      await dialog.getByLabel('时长（分钟）').fill('45');
      await dialog.getByRole('button', { name: '保存修改' }).click();

      dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '确认通知报名伙伴？' }) });
      await expect(dialog.getByRole('heading', { name: '确认通知报名伙伴？' })).toBeFocused();
      await expect(dialog).toContainText('1 位伙伴已报名');
      await expect(dialog).toContainText('30 分钟');
      await expect(dialog).toContainText('45 分钟');
      await expect(dialog).toContainText('系统不会自动通知报名伙伴');
      await expect(dialog).not.toContainText('must-stay-hidden');
      expect(browserPatchCount).toBe(0);

      await dialog.getByRole('button', { name: '返回修改' }).click();
      dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '编辑议题' }) });
      await expect(dialog.getByLabel('时长（分钟）')).toHaveValue('45');
      await expect(dialog.getByRole('button', { name: '保存修改' })).toBeFocused();
      await dialog.getByRole('button', { name: '保存修改' }).click();
      dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '确认通知报名伙伴？' }) });
      expect(browserPatchCount).toBe(0);

      const parserStatus = testInfo.project.name === 'mobile' ? 413 : 400;
      const parserCode = testInfo.project.name === 'mobile' ? 'REQUEST_BODY_TOO_LARGE' : 'INVALID_JSON_BODY';
      const parserMessage = testInfo.project.name === 'mobile' ? '提交内容过大，请精简后重试' : '提交内容不是有效的 JSON，请检查后重试';
      let rejectNextPatch = true;
      await page.route(`**/api/topics/${topic.id}`, async (route) => {
        if (route.request().method() !== 'PATCH' || !rejectNextPatch) return route.continue();
        rejectNextPatch = false;
        return route.fulfill({
          status: parserStatus,
          contentType: 'application/json',
          body: JSON.stringify({ code: parserCode, message: parserMessage }),
        });
      });
      await dialog.getByRole('button', { name: '确认保存并另行通知' }).click();
      dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '确认通知报名伙伴？' }) });
      const parserAlert = dialog.getByRole('alert');
      await expect(parserAlert).toHaveText(`${parserMessage}；内容已保留，未提交`);
      await expect(parserAlert).toBeFocused();
      await expect(dialog).toContainText('1 位伙伴已报名');
      await expect(dialog).toContainText('30 分钟');
      await expect(dialog).toContainText('45 分钟');
      await expect(dialog.getByRole('button', { name: '确认保存并另行通知' })).toBeEnabled();
      expect(await parserAlert.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
      })).toBe(true);
      expect(browserPatchCount).toBe(1);
      await page.unroute(`**/api/topics/${topic.id}`);

      const beforeRemoteEdit = await readPhaseTopic(request, topic.id);
      const remoteEdit = await request.patch(`/api/topics/${topic.id}`, {
        headers: revisionHeaders(beforeRemoteEdit.revision),
        data: { title: remoteTitle },
      });
      expect(remoteEdit.status()).toBe(200);
      await dialog.getByRole('button', { name: '确认保存并另行通知' }).click();

      dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '编辑议题' }) });
      await expect(dialog.getByRole('alert')).toContainText('议题已被其他协作者更新');
      await expect(dialog.getByLabel('议题标题')).toHaveValue(remoteTitle);
      await expect(dialog.getByLabel('时长（分钟）')).toHaveValue('45');
      expect(browserPatchCount).toBe(2);
      await dialog.getByRole('button', { name: '基于最新版再次保存' }).click();

      dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '确认通知报名伙伴？' }) });
      await expect(dialog).toContainText('1 位伙伴已报名');
      const actionBounds = await Promise.all([
        dialog.getByRole('button', { name: '确认保存并另行通知' }).boundingBox(),
        dialog.getByRole('button', { name: '返回修改' }).boundingBox(),
      ]);
      for (const bounds of actionBounds) {
        expect(bounds).not.toBeNull();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await dialog.getByRole('button', { name: '确认保存并另行通知' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText('改期已保存，1 位伙伴仍保留报名，请另行通知')).toBeVisible();
      expect(browserPatchCount).toBe(3);

      const latest = await readPhaseTopic(request, topic.id);
      expect(latest).toEqual(expect.objectContaining({ title: remoteTitle, duration: 45, participantCount: 1 }));
      const participants = await request.get(`/api/topics/${topic.id}/participants`, { headers: sessionHeaders() });
      expect(participants.status()).toBe(200);
      expect(await participants.json()).toHaveLength(1);
      const updatedCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: remoteTitle, exact: true }) });
      await expect(updatedCard).toContainText('1 人报名');
    } finally {
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('活动详情叠层的 412 放弃草稿后焦点仍留在最新详情', async ({ page, request }, testInfo) => {
    const title = `详情叠层冲突-${testInfo.project.name}-${Date.now()}`;
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title,
      summary: '从活动详情进入编辑时，冲突恢复不能穿透到底层页面。',
      proposer: '叠层冲突测试',
      presenter: '叠层冲突测试',
      tags: ['叠层'],
    } });
    const topic = await created.json() as PhaseTopic;
    const scheduledResponse = await request.post(`/api/topics/${topic.id}/schedule`, {
      headers: revisionHeaders(topic.revision),
      data: { scheduledAt: new Date(Date.now() + 90 * 86_400_000).toISOString(), duration: 40, room: '叠层测试会议室', meetingUrl: '' },
    });
    expect(scheduledResponse.status()).toBe(200);
    const scheduled = await scheduledResponse.json() as PhaseTopic;
    await page.route('**/api/topics?sort=*', async (route) => {
      const response = await route.fetch();
      const topics = await response.json() as PhaseTopic[];
      await route.fulfill({ response, json: topics.filter((item) => item.id === topic.id) });
    });

    try {
      await page.goto('/');
      await page.locator('.next-fire').click();
      const details = page.getByRole('dialog', { name: title });
      await details.getByRole('button', { name: '编辑维护' }).click();
      const edit = page.getByRole('dialog', { name: '编辑议题' });
      await edit.getByLabel('一句话简介').fill('本地尚未提交的详情叠层草稿。');
      const remoteSummary = '另一位协作者已经提交的权威简介。';
      const remote = await request.patch(`/api/topics/${topic.id}`, {
        headers: revisionHeaders(scheduled.revision),
        data: { summary: remoteSummary },
      });
      expect(remote.status()).toBe(200);
      await edit.getByRole('button', { name: '保存修改' }).click();
      await expect(edit.getByRole('alert')).toContainText('议题已被其他协作者更新');
      await edit.getByRole('button', { name: '关闭' }).click();
      await expect(edit).toHaveCount(0);
      await expect(details).toBeVisible();
      await expect(details).toContainText(remoteSummary);
      const maintain = details.getByRole('button', { name: '编辑维护' });
      await expect(maintain).toBeFocused();
      await page.waitForTimeout(1_500);
      await expect(maintain).toBeFocused();
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.activity-details-modal')))).toBe(true);
    } finally {
      await page.unroute('**/api/topics?sort=*');
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('普通表单请求错误保留输入、聚焦说明且不自动重试', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /发起议题/ }).first().click();
    const dialog = page.getByRole('dialog', { name: '发起一个新议题' });
    await dialog.getByLabel('议题标题').fill('客户端错误保留的议题草稿');
    await dialog.getByLabel('一句话简介').fill('错误发生后仍应留在当前表单。');
    await dialog.getByLabel('你的名字').fill('恢复测试');
    let requestCount = 0;
    await page.route('**/api/topics', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      requestCount += 1;
      return route.fulfill({
        status: 415,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'UNSUPPORTED_MEDIA_TYPE', message: '提交格式不受支持，请使用 JSON' }),
      });
    });
    await dialog.getByRole('button', { name: '发布议题' }).click();
    const alert = dialog.getByRole('alert');
    await expect(alert).toHaveText('提交格式不受支持，请使用 JSON；内容已保留，未提交');
    await expect(alert).toBeFocused();
    await expect(dialog.getByLabel('议题标题')).toHaveValue('客户端错误保留的议题草稿');
    await expect(dialog.getByLabel('一句话简介')).toHaveValue('错误发生后仍应留在当前表单。');
    await expect(dialog.getByLabel('你的名字')).toHaveValue('恢复测试');
    await expect(dialog.getByRole('button', { name: '发布议题' })).toBeEnabled();
    await expect(page.getByRole('dialog', { name: '输入围炉口令' })).toHaveCount(0);
    expect(requestCount).toBe(1);
    await page.unroute('**/api/topics');
    await dialog.getByRole('button', { name: '关闭' }).click();
  });

  test('自荐发布并可逐步撤销排期和认领', async ({ page, request }, testInfo) => {
    const title = `自荐发布浏览器验收-${testInfo.project.name}-${Date.now()}`;
    await page.goto('/');
    await page.getByRole('button', { name: /发起议题/ }).first().click();
    await page.getByLabel('议题标题').fill(title);
    await page.getByLabel('一句话简介').fill('从自荐发布走到排期，再逐步撤销以验证纠错路径。');
    await page.getByLabel('你的名字').fill('自荐分享者');
    await page.getByLabel('我来分享').check();
    const createdResponse = page.waitForResponse((response) => response.url().endsWith('/api/topics')
      && response.request().method() === 'POST' && response.status() === 201);
    await page.getByRole('button', { name: '发布议题' }).click();
    const createdTopic = await (await createdResponse).json() as PhaseTopic;
    const transition = page.getByRole('dialog', { name: '安排炉边分享' });
    await expect(transition).toContainText('议题已发布并由你分享');
    await expect(transition).toContainText('可关闭后从“准备中”继续');
    await expect(transition.getByLabel('分享时间')).toBeFocused();
    const draftTime = await transition.getByLabel('分享时间').inputValue();
    await transition.getByLabel('时长（分钟）').fill('73');
    await transition.getByLabel('地点 / 参与说明（链接与凭证请填下方）').fill('并发后保留的炉边空间');
    await transition.getByLabel('线上会议链接（选填）').fill('https://meet.example.test/revision-recovery');
    const concurrentEdit = await request.patch(`/api/topics/${createdTopic.id}`, {
      headers: revisionHeaders(createdTopic.revision),
      data: { summary: '另一位协作者刚刚补充了议题简介。' },
    });
    expect(concurrentEdit.status()).toBe(200);
    await transition.getByRole('button', { name: '确认排期' }).click();
    const conflict = transition.getByRole('alert');
    await expect(conflict).toBeFocused();
    await expect(conflict).toContainText('排期草稿仍然保留且尚未提交');
    await expect(transition.getByLabel('分享时间')).toHaveValue(draftTime);
    await expect(transition.getByLabel('时长（分钟）')).toHaveValue('73');
    await expect(transition.getByLabel('地点 / 参与说明（链接与凭证请填下方）')).toHaveValue('并发后保留的炉边空间');
    await expect(transition.getByLabel('线上会议链接（选填）')).toHaveValue('https://meet.example.test/revision-recovery');
    await transition.getByRole('button', { name: '确认排期' }).click();
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await expect(card).toContainText('已排期');
    await expect(card).toContainText('分享 · 自荐分享者');
    await expect(card.getByRole('button', { name: /完成归档/ })).toHaveCount(0);
    await expect(card).toBeFocused();
    await page.waitForTimeout(1_200);
    await expect(card).toBeFocused();

    await card.getByRole('button', { name: /取消排期/ }).click();
    await page.getByRole('button', { name: '确认取消排期' }).click();
    await expect(card).toContainText('已被认领');

    await card.getByRole('button', { name: /重新开放/ }).click();
    await page.getByRole('button', { name: '重新开放认领' }).click();
    await expect(card).toContainText('等待添柴');
    await card.getByRole('button', { name: /删除/ }).click();
    await page.getByRole('button', { name: '确认永久删除' }).click();
    await expect(card).toHaveCount(0);
  });

  test('认领成功连续进入可跳过的排期，并使用最新议题版本', async ({ page, request }, testInfo) => {
    const title = `认领排期转场-${testInfo.project.name}-${Date.now()}`;
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title,
      summary: '验证从等待认领到准备中再到排期的连续操作。',
      proposer: '火种发起人',
      tags: ['转场'],
    } });
    expect(created.status()).toBe(201);
    const topic = await created.json() as PhaseTopic;
    let claimRequests = 0;
    page.on('request', (outgoing) => {
      if (outgoing.method() === 'POST' && outgoing.url().endsWith(`/api/topics/${topic.id}/claim`)) claimRequests += 1;
    });
    try {
      await page.goto('/');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await card.getByRole('button', { name: '认领议题' }).click();
      const claimDialog = page.getByRole('dialog', { name: '认领这个议题' });
      await claimDialog.getByLabel('认领人').fill('接棒分享人');
      const claimed = page.waitForResponse((response) => response.url().endsWith(`/api/topics/${topic.id}/claim`) && response.status() === 200);
      await claimDialog.getByRole('button', { name: '确认认领' }).click();
      const claimedTopic = await (await claimed).json() as PhaseTopic;
      expect(claimedTopic.revision).toBe(topic.revision + 1);
      expect(claimRequests).toBe(1);

      const transition = page.getByRole('dialog', { name: '安排炉边分享' });
      await expect(transition).toContainText('认领已经保存');
      await expect(transition).toContainText('可关闭后从“准备中”继续');
      await expect(transition.getByLabel('分享时间')).toBeFocused();
      await transition.getByLabel('时长（分钟）').fill('65');
      await transition.getByLabel('地点 / 参与说明（链接与凭证请填下方）').fill('认领转场草稿会议室');
      const concurrentEdit = await request.patch(`/api/topics/${topic.id}`, {
        headers: revisionHeaders(claimedTopic.revision),
        data: { summary: '发起人刚刚补充了一个上下文。' },
      });
      expect(concurrentEdit.status()).toBe(200);
      await transition.getByRole('button', { name: '确认排期' }).click();
      await expect(transition.getByRole('alert')).toContainText('排期草稿仍然保留且尚未提交');
      await expect(transition.getByLabel('时长（分钟）')).toHaveValue('65');
      await expect(transition.getByLabel('地点 / 参与说明（链接与凭证请填下方）')).toHaveValue('认领转场草稿会议室');
      await transition.getByRole('button', { name: '关闭' }).click();
      await expect(card).toContainText('已被认领');
      await expect(card).toContainText('分享 · 接棒分享人');
      await expect(card).toContainText('发起人刚刚补充了一个上下文。');
      await expect(page.getByRole('button', { name: '准备中', exact: true })).toHaveClass(/active/);
      await expect(card).toBeFocused();
      await page.waitForTimeout(1_200);
      await expect(card).toBeFocused();

      await card.getByRole('button', { name: '安排分享' }).click();
      const directSchedule = page.getByRole('dialog', { name: '安排炉边分享' });
      await expect(directSchedule.locator('.transition-note')).toHaveCount(0);
      await directSchedule.getByRole('button', { name: '关闭' }).click();
      expect(claimRequests).toBe(1);
    } finally {
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('取消排期先保留可复制名单，并在并发报名后刷新通知确认', async ({ page, request }, testInfo) => {
    const title = `取消排期通知-${testInfo.project.name}-${Date.now()}`;
    const scheduled = await createScheduledPhaseTopic(request, {
      title,
      scheduledAt: new Date(Date.now() + 220 * 86_400_000).toISOString(),
    });
    await request.post(`/api/topics/${scheduled.id}/participants`, { headers: sessionHeaders(), data: { name: 'Alice' } });
    await request.post(`/api/topics/${scheduled.id}/participants`, { headers: sessionHeaders(), data: { name: '小林' } });
    let impactReads = 0;
    await page.route(`**/api/topics/${scheduled.id}/unschedule-impact`, async (route) => {
      impactReads += 1;
      if (impactReads === 1) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: '影响读取暂时失败' }) });
        return;
      }
      await route.continue();
    });
    try {
      await page.goto('/');
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: async (value: string) => { sessionStorage.setItem('e2e-unschedule-copy', value); } },
        });
      });
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await card.getByRole('button', { name: '取消排期', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '取消这次排期？' });
      const confirm = dialog.getByRole('button', { name: '确认取消排期' });
      await expect(dialog.getByRole('alert')).toContainText('为避免丢失联系人，本次操作已锁定');
      await expect(confirm).toBeDisabled();
      await dialog.getByRole('button', { name: '重新读取名单' }).click();
      const noticeList = dialog.getByLabel('报名通知名单');
      await expect(noticeList).toContainText('受影响伙伴：2 人');
      await expect(noticeList).toContainText('Alice');
      await expect(noticeList).toContainText('小林');
      const notified = dialog.getByLabel(/我已通过其他方式通知以上伙伴/);
      await expect(notified).not.toBeChecked();
      await expect(confirm).toBeDisabled();

      await notified.check();
      await expect(confirm).toBeEnabled();
      const concurrentJoin = await request.post(`/api/topics/${scheduled.id}/participants`, { headers: sessionHeaders(), data: { name: '后来报名的伙伴' } });
      expect(concurrentJoin.status()).toBe(201);
      await confirm.click();
      const refreshedAlert = dialog.getByRole('alert');
      await expect(refreshedAlert).toContainText('报名名单已刷新，请重新核对并确认通知');
      await expect(refreshedAlert).toBeFocused();
      await expect(noticeList).toContainText('受影响伙伴：3 人');
      await expect(noticeList).toContainText('后来报名的伙伴');
      await expect(notified).not.toBeChecked();
      await expect(confirm).toBeDisabled();

      await dialog.getByRole('button', { name: '复制通知名单' }).click();
      await expect(dialog.getByText('通知名单已复制')).toBeVisible();
      const copied = await page.evaluate(() => sessionStorage.getItem('e2e-unschedule-copy'));
      expect(copied).toContain(title);
      expect(copied).toContain('受影响伙伴：3 人');
      expect(copied).toContain('Alice');
      expect(copied).toContain('小林');
      expect(copied).toContain('后来报名的伙伴');

      await notified.check();
      await confirm.click();
      await expect(dialog).toHaveCount(0);
      await expect(card).toContainText('已被认领');
      await expect(page.getByText(/移除 3 位报名；你已确认另行通知/)).toBeVisible();
      const participants = await request.get(`/api/topics/${scheduled.id}/participants`, { headers: sessionHeaders() });
      expect(await participants.json()).toEqual([]);
      const overflow = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      expect(overflow.document).toBeLessThanOrEqual(0);
      expect(overflow.body).toBeLessThanOrEqual(0);
    } finally {
      await page.unroute(`**/api/topics/${scheduled.id}/unschedule-impact`);
      await deleteLatestTopic(request, scheduled.id);
    }
  });

  test('取消影响首次读取遇到已取消或已删除时关闭失效确认并同步', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const cancelled = await createScheduledPhaseTopic(request, {
      title: `取消影响状态变化-${marker}`,
      scheduledAt: new Date(Date.now() + 230 * 86_400_000).toISOString(),
    });
    const removed = await createScheduledPhaseTopic(request, {
      title: `取消影响已删除-${marker}`,
      scheduledAt: new Date(Date.now() + 231 * 86_400_000).toISOString(),
    });
    let browserUnscheduleWrites = 0;
    page.on('request', (outgoing) => {
      if (outgoing.method() === 'POST' && /\/api\/topics\/\d+\/unschedule$/.test(outgoing.url())) browserUnscheduleWrites += 1;
    });
    try {
      await page.goto('/');
      const cancelledCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: cancelled.title, exact: true }) });
      const removedCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: removed.title, exact: true }) });
      const cancelledAction = cancelledCard.getByRole('button', { name: '取消排期', exact: true });
      const removedAction = removedCard.getByRole('button', { name: '取消排期', exact: true });
      await expect(cancelledAction).toBeVisible();
      await expect(removedAction).toBeVisible();

      const externalCancel = await request.post(`/api/topics/${cancelled.id}/unschedule`, {
        headers: revisionHeaders(cancelled.revision), data: {},
      });
      expect(externalCancel.status()).toBe(200);
      await cancelledAction.click();
      await expect(page.getByRole('dialog', { name: '取消这次排期？' })).toHaveCount(0);
      await expect(page.getByText(/取消确认已失效.*已同步最新状态/)).toBeVisible();
      await expect(cancelledCard).toContainText('已被认领');
      await expect(cancelledCard).toBeFocused();

      const removedCancelled = await request.post(`/api/topics/${removed.id}/unschedule`, {
        headers: revisionHeaders(removed.revision), data: {},
      });
      const removedClaimed = await removedCancelled.json() as PhaseTopic;
      const externalDelete = await request.delete(`/api/topics/${removed.id}`, { headers: revisionHeaders(removedClaimed.revision) });
      expect(externalDelete.status()).toBe(204);
      await removedAction.click();
      await expect(page.getByRole('dialog', { name: '取消这次排期？' })).toHaveCount(0);
      await expect(removedCard).toHaveCount(0);
      await expect(page.locator('#topics h2')).toBeFocused();
      expect(browserUnscheduleWrites).toBe(0);
    } finally {
      await deleteLatestTopic(request, cancelled.id);
      const maybeRemoved = await request.get(`/api/topics/${removed.id}`);
      if (maybeRemoved.status() === 200) await deleteLatestTopic(request, removed.id);
    }
  });

  test('线上会议可加入，并完成报名、去重和取消报名', async ({ page, request }, testInfo) => {
    const title = `线上参会浏览器验收-${testInfo.project.name}-${Date.now()}`;
    const meetingUrl = 'https://meet.example.test/fireside/weekly-room';
    let createdId: number | null = null;
    try {
    await page.goto('/');
    await page.getByRole('button', { name: /发起议题/ }).first().click();
    await page.getByLabel('议题标题').fill(title);
    await page.getByLabel('一句话简介').fill('验证会议入口、报名名单与周历中的独立参会动作。');
    await page.getByLabel('你的名字').fill('线上组织者');
    await page.getByLabel('我来分享').check();
    const created = page.waitForResponse((response) => response.url().endsWith('/api/topics')
      && response.request().method() === 'POST' && response.status() === 201);
    await page.getByRole('button', { name: '发布议题' }).click();
    createdId = ((await (await created).json()) as { id: number }).id;
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    const scheduleDialog = page.getByRole('dialog', { name: '安排炉边分享' });
    await expect(scheduleDialog).toContainText('议题已发布并由你分享');
    await scheduleDialog.getByLabel('地点 / 参与说明').fill('线上入口：https://meet.test/x?passcode=must-not-leak');
    await scheduleDialog.getByRole('button', { name: '确认排期' }).click();
    await expect(scheduleDialog.getByRole('alert')).toContainText('地点中不能填写会议链接、会议号或密码');
    await scheduleDialog.getByLabel('地点 / 参与说明').fill('线上会议');
    await scheduleDialog.getByLabel('线上会议链接（选填）').fill(meetingUrl);
    await scheduleDialog.getByRole('button', { name: '确认排期' }).click();

    await card.getByRole('button', { name: '加入会议' }).click();
    let meetingDialog = page.getByRole('dialog');
    let meetingAccessLink = meetingDialog.getByRole('link', { name: '进入线上会议' });
    await expect(meetingAccessLink).toHaveAttribute('href', meetingUrl);
    await expect(meetingAccessLink).toHaveAttribute('target', '_blank');
    await expect(meetingAccessLink).toHaveAttribute('rel', 'noreferrer');
    await meetingDialog.getByRole('button', { name: '关闭' }).click();
    const participantButton = card.getByRole('button', { name: /报名参加/ });
    await participantButton.click();
    const participantDialog = page.getByRole('dialog');
    await expect(participantDialog).toContainText('姓名仅向已解锁协作者显示');
    await expect(participantDialog).toContainText('当前不绑定个人账号，协作者可代为取消报名');
    await expect(participantDialog).not.toContainText('公开署名');
    await expect(participantDialog.getByLabel('你的名字')).toBeFocused();
    await participantDialog.getByLabel('你的名字').fill('Alice');
    await participantDialog.getByRole('button', { name: '确认报名' }).click();
    await expect(participantDialog.getByText('Alice')).toBeVisible();
    await participantDialog.getByLabel('你的名字').fill(' alice ');
    await participantDialog.getByRole('button', { name: '确认报名' }).click();
    await expect(participantDialog.getByText(/已在名单中.*已刷新/)).toBeVisible();
    await participantDialog.getByLabel('你的名字').fill('小林');
    await participantDialog.getByRole('button', { name: '确认报名' }).click();
    await expect(participantDialog.getByText('2 人')).toBeVisible();
    await participantDialog.getByRole('button', { name: '取消 Alice 的报名' }).click();
    await expect(participantDialog.getByText('1 人')).toBeVisible();
    await participantDialog.getByRole('button', { name: '关闭' }).click();
    await expect(participantButton).toBeFocused();
    await expect(card).toContainText('1 人报名');

    await page.getByRole('button', { name: '周历' }).click();
    const weekEvent = page.locator('.week-event').filter({ hasText: title });
    await expect(weekEvent).toContainText('1 人报名');
    await weekEvent.getByRole('button', { name: new RegExp(title) }).first().click();
    let activityDialog = page.getByRole('dialog', { name: title });
    await expect(activityDialog).toContainText('1 人报名');
    await activityDialog.getByRole('button', { name: '报名 / 查看参与' }).click();
    const weekParticipantDialog = page.getByRole('dialog', { name: '报名参加围炉' });
    await weekParticipantDialog.getByRole('button', { name: '取消 小林 的报名' }).click();
    await expect(weekParticipantDialog.getByText('0 人')).toBeVisible();
    await weekParticipantDialog.getByRole('button', { name: '关闭' }).click();
    activityDialog = page.getByRole('dialog', { name: title });
    await expect(activityDialog).toContainText('0 人报名');
    await activityDialog.getByRole('button', { name: '关闭' }).click();
    await expect(weekEvent).toContainText('0 人报名');

    await page.getByRole('button', { name: '月历' }).click();
    const monthEvent = page.locator('.calendar-event').filter({ hasText: title });
    await expect(monthEvent).toContainText('0 人');
    await monthEvent.click();
    await expect(page.getByRole('dialog', { name: title })).toContainText('0 人报名');
    await page.getByRole('dialog', { name: title }).getByRole('button', { name: '关闭' }).click();

    await page.getByRole('button', { name: '周历' }).click();
    await weekEvent.getByRole('button', { name: '加入会议' }).click();
    meetingDialog = page.getByRole('dialog');
    meetingAccessLink = meetingDialog.getByRole('link', { name: '进入线上会议' });
    await expect(meetingAccessLink).toHaveAttribute('href', meetingUrl);
    await meetingDialog.getByRole('button', { name: '关闭' }).click();
    await expect(page.getByRole('heading', { name: '编辑议题' })).toHaveCount(0);

    await page.getByRole('button', { name: '列表' }).click();
    await card.getByRole('button', { name: '取消排期' }).click();
    await page.getByRole('button', { name: '确认取消排期' }).click();
    await expect(card).toContainText('已被认领');
    await card.getByRole('button', { name: /删除/ }).click();
    await page.getByRole('button', { name: '确认永久删除' }).click();
    await expect(card).toHaveCount(0);
    createdId = null;
    } finally {
      if (createdId !== null) await deleteLatestTopic(request, createdId);
    }
  });

  test('并发同名报名会刷新权威名单，读取失败时进入未知态并可重试', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const successTopic = await createScheduledPhaseTopic(request, {
      title: `同名报名刷新-${marker}`,
      scheduledAt: new Date(Date.now() + 12 * 86_400_000).toISOString(),
    });
    const failureTopic = await createScheduledPhaseTopic(request, {
      title: `同名报名重试-${marker}`,
      scheduledAt: new Date(Date.now() + 13 * 86_400_000).toISOString(),
    });
    let browserJoinWrites = 0;
    page.on('request', (outgoing) => {
      if (outgoing.method() === 'POST' && /\/api\/topics\/\d+\/participants$/.test(outgoing.url())) browserJoinWrites += 1;
    });
    try {
      await page.goto('/');
      const successCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: successTopic.title, exact: true }) });
      await successCard.getByRole('button', { name: '报名参加' }).click();
      let dialog = page.getByRole('dialog', { name: '报名参加围炉' });
      await expect(dialog.getByText('0 人')).toBeVisible();
      const externalSuccess = await request.post(`/api/topics/${successTopic.id}/participants`, {
        headers: sessionHeaders(), data: { name: '同名伙伴' },
      });
      expect(externalSuccess.status()).toBe(201);
      await dialog.getByLabel('你的名字').fill('同名伙伴');
      const duplicateSuccess = page.waitForResponse((response) => response.url().endsWith(`/api/topics/${successTopic.id}/participants`)
        && response.request().method() === 'POST' && response.status() === 409);
      await dialog.getByRole('button', { name: '确认报名' }).click();
      await duplicateSuccess;
      const notice = dialog.getByRole('status');
      await expect(notice).toContainText('已在名单中，已刷新最新名单');
      await expect(notice).toBeFocused();
      await expect(dialog.getByText('同名伙伴')).toBeVisible();
      await expect(dialog.getByText('1 人')).toBeVisible();
      await expect(successCard).toContainText('1 人报名');
      await dialog.getByRole('button', { name: '关闭' }).click();

      const failureCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: failureTopic.title, exact: true }) });
      await failureCard.getByRole('button', { name: '报名参加' }).click();
      dialog = page.getByRole('dialog', { name: '报名参加围炉' });
      await expect(dialog.getByText('0 人')).toBeVisible();
      const externalFailure = await request.post(`/api/topics/${failureTopic.id}/participants`, {
        headers: sessionHeaders(), data: { name: '迟到伙伴' },
      });
      expect(externalFailure.status()).toBe(201);
      let failDuplicateRefresh = true;
      await page.route(`**/api/topics/${failureTopic.id}/participants`, async (route) => {
        if (route.request().method() === 'GET' && failDuplicateRefresh) {
          failDuplicateRefresh = false;
          return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '名单暂时不可用' }) });
        }
        await route.continue();
      });
      await dialog.getByLabel('你的名字').fill('迟到伙伴');
      const duplicateFailure = page.waitForResponse((response) => response.url().endsWith(`/api/topics/${failureTopic.id}/participants`)
        && response.request().method() === 'POST' && response.status() === 409);
      await dialog.getByRole('button', { name: '确认报名' }).click();
      await duplicateFailure;
      await expect(dialog.getByText('暂不可用', { exact: true })).toBeVisible();
      await expect(dialog.getByLabel('你的名字')).toHaveCount(0);
      const retry = dialog.getByRole('button', { name: '重新读取名单' });
      await expect(retry).toBeVisible();
      await expect(dialog.getByRole('alert')).toBeFocused();
      await retry.click();
      await expect(dialog.getByText('迟到伙伴')).toBeVisible();
      await expect(dialog.getByText('1 人')).toBeVisible();
      await expect(failureCard).toContainText('1 人报名');
      expect(browserJoinWrites).toBe(2);
      const finalParticipants = await request.get(`/api/topics/${failureTopic.id}/participants`, { headers: sessionHeaders() });
      expect((await finalParticipants.json()) as unknown[]).toHaveLength(1);
      await page.unroute(`**/api/topics/${failureTopic.id}/participants`);
    } finally {
      await page.unroute(`**/api/topics/${failureTopic.id}/participants`).catch(() => undefined);
      await deleteLatestTopic(request, successTopic.id);
      await deleteLatestTopic(request, failureTopic.id);
    }
  });

  test('并发取消同一报名会刷新权威名单，读取失败时进入未知态且不重放删除', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const successTopic = await createScheduledPhaseTopic(request, {
      title: `并发取消刷新-${marker}`,
      scheduledAt: new Date(Date.now() + 15 * 86_400_000).toISOString(),
    });
    const failureTopic = await createScheduledPhaseTopic(request, {
      title: `并发取消重试-${marker}`,
      scheduledAt: new Date(Date.now() + 16 * 86_400_000).toISOString(),
    });
    const successJoin = await request.post(`/api/topics/${successTopic.id}/participants`, {
      headers: sessionHeaders(), data: { name: '先离席伙伴' },
    });
    const failureJoin = await request.post(`/api/topics/${failureTopic.id}/participants`, {
      headers: sessionHeaders(), data: { name: '稍后离席伙伴' },
    });
    expect(successJoin.status()).toBe(201);
    expect(failureJoin.status()).toBe(201);
    const successParticipant = await successJoin.json() as { id: number };
    const failureParticipant = await failureJoin.json() as { id: number };
    let browserDeleteWrites = 0;
    page.on('request', (outgoing) => {
      if (outgoing.method() === 'DELETE' && /\/api\/topics\/\d+\/participants\/\d+$/.test(outgoing.url())) browserDeleteWrites += 1;
    });
    try {
      await page.goto('/');
      const successCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: successTopic.title, exact: true }) });
      await successCard.getByRole('button', { name: '报名参加' }).click();
      let dialog = page.getByRole('dialog', { name: '报名参加围炉' });
      await expect(dialog.getByText('先离席伙伴')).toBeVisible();
      await expect(dialog.getByText('1 人')).toBeVisible();
      const externalSuccess = await request.delete(`/api/topics/${successTopic.id}/participants/${successParticipant.id}`, { headers: sessionHeaders() });
      expect(externalSuccess.status()).toBe(204);
      const staleSuccess = page.waitForResponse((response) => response.url().endsWith(`/api/topics/${successTopic.id}/participants/${successParticipant.id}`)
        && response.request().method() === 'DELETE' && response.status() === 404);
      await dialog.getByRole('button', { name: '取消 先离席伙伴 的报名' }).click();
      await staleSuccess;
      const notice = dialog.getByRole('status');
      await expect(notice).toHaveText('该报名已由其他协作者取消，名单已刷新。');
      await expect(notice).toBeFocused();
      await expect(dialog.getByText('0 人')).toBeVisible();
      await expect(dialog.getByText('先离席伙伴')).toHaveCount(0);
      await expect(successCard).toContainText('0 人报名');
      await dialog.getByRole('button', { name: '关闭' }).click();

      const failureCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: failureTopic.title, exact: true }) });
      await failureCard.getByRole('button', { name: '报名参加' }).click();
      dialog = page.getByRole('dialog', { name: '报名参加围炉' });
      await expect(dialog.getByText('稍后离席伙伴')).toBeVisible();
      await expect(dialog.getByText('1 人')).toBeVisible();
      const externalFailure = await request.delete(`/api/topics/${failureTopic.id}/participants/${failureParticipant.id}`, { headers: sessionHeaders() });
      expect(externalFailure.status()).toBe(204);
      let failRecoveryRead = true;
      await page.route(`**/api/topics/${failureTopic.id}/participants`, async (route) => {
        if (route.request().method() === 'GET' && failRecoveryRead) {
          failRecoveryRead = false;
          return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '名单暂时不可用' }) });
        }
        await route.continue();
      });
      const staleFailure = page.waitForResponse((response) => response.url().endsWith(`/api/topics/${failureTopic.id}/participants/${failureParticipant.id}`)
        && response.request().method() === 'DELETE' && response.status() === 404);
      await dialog.getByRole('button', { name: '取消 稍后离席伙伴 的报名' }).click();
      await staleFailure;
      await expect(dialog.getByText('暂不可用', { exact: true })).toBeVisible();
      await expect(dialog.getByText('稍后离席伙伴')).toHaveCount(0);
      const retry = dialog.getByRole('button', { name: '重新读取名单' });
      await expect(retry).toBeVisible();
      await expect(dialog.getByRole('alert')).toBeFocused();
      await retry.click();
      await expect(dialog.getByText('0 人')).toBeVisible();
      await expect(failureCard).toContainText('0 人报名');
      expect(browserDeleteWrites).toBe(2);
      const finalParticipants = await request.get(`/api/topics/${failureTopic.id}/participants`, { headers: sessionHeaders() });
      expect((await finalParticipants.json()) as unknown[]).toHaveLength(0);
      await page.unroute(`**/api/topics/${failureTopic.id}/participants`);
    } finally {
      await page.unroute(`**/api/topics/${failureTopic.id}/participants`).catch(() => undefined);
      await deleteLatestTopic(request, successTopic.id);
      await deleteLatestTopic(request, failureTopic.id);
    }
  });

  test('打开名单期间另一协作者取消排期会关闭陈旧名单并说明已清空', async ({ page, request }, testInfo) => {
    const title = `名单随取消失效-${testInfo.project.name}-${Date.now()}`;
    const topic = await createScheduledPhaseTopic(request, {
      title,
      scheduledAt: new Date(Date.now() + 17 * 86_400_000).toISOString(),
    });
    const seeded = await request.post(`/api/topics/${topic.id}/participants`, {
      headers: sessionHeaders(), data: { name: '既有伙伴' },
    });
    expect(seeded.status()).toBe(201);
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
    let markListWaiting!: () => void;
    const listWaiting = new Promise<void>((resolve) => { markListWaiting = resolve; });
    let gateNextList = false;
    await page.route('**/api/topics?sort=*', async (route) => {
      if (route.request().method() === 'GET' && gateNextList) {
        gateNextList = false;
        markListWaiting();
        await listGate;
      }
      await route.continue();
    });
    try {
      await page.goto('/');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await card.getByRole('button', { name: '报名参加' }).click();
      const dialog = page.getByRole('dialog', { name: '报名参加围炉' });
      await expect(dialog.getByText('既有伙伴')).toBeVisible();
      await expect(dialog.getByText('1 人')).toBeVisible();

      gateNextList = true;
      await dialog.getByLabel('你的名字').fill('新伙伴');
      const joined = page.waitForResponse((response) => response.url().endsWith(`/api/topics/${topic.id}/participants`)
        && response.request().method() === 'POST' && response.status() === 201);
      await dialog.getByRole('button', { name: '确认报名' }).click();
      await joined;
      await expect(dialog.getByText('新伙伴')).toBeVisible();
      await listWaiting;

      const latest = await readPhaseTopic(request, topic.id);
      const unscheduled = await request.post(`/api/topics/${topic.id}/unschedule`, {
        headers: revisionHeaders(latest.revision), data: {},
      });
      expect(unscheduled.status()).toBe(200);
      releaseList();

      await expect(dialog).toHaveCount(0);
      await expect(page.getByText('活动排期已取消，报名名单已清空')).toBeVisible();
      await expect(card).toContainText('已被认领');
      await expect(card).toBeFocused();
      await page.waitForTimeout(1_200);
      await expect(card).toBeFocused();
      await expect(page.getByText('既有伙伴')).toHaveCount(0);
      await expect(page.getByText('新伙伴')).toHaveCount(0);
      const serverParticipants = await request.get(`/api/topics/${topic.id}/participants`, { headers: sessionHeaders() });
      expect((await serverParticipants.json()) as unknown[]).toHaveLength(0);
    } finally {
      releaseList();
      await page.unroute('**/api/topics?sort=*').catch(() => undefined);
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('外部更高版本的名单校正失败会先隐藏旧子集并可重试恢复', async ({ page, request }, testInfo) => {
    const title = `名单外部版本恢复-${testInfo.project.name}-${Date.now()}`;
    const topic = await createScheduledPhaseTopic(request, {
      title,
      scheduledAt: new Date(Date.now() + 18 * 86_400_000).toISOString(),
    });
    const seeded = await request.post(`/api/topics/${topic.id}/participants`, {
      headers: sessionHeaders(), data: { name: '甲伙伴' },
    });
    expect(seeded.status()).toBe(201);
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
    let markListWaiting!: () => void;
    const listWaiting = new Promise<void>((resolve) => { markListWaiting = resolve; });
    let gateNextList = false;
    let failExternalRosterRead = false;
    let browserParticipantPosts = 0;
    page.on('request', (outgoing) => {
      if (outgoing.method() === 'POST' && outgoing.url().endsWith(`/api/topics/${topic.id}/participants`)) browserParticipantPosts += 1;
    });
    await page.route('**/api/topics?sort=*', async (route) => {
      if (route.request().method() === 'GET' && gateNextList) {
        gateNextList = false;
        markListWaiting();
        await listGate;
      }
      await route.continue();
    });
    await page.route(`**/api/topics/${topic.id}/participants`, async (route) => {
      if (route.request().method() === 'GET' && failExternalRosterRead) {
        failExternalRosterRead = false;
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '外部版本名单暂时不可用' }) });
      }
      await route.continue();
    });
    try {
      await page.goto('/');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await card.getByRole('button', { name: '报名参加' }).click();
      const dialog = page.getByRole('dialog', { name: '报名参加围炉' });
      await expect(dialog.getByText('甲伙伴')).toBeVisible();

      gateNextList = true;
      await dialog.getByLabel('你的名字').fill('丙伙伴');
      await dialog.getByRole('button', { name: '确认报名' }).click();
      await expect(dialog.getByText('丙伙伴')).toBeVisible();
      await expect(dialog.getByText('2 人')).toBeVisible();
      await listWaiting;

      const external = await request.post(`/api/topics/${topic.id}/participants`, {
        headers: sessionHeaders(), data: { name: '乙伙伴' },
      });
      expect(external.status()).toBe(201);
      failExternalRosterRead = true;
      releaseList();

      await expect(dialog.getByText('暂不可用', { exact: true })).toBeVisible();
      await expect(dialog.getByText('甲伙伴')).toHaveCount(0);
      await expect(dialog.getByText('丙伙伴')).toHaveCount(0);
      await expect(dialog.getByText('乙伙伴')).toHaveCount(0);
      await expect(dialog.getByLabel('你的名字')).toHaveCount(0);
      const retry = dialog.getByRole('button', { name: '重新读取名单' });
      await expect(retry).toBeVisible();
      await expect(dialog.getByRole('alert')).toBeFocused();
      await retry.click();
      await expect(dialog.getByText('甲伙伴')).toBeVisible();
      await expect(dialog.getByText('乙伙伴')).toBeVisible();
      await expect(dialog.getByText('丙伙伴')).toBeVisible();
      await expect(dialog.getByText('3 人')).toBeVisible();
      await expect(card).toContainText('3 人报名');
      expect(browserParticipantPosts).toBe(1);
    } finally {
      releaseList();
      await page.unroute('**/api/topics?sort=*').catch(() => undefined);
      await page.unroute(`**/api/topics/${topic.id}/participants`).catch(() => undefined);
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('完整列表刷新以服务端成员关系为准且不会保留跨端已删除议题', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const deletedTitle = `跨端删除残影-${marker}`;
    const createdTitle = `触发权威刷新-${marker}`;
    const seeded = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title: deletedTitle,
      summary: '该议题会被另一个协作者删除。',
      proposer: '协作者乙',
      tags: ['并发'],
    } });
    expect(seeded.status()).toBe(201);
    const deletedTopic = await seeded.json() as PhaseTopic;
    let createdId = 0;
    try {
      await page.goto('/');
      const deletedCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: deletedTitle, exact: true }) });
      await expect(deletedCard).toBeVisible();
      const externalDelete = await request.delete(`/api/topics/${deletedTopic.id}`, { headers: revisionHeaders(deletedTopic.revision) });
      expect(externalDelete.status()).toBe(204);

      await page.getByRole('button', { name: /发起议题/ }).first().click();
      await page.getByLabel('议题标题').fill(createdTitle);
      await page.getByLabel('一句话简介').fill('一次成功写入后的完整列表刷新应移除服务端已不存在的成员。');
      await page.getByLabel('你的名字').fill('协作者甲');
      const createdResponse = page.waitForResponse((response) => response.url().endsWith('/api/topics')
        && response.request().method() === 'POST' && response.status() === 201);
      const refreshedList = page.waitForResponse((response) => response.url().includes('/api/topics?sort=')
        && response.request().method() === 'GET' && response.status() === 200);
      await page.getByRole('button', { name: '发布议题' }).click();
      const created = await (await createdResponse).json() as PhaseTopic;
      createdId = created.id;
      await refreshedList;
      await expect(page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: createdTitle, exact: true }) })).toBeVisible();
      await expect(deletedCard).toHaveCount(0);
    } finally {
      if (createdId) await deleteLatestTopic(request, createdId);
      const maybeDeleted = await request.get(`/api/topics/${deletedTopic.id}`);
      if (maybeDeleted.status() === 200) await deleteLatestTopic(request, deletedTopic.id);
    }
  });

  test('迟到的旧 Topic 快照不会覆盖报名成功版本', async ({ page, request }, testInfo) => {
    const title = `报名版本单调-${testInfo.project.name}-${Date.now()}`;
    const topic = await createScheduledPhaseTopic(request, {
      title,
      scheduledAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    });
    let releaseOldTopic!: () => void;
    const oldTopicGate = new Promise<void>((resolve) => { releaseOldTopic = resolve; });
    let markOldCaptured!: () => void;
    const oldCaptured = new Promise<void>((resolve) => { markOldCaptured = resolve; });
    let markOldDelivered!: () => void;
    const oldDelivered = new Promise<void>((resolve) => { markOldDelivered = resolve; });
    let captureOld = true;
    await page.route(`**/api/topics/${topic.id}`, async (route) => {
      if (route.request().method() === 'GET' && captureOld) {
        captureOld = false;
        const oldResponse = await route.fetch();
        markOldCaptured();
        await oldTopicGate;
        await route.fulfill({ response: oldResponse });
        markOldDelivered();
        return;
      }
      await route.continue();
    });
    try {
      await page.goto('/');
      await page.getByRole('button', { name: '月历', exact: true }).click();
      await page.locator('.calendar-event').filter({ hasText: title }).click();
      let activityDialog = page.getByRole('dialog', { name: title });
      await oldCaptured;
      await activityDialog.getByRole('button', { name: '报名 / 查看参与' }).click();
      const dialog = page.getByRole('dialog', { name: '报名参加围炉' });
      await expect(dialog.getByText('0 人')).toBeVisible();
      await dialog.getByLabel('你的名字').fill('单调版本伙伴');
      const joined = page.waitForResponse((response) => response.url().endsWith(`/api/topics/${topic.id}/participants`)
        && response.request().method() === 'POST' && response.status() === 201);
      await dialog.getByRole('button', { name: '确认报名' }).click();
      await joined;
      await expect(dialog.getByText('1 人')).toBeVisible();
      await dialog.getByRole('button', { name: '关闭' }).click();
      activityDialog = page.getByRole('dialog', { name: title });
      await expect(activityDialog).toContainText('1 人报名');

      releaseOldTopic();
      await oldDelivered;
      await expect(activityDialog).toContainText('1 人报名');
      await activityDialog.getByRole('button', { name: '关闭' }).click();
      await page.getByRole('button', { name: '列表', exact: true }).click();
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await expect(card).toContainText('1 人报名');

      await card.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
      const editDialog = page.getByRole('dialog', { name: '编辑议题' });
      await editDialog.locator('textarea[name="summary"]').fill('迟到旧快照不能让下一次编辑使用陈旧 revision。');
      const patchRequest = page.waitForRequest((outgoing) => outgoing.url().endsWith(`/api/topics/${topic.id}`)
        && outgoing.method() === 'PATCH');
      const patched = page.waitForResponse((response) => response.url().endsWith(`/api/topics/${topic.id}`)
        && response.request().method() === 'PATCH');
      await editDialog.getByRole('button', { name: '保存修改' }).click();
      expect((await patchRequest).headers()['if-match']).toBe('"3"');
      expect((await patched).status()).toBe(200);
      await expect(card).toContainText('1 人报名');
    } finally {
      releaseOldTopic();
      await page.unroute(`**/api/topics/${topic.id}`).catch(() => undefined);
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('报名和取消已成功时名单同步失败不回退本地结果', async ({ page, request }, testInfo) => {
    const title = `报名同步韧性-${testInfo.project.name}-${Date.now()}`;
    const participantName = `围炉伙伴-${testInfo.project.name}`;
    const topic = await createScheduledPhaseTopic(request, {
      title,
      scheduledAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    });
    let failNextParticipantsRead = false;
    let failNextTopicsRead = false;
    let failNextExactTopicRead = false;
    let failedReads = 0;
    let failedTopicReads = 0;
    let failedExactTopicReads = 0;
    let browserWrites = 0;
    await page.route(`**/api/topics/${topic.id}/participants`, async (route) => {
      if (route.request().method() !== 'GET' || !failNextParticipantsRead) return route.continue();
      failNextParticipantsRead = false;
      failedReads += 1;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'TEMPORARY_PARTICIPANT_SYNC_FAILURE', message: '模拟名单同步失败' }),
      });
    });
    await page.route('**/api/topics?sort=*', async (route) => {
      if (route.request().method() !== 'GET' || !failNextTopicsRead) return route.continue();
      failNextTopicsRead = false;
      failedTopicReads += 1;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'TEMPORARY_TOPIC_SYNC_FAILURE', message: '模拟议题列表同步失败' }),
      });
    });
    await page.route(`**/api/topics/${topic.id}`, async (route) => {
      if (route.request().method() !== 'GET' || !failNextExactTopicRead) return route.continue();
      failNextExactTopicRead = false;
      failedExactTopicReads += 1;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'TEMPORARY_EXACT_TOPIC_SYNC_FAILURE', message: '模拟精确议题同步失败' }),
      });
    });
    page.on('request', (requestEvent) => {
      const url = new URL(requestEvent.url());
      if (url.pathname === `/api/topics/${topic.id}/participants` && requestEvent.method() === 'POST') browserWrites += 1;
      if (url.pathname.startsWith(`/api/topics/${topic.id}/participants/`) && requestEvent.method() === 'DELETE') browserWrites += 1;
    });

    try {
      await page.goto('/');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await card.getByRole('button', { name: '报名参加' }).click();
      let dialog = page.getByRole('dialog', { name: '报名参加围炉' });
      await dialog.getByLabel('你的名字').fill(participantName);
      failNextParticipantsRead = true;
      failNextTopicsRead = true;
      failNextExactTopicRead = true;
      await dialog.getByRole('button', { name: '确认报名' }).click();
      await expect(dialog.getByText(participantName, { exact: true })).toBeVisible();
      await expect(dialog.getByText('1 人', { exact: true })).toBeVisible();
      let warning = dialog.getByRole('alert');
      await expect(warning).toContainText('报名已成功，名单同步暂时失败');
      await expect(warning).toBeFocused();
      await expect(card).toContainText('1 人报名');
      await expect(page.getByText(/报名结果已保存，议题列表同步暂时失败/)).toBeVisible();
      await expect(page.getByText('模拟议题列表同步失败', { exact: true })).toHaveCount(0);
      await expect.poll(() => failedExactTopicReads).toBe(1);
      let serverParticipants = await request.get(`/api/topics/${topic.id}/participants`, { headers: sessionHeaders() });
      expect((await serverParticipants.json() as { name: string }[]).map(({ name }) => name)).toContain(participantName);

      await dialog.getByRole('button', { name: '关闭' }).click();
      await card.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
      const editDialog = page.getByRole('dialog', { name: '编辑议题' });
      await editDialog.getByLabel('一句话简介').fill('报名版本已从响应头合并，读取双失败后仍可继续维护。');
      await editDialog.getByRole('button', { name: '保存修改' }).click();
      await expect(editDialog).toHaveCount(0);
      await expect(card).toContainText('报名版本已从响应头合并');
      await card.getByRole('button', { name: '报名参加' }).click();
      dialog = page.getByRole('dialog', { name: '报名参加围炉' });
      await expect(dialog.getByText(participantName, { exact: true })).toBeVisible();

      failNextParticipantsRead = true;
      failNextTopicsRead = true;
      failNextExactTopicRead = true;
      await dialog.getByRole('button', { name: `取消 ${participantName} 的报名` }).click();
      await expect(dialog.getByText(participantName, { exact: true })).toHaveCount(0);
      await expect(dialog.getByText('0 人', { exact: true })).toBeVisible();
      warning = dialog.getByRole('alert');
      await expect(warning).toContainText('取消报名已成功，名单同步暂时失败');
      await expect(warning).toBeFocused();
      await expect(card).toContainText('0 人报名');
      serverParticipants = await request.get(`/api/topics/${topic.id}/participants`, { headers: sessionHeaders() });
      expect(await serverParticipants.json()).toEqual([]);
      expect(failedReads).toBe(2);
      expect(failedTopicReads).toBe(2);
      await expect.poll(() => failedExactTopicReads).toBe(2);
      expect(browserWrites).toBe(2);
    } finally {
      await page.unroute(`**/api/topics/${topic.id}/participants`);
      await page.unroute(`**/api/topics/${topic.id}`);
      await page.unroute('**/api/topics?sort=*');
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('参与名单首次读取失败不伪装成零人且可原地重试', async ({ page, request }, testInfo) => {
    const title = `名单首次恢复-${testInfo.project.name}-${Date.now()}`;
    const participantName = `已报名伙伴-${testInfo.project.name}`;
    const topic = await createScheduledPhaseTopic(request, {
      title,
      scheduledAt: new Date(Date.now() + 11 * 86_400_000).toISOString(),
    });
    const joined = await request.post(`/api/topics/${topic.id}/participants`, {
      headers: sessionHeaders(), data: { name: participantName },
    });
    expect(joined.status()).toBe(201);
    const participant = await joined.json() as { id: number };
    let failFirstRead = true;
    await page.route(`**/api/topics/${topic.id}/participants`, async (route) => {
      if (route.request().method() !== 'GET' || !failFirstRead) return route.continue();
      failFirstRead = false;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'TEMPORARY_PARTICIPANT_READ_FAILURE', message: '模拟首次名单读取失败' }),
      });
    });

    try {
      await page.goto('/');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await card.getByRole('button', { name: '报名参加' }).click();
      const dialog = page.getByRole('dialog', { name: '报名参加围炉' });
      await expect(dialog.getByText('暂不可用', { exact: true })).toBeVisible();
      await expect(dialog.getByText(/名单暂时无法读取.*重新读取完整名单后才可报名/)).toBeVisible();
      await expect(dialog.getByText('0 人', { exact: true })).toHaveCount(0);
      await expect(dialog.getByLabel('你的名字')).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: '确认报名' })).toHaveCount(0);
      const alert = dialog.getByRole('alert');
      await expect(alert).toContainText('模拟首次名单读取失败');
      await expect(alert).toBeFocused();
      await alert.getByRole('button', { name: '重新读取名单' }).click();
      await expect(dialog.getByText(participantName, { exact: true })).toBeVisible();
      await expect(dialog.getByText('1 人', { exact: true })).toBeVisible();
      await expect(dialog.getByLabel('你的名字')).toBeVisible();
      await expect(dialog.getByRole('button', { name: '确认报名' })).toBeVisible();
      await expect(dialog.getByRole('alert')).toHaveCount(0);
    } finally {
      await page.unroute(`**/api/topics/${topic.id}/participants`);
      await request.delete(`/api/topics/${topic.id}/participants/${participant.id}`, { headers: sessionHeaders() });
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('完整名单读取会把外部报名人数同步到卡片和日历', async ({ page, request }, testInfo) => {
    const title = `名单跨视图校正-${testInfo.project.name}-${Date.now()}`;
    const participantName = `外部伙伴-${testInfo.project.name}`;
    const topic = await createScheduledPhaseTopic(request, {
      title,
      scheduledAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });
    let participantId = 0;
    try {
      await page.goto('/');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await expect(card).toContainText('0 人报名');
      const joined = await request.post(`/api/topics/${topic.id}/participants`, {
        headers: sessionHeaders(), data: { name: participantName },
      });
      expect(joined.status()).toBe(201);
      participantId = (await joined.json() as { id: number }).id;

      await card.getByRole('button', { name: '报名参加' }).click();
      const dialog = page.getByRole('dialog', { name: '报名参加围炉' });
      await expect(dialog.getByText(participantName, { exact: true })).toBeVisible();
      await expect(dialog.getByText('1 人', { exact: true })).toBeVisible();
      await expect(card).toContainText('1 人报名');
      await dialog.getByRole('button', { name: '关闭' }).click();

      await page.getByRole('button', { name: '月历', exact: true }).click();
      await expect(page.locator('.calendar-event').filter({ hasText: title })).toContainText('1 人');
    } finally {
      if (participantId) await request.delete(`/api/topics/${topic.id}/participants/${participantId}`, { headers: sessionHeaders() });
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('纯线下活动只引导按地点到场，不承诺不存在的会议入口', async ({ page, request }, testInfo) => {
    const title = `线下阶段承诺-${testInfo.project.name}-${Date.now()}`;
    const start = Date.now() + 3_600_000;
    const topic = await createScheduledPhaseTopic(request, {
      title,
      scheduledAt: new Date(start).toISOString(),
    });
    try {
      await page.clock.install({ time: start });
      await page.goto('/');
      const card = page.locator('.topic-card')
        .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
        .filter({ hasText: `#${String(topic.id).padStart(3, '0')}` });
      await expect(card.locator('.status-pill')).toHaveText('进行中');
      await expect(card).toContainText('仍可报名并按地点到场');
      await expect(card).not.toContainText('加入线上会议');
      await expect(card.getByRole('button', { name: '加入会议' })).toHaveCount(0);

      await page.getByRole('button', { name: '周历', exact: true }).click();
      const event = page.locator('.week-event').filter({ hasText: title });
      await event.getByRole('button', { name: new RegExp(title) }).first().click();
      const dialog = page.getByRole('dialog', { name: title });
      await expect(dialog.locator('.activity-phase-copy')).toContainText('仍可报名并按地点到场');
      await expect(dialog.locator('.activity-phase-copy')).not.toContainText('加入线上会议');
      await expect(dialog.getByRole('button', { name: '加入会议' })).toHaveCount(0);
      await dialog.getByRole('button', { name: '关闭' }).click();
    } finally {
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('从活动详情取消未来排期后返回准备中卡片而不留下失效详情', async ({ page, request }, testInfo) => {
    const title = `详情取消排期-${testInfo.project.name}-${Date.now()}`;
    const scheduled = await createScheduledPhaseTopic(request, {
      title,
      scheduledAt: new Date(Date.now() + 120 * 86_400_000).toISOString(),
    });
    await page.route('**/api/topics?sort=*', async (route) => {
      const response = await route.fetch();
      const topics = await response.json() as PhaseTopic[];
      await route.fulfill({ response, json: topics.filter((item) => item.id === scheduled.id) });
    });
    try {
      await page.goto('/');
      await page.locator('.next-fire').click();
      const details = page.getByRole('dialog', { name: title });
      await details.getByRole('button', { name: '取消排期' }).click();
      const confirmation = page.getByRole('dialog', { name: '取消这次排期？' });
      await expect(confirmation).toContainText('当前没有报名伙伴，无需执行通知步骤');
      await confirmation.getByRole('button', { name: '确认取消排期' }).click();
      await expect(details).toHaveCount(0);
      await expect(page.getByRole('dialog', { name: '安排炉边分享' })).toHaveCount(0);
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await expect(page.getByRole('button', { name: '准备中', exact: true })).toHaveClass(/active/);
      await expect(card).toContainText('已被认领');
      await expect(card).toBeFocused();
      await page.waitForTimeout(1_200);
      await expect(card).toBeFocused();
    } finally {
      await page.unroute('**/api/topics?sort=*');
      await deleteLatestTopic(request, scheduled.id);
    }
  });

  test('筛选后的周历空态说明真实原因，并可在原视图清除条件恢复', async ({ page, request }) => {
    const response = await request.get('/api/topics?sort=manual');
    expect(response.status()).toBe(200);
    const topics = await response.json() as PhaseTopic[];
    const scheduledAt = buildWeekDays(new Date())[2].toISOString();
    const fixtureTitle = `本周恢复入口-${Date.now()}`;
    const fixture: PhaseTopic = {
      id: 990_000 + Math.floor(Math.random() * 9_000),
      revision: 1,
      title: fixtureTitle,
      summary: '用于验证筛选空态不会冒充自然周真实空态。',
      proposer: '筛选恢复测试',
      presenter: '筛选恢复测试',
      tags: ['恢复'],
      status: 'SCHEDULED',
      scheduledAt,
      duration: 30,
      room: '炉边测试区',
      meetingUrl: null,
      hasMeetingUrl: false,
      participantCount: 0,
      takeaway: null,
      materialUrl: null,
      createdAt: scheduledAt,
      updatedAt: scheduledAt,
      archivedAt: null,
    };
    await page.route('**/api/topics?sort=*', async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-Order-Version': response.headers()['x-order-version'] ?? '1' },
      body: JSON.stringify([...topics, fixture]),
    }));

    await page.goto('/');
    await page.getByPlaceholder('搜索议题、标签或分享人').fill('绝不会匹配的筛选条件');
    await page.getByRole('button', { name: '周历', exact: true }).click();
    const calendarEmpty = page.locator('.calendar-empty-action');
    await expect(calendarEmpty).toContainText('当前条件下，本周没有匹配活动');
    await expect(calendarEmpty).not.toContainText('本周还没有围炉活动');
    const resultClear = page.locator('.result-context').getByRole('button', { name: '清除条件' });
    const calendarClear = calendarEmpty.getByRole('button', { name: '清除条件' });
    for (const button of [resultClear, calendarClear]) {
      const box = await button.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }

    await calendarClear.click();
    await expect(page.getByPlaceholder('搜索议题、标签或分享人')).toHaveValue('');
    await expect(page.getByRole('button', { name: '周历', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.week-event').filter({ hasText: fixtureTitle })).toBeVisible();
    await expect(calendarEmpty).toHaveCount(0);
    await expect(page.locator('#topics h2')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('搜索空态清除后恢复结果并把焦点稳定交给议题区', async ({ page }) => {
    await page.goto('/');
    const search = page.getByPlaceholder('搜索议题、标签或分享人');
    await search.fill(`没有匹配-${Date.now()}`);
    const empty = page.locator('.empty-state').filter({ hasText: '没有找到匹配的议题' });
    await expect(empty).toBeVisible();
    await empty.getByRole('button', { name: '清除搜索' }).click();
    await expect(search).toHaveValue('');
    await expect(page.locator('.topic-card')).not.toHaveCount(0);
    await page.waitForTimeout(1_200);
    await expect(page.locator('#topics h2')).toBeFocused();
  });

  test('重新连接成功或继续失败都保留可操作焦点', async ({ page }) => {
    let topicReads = 0;
    let keepFailing = false;
    await page.route('**/api/topics?sort=*', async (route) => {
      topicReads += 1;
      if (topicReads === 1 || keepFailing) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: '炉火连接暂时中断' }),
        });
        return;
      }
      await route.continue();
    });

    try {
      await page.goto('/');
      let retry = page.getByRole('button', { name: '重新连接' });
      await expect(retry).toBeVisible();
      await retry.click();
      await expect(page.locator('.topic-card')).not.toHaveCount(0);
      expect(topicReads).toBe(2);
      await page.waitForTimeout(1_200);
      await expect(page.locator('#topics h2')).toBeFocused();

      keepFailing = true;
      await page.reload();
      retry = page.getByRole('button', { name: '重新连接' });
      await expect(retry).toBeVisible();
      await retry.click();
      expect(topicReads).toBe(4);
      await expect(retry).toBeFocused();
    } finally {
      await page.unroute('**/api/topics?sort=*').catch(() => undefined);
    }
  });

  test('活动从即将开始无刷新进入进行中，并在阶段冲突后同步动作矩阵', async ({ page, request }, testInfo) => {
    test.setTimeout(45_000);
    const marker = `${testInfo.project.name}-${Date.now()}-${testInfo.retry}`;
    const upcomingTitle = `即将开始阶段验收-${marker}`;
    const liveTitle = `跨开始边界验收-${marker}`;
    const upcomingMeeting = `https://meet.example.test/upcoming/${marker}`;
    const liveMeeting = `https://meet.example.test/live/${marker}`;
    const cleanupIds: number[] = [];

    await page.addInitScript(() => {
      const key = 'e2e-phase-document-loads';
      sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? 0) + 1));
    });

    try {
      const upcoming = await createScheduledPhaseTopic(request, {
        title: upcomingTitle,
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
        meetingUrl: upcomingMeeting,
      });
      cleanupIds.push(upcoming.id);

      await page.goto('/');
      const upcomingCard = page.locator('.topic-card')
        .filter({ has: page.getByRole('heading', { name: upcomingTitle, exact: true }) })
        .filter({ hasText: `#${String(upcoming.id).padStart(3, '0')}` });
      await expect(upcomingCard.locator('.status-pill')).toHaveText('已排期');
      await expect(upcomingCard.getByRole('button', { name: '报名参加' })).toBeVisible();
      await expect(upcomingCard.getByRole('button', { name: '加入会议' })).toBeVisible();
      await expect(upcomingCard.getByRole('button', { name: '生成海报' })).toBeVisible();
      await expect(upcomingCard.getByRole('button', { name: '取消排期' })).toBeVisible();
      await expect(upcomingCard.getByRole('button', { name: new RegExp(`^删除 ${upcomingTitle}$`) })).toHaveCount(0);
      await expect(upcomingCard.getByRole('button', { name: '完成归档' })).toHaveCount(0);
      await expect(upcomingCard.getByRole('button', { name: /未举行/ })).toHaveCount(0);

      await upcomingCard.getByRole('button', { name: '报名参加' }).click();
      let participantDialog = page.getByRole('dialog');
      await participantDialog.getByLabel('你的名字').fill('即将开始参与者');
      await participantDialog.getByRole('button', { name: '确认报名' }).click();
      await expect(participantDialog.getByText('即将开始参与者')).toBeVisible();
      await participantDialog.getByRole('button', { name: '取消 即将开始参与者 的报名' }).click();
      await expect(participantDialog.getByText('0 人')).toBeVisible();
      await participantDialog.getByRole('button', { name: '关闭' }).click();

      await upcomingCard.getByRole('button', { name: '加入会议' }).click();
      let dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('link', { name: '进入线上会议' })).toHaveAttribute('href', upcomingMeeting);
      await dialog.getByRole('button', { name: '关闭' }).click();

      await upcomingCard.getByRole('button', { name: '生成海报' }).click();
      dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: '宣讲海报已为你备好' })).toBeVisible();
      await dialog.getByRole('button', { name: '关闭' }).click();

      const boundaryStart = Date.now() + 3_600_000;
      const boundary = await createScheduledPhaseTopic(request, {
        title: liveTitle,
        scheduledAt: new Date(boundaryStart).toISOString(),
        meetingUrl: liveMeeting,
      });
      cleanupIds.push(boundary.id);
      await page.clock.install({ time: boundaryStart - 8_000 });
      await page.reload();
      const documentLoadsAtUpcoming = await page.evaluate(() => Number(sessionStorage.getItem('e2e-phase-document-loads')));
      const liveCard = page.locator('.topic-card')
        .filter({ has: page.getByRole('heading', { name: liveTitle, exact: true }) })
        .filter({ hasText: `#${String(boundary.id).padStart(3, '0')}` });
      await expect(liveCard.locator('.status-pill')).toHaveText('已排期');
      await liveCard.getByRole('button', { name: '取消排期' }).click();
      const staleUnscheduleDialog = page.getByRole('dialog');
      await expect(staleUnscheduleDialog.getByRole('heading', { name: '取消这次排期？' })).toBeVisible();

      await page.route(`**/api/topics/${boundary.id}/unschedule`, async (route) => route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'ACTIVITY_TIME_CONFLICT', message: '活动进行中，不能取消排期', phase: 'LIVE' }),
      }));
      await page.clock.runFor(8_010);
      await expect(liveCard.locator('.status-pill')).toHaveText('进行中');
      expect(await page.evaluate(() => Number(sessionStorage.getItem('e2e-phase-document-loads')))).toBe(documentLoadsAtUpcoming);
      await staleUnscheduleDialog.getByRole('button', { name: '确认取消排期' }).click();
      await expect(staleUnscheduleDialog).toHaveCount(0);
      await expect(liveCard.locator('.status-pill')).toHaveText('进行中');
      await expect(page.getByText(/已同步最新状态/)).toBeVisible();

      await expect(liveCard.getByRole('button', { name: '报名参加' })).toBeVisible();
      await expect(liveCard.getByRole('button', { name: '加入会议' })).toBeVisible();
      await expect(liveCard.getByRole('button', { name: '生成海报' })).toHaveCount(0);
      await expect(liveCard.getByRole('button', { name: '取消排期' })).toHaveCount(0);
      await expect(liveCard.getByRole('button', { name: '完成归档' })).toHaveCount(0);
      await expect(liveCard.getByRole('button', { name: /未举行/ })).toHaveCount(0);
      await expect(liveCard.getByRole('button', { name: new RegExp(`^删除 ${liveTitle}$`) })).toHaveCount(0);

      await liveCard.getByRole('button', { name: '报名参加' }).click();
      participantDialog = page.getByRole('dialog');
      await participantDialog.getByLabel('你的名字').fill('迟到参与者');
      await participantDialog.getByRole('button', { name: '确认报名' }).click();
      await expect(participantDialog.getByText('迟到参与者')).toBeVisible();
      await participantDialog.getByRole('button', { name: '关闭' }).click();

      await liveCard.getByRole('button', { name: '加入会议' }).click();
      dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('link', { name: '进入线上会议' })).toHaveAttribute('href', liveMeeting);
      await dialog.getByRole('button', { name: '关闭' }).click();

      await liveCard.getByRole('button', { name: `编辑 ${liveTitle}`, exact: true }).click();
      dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('活动进行中，排期已锁定');
      await expect(dialog.getByLabel('分享时间')).toBeDisabled();
      await expect(dialog.getByLabel('时长（分钟）')).toBeDisabled();
      await expect(dialog.getByLabel('地点 / 参与说明（链接与凭证请填下方）')).toBeEnabled();
      await dialog.getByRole('button', { name: '关闭' }).click();

      await page.getByRole('button', { name: '周历' }).click();
      const liveWeekEvent = page.locator('.week-event').filter({ hasText: liveTitle });
      await expect(liveWeekEvent).toContainText('进行中');
      await expect(liveWeekEvent.getByRole('button', { name: '加入会议' })).toBeVisible();
      await expect(liveWeekEvent.getByRole('button', { name: '生成海报' })).toHaveCount(0);
      await page.unroute(`**/api/topics/${boundary.id}/unschedule`);
    } finally {
      await cleanupPhaseTopics(request, cleanupIds);
    }
  });

  test('结束与归档阶段提供只读名单、归档和未举行恢复且关闭会议', async ({ page, request }) => {
    const topicsResponse = await request.get('/api/topics');
    expect(topicsResponse.ok()).toBe(true);
    const topics = await topicsResponse.json() as PhaseTopic[];
    const archivedSeed = topics.find((topic) => topic.title === 'RAG 不是万能药：我们踩过的三个坑' && topic.status === 'ARCHIVED');
    if (!archivedSeed) throw new Error('缺少可恢复的历史归档种子议题');
    const originalArchive = {
      takeaway: archivedSeed.takeaway ?? '历史归档验收恢复内容',
      materialUrl: archivedSeed.materialUrl ?? '',
    };

    try {
      await page.goto('/');
      let seedCard = page.locator('.topic-card')
        .filter({ has: page.getByRole('heading', { name: archivedSeed.title, exact: true }) })
        .filter({ hasText: `#${String(archivedSeed.id).padStart(3, '0')}` });
      await expect(seedCard.locator('.status-pill')).toHaveText('已经归档');
      await expect(seedCard.getByRole('button', { name: '查看参与' })).toBeVisible();
      await expect(seedCard.getByRole('button', { name: '撤销归档' })).toBeVisible();
      await expect(seedCard.getByRole('button', { name: '加入会议' })).toHaveCount(0);
      await expect(seedCard.getByRole('button', { name: '报名参加' })).toHaveCount(0);
      await expect(seedCard.getByRole('button', { name: '生成海报' })).toHaveCount(0);
      await expect(seedCard.getByRole('button', { name: '完成归档' })).toHaveCount(0);
      await expect(seedCard.getByRole('button', { name: new RegExp(`^删除 ${archivedSeed.title}$`) })).toHaveCount(0);
      await seedCard.getByRole('button', { name: `编辑 ${archivedSeed.title}`, exact: true }).click();
      let dialog = page.getByRole('dialog', { name: '编辑议题' });
      await expect(dialog.getByLabel('资料链接（选填）')).toHaveAttribute('maxlength', '2048');
      await expect(dialog.getByLabel('分享时间')).toBeEnabled();
      await expect(dialog.getByLabel('时长（分钟）')).toBeEnabled();
      await expect(dialog).toContainText('活动必须在归档时间');
      await dialog.getByRole('button', { name: '关闭' }).click();
      const archivedMeeting = await request.get(`/api/topics/${archivedSeed.id}/meeting-access`, { headers: sessionHeaders() });
      expect(archivedMeeting.status()).toBe(409);
      expect(await archivedMeeting.text()).not.toContain('http');

      const unarchived = await request.post(`/api/topics/${archivedSeed.id}/unarchive`, {
        headers: revisionHeaders((await readPhaseTopic(request, archivedSeed.id)).revision),
        data: {},
      });
      expect(unarchived.status()).toBe(200);
      await page.reload();
      seedCard = page.locator('.topic-card')
        .filter({ has: page.getByRole('heading', { name: archivedSeed.title, exact: true }) })
        .filter({ hasText: `#${String(archivedSeed.id).padStart(3, '0')}` });
      await expect(seedCard.locator('.status-pill')).toHaveText('待归档');
      await expect(seedCard).toContainText('分享已结束，等待归档');
      await expect(seedCard.getByRole('button', { name: '查看参与' })).toBeVisible();
      await expect(seedCard.getByRole('button', { name: '完成归档' })).toBeVisible();
      await expect(seedCard.getByRole('button', { name: '未举行 / 重新排期' })).toBeVisible();
      await expect(seedCard.getByRole('button', { name: '报名参加' })).toHaveCount(0);
      await expect(seedCard.getByRole('button', { name: '加入会议' })).toHaveCount(0);
      await expect(seedCard.getByRole('button', { name: '生成海报' })).toHaveCount(0);
      await expect(seedCard.getByRole('button', { name: '取消排期' })).toHaveCount(0);
      await expect(seedCard.getByRole('button', { name: new RegExp(`^删除 ${archivedSeed.title}$`) })).toHaveCount(0);
      const endedMeeting = await request.get(`/api/topics/${archivedSeed.id}/meeting-access`, { headers: sessionHeaders() });
      expect(endedMeeting.status()).toBe(409);
      expect(await endedMeeting.text()).not.toContain('http');

      await seedCard.getByRole('button', { name: '查看参与' }).click();
      dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: '本期参与伙伴' })).toBeVisible();
      await expect(dialog.getByText('0 人')).toBeVisible();
      await expect(dialog).toContainText('本期报名已经结束，名单仅供回顾');
      await expect(dialog).toContainText('本期暂无参与记录');
      await expect(dialog).not.toContainText('成为第一位围炉伙伴');
      await expect(dialog).not.toContainText('协作者可代为取消报名');
      await expect(dialog.getByLabel('你的名字')).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: '确认报名' })).toHaveCount(0);
      await expect(dialog.locator('.participant-row button')).toHaveCount(0);
      await dialog.getByRole('button', { name: '关闭' }).click();

      await seedCard.getByRole('button', { name: `编辑 ${archivedSeed.title}`, exact: true }).click();
      dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('分享时间')).toBeDisabled();
      await expect(dialog.getByLabel('时长（分钟）')).toBeDisabled();
      await expect(dialog.getByLabel('地点 / 参与说明（链接与凭证请填下方）')).toBeEnabled();
      await dialog.getByRole('button', { name: '关闭' }).click();

      await page.getByRole('button', { name: '周历' }).click();
      await page.getByRole('button', { name: '上一个周期' }).click();
      const endedWeekEvent = page.locator('.week-event').filter({ hasText: archivedSeed.title });
      await expect(endedWeekEvent).toContainText('待归档');
      await expect(endedWeekEvent.getByRole('button', { name: '加入会议' })).toHaveCount(0);
      await expect(endedWeekEvent.getByRole('button', { name: '生成海报' })).toHaveCount(0);
      await page.getByRole('button', { name: '列表' }).click();

      await seedCard.getByRole('button', { name: '完成归档' }).click();
      dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('资料链接（选填）')).toHaveAttribute('maxlength', '2048');
      await dialog.getByLabel('本期最值得留下的收获').fill(originalArchive.takeaway);
      if (originalArchive.materialUrl) await dialog.getByLabel('资料链接（选填）').fill(originalArchive.materialUrl);
      await dialog.getByRole('button', { name: '完成归档' }).click();
      await page.getByRole('button', { name: '往期归档', exact: true }).click();
      await expect(seedCard.locator('.status-pill')).toHaveText('已经归档');

      const secondUnarchive = await request.post(`/api/topics/${archivedSeed.id}/unarchive`, {
        headers: revisionHeaders((await readPhaseTopic(request, archivedSeed.id)).revision),
        data: {},
      });
      expect(secondUnarchive.status()).toBe(200);
      const endedForReset = await readPhaseTopic(request, archivedSeed.id);
      await page.reload();
      seedCard = page.locator('.topic-card')
        .filter({ has: page.getByRole('heading', { name: archivedSeed.title, exact: true }) })
        .filter({ hasText: `#${String(archivedSeed.id).padStart(3, '0')}` });

      let serveResetResult = false;
      let resetRequestCount = 0;
      const claimedAfterReset: PhaseTopic = {
        ...endedForReset,
        revision: endedForReset.revision + 1,
        status: 'CLAIMED',
        scheduledAt: null,
        duration: null,
        room: null,
        meetingUrl: null,
        hasMeetingUrl: false,
        participantCount: 0,
        updatedAt: new Date().toISOString(),
      };
      await page.route(`**/api/topics/${archivedSeed.id}/unschedule`, async (route) => {
        resetRequestCount += 1;
        serveResetResult = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(claimedAfterReset) });
      });
      await page.route(/\/api\/topics\?sort=/, async (route) => {
        if (!serveResetResult) return route.continue();
        const response = await route.fetch();
        const currentTopics = await response.json() as PhaseTopic[];
        await route.fulfill({ response, json: currentTopics.map((topic) => topic.id === archivedSeed.id ? claimedAfterReset : topic) });
      });

      await page.getByRole('button', { name: '周历', exact: true }).click();
      await page.getByRole('button', { name: '上一个周期' }).click();
      const resetEvent = page.locator('.week-event').filter({ hasText: archivedSeed.title });
      await resetEvent.locator('.week-event-main').click();
      const resetDetails = page.getByRole('dialog', { name: archivedSeed.title });
      await resetDetails.getByRole('button', { name: '未举行 / 重新排期' }).click();
      dialog = page.getByRole('dialog', { name: '确认未举行 / 重新排期？' });
      await expect(dialog.getByRole('heading', { name: '确认未举行 / 重新排期？' })).toBeVisible();
      await expect(dialog).toContainText('当前没有报名伙伴，无需执行通知步骤。');
      await expect(dialog).toContainText(/地点/);
      await expect(dialog).toContainText(/会议入口/);
      await dialog.getByRole('button', { name: '确认未举行 / 重新排期' }).click();
      expect(resetRequestCount).toBe(1);
      const rescheduleTransition = page.getByRole('dialog', { name: '安排炉边分享' });
      await expect(rescheduleTransition).toContainText('未举行状态已保存，旧报名已经清理');
      await expect(page.getByRole('dialog', { name: archivedSeed.title })).toHaveCount(0);
      await rescheduleTransition.getByRole('button', { name: '关闭' }).click();
      await expect(seedCard.locator('.status-pill')).toHaveText('已被认领');
      await expect(seedCard).not.toContainText('人报名');
      await expect(seedCard).toBeFocused();
      const unchangedRealParticipants = await request.get(`/api/topics/${archivedSeed.id}/participants`, { headers: sessionHeaders() });
      expect(unchangedRealParticipants.status()).toBe(200);
      expect(await unchangedRealParticipants.json()).toEqual([]);
      await page.unroute(`**/api/topics/${archivedSeed.id}/unschedule`);
      await page.unroute(/\/api\/topics\?sort=/);
    } finally {
      const current = await readPhaseTopic(request, archivedSeed.id);
      if (current.status === 'SCHEDULED') {
        const restored = await request.post(`/api/topics/${archivedSeed.id}/archive`, {
          headers: revisionHeaders(current.revision),
          data: originalArchive,
        });
        if (restored.status() !== 200) throw new Error(`Failed to restore archived seed ${archivedSeed.id}: ${restored.status()}`);
      } else if (current.status !== 'ARCHIVED') {
        throw new Error(`Archived seed ${archivedSeed.id} ended in unexpected state ${current.status}`);
      }
    }
  });

  test('往期列表与活动详情在无资料链接时仍完整呈现原活动和本期收获', async ({ page }) => {
    const scheduledAt = buildWeekDays(new Date())[1].toISOString();
    const title = `完整往期回顾-${Date.now()}`;
    const takeaway = '这次围炉确认了三个可复用结论，并留下一个需要下一位伙伴继续追问的问题。';
    const archived: PhaseTopic = {
      id: 980_000 + Math.floor(Math.random() * 9_000),
      revision: 4,
      title,
      summary: '没有外部资料链接时，系统自身仍应承载完整回顾。',
      proposer: '往期发起人',
      presenter: '往期分享人',
      tags: ['往期', '沉淀'],
      status: 'ARCHIVED',
      scheduledAt,
      duration: 55,
      room: '炉边回顾空间',
      meetingUrl: null,
      hasMeetingUrl: false,
      participantCount: 3,
      takeaway,
      materialUrl: null,
      createdAt: scheduledAt,
      updatedAt: scheduledAt,
      archivedAt: scheduledAt,
    };
    await page.route('**/api/topics?sort=*', async (route) => {
      const response = await route.fetch();
      const topics = await response.json() as PhaseTopic[];
      await route.fulfill({ response, json: [...topics, archived] });
    });
    await page.route(`**/api/topics/${archived.id}`, async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(archived),
    }));
    await page.goto('/');
    await page.getByRole('button', { name: '往期归档', exact: true }).click();
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    const archivedYear = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date(scheduledAt));
    await expect(card.locator('.archived-schedule')).toContainText(archivedYear);
    await expect(card.locator('.archived-schedule')).toContainText('炉边回顾空间');
    await expect(card.locator('.archived-schedule')).toContainText('55 分钟');
    await expect(card).toContainText(takeaway);
    await expect(card.getByRole('button', { name: /展开议题简介|展开炉边余温/ })).toHaveCount(0);
    await expect(card.getByRole('button', { name: '加入会议' })).toHaveCount(0);

    await page.getByRole('button', { name: '周历', exact: true }).click();
    const event = page.locator('.week-event').filter({ hasText: title });
    await event.locator('.week-event-main').click();
    const dialog = page.getByRole('dialog', { name: title });
    await expect(dialog.locator('.activity-detail-grid')).toContainText(archivedYear);
    await expect(dialog.locator('.activity-detail-grid')).toContainText('炉边回顾空间');
    await expect(dialog.locator('.activity-detail-grid')).toContainText('55 分钟');
    await expect(dialog.locator('.activity-takeaway')).toContainText(takeaway);
    await expect(dialog.getByRole('link', { name: '查看资料' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '加入会议' })).toHaveCount(0);
    const dimensions = await dialog.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    await dialog.getByRole('button', { name: '关闭' }).click();
    await page.unroute(`**/api/topics/${archived.id}`);
    await page.unroute('**/api/topics?sort=*');
  });

  test('跨年排期在列表与下一场显示年份，同年仍保持紧凑格式', async ({ page }, testInfo) => {
    const reference = new Date('2026-12-30T04:00:00.000Z');
    let scheduledAt = '2027-01-08T11:30:00.000Z';
    let fixtureCount = 1;
    const title = `跨年排期日期-${testInfo.project.name}`;
    const fixture = (): PhaseTopic => ({
      id: 979_321,
      revision: 2,
      title,
      summary: '跨年度活动必须在发现入口明确显示年份。',
      proposer: '日期验收',
      presenter: '日期验收',
      tags: ['跨年'],
      status: 'SCHEDULED',
      scheduledAt,
      duration: 45,
      room: '跨年炉边',
      meetingUrl: null,
      hasMeetingUrl: false,
      participantCount: 0,
      takeaway: null,
      materialUrl: null,
      createdAt: reference.toISOString(),
      updatedAt: reference.toISOString(),
      archivedAt: null,
    });
    await page.clock.install({ time: reference });
    await page.route('**/api/topics?sort=*', async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-Order-Version': '1' },
      body: JSON.stringify(Array.from({ length: fixtureCount }, (_, index) => ({
        ...fixture(),
        id: 979_321 + index,
        title: index === 0 ? title : `${title}-${index + 1}`,
      }))),
    }));

    const assertCrossYear = async () => {
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await expect(card.locator('.schedule-box')).toContainText('2027年');
      await expect(page.locator('.next-fire strong')).toContainText('2027年');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    };
    await page.goto('/');
    await assertCrossYear();
    if (testInfo.project.name === 'chromium') {
      await page.setViewportSize({ width: 820, height: 1180 });
      await page.reload();
      await assertCrossYear();
    }

    fixtureCount = 4;
    await page.reload();
    await page.getByRole('button', { name: '周历', exact: true }).click();
    await expect(page.locator('.calendar-toolbar h3')).toHaveText('2026年12月28日 — 2027年1月3日');
    await page.getByRole('button', { name: '查看下一场' }).click();
    await expect(page.locator('.calendar-toolbar h3')).toHaveText('2027年1月4日 — 1月10日');
    const crossYearEvent = page.locator('.week-event').filter({ hasText: title }).first();
    await expect(crossYearEvent).toContainText('2027年1月8日');
    await page.waitForTimeout(1_200);
    await expect(crossYearEvent.locator('.week-event-main')).toBeFocused();
    await expect.poll(() => page.evaluate(() => {
      const target = document.activeElement as HTMLElement | null;
      const header = document.querySelector<HTMLElement>('.site-header');
      if (!target || !header) return Number.NEGATIVE_INFINITY;
      return target.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
    })).toBeGreaterThanOrEqual(8);
    const crossYearMore = page.getByRole('button', { name: /2027年1月8日.*共有 4 场，查看全部当日议程/ });
    await crossYearMore.click();
    const crossYearAgenda = page.getByRole('dialog', { name: /2027年1月8日.*4 场围炉/ });
    await expect(crossYearAgenda).toBeVisible();
    await crossYearAgenda.getByRole('button', { name: '关闭当日议程' }).click();

    fixtureCount = 1;
    scheduledAt = '2026-12-27T11:30:00.000Z';
    await page.getByRole('button', { name: '列表', exact: true }).click();
    await page.reload();
    const sameYearCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await expect(sameYearCard.locator('.schedule-box')).not.toContainText('2026年');
    await expect(page.locator('.next-fire strong')).not.toContainText('2026年');
    await page.unroute('**/api/topics?sort=*');
  });

  test('纯历史同日议程只承诺回顾，不误导报名、会议或海报', async ({ page }, testInfo) => {
    const now = new Date('2026-09-02T06:00:00.000Z');
    const titlePrefix = `历史议程文案-${testInfo.project.name}`;
    const archivedTopics: PhaseTopic[] = Array.from({ length: 4 }, (_, index) => ({
      id: 989_100 + index,
      revision: 4,
      title: `${titlePrefix}-${index + 1}`,
      summary: '历史活动只能回顾真实存在的参与和沉淀信息。',
      proposer: '历史验收',
      presenter: '历史分享人',
      tags: ['历史'],
      status: 'ARCHIVED',
      scheduledAt: new Date(`2026-09-01T${String(10 + index).padStart(2, '0')}:00:00.000Z`).toISOString(),
      duration: 30,
      room: '历史炉边',
      meetingUrl: null,
      hasMeetingUrl: false,
      participantCount: index,
      takeaway: '已沉淀一条回顾线索',
      materialUrl: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: now.toISOString(),
      archivedAt: now.toISOString(),
    }));
    await page.clock.install({ time: now });
    await page.route('**/api/topics?sort=*', async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-Order-Version': '1' },
      body: JSON.stringify(archivedTopics),
    }));

    await page.goto('/');
    await page.getByRole('button', { name: '月历', exact: true }).click();
    await page.getByRole('button', { name: /2026年9月1日.*共有 4 场，查看全部当日议程/ }).click();
    const agenda = page.getByRole('dialog', { name: /2026年9月1日.*4 场围炉/ });
    await expect(agenda.locator('.modal-intro')).toHaveText('这些活动均已归档。选择一场，可回顾参与伙伴与沉淀内容。');
    await expect(agenda.locator('.modal-intro')).not.toContainText('报名');
    await expect(agenda.locator('.modal-intro')).not.toContainText('加入会议');
    await expect(agenda.locator('.modal-intro')).not.toContainText('海报');
    await page.unroute('**/api/topics?sort=*');
  });

  test('公网只读脱敏，解锁后协作且失效口令不会丢失表单', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const protectedTitle = `公网隐私验收-${marker}`;
    const retainedTitle = `口令失效表单保留-${marker}`;
    const secretMeeting = `https://meet.example.test/private/${marker}?passcode=never-public`;
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title: protectedTitle, summary: '公开页面可以看到议题，但不能看到会议凭证和报名姓名。', proposer: '隐私组织者', presenter: '隐私组织者', tags: ['隐私'],
    } });
    const topic = await created.json() as { id: number; revision: number };
    try {
    const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, { headers: revisionHeaders(topic.revision), data: {
      scheduledAt: new Date(Date.now() + 301 * 86_400_000).toISOString(), duration: 40, room: '三楼围炉会议室', meetingUrl: secretMeeting,
    } });
    expect(scheduled.status()).toBe(200);
    await request.post(`/api/topics/${topic.id}/participants`, { headers: sessionHeaders(), data: { name: '不公开的报名人' } });

    const publicTopics = await request.get('/api/topics');
    expect(publicTopics.status()).toBe(200);
    expect(await publicTopics.text()).not.toContain('never-public');
    expect(await publicTopics.text()).not.toContain('不公开的报名人');
    expect((await request.get(`/api/topics/${topic.id}/participants`)).status()).toBe(401);
    expect((await request.get(`/api/topics/${topic.id}/meeting-access`)).status()).toBe(401);
    expect((await request.post('/api/topics', { data: {} })).status()).toBe(401);

    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('e2e-force-locked', '1');
      sessionStorage.setItem('fireside-write-key', 'legacy-raw-key-must-not-migrate');
      sessionStorage.removeItem('fireside-collaboration-session-v1');
    });
    await page.reload();
    await expectCollaborationState(page, '解锁协作');
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('fireside-write-key'))).toBeNull();
    await expect(page.locator('body')).not.toContainText('never-public');
    await expect(page.locator('body')).not.toContainText('不公开的报名人');
    const protectedCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: protectedTitle, exact: true }) });
    await protectedCard.getByRole('button', { name: '加入会议' }).click();
    let accessDialog = page.getByRole('dialog');
    await expect(accessDialog.getByRole('heading', { name: '解锁围炉协作' })).toBeVisible();
    await accessDialog.getByLabel('围炉口令').fill('五字口令呀');
    await accessDialog.getByRole('button', { name: '解锁协作' }).click();
    await expect(accessDialog.getByText('围炉口令至少需要 6 个字符')).toBeVisible();
    await expect(accessDialog.getByLabel('围炉口令')).toHaveValue('');
    await accessDialog.getByLabel('围炉口令').fill('wrong-key');
    await accessDialog.getByRole('button', { name: '解锁协作' }).click();
    await expect(accessDialog.getByText('围炉口令不正确')).toBeVisible();
    await expect(accessDialog.getByLabel('围炉口令')).toHaveValue('');
    await accessDialog.getByLabel('围炉口令').fill(writeKey);
    const encodedVerification = page.waitForRequest((request) => request.url().endsWith('/api/access/verify'));
    await accessDialog.getByRole('button', { name: '解锁协作' }).click();
    const verificationHeaders = (await encodedVerification).headers();
    expect(verificationHeaders['x-fireside-write-key-encoding']).toBe('base64url-utf8-v1');
    expect(verificationHeaders['x-fireside-write-key']).toBe(Buffer.from(writeKey, 'utf8').toString('base64url'));
    expect(verificationHeaders['x-fireside-write-key']).toMatch(/^[A-Za-z0-9_-]+$/);
    const meetingDialog = page.getByRole('dialog');
    await expect(meetingDialog.getByRole('link', { name: '进入线上会议' })).toHaveAttribute('href', secretMeeting);
    await meetingDialog.getByRole('button', { name: '关闭' }).click();
    await expectCollaborationState(page, '退出协作');
    expect(await page.evaluate((plainKey) => Object.values(sessionStorage).includes(plainKey), writeKey)).toBe(false);

    await clickCollaborationState(page, '退出协作');
    await expectCollaborationState(page, '解锁协作');
    await page.getByRole('button', { name: /发起议题/ }).first().click();
    const createDialog = page.getByRole('dialog', { name: '发起一个新议题' });
    await expect(createDialog).toBeVisible();
    await expect(page.getByRole('dialog', { name: '解锁围炉协作' })).toHaveCount(0);
    await expect(createDialog.getByRole('status')).toContainText('可以先填写草稿');
    await createDialog.getByLabel('议题标题').fill(retainedTitle);
    await createDialog.getByLabel('一句话简介').fill('第一次提交因口令失效而失败，重新解锁后由用户再次确认。');
    await createDialog.getByLabel('你的名字').fill('协作测试者');
    let createRequestCount = 0;
    page.on('request', (outgoing) => {
      if (outgoing.method() === 'POST' && outgoing.url().endsWith('/api/topics')) createRequestCount += 1;
    });
    await createDialog.getByRole('button', { name: '发布议题' }).click();
    accessDialog = page.getByRole('dialog', { name: '解锁围炉协作' });
    await expect(accessDialog).toContainText('议题草稿已保留且尚未提交');
    expect(createRequestCount).toBe(0);
    await accessDialog.getByLabel('围炉口令').fill(writeKey);
    await accessDialog.getByRole('button', { name: '解锁协作' }).click();
    await expect(createDialog.getByLabel('议题标题')).toHaveValue(retainedTitle);
    await expect(createDialog.getByRole('button', { name: '发布议题' })).toBeFocused();
    expect(createRequestCount).toBe(0);

    await page.evaluate(() => sessionStorage.setItem('fireside-collaboration-session-v1', 'expired-session'));
    await createDialog.getByRole('button', { name: '发布议题' }).click();
    accessDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '解锁围炉协作' }) });
    await expect(accessDialog).toBeVisible();
    await expect(createDialog.getByLabel('议题标题')).toHaveValue(retainedTitle);
    expect(createRequestCount).toBe(1);
    await accessDialog.getByLabel('围炉口令').fill(writeKey);
    await accessDialog.getByRole('button', { name: '解锁协作' }).click();
    await expect(createDialog.getByLabel('议题标题')).toHaveValue(retainedTitle);
    expect(createRequestCount).toBe(1);
    await createDialog.getByRole('button', { name: '发布议题' }).click();
    expect(createRequestCount).toBe(2);
    await expect(page.getByRole('heading', { name: retainedTitle, exact: true })).toBeVisible();

    } finally {
      const allTopics = await request.get('/api/topics');
      const cleanupIds = (await allTopics.json() as { id: number; title: string }[])
        .filter((item) => item.title === protectedTitle || item.title === retainedTitle)
        .map(({ id }) => id);
      await Promise.all(cleanupIds.map((id) => deleteLatestTopic(request, id)));
    }
  });

  test('解锁协作与发起议题在锁定状态进入不同任务', async ({ page, request }, testInfo) => {
    const title = `入口分离-${testInfo.project.name}-${Date.now()}`;
    let createdId: number | null = null;
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('e2e-force-locked', '1');
      sessionStorage.removeItem('fireside-collaboration-session-v1');
    });
    await page.reload();
    await expectCollaborationState(page, '解锁协作');

    await clickCollaborationState(page, '解锁协作');
    const accessDialog = page.getByRole('dialog', { name: '解锁围炉协作' });
    await expect(accessDialog).toBeVisible();
    await expect(page.getByRole('dialog', { name: '发起一个新议题' })).toHaveCount(0);
    await accessDialog.getByRole('button', { name: '关闭' }).click();
    if (testInfo.project.name === 'mobile') await expect(page.getByRole('button', { name: '菜单', exact: true })).toBeFocused();
    else await expect(page.locator('.desktop-nav').getByRole('button', { name: '解锁协作', exact: true })).toBeFocused();

    await page.getByRole('button', { name: /发起议题|^发起$/ }).first().click();
    const createDialog = page.getByRole('dialog', { name: '发起一个新议题' });
    await expect(createDialog).toBeVisible();
    await expect(page.getByRole('dialog', { name: '解锁围炉协作' })).toHaveCount(0);
    await expect(createDialog.getByLabel('议题标题')).toBeFocused();
    await expect(createDialog).toContainText('可以先填写草稿；发布时再用围炉口令解锁');
    await createDialog.getByLabel('议题标题').fill(title);
    await createDialog.getByLabel('一句话简介').fill('先整理草稿，再在真正发布时解锁。');
    await createDialog.getByLabel('你的名字').fill('入口测试者');
    await createDialog.getByLabel('标签（最多 5 个）').fill('入口, 草稿');
    await createDialog.getByLabel('我来分享').check();
    const submit = createDialog.getByRole('button', { name: '发布议题' });
    let createRequests = 0;
    page.on('request', (outgoing) => {
      if (outgoing.method() === 'POST' && outgoing.url().endsWith('/api/topics')) createRequests += 1;
    });

    async function expectDraft() {
      await expect(createDialog.getByLabel('议题标题')).toHaveValue(title);
      await expect(createDialog.getByLabel('一句话简介')).toHaveValue('先整理草稿，再在真正发布时解锁。');
      await expect(createDialog.getByLabel('你的名字')).toHaveValue('入口测试者');
      await expect(createDialog.getByLabel('标签（最多 5 个）')).toHaveValue('入口, 草稿');
      await expect(createDialog.getByLabel('我来分享')).toBeChecked();
      await expect(submit).toBeFocused();
      expect(createRequests).toBe(0);
    }
    async function openDraftAccess() {
      await submit.click();
      const dialog = page.getByRole('dialog', { name: '解锁围炉协作' });
      await expect(page.locator('[role="dialog"]')).toHaveCount(2);
      await expect(createDialog).toHaveAttribute('inert', '');
      await expect(dialog).toContainText('议题草稿已保留且尚未提交');
      expect(createRequests).toBe(0);
      return dialog;
    }

    let draftAccess = await openDraftAccess();
    await draftAccess.getByLabel('围炉口令').fill('五字口令呀');
    await draftAccess.getByRole('button', { name: '解锁协作' }).click();
    await expect(draftAccess.getByRole('alert')).toContainText('围炉口令至少需要 6 个字符');
    expect(createRequests).toBe(0);
    await draftAccess.getByRole('button', { name: '关闭' }).click();
    await expectDraft();

    draftAccess = await openDraftAccess();
    await page.locator('.access-backdrop').click({ position: { x: 2, y: 2 } });
    await expectDraft();

    draftAccess = await openDraftAccess();
    await page.keyboard.press('Escape');
    await expectDraft();

    draftAccess = await openDraftAccess();
    await draftAccess.getByLabel('围炉口令').fill(writeKey);
    await draftAccess.getByRole('button', { name: '解锁协作' }).click();
    await expectDraft();

    try {
      const created = page.waitForResponse((response) => response.url().endsWith('/api/topics')
        && response.request().method() === 'POST' && response.status() === 201);
      await submit.click();
      const createdResponse = await created;
      createdId = ((await createdResponse.json()) as { id: number }).id;
      expect(createRequests).toBe(1);
      const transition = page.getByRole('dialog', { name: '安排炉边分享' });
      await expect(transition).toContainText('议题已发布并由你分享');
      await transition.getByRole('button', { name: '关闭' }).click();
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await expect(card).toContainText('已被认领');
      await expect(card).toContainText('分享 · 入口测试者');
      await expect(card.locator('.topic-tags')).toContainText('入口');
      await expect(card.locator('.topic-tags')).toContainText('草稿');
    } finally {
      if (createdId !== null) await deleteLatestTopic(request, createdId);
    }
  });

  test('旧口令不迁移，刷新校验临时会话且退出清理敏感弹窗', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `会话退出验收-${marker}`;
    const secretMeeting = `https://meet.example.test/session/${marker}?pwd=must-disappear`;
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const topic = await createScheduledPhaseTopic(request, {
      title,
      scheduledAt: new Date(Date.now() + 302 * 86_400_000).toISOString(),
      meetingUrl: secretMeeting,
    });
    let releaseSessionValidation = () => {};
    const sessionValidationGate = new Promise<void>((resolve) => { releaseSessionValidation = resolve; });
    await page.route('**/api/access/session', async (route) => {
      await sessionValidationGate;
      await route.continue();
    });

    try {
      const sessionChecked = page.waitForResponse((response) => response.url().endsWith('/api/access/session') && response.status() === 200);
      await page.goto('/');
      await expectCollaborationState(page, '确认协作…', true);
      releaseSessionValidation();
      const sessionResponse = await sessionChecked;
      const headers = sessionResponse.request().headers();
      expect(headers['x-fireside-session']).toBe(collaborationSession);
      expect(headers['x-fireside-write-key']).toBeUndefined();
      await expectCollaborationState(page, '退出协作');
      await page.unroute('**/api/access/session');
      expect(await page.evaluate(({ legacyKey, sessionKey }) => ({
        legacy: sessionStorage.getItem(legacyKey),
        session: sessionStorage.getItem(sessionKey),
      }), { legacyKey: legacyWriteKeyStorage, sessionKey: collaborationSessionStorage })).toEqual({
        legacy: null,
        session: collaborationSession,
      });

      await page.route(/\/api\/access$/, async (route) => route.abort('failed'));
      await page.reload();
      await expectCollaborationState(page, '解锁协作');
      expect(await page.evaluate((sessionKey) => sessionStorage.getItem(sessionKey), collaborationSessionStorage)).toBeNull();
      await page.unroute(/\/api\/access$/);

      await page.evaluate(({ sessionKey, session }) => sessionStorage.setItem(sessionKey, session), {
        sessionKey: collaborationSessionStorage,
        session: collaborationSession,
      });
      const refreshedSessionChecked = page.waitForResponse((response) => response.url().endsWith('/api/access/session') && response.status() === 200);
      await page.reload();
      const refreshedSessionResponse = await refreshedSessionChecked;
      expect(refreshedSessionResponse.request().headers()['x-fireside-session']).toBe(collaborationSession);
      await expectCollaborationState(page, '退出协作');

      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await card.getByRole('button', { name: '加入会议' }).click();
      const meetingDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '进入线上围炉' }) });
      await expect(meetingDialog.getByRole('link', { name: '进入线上会议' })).toHaveAttribute('href', secretMeeting);

      await page.locator('button.access-button').evaluate((button: HTMLButtonElement) => button.click());
      await expect(meetingDialog).toHaveCount(0);
      await expectCollaborationState(page, '解锁协作');
      await expect(page.locator('body')).not.toContainText(secretMeeting);
      expect(await page.evaluate((sessionKey) => sessionStorage.getItem(sessionKey), collaborationSessionStorage)).toBeNull();
      expect(pageErrors).toEqual([]);
    } finally {
      releaseSessionValidation();
      await page.unroute('**/api/access/session').catch(() => undefined);
      await page.unroute(/\/api\/access$/).catch(() => undefined);
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('退出协作会丢弃迟到的真实会议响应', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `迟到会议响应验收-${marker}`;
    const secretMeeting = `https://meet.example.test/late/${marker}?pwd=never-return`;
    const topic = await createScheduledPhaseTopic(request, {
      title,
      scheduledAt: new Date(Date.now() + 303 * 86_400_000).toISOString(),
      meetingUrl: secretMeeting,
    });
    let releaseMeeting = () => {};
    let markMeetingCaptured = () => {};
    const meetingGate = new Promise<void>((resolve) => { releaseMeeting = resolve; });
    const meetingCaptured = new Promise<void>((resolve) => { markMeetingCaptured = resolve; });
    await page.route(`**/api/topics/${topic.id}/meeting-access`, async (route) => {
      const response = await route.fetch();
      markMeetingCaptured();
      await meetingGate;
      await route.fulfill({ response });
    });

    try {
      await page.goto('/');
      await expectCollaborationState(page, '退出协作');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      const delivered = page.waitForResponse((response) => response.url().endsWith(`/api/topics/${topic.id}/meeting-access`));
      await card.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
      await meetingCaptured;
      await page.locator('button.access-button').evaluate((button: HTMLButtonElement) => button.click());
      await expectCollaborationState(page, '解锁协作');
      releaseMeeting();
      await delivered;
      await expect(page.getByRole('heading', { name: '编辑议题' })).toHaveCount(0);
      await expect(page.locator('input[name="meetingUrl"]')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('never-return');
      expect(await page.evaluate((sessionKey) => sessionStorage.getItem(sessionKey), collaborationSessionStorage)).toBeNull();
    } finally {
      releaseMeeting();
      await page.unroute(`**/api/topics/${topic.id}/meeting-access`).catch(() => undefined);
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('会议入口临时读取失败后只由用户显式重试并恢复原触发器焦点', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `会议入口显式重试-${marker}`;
    const meetingUrl = `https://meet.example.test/retry/${marker}`;
    const topic = await createScheduledPhaseTopic(request, {
      title,
      scheduledAt: new Date(Date.now() + 307 * 86_400_000).toISOString(),
      meetingUrl,
    });
    let meetingReads = 0;
    await page.route(`**/api/topics/${topic.id}/meeting-access`, async (route) => {
      meetingReads += 1;
      if (meetingReads === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'MEETING_ACCESS_TEMPORARY', message: '会议入口暂时不可用' }),
        });
        return;
      }
      await route.continue();
    });

    try {
      await page.goto('/');
      await expectCollaborationState(page, '退出协作');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      const meetingTrigger = card.getByRole('button', { name: '加入会议' });
      await meetingTrigger.click();
      const dialog = page.getByRole('dialog', { name: '进入线上围炉' });
      const retry = dialog.getByRole('button', { name: '重新读取会议入口' });
      await expect(dialog.getByRole('alert')).toContainText('会议入口暂时不可用');
      await expect(retry).toBeFocused();
      await expect.poll(async () => (await retry.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      await page.waitForTimeout(600);
      expect(meetingReads).toBe(1);

      await retry.click();
      await expect.poll(() => meetingReads).toBe(2);
      const link = dialog.getByRole('link', { name: '进入线上会议' });
      await expect(link).toHaveAttribute('href', meetingUrl);
      await expect(link).toBeFocused();
      await dialog.getByRole('button', { name: '关闭' }).click();
      await expect(meetingTrigger).toBeFocused();
    } finally {
      await page.unroute(`**/api/topics/${topic.id}/meeting-access`).catch(() => undefined);
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('会议入口旧响应在外部取消排期后必须经权威版本复核丢弃', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `会议入口版本复核-${marker}`;
    const secretMeeting = `https://meet.example.test/stale/${marker}?pwd=must-disappear`;
    const topic = await createScheduledPhaseTopic(request, {
      title,
      scheduledAt: new Date(Date.now() + 308 * 86_400_000).toISOString(),
      meetingUrl: secretMeeting,
    });
    let releaseMeeting = () => {};
    let markMeetingCaptured = () => {};
    const meetingGate = new Promise<void>((resolve) => { releaseMeeting = resolve; });
    const meetingCaptured = new Promise<void>((resolve) => { markMeetingCaptured = resolve; });
    await page.route(`**/api/topics/${topic.id}/meeting-access`, async (route) => {
      const response = await route.fetch();
      markMeetingCaptured();
      await meetingGate;
      await route.fulfill({ response });
    });

    try {
      await page.goto('/');
      await expectCollaborationState(page, '退出协作');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await card.getByRole('button', { name: '加入会议' }).click();
      await meetingCaptured;
      const unscheduled = await request.post(`/api/topics/${topic.id}/unschedule`, {
        headers: revisionHeaders((await readPhaseTopic(request, topic.id)).revision),
        data: {},
      });
      expect(unscheduled.status()).toBe(200);
      expect((await unscheduled.json() as PhaseTopic).status).toBe('CLAIMED');
      releaseMeeting();

      await expect(page.getByRole('dialog', { name: '进入线上围炉' })).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(secretMeeting);
      await expect(page.locator('.toast')).toContainText('旧地址未显示');
      await expect(card.locator('.status-pill')).toHaveText('已被认领');
      expect(await page.locator('body').evaluate((body) => body.innerHTML.includes('must-disappear'))).toBe(false);
      await page.waitForTimeout(1_200);
      await expect(card).toBeFocused();
    } finally {
      releaseMeeting();
      await page.unroute(`**/api/topics/${topic.id}/meeting-access`).catch(() => undefined);
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('外部更换会议地址后丢弃旧值并回焦仍存在的加入会议动作', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `会议入口换址回焦-${marker}`;
    const oldMeeting = `https://meet.example.test/old/${marker}?pwd=stale-link`;
    const newMeeting = `https://meet.example.test/new/${marker}`;
    const topic = await createScheduledPhaseTopic(request, {
      title,
      scheduledAt: new Date(Date.now() + 311 * 86_400_000).toISOString(),
      meetingUrl: oldMeeting,
    });
    let releaseFirstMeeting = () => {};
    let markFirstMeetingCaptured = () => {};
    const firstMeetingGate = new Promise<void>((resolve) => { releaseFirstMeeting = resolve; });
    const firstMeetingCaptured = new Promise<void>((resolve) => { markFirstMeetingCaptured = resolve; });
    let meetingReads = 0;
    await page.route(`**/api/topics/${topic.id}/meeting-access`, async (route) => {
      const response = await route.fetch();
      meetingReads += 1;
      if (meetingReads === 1) {
        markFirstMeetingCaptured();
        await firstMeetingGate;
      }
      await route.fulfill({ response });
    });

    try {
      await page.goto('/');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      const meetingTrigger = card.getByRole('button', { name: '加入会议' });
      await meetingTrigger.click();
      await firstMeetingCaptured;
      const changed = await request.patch(`/api/topics/${topic.id}`, {
        headers: revisionHeaders((await readPhaseTopic(request, topic.id)).revision),
        data: { meetingUrl: newMeeting },
      });
      expect(changed.status()).toBe(200);
      releaseFirstMeeting();

      await expect(page.getByRole('dialog', { name: '进入线上围炉' })).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(oldMeeting);
      await page.waitForTimeout(1_200);
      await expect(meetingTrigger).toBeFocused();

      await meetingTrigger.click();
      const dialog = page.getByRole('dialog', { name: '进入线上围炉' });
      await expect(dialog.getByRole('link', { name: '进入线上会议' })).toHaveAttribute('href', newMeeting);
      expect(meetingReads).toBe(2);
      await dialog.getByRole('button', { name: '关闭' }).click();
    } finally {
      releaseFirstMeeting();
      await page.unroute(`**/api/topics/${topic.id}/meeting-access`).catch(() => undefined);
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('首次编辑也会在外部取消后复核并拒绝迟到会议地址', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `编辑会议版本复核-${marker}`;
    const secretMeeting = `https://meet.example.test/edit-stale/${marker}?pwd=never-fill`;
    const topic = await createScheduledPhaseTopic(request, {
      title,
      scheduledAt: new Date(Date.now() + 309 * 86_400_000).toISOString(),
      meetingUrl: secretMeeting,
    });
    let releaseMeeting = () => {};
    let markMeetingCaptured = () => {};
    const meetingGate = new Promise<void>((resolve) => { releaseMeeting = resolve; });
    const meetingCaptured = new Promise<void>((resolve) => { markMeetingCaptured = resolve; });
    await page.route(`**/api/topics/${topic.id}/meeting-access`, async (route) => {
      const response = await route.fetch();
      markMeetingCaptured();
      await meetingGate;
      await route.fulfill({ response });
    });

    try {
      await page.goto('/');
      await expectCollaborationState(page, '退出协作');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await card.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
      await meetingCaptured;
      const unscheduled = await request.post(`/api/topics/${topic.id}/unschedule`, {
        headers: revisionHeaders((await readPhaseTopic(request, topic.id)).revision),
        data: {},
      });
      expect(unscheduled.status()).toBe(200);
      releaseMeeting();

      const dialog = page.getByRole('dialog', { name: '编辑议题' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('线上会议链接（选填）')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(secretMeeting);
      expect(await page.locator('body').evaluate((body) => body.innerHTML.includes('never-fill'))).toBe(false);
      await expect(page.locator('.toast')).toContainText('旧会议地址未载入');
      await dialog.getByRole('button', { name: '关闭' }).click();
    } finally {
      releaseMeeting();
      await page.unroute(`**/api/topics/${topic.id}/meeting-access`).catch(() => undefined);
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('编辑412恢复不会把随后失效的新版会议地址注入表单', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `编辑冲突会议复核-${marker}`;
    const remoteTitle = `远端会议已更新-${marker}`;
    const originalSecret = `https://meet.example.test/edit-original/${marker}`;
    const remoteSecret = `https://meet.example.test/edit-remote/${marker}?pwd=never-inject`;
    const topic = await createScheduledPhaseTopic(request, {
      title,
      scheduledAt: new Date(Date.now() + 310 * 86_400_000).toISOString(),
      meetingUrl: originalSecret,
    });
    let releaseMeeting = () => {};
    let markMeetingCaptured = () => {};
    const meetingGate = new Promise<void>((resolve) => { releaseMeeting = resolve; });
    const meetingCaptured = new Promise<void>((resolve) => { markMeetingCaptured = resolve; });

    try {
      await page.goto('/');
      await expectCollaborationState(page, '退出协作');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await card.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '编辑议题' });
      await expect(dialog.getByLabel('线上会议链接（选填）')).toHaveValue(originalSecret);
      await dialog.getByLabel('一句话简介').fill(`需要保留但不能带回会议密钥-${marker}`);

      const remoteEdit = await request.patch(`/api/topics/${topic.id}`, {
        headers: revisionHeaders((await readPhaseTopic(request, topic.id)).revision),
        data: { title: remoteTitle, meetingUrl: remoteSecret },
      });
      expect(remoteEdit.status()).toBe(200);
      const remoteTopic = await remoteEdit.json() as PhaseTopic;
      await page.route(`**/api/topics/${topic.id}/meeting-access`, async (route) => {
        const response = await route.fetch();
        markMeetingCaptured();
        await meetingGate;
        await route.fulfill({ response });
      });

      await dialog.getByRole('button', { name: '保存修改' }).click();
      await meetingCaptured;
      const unscheduled = await request.post(`/api/topics/${topic.id}/unschedule`, {
        headers: revisionHeaders(remoteTopic.revision),
        data: {},
      });
      expect(unscheduled.status()).toBe(200);
      releaseMeeting();

      await expect(dialog).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(remoteSecret);
      expect(await page.locator('body').evaluate((body) => body.innerHTML.includes('never-inject'))).toBe(false);
      const updatedCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: remoteTitle, exact: true }) });
      await expect(updatedCard.locator('.status-pill')).toHaveText('已被认领');
    } finally {
      releaseMeeting();
      await page.unroute(`**/api/topics/${topic.id}/meeting-access`).catch(() => undefined);
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('429 倒计时关闭重开仍有效，不自动重放且已有会话继续业务', async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const draftTitle = `限流后显式提交-${marker}`;
    const existingSessionTitle = `限流不影响已有会话-${marker}`;
    const createdIds: number[] = [];
    let verifyRequests = 0;
    const createRequests: string[] = [];
    let existingSessionPage: Page | null = null;

    page.on('request', (outgoing) => {
      if (outgoing.method() === 'POST' && outgoing.url().endsWith('/api/topics')) createRequests.push(outgoing.url());
    });

    try {
      const existingReadSecret = `https://meet.example.test/rate/${marker}?pwd=existing-session`;
      const existingReadTopic = await createScheduledPhaseTopic(request, {
        title: `限流期间敏感读取-${marker}`,
        scheduledAt: new Date(Date.now() + 304 * 86_400_000).toISOString(),
        meetingUrl: existingReadSecret,
      });
      createdIds.push(existingReadTopic.id);
      const seededParticipant = await request.post(`/api/topics/${existingReadTopic.id}/participants`, {
        headers: sessionHeaders(),
        data: { name: `已有会话参与者-${marker}` },
      });
      expect(seededParticipant.status()).toBe(201);

      await page.goto('/');
      await expectCollaborationState(page, '退出协作');
      await page.getByRole('button', { name: /发起议题/ }).first().click();
      const businessDialog = page.locator('.modal[role="dialog"]:not(.access-modal)');
      const submitButton = businessDialog.locator('button[type="submit"]');
      await businessDialog.locator('input[name="title"]').fill(draftTitle);
      await businessDialog.locator('textarea[name="summary"]').fill('限流只影响新的口令校验，草稿和已有会话不受影响。');
      await businessDialog.locator('input[name="proposer"]').fill('限流验收者');
      await page.evaluate((sessionKey) => sessionStorage.setItem(sessionKey, 'expired-session'), collaborationSessionStorage);
      const rejected = page.waitForResponse((response) => response.url().endsWith('/api/topics')
        && response.request().method() === 'POST' && response.status() === 401);
      await submitButton.click();
      await rejected;
      expect(createRequests).toHaveLength(1);

      let accessDialog = page.locator('.access-modal[role="dialog"]');
      for (const candidate of ['wrong-rate-key-1', 'wrong-rate-key-2']) {
        await accessDialog.getByLabel('围炉口令').fill(candidate);
        const wrong = page.waitForResponse((response) => response.url().endsWith('/api/access/verify') && response.status() === 401);
        await accessDialog.getByRole('button', { name: '解锁协作' }).click();
        await wrong;
        verifyRequests += 1;
        await expect(accessDialog.getByLabel('围炉口令')).toHaveValue('');
      }
      await accessDialog.getByLabel('围炉口令').fill(writeKey);
      const blocked = page.waitForResponse((response) => response.url().endsWith('/api/access/verify') && response.status() === 429);
      await accessDialog.getByRole('button', { name: '解锁协作' }).click();
      const blockedResponse = await blocked;
      verifyRequests += 1;
      expect(Number(blockedResponse.headers()['retry-after'])).toBeGreaterThan(0);
      await expect(accessDialog.getByRole('alert')).toContainText('请等待');
      await expect(accessDialog.getByRole('alert')).toBeFocused();
      await expect(accessDialog.getByLabel('围炉口令')).toHaveValue('');
      await expect(accessDialog.locator('button[type="submit"]')).toBeDisabled();
      expect(verifyRequests).toBe(3);
      expect(createRequests).toHaveLength(1);

      existingSessionPage = await page.context().newPage();
      await existingSessionPage.addInitScript(({ sessionKey, session }) => {
        sessionStorage.setItem(sessionKey, session);
      }, {
        sessionKey: collaborationSessionStorage,
        session: collaborationSession,
      });
      await existingSessionPage.goto('/');
      await expectCollaborationState(existingSessionPage, '退出协作');
      await existingSessionPage.getByRole('button', { name: /发起议题/ }).first().click();
      const existingBusinessDialog = existingSessionPage.locator('.modal[role="dialog"]:not(.access-modal)');
      await existingBusinessDialog.locator('input[name="title"]').fill(existingSessionTitle);
      await existingBusinessDialog.locator('textarea[name="summary"]').fill('另一个已解锁浏览器在新验证被限流时仍可以正常协作。');
      await existingBusinessDialog.locator('input[name="proposer"]').fill('已有会话');
      const existingSessionCreate = existingSessionPage.waitForResponse((response) => response.url().endsWith('/api/topics')
        && response.request().method() === 'POST' && response.status() === 201);
      await existingBusinessDialog.getByRole('button', { name: '发布议题' }).click();
      const existingCreatedResponse = await existingSessionCreate;
      createdIds.push(((await existingCreatedResponse.json()) as { id: number }).id);
      await expect(existingSessionPage.getByRole('heading', { name: existingSessionTitle, exact: true })).toBeVisible();

      // 成功发布征集会按业务规格切到 OPEN；敏感读取夹具位于 SCHEDULED，先显式回到完整广场。
      await existingSessionPage.getByRole('button', { name: '全部议题', exact: true }).click();

      const existingReadCard = existingSessionPage.locator('.topic-card')
        .filter({ has: existingSessionPage.getByRole('heading', { name: existingReadTopic.title, exact: true }) });
      await existingReadCard.getByRole('button', { name: '报名参加' }).click();
      let existingSensitiveDialog = existingSessionPage.locator('.participants-modal[role="dialog"]');
      await expect(existingSensitiveDialog).toContainText(`已有会话参与者-${marker}`);
      await existingSensitiveDialog.getByRole('button', { name: '关闭' }).click();
      await existingReadCard.getByRole('button', { name: '加入会议' }).click();
      existingSensitiveDialog = existingSessionPage.locator('.meeting-modal[role="dialog"]');
      await expect(existingSensitiveDialog.getByRole('link', { name: '进入线上会议' })).toHaveAttribute('href', existingReadSecret);
      await existingSensitiveDialog.getByRole('button', { name: '关闭' }).click();

      await accessDialog.getByRole('button', { name: '关闭' }).click();
      await expect(accessDialog).toHaveCount(0);
      await expect(businessDialog.locator('input[name="title"]')).toHaveValue(draftTitle);

      await submitButton.click();
      expect(createRequests).toHaveLength(1);
      accessDialog = page.locator('.access-modal[role="dialog"]');
      await expect(accessDialog.getByRole('alert')).toContainText('请等待');
      await expect(accessDialog.locator('button[type="submit"]')).toBeDisabled();
      expect(verifyRequests).toBe(3);

      await expect(accessDialog.getByRole('status')).toContainText('系统不会自动提交', { timeout: 8_000 });
      await expect(accessDialog.getByLabel('围炉口令')).toBeFocused();
      await expect(accessDialog.locator('button[type="submit"]')).toBeEnabled();
      expect(verifyRequests).toBe(3);
      expect(createRequests).toHaveLength(1);

      await accessDialog.getByLabel('围炉口令').fill(writeKey);
      const unlocked = page.waitForResponse((response) => response.url().endsWith('/api/access/verify') && response.status() === 200);
      await accessDialog.getByRole('button', { name: '解锁协作' }).click();
      await unlocked;
      verifyRequests += 1;
      await expect(accessDialog).toHaveCount(0);
      await expect(businessDialog.locator('input[name="title"]')).toHaveValue(draftTitle);
      expect(createRequests).toHaveLength(1);

      const created = page.waitForResponse((response) => response.url().endsWith('/api/topics')
        && response.request().method() === 'POST' && response.status() === 201);
      await submitButton.click();
      const createdResponse = await created;
      createdIds.push(((await createdResponse.json()) as { id: number }).id);
      expect(createRequests).toHaveLength(2);
      expect(verifyRequests).toBe(4);
      await expect(page.getByRole('heading', { name: draftTitle, exact: true })).toBeVisible();
    } finally {
      await existingSessionPage?.close();
      await Promise.all(createdIds.map((id) => deleteLatestTopic(request, id)));
    }
  });

  test('真实 401 叠层中 Esc 只关闭口令层并保留草稿、错误和滚动锁', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => { document.body.style.overflow = 'visible'; });
    const trigger = page.getByRole('button', { name: /发起议题/ }).first();
    await trigger.click();
    const businessDialog = page.locator('.modal[role="dialog"]:not(.access-modal)');
    const titleInput = businessDialog.locator('input[name="title"]');
    const summaryInput = businessDialog.locator('textarea[name="summary"]');
    const proposerInput = businessDialog.locator('input[name="proposer"]');
    const tagsInput = businessDialog.locator('input[name="tags"]');
    const submitButton = businessDialog.locator('button[type="submit"]');
    await titleInput.fill('叠层 Esc 草稿验收');
    await summaryInput.fill('真实 401 后，只能关闭最上层口令弹窗，不能丢掉底层表单。');
    await proposerInput.fill('叠层测试者');
    await tagsInput.fill('弹窗, 焦点, 草稿');
    await businessDialog.getByLabel('我来分享').check();
    await page.evaluate(() => sessionStorage.setItem('fireside-collaboration-session-v1', 'expired-session'));

    const rejected = page.waitForResponse((response) => response.url().endsWith('/api/topics')
      && response.request().method() === 'POST' && response.status() === 401);
    await submitButton.click();
    await rejected;

    const dialogs = page.locator('[role="dialog"]');
    const accessDialog = page.locator('.access-modal[role="dialog"]');
    const accessInput = accessDialog.getByLabel('围炉口令');
    await expect(dialogs).toHaveCount(2);
    await expect(businessDialog).toHaveAttribute('inert', '');
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await expect(accessInput).toBeFocused();
    await expect(businessDialog.locator('.form-error')).toContainText('协作会话已失效');

    for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Tab']) {
      await page.keyboard.press(key);
      await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]')?.classList.contains('access-modal'))).toBe(true);
    }
    await titleInput.evaluate((element: HTMLInputElement) => element.focus());
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]')?.classList.contains('access-modal'))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialogs).toHaveCount(1);
    await expect(accessDialog).toHaveCount(0);
    await expect(businessDialog).not.toHaveAttribute('inert', '');
    await expect(titleInput).toHaveValue('叠层 Esc 草稿验收');
    await expect(summaryInput).toHaveValue('真实 401 后，只能关闭最上层口令弹窗，不能丢掉底层表单。');
    await expect(proposerInput).toHaveValue('叠层测试者');
    await expect(tagsInput).toHaveValue('弹窗, 焦点, 草稿');
    await expect(businessDialog.getByLabel('我来分享')).toBeChecked();
    await expect(businessDialog.locator('.form-error')).toContainText('协作会话已失效');
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await expect(submitButton).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialogs).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('visible');
    await expect(trigger).toBeFocused();
  });

  test('真实 401 叠层的 X、遮罩和错误口令不丢草稿，解锁后必须再次提交', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `叠层解锁显式重试-${marker}`;
    let createdId: number | null = null;
    await page.goto('/');
    await page.evaluate(() => { document.body.style.overflow = 'visible'; });
    const trigger = page.getByRole('button', { name: /发起议题/ }).first();
    await trigger.click();
    const businessDialog = page.locator('.modal[role="dialog"]:not(.access-modal)');
    const titleInput = businessDialog.locator('input[name="title"]');
    const summaryInput = businessDialog.locator('textarea[name="summary"]');
    const proposerInput = businessDialog.locator('input[name="proposer"]');
    const submitButton = businessDialog.locator('button[type="submit"]');
    await titleInput.fill(title);
    await summaryInput.fill('关闭口令层或重新解锁，都不应自动重放已经失败的创建请求。');
    await proposerInput.fill('显式重试测试者');
    const createRequests: string[] = [];
    page.on('request', (outgoing) => {
      if (outgoing.method() === 'POST' && outgoing.url().endsWith('/api/topics')) createRequests.push(outgoing.url());
    });
    async function openAccessFromReal401() {
      await page.evaluate(() => sessionStorage.setItem('fireside-collaboration-session-v1', 'expired-session'));
      const rejected = page.waitForResponse((response) => response.url().endsWith('/api/topics')
        && response.request().method() === 'POST' && response.status() === 401);
      await submitButton.click();
      await rejected;
      const accessDialog = page.locator('.access-modal[role="dialog"]');
      await expect(page.locator('[role="dialog"]')).toHaveCount(2);
      await expect(businessDialog).toHaveAttribute('inert', '');
      await expect(accessDialog.getByLabel('围炉口令')).toBeFocused();
      return accessDialog;
    }
    async function openAccessFromLockedDraft() {
      await submitButton.click();
      const accessDialog = page.locator('.access-modal[role="dialog"]');
      await expect(page.locator('[role="dialog"]')).toHaveCount(2);
      await expect(businessDialog).toHaveAttribute('inert', '');
      await expect(accessDialog).toContainText('议题草稿已保留且尚未提交');
      await expect(accessDialog.getByLabel('围炉口令')).toBeFocused();
      return accessDialog;
    }
    async function expectDraftAfterAccessClose() {
      await expect(page.locator('[role="dialog"]')).toHaveCount(1);
      await expect(businessDialog).not.toHaveAttribute('inert', '');
      await expect(titleInput).toHaveValue(title);
      await expect(summaryInput).toHaveValue('关闭口令层或重新解锁，都不应自动重放已经失败的创建请求。');
      await expect(proposerInput).toHaveValue('显式重试测试者');
      await expect(businessDialog.locator('.form-error')).toContainText('协作会话已失效');
      await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');
      await expect(submitButton).toBeFocused();
    }

    try {
      let accessDialog = await openAccessFromReal401();
      expect(createRequests).toHaveLength(1);
      await accessDialog.getByRole('button', { name: '关闭' }).click();
      await expectDraftAfterAccessClose();

      accessDialog = await openAccessFromLockedDraft();
      expect(createRequests).toHaveLength(1);
      await accessDialog.getByLabel('围炉口令').fill('wrong-key');
      const wrongKey = page.waitForResponse((response) => response.url().endsWith('/api/access/verify') && response.status() === 401);
      await accessDialog.getByRole('button', { name: '解锁协作' }).click();
      await wrongKey;
      await expect(page.locator('[role="dialog"]')).toHaveCount(2);
      await expect(accessDialog.getByRole('alert')).toContainText('围炉口令不正确');
      await expect(businessDialog).toHaveAttribute('inert', '');
      await expect(titleInput).toHaveValue(title);
      await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]')?.classList.contains('access-modal'))).toBe(true);
      await accessDialog.getByRole('heading', { name: '解锁围炉协作' }).click();
      await expect(page.locator('[role="dialog"]')).toHaveCount(2);
      await page.locator('.access-backdrop').click({ position: { x: 2, y: 2 } });
      await expectDraftAfterAccessClose();

      accessDialog = await openAccessFromLockedDraft();
      expect(createRequests).toHaveLength(1);
      await accessDialog.getByLabel('围炉口令').fill(writeKey);
      const unlocked = page.waitForResponse((response) => response.url().endsWith('/api/access/verify') && response.status() === 200);
      await accessDialog.getByRole('button', { name: '解锁协作' }).click();
      await unlocked;
      await expectDraftAfterAccessClose();
      await page.waitForTimeout(250);
      expect(createRequests).toHaveLength(1);

      const created = page.waitForResponse((response) => response.url().endsWith('/api/topics')
        && response.request().method() === 'POST' && response.status() === 201);
      await submitButton.click();
      const createdResponse = await created;
      createdId = ((await createdResponse.json()) as { id: number }).id;
      expect(createRequests).toHaveLength(2);
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);
      const createdCard = page.locator('.topic-card')
        .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await expect(createdCard).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('visible');
      await expect(createdCard).toBeFocused();
      await page.waitForTimeout(1_200);
      await expect(createdCard).toBeFocused();
    } finally {
      if (createdId !== null) await deleteLatestTopic(request, createdId);
    }
  });

  test('单层业务弹窗仍独占 Tab、正确释放滚动锁并恢复触发点', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => { document.body.style.overflow = 'visible'; });
    const trigger = page.getByRole('button', { name: /发起议题/ }).first();
    await trigger.click();
    let dialog = page.locator('.modal[role="dialog"]:not(.access-modal)');
    await expect(page.locator('[role="dialog"]')).toHaveCount(1);
    await expect(dialog).not.toHaveAttribute('inert', '');
    await expect(dialog.locator('input[name="title"]')).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    for (const key of ['Shift+Tab', 'Shift+Tab', 'Tab', 'Tab']) {
      await page.keyboard.press(key);
      await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
    }
    await dialog.getByRole('heading', { name: '发起一个新议题' }).click();
    await expect(page.locator('[role="dialog"]')).toHaveCount(1);
    await page.locator('.modal-backdrop').click({ position: { x: 2, y: 2 } });
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('visible');
    await expect(trigger).toBeFocused();

    await trigger.click();
    dialog = page.locator('.modal[role="dialog"]:not(.access-modal)');
    await expect(dialog.locator('input[name="title"]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('visible');
    await expect(trigger).toBeFocused();
  });

  test('报名弹窗遇到取消排期会关闭并同步权威结果', async ({ page, request }, testInfo) => {
    const title = `报名冲突验收-${testInfo.project.name}-${Date.now()}`;
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title, summary: '打开报名后由另一位协调者取消排期。', proposer: '冲突测试', presenter: '冲突测试', tags: [],
    } });
    const topic = await created.json() as { id: number; revision: number };
    const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, { headers: revisionHeaders(topic.revision), data: {
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), duration: 30, room: '冲突测试会议室', meetingUrl: '',
    } });
    expect(scheduled.status()).toBe(200);
    const scheduledTopic = await scheduled.json() as { revision: number };

    await page.goto('/');
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await card.getByRole('button', { name: '报名参加' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('你的名字').fill('晚到的参与者');
    const unscheduled = await request.post(`/api/topics/${topic.id}/unschedule`, { headers: revisionHeaders(scheduledTopic.revision), data: {} });
    expect(unscheduled.status()).toBe(200);
    await dialog.getByRole('button', { name: '确认报名' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toContainText('已被认领');
    await expect(page.getByText(/已同步最新状态/)).toBeVisible();

    await deleteLatestTopic(request, topic.id);
  });

  test('排期重叠保留安排表单并展示冲突场次', async ({ page, request }, testInfo) => {
    const title = `排期重叠表单-${testInfo.project.name}-${Date.now()}`;
    const conflictTitle = `已占用时段-${testInfo.project.name}`;
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title, summary: '重叠时不能丢失协调者刚刚填写的排期。', proposer: '排期测试', presenter: '排期测试', tags: ['排期'],
    } });
    const topic = await created.json() as { id: number; revision: number };
    const conflictTime = new Date(Date.now() + 12 * 86_400_000);
    conflictTime.setUTCSeconds(0, 0);
    try {
      await page.goto('/');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await card.getByRole('button', { name: '安排分享' }).click();
      const dialog = page.getByRole('dialog', { name: '安排炉边分享' });
      const scheduledInput = dialog.getByLabel('分享时间');
      const roomInput = dialog.getByLabel('地点 / 参与说明（链接与凭证请填下方）');
      const inputValue = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(conflictTime).replace(' ', 'T');
      await scheduledInput.fill(inputValue);
      await roomInput.fill('重叠后仍保留的会议室');
      await page.route(`**/api/topics/${topic.id}/schedule`, async (route) => route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'ACTIVITY_SCHEDULE_OVERLAP',
          message: '该时段与已排期议题重叠，请调整时间后重试',
          conflicts: [{ id: 9876, title: conflictTitle, scheduledAt: conflictTime.toISOString(), duration: 45 }],
        }),
      }));
      await dialog.getByRole('button', { name: '确认排期' }).click();
      const alert = dialog.getByRole('alert');
      await expect(alert).toBeFocused();
      await expect(alert).toContainText('当前填写内容已保留，未提交');
      await expect(alert).toContainText(conflictTitle);
      await expect(alert).toContainText('45 分钟');
      await expect(scheduledInput).toHaveValue(inputValue);
      await expect(roomInput).toHaveValue('重叠后仍保留的会议室');
      await page.unroute(`**/api/topics/${topic.id}/schedule`);
      await dialog.getByRole('button', { name: '关闭' }).click();
    } finally {
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('已报名改期重叠时保留二次确认和草稿', async ({ page, request }, testInfo) => {
    const title = `改期重叠确认-${testInfo.project.name}-${Date.now()}`;
    const start = new Date(Date.now() + 15 * 86_400_000);
    start.setUTCSeconds(0, 0);
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title, summary: '确认页发生排期冲突时不能关闭或丢弃改期。', proposer: '改期测试', presenter: '改期测试', tags: [],
    } });
    const topic = await created.json() as { id: number; revision: number };
    const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, { headers: revisionHeaders(topic.revision), data: {
      scheduledAt: start.toISOString(), duration: 30, room: '原排期会议室', meetingUrl: '',
    } });
    expect(scheduled.status()).toBe(200);
    const scheduledTopic = await scheduled.json() as { revision: number };
    await request.post(`/api/topics/${topic.id}/participants`, { headers: sessionHeaders(), data: { name: '已报名伙伴' } });
    const changedTime = new Date(start.getTime() + 60 * 60_000);
    const conflictTime = new Date(changedTime.getTime() - 10 * 60_000);
    const inputValue = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(changedTime).replace(' ', 'T');
    try {
      await page.goto('/');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await card.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
      let dialog = page.getByRole('dialog', { name: '编辑议题' });
      await dialog.getByLabel('分享时间').fill(inputValue);
      await dialog.getByRole('button', { name: '保存修改' }).click();
      dialog = page.getByRole('dialog', { name: '确认通知报名伙伴？' });
      await expect(dialog).toContainText('1 位伙伴已报名');
      await page.route(`**/api/topics/${topic.id}`, async (route) => {
        if (route.request().method() !== 'PATCH') return route.continue();
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'ACTIVITY_SCHEDULE_OVERLAP',
            message: '该时段与已排期议题重叠，请调整时间后重试',
            conflicts: [{ id: 9877, title: '另一场围炉', scheduledAt: conflictTime.toISOString(), duration: 40 }],
          }),
        });
      });
      await dialog.getByRole('button', { name: '确认保存并另行通知' }).click();
      await expect(dialog.getByRole('heading', { name: '确认通知报名伙伴？' })).toBeVisible();
      await expect(dialog.getByRole('alert')).toContainText('另一场围炉');
      await dialog.getByRole('button', { name: '返回修改' }).click();
      dialog = page.getByRole('dialog', { name: '编辑议题' });
      await expect(dialog.getByLabel('分享时间')).toHaveValue(inputValue);
      await page.unroute(`**/api/topics/${topic.id}`);
      await dialog.getByRole('button', { name: '关闭' }).click();
    } finally {
      const latest = await readPhaseTopic(request, topic.id);
      expect(latest.revision).toBeGreaterThanOrEqual(scheduledTopic.revision);
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('陈旧编辑遇到取消排期会关闭并同步权威状态', async ({ page, request }, testInfo) => {
    const title = `编辑冲突验收-${testInfo.project.name}-${Date.now()}`;
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title, summary: '编辑排期时由另一位协调者取消排期。', proposer: '冲突测试', presenter: '冲突测试', tags: [],
    } });
    const topic = await created.json() as { id: number; revision: number };
    const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, { headers: revisionHeaders(topic.revision), data: {
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), duration: 30, room: '原会议室', meetingUrl: '',
    } });
    expect(scheduled.status()).toBe(200);
    const scheduledTopic = await scheduled.json() as { revision: number };

    await page.goto('/');
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await card.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('地点 / 参与说明').fill('陈旧新地点');
    const unscheduled = await request.post(`/api/topics/${topic.id}/unschedule`, { headers: revisionHeaders(scheduledTopic.revision), data: {} });
    expect(unscheduled.status()).toBe(200);
    await dialog.getByRole('button', { name: '保存修改' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(card).toContainText('已被认领');
    await expect(card).not.toContainText('陈旧新地点');
    await expect(page.getByText(/已同步最新状态/)).toBeVisible();

    await deleteLatestTopic(request, topic.id);
  });

  test('陈旧内容编辑保留草稿，并由用户基于最新版显式重试', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `内容版本冲突验收-${marker}`;
    const remoteTitle = `另一位协作者更新的标题-${marker}`;
    const localSummary = `仍需保留的本地草稿-${marker}`;
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title, summary: '双方从同一份议题快照开始编辑。', proposer: '版本测试', tags: ['并发'],
    } });
    const topic = await created.json() as { id: number; revision: number };

    await page.goto('/');
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await card.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '编辑议题' }) });
    await dialog.getByLabel('一句话简介').fill(localSummary);

    const remoteEdit = await request.patch(`/api/topics/${topic.id}`, {
      headers: revisionHeaders(topic.revision),
      data: { title: remoteTitle },
    });
    expect(remoteEdit.status()).toBe(200);
    await dialog.getByRole('button', { name: '保存修改' }).click();

    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toContainText('议题已被其他协作者更新');
    await expect(dialog.getByLabel('议题标题')).toHaveValue(remoteTitle);
    await expect(dialog.getByLabel('一句话简介')).toHaveValue(localSummary);
    await dialog.getByRole('button', { name: '基于最新版再次保存' }).click();

    await expect(dialog).toHaveCount(0);
    const mergedCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: remoteTitle, exact: true }) });
    await expect(mergedCard).toContainText(localSummary);
    const latest = await request.get(`/api/topics/${topic.id}`);
    expect(await latest.json()).toEqual(expect.objectContaining({ title: remoteTitle, summary: localSummary }));
    await deleteLatestTopic(request, topic.id);
  });

  test('陈旧内容编辑可放弃草稿，并立即同步远端版本', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `放弃冲突草稿验收-${marker}`;
    const remoteTitle = `远端权威标题-${marker}`;
    const originalSummary = '关闭冲突弹窗时，本地草稿不能写入服务端。';
    const localDraft = `应被放弃的本地简介-${marker}`;
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title, summary: originalSummary, proposer: '冲突恢复测试', tags: ['并发'],
    } });
    const topic = await created.json() as { id: number; revision: number };

    await page.goto('/');
    const originalCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await originalCard.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '编辑议题' }) });
    await dialog.getByLabel('一句话简介').fill(localDraft);

    const remoteEdit = await request.patch(`/api/topics/${topic.id}`, {
      headers: revisionHeaders(topic.revision),
      data: { title: remoteTitle },
    });
    expect(remoteEdit.status()).toBe(200);
    await dialog.getByRole('button', { name: '保存修改' }).click();
    await expect(dialog.getByRole('alert')).toContainText('议题已被其他协作者更新');
    await expect(dialog.getByLabel('一句话简介')).toHaveValue(localDraft);

    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(dialog).toHaveCount(0);
    const syncedCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: remoteTitle, exact: true }) });
    await expect(syncedCard).toContainText(originalSummary);
    await expect(syncedCard).not.toContainText(localDraft);
    const latest = await request.get(`/api/topics/${topic.id}`);
    expect(await latest.json()).toEqual(expect.objectContaining({ title: remoteTitle, summary: originalSummary }));
    await deleteLatestTopic(request, topic.id);
  });

  test('陈旧删除同步同状态更新，并要求基于最新版重新确认', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `陈旧删除内容保护-${marker}`;
    const remoteSummary = `另一位协作者刚补充的简介-${marker}`;
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title, summary: '删除确认期间的同状态内容更新必须保留。', proposer: '删除测试', tags: ['并发'],
    } });
    const topic = await created.json() as { id: number; revision: number };
    await page.goto('/');
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    const deleteButton = card.getByRole('button', { name: `删除 ${title}`, exact: true });
    await deleteButton.click();
    await expect(page.getByRole('heading', { name: '删除这个议题？' })).toBeVisible();
    const edited = await request.patch(`/api/topics/${topic.id}`, {
      headers: revisionHeaders(topic.revision),
      data: { summary: remoteSummary },
    });
    expect(edited.status()).toBe(200);
    await page.getByRole('button', { name: '确认永久删除' }).click();

    await expect(page.getByText(/议题已被其他协作者更新/)).toBeVisible();
    await expect(card).toContainText(remoteSummary);
    await expect(deleteButton).toBeFocused();
    await deleteButton.click();
    await expect(page.getByRole('heading', { name: '删除这个议题？' })).toBeVisible();
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith(`/api/topics/${topic.id}`)
        && response.request().method() === 'DELETE' && response.status() === 204),
      page.getByRole('button', { name: '确认永久删除' }).click(),
    ]);
    await expect(card).toHaveCount(0);
  });

  test('已排期报名不能直接删除，必须先取消活动再明确永久删除', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `成熟删除保护-${marker}`;
    const participantName = `报名伙伴-${marker}`;
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title, summary: '生命周期必须先于永久删除。', proposer: '删除协调者', presenter: '分享人', tags: ['删除保护'],
    } });
    const topic = await created.json() as { id: number; revision: number };

    await page.goto('/');
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await card.getByRole('button', { name: `删除 ${title}`, exact: true }).click();
    const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, {
      headers: revisionHeaders(topic.revision),
      data: { scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), duration: 40, room: '版本测试会议室', meetingUrl: '' },
    });
    expect(scheduled.status()).toBe(200);
    const joined = await request.post(`/api/topics/${topic.id}/participants`, {
      headers: sessionHeaders(), data: { name: participantName },
    });
    expect(joined.status()).toBe(201);
    await page.getByRole('button', { name: '确认永久删除' }).click();

    await expect(page.getByText(/议题已被其他协作者更新/)).toBeVisible();
    await expect(card).toContainText('1 人报名');
    await expect(card.getByRole('button', { name: `删除 ${title}`, exact: true })).toHaveCount(0);
    await expect(card).toBeFocused();
    const latest = await readPhaseTopic(request, topic.id);
    const rejected = await request.delete(`/api/topics/${topic.id}`, { headers: revisionHeaders(latest.revision) });
    expect(rejected.status()).toBe(409);
    expect(await rejected.json()).toEqual(expect.objectContaining({
      code: 'TOPIC_DELETE_STATE_CONFLICT', currentStatus: 'SCHEDULED', currentRevision: latest.revision,
    }));
    const participants = await request.get(`/api/topics/${topic.id}/participants`, { headers: sessionHeaders() });
    expect((await participants.json()).map((participant: { name: string }) => participant.name)).toEqual([participantName]);

    await card.getByRole('button', { name: '取消排期' }).click();
    const unscheduleDialog = page.getByRole('dialog', { name: '取消这次排期？' });
    await expect(unscheduleDialog).toContainText('1 位伙伴将失去报名');
    await expect(unscheduleDialog.getByLabel('报名通知名单')).toContainText(participantName);
    await unscheduleDialog.getByLabel(/我已通过其他方式通知以上伙伴/).check();
    await unscheduleDialog.getByRole('button', { name: '确认取消排期' }).click();
    await expect(card).toContainText('已被认领');
    await expect(card).toContainText('分享 · 分享人');
    const deleteButton = card.getByRole('button', { name: `删除 ${title}`, exact: true });
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();
    await expect(page.getByRole('dialog')).toContainText('分享人 分享人 已认领');
    await expect(page.getByRole('dialog')).toContainText('系统不会自动通知分享人');
    await page.getByRole('button', { name: '确认永久删除' }).click();
    await expect(card).toHaveCount(0);
  });

  test('异常早期快照带成熟依赖时不展示不可执行的删除入口', async ({ page, request }, testInfo) => {
    const title = `异常早期删除入口-${testInfo.project.name}-${Date.now()}`;
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title, summary: '公开快照若显示残留报名，页面必须失败关闭。', proposer: '异常测试', presenter: '异常测试', tags: [],
    } });
    const topic = await created.json() as PhaseTopic;
    await page.route(/\/api\/topics\?sort=/, async (route) => {
      const response = await route.fetch();
      const list = await response.json() as PhaseTopic[];
      await route.fulfill({ response, json: list.map((item) => item.id === topic.id ? { ...item, participantCount: 1 } : item) });
    });

    await page.goto('/');
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await expect(card).toContainText('已被认领');
    await expect(card.getByRole('button', { name: `删除 ${title}`, exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: `编辑 ${title}`, exact: true })).toBeVisible();

    await page.unroute(/\/api\/topics\?sort=/);
    await deleteLatestTopic(request, topic.id);
  });

  test('删除确认收到状态 409 后同步异常依赖、移除入口并聚焦卡片', async ({ page, request }, testInfo) => {
    const title = `删除状态冲突恢复-${testInfo.project.name}-${Date.now()}`;
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title, summary: '确认期间服务端发现成熟依赖。', proposer: '状态冲突测试', presenter: '状态冲突测试', tags: [],
    } });
    const topic = await created.json() as PhaseTopic;
    let stateConflict = false;
    await page.route(/\/api\/topics\?sort=/, async (route) => {
      const response = await route.fetch();
      if (!stateConflict) return route.fulfill({ response });
      const list = await response.json() as PhaseTopic[];
      await route.fulfill({ response, json: list.map((item) => item.id === topic.id ? { ...item, participantCount: 1 } : item) });
    });
    await page.route(`**/api/topics/${topic.id}`, async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue();
      stateConflict = true;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
        code: 'TOPIC_DELETE_STATE_CONFLICT', message: '这个议题包含排期、报名或归档信息，不能直接永久删除',
        currentRevision: topic.revision, currentStatus: 'CLAIMED',
      }) });
    });

    await page.goto('/');
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await card.getByRole('button', { name: `删除 ${title}`, exact: true }).click();
    await page.getByRole('button', { name: '确认永久删除' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(/不能直接永久删除/)).toBeVisible();
    await expect(card.getByRole('button', { name: `删除 ${title}`, exact: true })).toHaveCount(0);
    await expect(card).toBeFocused();

    await page.unroute(`**/api/topics/${topic.id}`);
    await page.unroute(/\/api\/topics\?sort=/);
    await deleteLatestTopic(request, topic.id);
  });

  test('删除确认期间议题已不存在时关闭陈旧界面并聚焦议题广场', async ({ page, request }, testInfo) => {
    const title = `删除缺失恢复-${testInfo.project.name}-${Date.now()}`;
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title, summary: '另一位协调者先完成删除。', proposer: '缺失测试', tags: [],
    } });
    const topic = await created.json() as { id: number; revision: number };
    await page.goto('/');
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await card.getByRole('button', { name: `删除 ${title}`, exact: true }).click();
    const remoteDelete = await request.delete(`/api/topics/${topic.id}`, { headers: revisionHeaders(topic.revision) });
    expect(remoteDelete.status()).toBe(204);
    await page.getByRole('button', { name: '确认永久删除' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(card).toHaveCount(0);
    await expect(page.getByText(/已由其他协作者删除，无需重复操作/)).toBeVisible();
    await expect(page.locator('#topics h2')).toBeFocused();
  });

  test('极限连续标题与分享人不会撑宽删除弹窗，Esc 和遮罩均恢复焦点', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}${Date.now().toString(36)}`;
    const title = `${'W'.repeat(80 - marker.length)}${marker}`;
    const presenter = 'M'.repeat(30);
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title, summary: '验证合法极限连续文本的删除确认布局。', proposer: '极限布局测试', presenter, tags: [],
    } });
    const topic = await created.json() as { id: number };
    await page.goto('/');
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    const deleteButton = card.getByRole('button', { name: `删除 ${title}`, exact: true });
    await deleteButton.click();
    let dialog = page.getByRole('dialog');
    const dimensions = await dialog.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const name of ['取消', '确认永久删除']) {
      const button = dialog.getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      await expect.poll(async () => (await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press('Escape');
    await expect(deleteButton).toBeFocused();

    await deleteButton.click();
    dialog = page.getByRole('dialog');
    await page.locator('.modal-backdrop').click({ position: { x: 2, y: 2 } });
    await expect(dialog).toHaveCount(0);
    await expect(deleteButton).toBeFocused();
    await deleteLatestTopic(request, topic.id);
  });

  test('合法连续文本不会撑宽议题卡片或海报弹窗', async ({ page, request }, testInfo) => {
    const suffix = testInfo.project.name === 'mobile' ? 'M' : 'D';
    const title = `${'W'.repeat(79)}${suffix}`;
    const presenter = 'P'.repeat(30);
    const tags = ['A', 'B', 'C'].map((prefix) => `${prefix}${'T'.repeat(19)}`);
    const future = new Date(Date.now() + 180 * 86_400_000);
    future.setUTCHours(6, 30, 0, 0);
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title,
      summary: 'S'.repeat(500),
      proposer: '极端文本测试',
      presenter,
      tags,
    } });
    expect(created.status()).toBe(201);
    const topic = await created.json() as PhaseTopic;
    try {
      const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, {
        headers: revisionHeaders(topic.revision),
        data: { scheduledAt: future.toISOString(), duration: 30, room: 'R'.repeat(60), meetingUrl: '' },
      });
      expect(scheduled.status()).toBe(200);
      const visibleThisWeek = buildWeekDays(new Date())[2].toISOString();
      await page.route('**/api/topics?sort=*', async (route) => {
        const response = await route.fetch();
        const list = await response.json() as PhaseTopic[];
        await route.fulfill({ response, json: list.map((item) => item.id === topic.id ? { ...item, scheduledAt: visibleThisWeek } : item) });
      });

      await page.goto('/');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await expect(card).toBeVisible();
      const cardMetrics = await card.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
      expect(cardMetrics.scrollWidth).toBeLessThanOrEqual(cardMetrics.clientWidth);
      const headingMetrics = await card.getByRole('heading', { name: title, exact: true }).evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowWrap: getComputedStyle(element).overflowWrap,
      }));
      expect(headingMetrics.scrollWidth).toBeLessThanOrEqual(headingMetrics.clientWidth);
      expect(headingMetrics.overflowWrap).toBe('anywhere');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await page.getByRole('button', { name: '周历', exact: true }).click();
      const event = page.locator('.week-event').filter({ hasText: title });
      await event.locator('.week-event-main').click();
      const detail = page.getByRole('dialog', { name: title });
      await expect(detail).toContainText('S'.repeat(80));
      await expect(detail).toContainText(presenter);
      await expect(detail).toContainText('R'.repeat(40));
      for (const locator of [detail, detail.getByRole('heading', { name: title }), detail.locator('.modal-intro'), detail.locator('.activity-detail-grid'), detail.locator('.activity-detail-actions')]) {
        const dimensions = await locator.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
        expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await detail.getByRole('button', { name: '关闭' }).click();
      await page.getByRole('button', { name: '列表', exact: true }).click();

      await card.getByRole('button', { name: '生成海报' }).click();
      const dialog = page.getByRole('dialog', { name: '宣讲海报已为你备好' });
      await expect(dialog).toBeVisible();
      const preview = dialog.getByRole('img', { name: /围炉夜话宣讲海报/ });
      const downloadButton = dialog.getByRole('button', { name: '下载 PNG' });
      await expect(preview).toBeVisible();
      await expect(downloadButton).toBeVisible();
      for (const locator of [dialog, dialog.locator('.poster-layout'), dialog.locator('.poster-preview'), dialog.locator('.poster-side')]) {
        const dimensions = await locator.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
        expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
      }
      const dialogBox = (await dialog.boundingBox())!;
      for (const locator of [preview, downloadButton]) {
        const box = (await locator.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(dialogBox.x);
        expect(box.x + box.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width);
      }
      expect((await downloadButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await page.unroute('**/api/topics?sort=*');
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('合法上限正文在四档列表视口渐进披露且展开焦点稳定', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', '单桌面项目顺序覆盖四档视口，避免重复职责');
    const title = `极限归档-${'题'.repeat(70)}`;
    const summary = '简介正文'.repeat(125);
    const takeaway = '归档余温'.repeat(250);
    const scheduledAt = buildWeekDays(new Date())[1].toISOString();
    const archived: PhaseTopic = {
      id: 997_780,
      revision: 4,
      title,
      summary,
      proposer: '极端正文验收人',
      presenter: '极端正文分享人',
      tags: ['可扫描性', '渐进披露'],
      status: 'ARCHIVED',
      scheduledAt,
      duration: 45,
      room: '炉边回顾空间',
      meetingUrl: null,
      hasMeetingUrl: false,
      participantCount: 2,
      takeaway,
      materialUrl: null,
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-30T13:00:00.000Z',
      archivedAt: '2026-08-30T13:00:00.000Z',
    };
    await page.route('**/api/topics?sort=*', async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-Order-Version': '1' },
      body: JSON.stringify([archived]),
    }));
    await page.route(`**/api/topics/${archived.id}`, async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(archived),
    }));
    const expectFocusedInSafeViewport = async (button: Locator) => {
      await expect.poll(async () => button.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const headerBottom = document.querySelector('.site-header')?.getBoundingClientRect().bottom ?? 0;
        return document.activeElement === element
          && rect.top >= headerBottom + 7
          && rect.bottom <= window.innerHeight - 7
          && element.closest('.topic-card')?.getAttribute('data-topic-id') === '997780';
      })).toBe(true);
    };

    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 820, height: 1000 },
      { width: 393, height: 844 },
      { width: 320, height: 700 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/');
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      const summaryText = card.locator(`#topic-summary-${archived.id}`);
      const takeawayText = card.locator(`#topic-takeaway-${archived.id}`);
      const summaryButton = card.getByRole('button', { name: '展开议题简介' });
      const takeawayButton = card.getByRole('button', { name: '展开炉边余温' });
      await expect(card).toBeVisible();
      const collapsedCard = (await card.boundingBox())!;
      expect(collapsedCard.height).toBeLessThanOrEqual(viewport.height * 1.75);
      for (const [text, lines] of [[summaryText, '4'], [takeawayText, '5']] as const) {
        const metrics = await text.evaluate((element) => ({
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          lineClamp: getComputedStyle(element).webkitLineClamp,
        }));
        expect(metrics.lineClamp).toBe(lines);
        expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
      }
      for (const [button, target] of [[summaryButton, `topic-summary-${archived.id}`], [takeawayButton, `topic-takeaway-${archived.id}`]] as const) {
        await expect(button).toHaveAttribute('aria-controls', target);
        await expect(button).toHaveAttribute('aria-expanded', 'false');
        const buttonMetrics = await button.evaluate((element) => ({
          fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
          height: element.getBoundingClientRect().height,
        }));
        expect(buttonMetrics.fontSize).toBeGreaterThanOrEqual(14);
        expect(buttonMetrics.height).toBeGreaterThanOrEqual(44);
      }

      await summaryButton.click();
      const collapseSummary = card.getByRole('button', { name: '收起议题简介' });
      await expect(collapseSummary).toBeFocused();
      await expect(collapseSummary).toHaveAttribute('aria-expanded', 'true');
      expect(await summaryText.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await collapseSummary.click();
      await expect(summaryButton).toBeFocused();
      await expectFocusedInSafeViewport(summaryButton);

      await takeawayButton.click();
      const collapseTakeaway = card.getByRole('button', { name: '收起炉边余温' });
      await expect(collapseTakeaway).toBeFocused();
      await expect(collapseTakeaway).toHaveAttribute('aria-expanded', 'true');
      expect(await takeawayText.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await collapseTakeaway.click();
      await expect(takeawayButton).toBeFocused();
      await expectFocusedInSafeViewport(takeawayButton);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '周历', exact: true }).click();
    await page.locator('.week-event').filter({ hasText: title }).locator('.week-event-main').click();
    const detail = page.getByRole('dialog', { name: title });
    await expect(detail.locator('.modal-intro')).toHaveText(summary);
    await expect(detail.locator('.activity-takeaway')).toContainText(takeaway);
    await detail.getByRole('button', { name: '关闭' }).click();
    await page.unroute(`**/api/topics/${archived.id}`);
    await page.unroute('**/api/topics?sort=*');
  });

  test('中等中文正文按真实行数折叠并随四档视口重算', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', '单桌面项目顺序覆盖四档视口，避免重复职责');
    const archived: PhaseTopic = {
      id: 997_781,
      revision: 4,
      title: '真实渲染行数验收',
      summary: '中'.repeat(160),
      proposer: '行数验收人',
      presenter: '行数分享人',
      tags: ['真实行数'],
      status: 'ARCHIVED',
      scheduledAt: buildWeekDays(new Date())[1].toISOString(),
      duration: 30,
      room: '炉边空间',
      meetingUrl: null,
      hasMeetingUrl: false,
      participantCount: 0,
      takeaway: '余'.repeat(220),
      materialUrl: null,
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-30T13:00:00.000Z',
      archivedAt: '2026-08-30T13:00:00.000Z',
    };
    await page.route('**/api/topics?sort=*', async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-Order-Version': '1' },
      body: JSON.stringify([archived]),
    }));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    const card = page.locator(`[data-topic-id="${archived.id}"]`);
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 820, height: 1000 },
      { width: 393, height: 844 },
      { width: 320, height: 700 },
    ]) {
      await page.setViewportSize(viewport);
      const summary = card.locator(`#topic-summary-${archived.id}`);
      const takeaway = card.locator(`#topic-takeaway-${archived.id}`);
      await expect(card.getByRole('button', { name: '展开议题简介' })).toBeVisible();
      await expect(card.getByRole('button', { name: '展开炉边余温' })).toBeVisible();
      await expect.poll(async () => summary.evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe('4');
      await expect.poll(async () => takeaway.evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe('5');
      expect(await summary.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      expect(await takeaway.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    const writes: string[] = [];
    page.on('request', (request) => {
      if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${request.url()}`);
    });
    const expand = card.getByRole('button', { name: '展开议题简介' });
    await expand.click();
    await card.getByRole('button', { name: '收起议题简介' }).click();
    expect(writes).toEqual([]);
    await page.unroute('**/api/topics?sort=*');
  });

  test('新归档余温不继承旧归档展开态且相同正文排序保持阅读状态', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', '生命周期状态由单浏览器确定性覆盖');
    const oldTakeaway = '旧归档余温'.repeat(60);
    const newTakeaway = '新归档余温'.repeat(60);
    let current: PhaseTopic = {
      id: 997_782,
      revision: 4,
      title: '归档正文语义版本验收',
      summary: '验证撤销归档会清空旧余温，新归档从默认折叠态开始。',
      proposer: '归档验收人',
      presenter: '归档分享人',
      tags: ['归档纠错'],
      status: 'ARCHIVED',
      scheduledAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      duration: 30,
      room: '炉边空间',
      meetingUrl: null,
      hasMeetingUrl: false,
      participantCount: 0,
      takeaway: oldTakeaway,
      materialUrl: null,
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-30T13:00:00.000Z',
      archivedAt: '2026-08-30T13:00:00.000Z',
    };
    await page.route('**/api/topics?sort=*', async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-Order-Version': '1' },
      body: JSON.stringify([current]),
    }));
    await page.route(`**/api/topics/${current.id}`, async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(current),
    }));
    await page.route(`**/api/topics/${current.id}/unarchive`, async (route) => {
      current = { ...current, revision: current.revision + 1, status: 'SCHEDULED', takeaway: null, materialUrl: null, archivedAt: null, updatedAt: new Date().toISOString() };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) });
    });
    await page.route(`**/api/topics/${current.id}/archive`, async (route) => {
      const body = route.request().postDataJSON() as { takeaway: string; materialUrl?: string };
      current = { ...current, revision: current.revision + 1, status: 'ARCHIVED', takeaway: body.takeaway, materialUrl: body.materialUrl || null, archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) });
    });

    await page.goto('/');
    const card = page.locator(`[data-topic-id="${current.id}"]`);
    await card.getByRole('button', { name: '展开炉边余温' }).click();
    await expect(card.getByRole('button', { name: '收起炉边余温' })).toHaveAttribute('aria-expanded', 'true');
    await page.locator('.sort-control select').selectOption('newest');
    await expect(card.getByRole('button', { name: '收起炉边余温' })).toHaveAttribute('aria-expanded', 'true');

    await card.getByRole('button', { name: '撤销归档' }).click();
    await page.getByRole('dialog', { name: '撤销这次归档？' }).getByRole('button', { name: '确认撤销归档' }).click();
    await expect(card.locator(`#topic-takeaway-${current.id}`)).toHaveCount(0);
    await card.getByRole('button', { name: '完成归档' }).click();
    const archiveDialog = page.getByRole('dialog', { name: '沉淀本期收获' });
    await archiveDialog.getByLabel('本期最值得留下的收获').fill(newTakeaway);
    await archiveDialog.getByRole('button', { name: '完成归档' }).click();
    const newText = card.locator(`#topic-takeaway-${current.id}`);
    const newExpand = card.getByRole('button', { name: '展开炉边余温' });
    await expect(newExpand).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(async () => newText.evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe('5');
    await expect(card).not.toContainText(oldTakeaway);

    await page.getByRole('button', { name: '周历', exact: true }).click();
    await page.locator('.week-event').filter({ hasText: current.title }).locator('.week-event-main').click();
    const detail = page.getByRole('dialog', { name: current.title });
    await expect(detail.locator('.activity-takeaway')).toContainText(newTakeaway);
    await detail.getByRole('button', { name: '关闭' }).click();
    await page.unroute(`**/api/topics/${current.id}/archive`);
    await page.unroute(`**/api/topics/${current.id}/unarchive`);
    await page.unroute(`**/api/topics/${current.id}`);
    await page.unroute('**/api/topics?sort=*');
  });

  test('未来排期一键生成脱敏的 1080×1440 PNG 海报并恢复焦点', async ({ page, request }, testInfo) => {
    const alphaTimestamp = Date.now().toString(36).replace(/\d/g, (digit) => String.fromCharCode(97 + Number(digit)));
    const marker = `${testInfo.project.name}-${alphaTimestamp}`;
    const pairedSecretUrl = 'https://secret.example.test/join/(team)/room?pwd=parenUrlSecret';
    const titleCredential = `入会码：火炬 ${pairedSecretUrl}`;
    const titlePrefix = '海报极限-';
    const title = `${titlePrefix}${'题'.repeat(80 - Array.from(titlePrefix + titleCredential).length)}${titleCredential}`;
    const presenterCredential = 'pwd=omega';
    const presenter = `${'讲'.repeat(30 - Array.from(presenterCredential).length)}${presenterCredential}`;
    const tags = ['甲', '乙', '丙', '丁', '戊'].map((prefix) => `${prefix}${'标'.repeat(19)}`);
    const secretUrl = `https://secret.example.test/join/${marker}?passcode=linkSecret`;
    expect(Array.from(title)).toHaveLength(80);
    expect(Array.from(presenter)).toHaveLength(30);
    expect(tags).toHaveLength(5);
    expect(tags.every((tag) => Array.from(tag).length === 20)).toBe(true);
    await page.addInitScript(() => {
      const state = window as typeof window & { __posterFillText: string[] };
      state.__posterFillText = [];
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
        state.__posterFillText.push(String(text));
        if (maxWidth === undefined) return original.call(this, text, x, y);
        return original.call(this, text, x, y, maxWidth);
      };
    });
    const future = new Date(Date.now() + 3 * 86_400_000);
    future.setHours(19, 30, 0, 0);
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title,
      summary: '验证最大合法布局与分段凭证。会议号：123 456 789，入会密码（括号密语），后续普通简介仍可安全绘制。',
      proposer: '海报发起人',
      presenter,
      tags,
    } });
    expect(created.ok()).toBe(true);
    const topic = await created.json() as { id: number; revision: number };
    try {
      const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, { headers: revisionHeaders(topic.revision), data: {
        scheduledAt: future.toISOString(), duration: 45, room: '三楼围炉会议室', meetingUrl: secretUrl,
      } });
      expect(scheduled.ok()).toBe(true);
      await page.goto('/');
    const card = page.locator('.topic-card')
      .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
      .filter({ hasText: `#${String(topic.id).padStart(3, '0')}` });
    const requests: string[] = [];
    page.on('request', (outgoing) => requests.push(outgoing.url()));
    const posterButton = card.getByRole('button', { name: '生成海报' });
    await posterButton.click();
    const dialog = page.getByRole('dialog');
    const dialogTitle = dialog.getByRole('heading', { name: '宣讲海报已为你备好' });
    const closeButton = dialog.getByRole('button', { name: '关闭' });
    await expect(dialogTitle).toBeVisible();
    await expect(closeButton).toBeFocused();
    const closeBox = (await closeButton.boundingBox())!;
    const dialogTitleBox = (await dialogTitle.boundingBox())!;
    expect(closeBox.width).toBeGreaterThanOrEqual(44);
    expect(closeBox.height).toBeGreaterThanOrEqual(44);
    expect(dialogTitleBox.x + dialogTitleBox.width).toBeLessThanOrEqual(closeBox.x);
    const preview = dialog.getByRole('img', { name: /围炉夜话宣讲海报/ });
    await expect(preview).toBeVisible();
    const dimensions = await preview.evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight, source: image.src }));
    expect(dimensions).toEqual(expect.objectContaining({ width: 1080, height: 1440 }));
    expect(dimensions.source.startsWith('blob:')).toBe(true);
    const dialogText = await dialog.textContent();
    const altText = await preview.getAttribute('alt');
    const drawnTexts = await page.evaluate(() => (window as typeof window & { __posterFillText: string[] }).__posterFillText);
    const drawnText = drawnTexts.join('\n');
    const secretFragments = [
      'secret.example.test', 'linkSecret', '火炬', '123', '456', '789', 'omega',
      '括号密语', '(team)', '/room', '?pwd=', 'parenUrlSecret',
    ];
    for (const secret of secretFragments) {
      expect(dialogText).not.toContain(secret);
      expect(altText).not.toContain(secret);
      expect(drawnText).not.toContain(secret);
    }
    for (const prefix of ['甲', '乙', '丙', '丁', '戊']) {
      expect(drawnTexts.some((text) => text.startsWith(prefix)), `${prefix}标签应进入 Canvas fillText`).toBe(true);
    }
    const viewport = page.viewportSize()!;
    const previewBox = (await preview.boundingBox())!;
    expect(previewBox.x).toBeGreaterThanOrEqual(0);
    expect(previewBox.x + previewBox.width).toBeLessThanOrEqual(viewport.width);
    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }));
    expect(overflow.document).toBeLessThanOrEqual(0);
    expect(overflow.body).toBeLessThanOrEqual(0);
    const sourceRequests = requests.filter((url) => url.endsWith(`/api/topics/${topic.id}`));
    expect(sourceRequests).toHaveLength(1);
    await expect(dialog).toContainText('长按海报图片保存');

    const downloadButton = dialog.getByRole('button', { name: '下载 PNG' });
    expect((await downloadButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const downloadPromise = page.waitForEvent('download');
    await downloadButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^围炉夜话-\d{8}-.*\.png$/);
    for (const secret of secretFragments) expect(download.suggestedFilename()).not.toContain(secret);
    const bytes = await readFile((await download.path())!);
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(bytes.readUInt32BE(16)).toBe(1080);
    expect(bytes.readUInt32BE(20)).toBe(1440);

    await closeButton.click();
    await expect(dialog).toHaveCount(0);
    await expect(posterButton).toBeFocused();

    await page.evaluate(() => {
      const state = window as typeof window & { __posterToBlob?: HTMLCanvasElement['toBlob'] };
      state.__posterToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback) { callback(null); };
    });
    await posterButton.click();
    await expect(page.getByText('PNG 生成失败，请重试')).toBeVisible();
    await page.evaluate(() => {
      const state = window as typeof window & { __posterToBlob?: HTMLCanvasElement['toBlob'] };
      if (state.__posterToBlob) HTMLCanvasElement.prototype.toBlob = state.__posterToBlob;
    });
    await page.getByRole('button', { name: '重新读取并生成' }).click();
    await expect(page.getByRole('img', { name: /围炉夜话宣讲海报/ })).toBeVisible();
    expect(requests.filter((url) => url.endsWith(`/api/topics/${topic.id}`))).toHaveLength(3);
    await page.getByRole('button', { name: '关闭' }).click();

    } finally {
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('同日海报标注场次和议题编号且文件名唯一', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const base = new Date(Date.now() + 20 * 86_400_000);
    base.setUTCHours(10, 0, 0, 0);
    const topics: { id: number; title: string }[] = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        const title = `同日海报-${marker}-${index + 1}`;
        const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
          title, summary: '同一天的每场分享保持独立宣传入口。', proposer: '海报场次测试', presenter: '海报场次测试', tags: ['同日'],
        } });
        const topic = await created.json() as { id: number; revision: number };
        topics.push({ id: topic.id, title });
        const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, { headers: revisionHeaders(topic.revision), data: {
          scheduledAt: new Date(base.getTime() + index * 30 * 60_000).toISOString(), duration: 30, room: '同日海报会议室', meetingUrl: '',
        } });
        expect(scheduled.status()).toBe(200);
      }

      await page.goto('/');
      const second = topics[1];
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: second.title, exact: true }) });
      await card.getByRole('button', { name: '生成海报' }).click();
      const dialog = page.getByRole('dialog', { name: '宣讲海报已为你备好' });
      await expect(dialog.locator('.poster-summary')).toContainText('当日第 2 / 2 场');
      await expect(dialog.locator('.poster-summary')).toContainText(`议题 #${String(second.id).padStart(3, '0')}`);
      await expect(dialog.getByRole('img', { name: new RegExp(`当日第 2 / 2 场.*议题 #${String(second.id).padStart(3, '0')}`) })).toBeVisible();
      const downloadPromise = page.waitForEvent('download');
      await dialog.getByRole('button', { name: '下载 PNG' }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(new RegExp(`^围炉夜话-\\d{8}-\\d{4}-${second.id}-.*\\.png$`));
      await dialog.getByRole('button', { name: '关闭' }).click();
    } finally {
      await cleanupPhaseTopics(request, topics.map(({ id }) => id));
    }
  });

  test('跨午夜历史重叠在搜索后仍可见并阻止海报', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `跨午夜冲突目标-${marker}`;
    const targetStart = new Date(Date.now() + 2 * 86_400_000);
    targetStart.setUTCHours(16, 30, 0, 0);
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title, summary: '搜索隐藏冲突方时也不能撤掉单轨冲突提示。', proposer: '历史冲突测试', presenter: '历史冲突测试', tags: ['跨午夜'],
    } });
    const topic = await created.json() as { id: number; revision: number };
    const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, { headers: revisionHeaders(topic.revision), data: {
      scheduledAt: targetStart.toISOString(), duration: 30, room: '次日会议室', meetingUrl: '',
    } });
    expect(scheduled.status()).toBe(200);
    const scheduledTopic = await scheduled.json() as PhaseTopic;
    try {
      const publicResponse = await request.get('/api/topics?sort=manual');
      const publicTopics = await publicResponse.json() as PhaseTopic[];
      const legacyConflict: PhaseTopic = {
        ...scheduledTopic,
        id: scheduledTopic.id + 100_000,
        revision: 1,
        title: `跨午夜历史场-${marker}`,
        scheduledAt: new Date(targetStart.getTime() - 60 * 60_000).toISOString(),
        duration: 90,
        room: '前夜会议室',
        participantCount: 0,
      };
      await page.route('**/api/topics?sort=*', async (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Order-Version': '1' },
        body: JSON.stringify([...publicTopics, legacyConflict]),
      }));
      await page.goto('/');
      await page.getByPlaceholder('搜索议题、标签或分享人').fill(title);
      await page.getByRole('button', { name: '月历', exact: true }).click();
      const calendarEvent = page.locator('.calendar-event').filter({ hasText: title });
      await expect(calendarEvent).toBeVisible();
      await expect(calendarEvent).toContainText('排期重叠');

      await page.getByRole('button', { name: '列表', exact: true }).click();
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await card.getByRole('button', { name: '生成海报' }).click();
      const dialog = page.getByRole('dialog', { name: '本次没有生成海报' });
      await expect(dialog).toContainText(legacyConflict.title);
      await expect(dialog).toContainText('存在重叠');
      await expect(dialog.getByRole('img')).toHaveCount(0);
      await dialog.getByRole('button', { name: '返回议题广场' }).click();
      await page.unroute('**/api/topics?sort=*');
    } finally {
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('同日列表读取失败时海报明确降级为无场次编号', async ({ page, request }, testInfo) => {
    const title = `海报场次降级-${testInfo.project.name}-${Date.now()}`;
    const start = new Date(Date.now() + 22 * 86_400_000);
    start.setUTCSeconds(0, 0);
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title, summary: '列表读取失败不应伪造同日场次。', proposer: '海报降级测试', presenter: '海报降级测试', tags: [],
    } });
    const topic = await created.json() as { id: number; revision: number };
    const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, { headers: revisionHeaders(topic.revision), data: {
      scheduledAt: start.toISOString(), duration: 30, room: '降级测试会议室', meetingUrl: '',
    } });
    expect(scheduled.status()).toBe(200);
    try {
      await page.goto('/');
      await page.route('**/api/topics?sort=schedule', async (route) => route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'BUSINESS_WRITES_DISABLED', message: '临时无法读取完整日程' }),
      }));
      const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await card.getByRole('button', { name: '生成海报' }).click();
      const dialog = page.getByRole('dialog', { name: '宣讲海报已为你备好' });
      await expect(dialog.locator('.poster-summary')).toContainText('即将开讲');
      await expect(dialog.getByRole('status')).toContainText('不含场次编号');
      await expect(dialog.locator('.poster-summary')).not.toContainText('当日第');
      await dialog.getByRole('button', { name: '关闭' }).click();
      await page.unroute('**/api/topics?sort=schedule');
    } finally {
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('海报从列表与周历读取最新改期后再生成', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `海报最新改期-${marker}`;
    const now = new Date();
    const nextMonday = new Date(now);
    const weekday = now.getDay() || 7;
    nextMonday.setDate(now.getDate() + (8 - weekday));
    nextMonday.setHours(0, 0, 0, 0);
    const latestTime = new Date((now.getTime() + nextMonday.getTime()) / 2);
    const originalTime = new Date((now.getTime() + latestTime.getTime()) / 2);
    const expectedTime = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(latestTime);
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title, summary: '列表快照过期时必须重新确认排期。', proposer: '海报测试', presenter: '海报测试', tags: ['改期'],
    } });
    const topic = await created.json() as { id: number; revision: number };
    const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, {
      headers: revisionHeaders(topic.revision),
      data: { scheduledAt: originalTime.toISOString(), duration: 35, room: '改期测试会议室', meetingUrl: '' },
    });
    expect(scheduled.status()).toBe(200);
    const scheduledTopic = await scheduled.json() as { revision: number };

    await page.goto('/');
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    const posterButton = card.getByRole('button', { name: '生成海报' });
    await expect(posterButton).toBeVisible();
    const changed = await request.patch(`/api/topics/${topic.id}`, {
      headers: revisionHeaders(scheduledTopic.revision),
      data: { scheduledAt: latestTime.toISOString(), duration: 55 },
    });
    expect(changed.ok()).toBe(true);

    let sourceReads = 0;
    await page.route(`**/api/topics/${topic.id}`, async (route) => {
      if (route.request().method() === 'GET') {
        sourceReads += 1;
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      await route.continue();
    });
    await posterButton.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '正在确认最新议题' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: '宣讲海报已为你备好' })).toBeVisible();
    await expect(dialog).toContainText(`${expectedTime} 北京时间`);
    await expect(dialog.getByRole('status')).toContainText('已按刚刚确认的最新排期生成');
    expect(sourceReads).toBe(1);
    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(posterButton).toBeFocused();

    await page.getByRole('button', { name: '周历' }).click();
    const weekEvent = page.locator('.week-event').filter({ hasText: title });
    const weekPosterButton = weekEvent.getByRole('button', { name: '生成海报' });
    await expect(weekPosterButton).toBeVisible();
    expect((await weekPosterButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await weekPosterButton.click();
    await expect(page.getByRole('heading', { name: '宣讲海报已为你备好' })).toBeVisible();
    expect(sourceReads).toBe(2);
    await page.getByRole('button', { name: '关闭' }).click();
    await expect(weekPosterButton).toBeFocused();

    await page.unroute(`**/api/topics/${topic.id}`);
    await deleteLatestTopic(request, topic.id);
  });

  test('海报拒绝陈旧的取消排期快照并同步页面', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const future = new Date(Date.now() + 305 * 86_400_000).toISOString();
    const createScheduled = async (title: string) => {
      const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
        title, summary: '状态改变后不能继续生成旧海报。', proposer: '海报测试', presenter: '海报测试', tags: [],
      } });
      const topic = await created.json() as { id: number; revision: number };
      const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, {
        headers: revisionHeaders(topic.revision),
        data: { scheduledAt: future, duration: 40, room: '状态测试会议室', meetingUrl: '' },
      });
      if (scheduled.status() !== 200) await deleteLatestTopic(request, topic.id);
      expect(scheduled.status()).toBe(200);
      return { id: topic.id, ...await scheduled.json() as { revision: number } };
    };
    const cancelledTitle = `海报取消排期-${marker}`;
    const cancelledTopic = await createScheduled(cancelledTitle);

    try {
    await page.goto('/');
    const cancelledCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: cancelledTitle, exact: true }) });
    const cancelledButton = cancelledCard.getByRole('button', { name: '生成海报' });
    await expect(cancelledButton).toBeVisible();
    const unscheduled = await request.post(`/api/topics/${cancelledTopic.id}/unschedule`, {
      headers: revisionHeaders(cancelledTopic.revision), data: {},
    });
    expect(unscheduled.ok()).toBe(true);
    await cancelledButton.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toContainText('取消排期或状态已变化');
    await expect(dialog.getByRole('img')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '下载 PNG' })).toHaveCount(0);
    await expect(cancelledCard).toContainText('已被认领');
    await dialog.getByRole('button', { name: '返回议题广场' }).click();
    await expect(cancelledCard).toBeFocused();

    } finally {
      await deleteLatestTopic(request, cancelledTopic.id);
    }
  });

  test('海报读取失败可显式重试且关闭后忽略迟到响应', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `海报读取重试-${marker}`;
    const created = await request.post('/api/topics', { headers: sessionHeaders(), data: {
      title, summary: '读取失败时不能降级到列表旧快照。', proposer: '海报测试', presenter: '海报测试', tags: [],
    } });
    const topic = await created.json() as { id: number; revision: number };
    try {
    const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, {
      headers: revisionHeaders(topic.revision),
      data: { scheduledAt: new Date(Date.now() + 306 * 86_400_000).toISOString(), duration: 40, room: '重试测试会议室', meetingUrl: '' },
    });
    expect(scheduled.status()).toBe(200);

    let sourceReads = 0;
    await page.route(`**/api/topics/${topic.id}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      sourceReads += 1;
      if (sourceReads === 1) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '模拟读取失败' }) });
        return;
      }
      if (sourceReads === 3) await new Promise((resolve) => setTimeout(resolve, 350));
      await route.continue();
    });

    await page.goto('/');
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    const posterButton = card.getByRole('button', { name: '生成海报' });
    await posterButton.click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toContainText('模拟读取失败');
    await expect(dialog.getByRole('img')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '下载 PNG' })).toHaveCount(0);
    await dialog.getByRole('button', { name: '重新读取并生成' }).click();
    await expect(dialog.getByRole('img', { name: /围炉夜话宣讲海报/ })).toBeVisible();
    expect(sourceReads).toBe(2);
    await dialog.getByRole('button', { name: '关闭' }).click();

    await posterButton.click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '正在确认最新议题' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(posterButton).toBeFocused();
    await page.waitForTimeout(450);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(sourceReads).toBe(3);

    } finally {
      await page.unroute(`**/api/topics/${topic.id}`).catch(() => undefined);
      await deleteLatestTopic(request, topic.id);
    }
  });

  test('统计与五步说明进入真实功能', async ({ page }) => {
    await page.goto('/');
    await page.locator('.stats').getByRole('button', { name: /等待认领/ }).click();
    await expect(page.getByRole('button', { name: '等待认领', exact: true })).toHaveClass(/active/);
    const flow = page.locator('.flow-grid');
    const createFlowButton = flow.getByRole('button', { name: '创建议题' });
    await createFlowButton.click();
    await expect(page.getByRole('heading', { name: '发起一个新议题' })).toBeVisible();
    await expect(page.getByLabel('议题标题')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: '关闭' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: '发布议题' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(createFlowButton).toBeFocused();
    await flow.getByRole('button', { name: '认领议题' }).click();
    await expect(page.getByRole('button', { name: '等待认领', exact: true })).toHaveClass(/active/);
    await flow.getByRole('button', { name: '议题排期' }).click();
    await expect(page.getByRole('button', { name: '准备中', exact: true })).toHaveClass(/active/);
    await flow.getByRole('button', { name: '报名围炉' }).click();
    await expect(page.getByRole('button', { name: '周历' })).toHaveClass(/active/);
    await flow.getByRole('button', { name: '沉淀归档' }).click();
    await expect(page.getByText(/待归档任务 · \d+ 个结果/)).toBeVisible();
  });

  test('同日多场在月历进入完整议程且保持顺序与焦点，标签超限不会静默丢弃', async ({ page, request }, testInfo) => {
    const sessionCount = 10;
    const dayOffset = 1 + testInfo.retry * 2;
    const scheduledAt = new Date(Date.now() + dayOffset * 86_400_000);
    scheduledAt.setUTCHours(10, 0, 0, 0);
    const ids: number[] = [];
    const titles: string[] = [];
    const titlePrefix = `月历溢出-${testInfo.project.name}-${Date.now()}`;
    try {
      for (let index = 1; index <= sessionCount; index += 1) {
        const title = `${titlePrefix}-${index}`;
        titles.push(title);
        const created = await request.post('/api/topics', {
          headers: sessionHeaders(),
          data: { title, summary: '验证同一天超过三个议题后仍可展开查看。', proposer: '月历测试', presenter: '月历测试', tags: [] },
        });
        const topic = await created.json() as { id: number; revision: number };
        ids.push(topic.id);
        const sessionTime = new Date(scheduledAt.getTime() + (index - 1) * 30 * 60_000);
        const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, {
          headers: revisionHeaders(topic.revision),
          data: { scheduledAt: sessionTime.toISOString(), duration: 30, room: '月历测试会议室', meetingUrl: '' },
        });
        expect(scheduled.status()).toBe(200);
      }

      await page.goto('/');
      await page.getByRole('button', { name: '月历', exact: true }).click();
      const moreButton = page.getByRole('button', { name: new RegExp(`共有 ${sessionCount} 场，查看全部当日议程`) });
      const fixtureEvents = page.locator('.calendar-event').filter({ hasText: titlePrefix });
      await expect(moreButton).toBeVisible();
      await expect(moreButton).toHaveText(`另有 ${sessionCount - 3} 场`);
      expect((await moreButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expect(fixtureEvents).toHaveCount(3);
      await moreButton.click();
      const agenda = page.getByRole('dialog', { name: new RegExp(`${sessionCount} 场围炉`) });
      await expect(agenda).toBeVisible();
      await expect(agenda.getByRole('heading', { name: new RegExp(`${sessionCount} 场围炉`) })).toBeFocused();
      await expect(agenda.locator('.modal-intro')).toContainText('无排期冲突的待开始活动可生成专属海报');
      await expect(agenda.locator('.modal-intro')).not.toContainText('加入会议');
      const agendaItems = agenda.locator('.day-agenda-item');
      await expect(agendaItems).toHaveCount(sessionCount);
      for (let index = 0; index < titles.length; index += 1) {
        await expect(agendaItems.nth(index)).toContainText(`第 ${index + 1} 场`);
        await expect(agendaItems.nth(index)).toContainText(titles[index]);
      }
      const agendaMetrics = await agenda.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
      expect(agendaMetrics.scrollWidth).toBeLessThanOrEqual(agendaMetrics.clientWidth);
      expect((await agendaItems.last().boundingBox())!.height).toBeGreaterThanOrEqual(44);
      for (const key of ['Tab', 'Tab', 'Shift+Tab']) {
        await page.keyboard.press(key);
        await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
      }
      await agendaItems.last().click();
      const detail = page.getByRole('dialog', { name: titles.at(-1)! });
      await expect(detail).toBeVisible();
      await expect(agenda).toHaveAttribute('inert', '');
      await expect(detail).not.toHaveAttribute('inert', '');
      await page.keyboard.press('Escape');
      await expect(detail).toHaveCount(0);
      await expect(agendaItems.last()).toBeFocused();
      await agenda.getByRole('button', { name: '关闭当日议程' }).click();
      await expect(moreButton).toBeFocused();

      await page.getByRole('button', { name: '周历', exact: true }).click();
      const weekFixtureEvents = page.locator('.week-event').filter({ hasText: titlePrefix });
      await expect(weekFixtureEvents).toHaveCount(3);
      const weekMore = page.getByRole('button', { name: new RegExp(`共有 ${sessionCount} 场，查看全部当日议程`) });
      await expect(weekMore).toHaveText(`查看当日全部 ${sessionCount} 场`);
      await weekMore.click();
      const weekAgenda = page.getByRole('dialog', { name: new RegExp(`${sessionCount} 场围炉`) });
      await expect(weekAgenda.locator('.day-agenda-item')).toHaveCount(sessionCount);
      await weekAgenda.locator('.day-agenda-item').last().click();
      const businessDetail = page.getByRole('dialog', { name: titles.at(-1)! });
      await businessDetail.getByRole('button', { name: '取消排期', exact: true }).click();
      const cancellation = page.getByRole('dialog', { name: '取消这次排期？' });
      await cancellation.getByRole('button', { name: '确认取消排期' }).click();
      const claimedCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: titles.at(-1)!, exact: true }) });
      await expect(claimedCard).toContainText('已被认领');
      await expect(claimedCard).toBeFocused();
      await page.waitForTimeout(1_600);
      await expect(claimedCard).toBeFocused();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await page.getByRole('button', { name: '周历', exact: true }).click();
      const reducedWeekMore = page.getByRole('button', { name: /共有 9 场，查看全部当日议程/ });
      await reducedWeekMore.click();
      let reducedWeekAgenda = page.getByRole('dialog', { name: /9 场围炉/ });
      await reducedWeekAgenda.getByRole('button', { name: '关闭当日议程' }).click();
      await page.waitForTimeout(1_200);
      await expect(reducedWeekMore).toBeFocused();
      await reducedWeekMore.click();
      reducedWeekAgenda = page.getByRole('dialog', { name: /9 场围炉/ });
      const removedFromCalendar = await readPhaseTopic(request, ids.at(-2)!);
      const unscheduled = await request.post(`/api/topics/${removedFromCalendar.id}/unschedule`, {
        headers: revisionHeaders(removedFromCalendar.revision), data: {},
      });
      expect(unscheduled.status()).toBe(200);
      await reducedWeekAgenda.locator('.day-agenda-item').last().click();
      const staleDetail = page.getByRole('dialog', { name: titles.at(-2)! });
      await expect(staleDetail).toContainText('这场活动已取消排期或状态已经变化');
      await staleDetail.getByRole('button', { name: '关闭' }).click();
      const updatedWeekAgenda = page.getByRole('dialog', { name: /8 场围炉/ });
      await expect(updatedWeekAgenda.getByRole('heading', { name: /8 场围炉/ })).toBeFocused();
      await updatedWeekAgenda.getByRole('button', { name: '关闭当日议程' }).click();
      await expect(page.getByRole('button', { name: /共有 8 场，查看全部当日议程/ })).toBeFocused();
      const overflow = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      expect(overflow.document).toBeLessThanOrEqual(0);
      expect(overflow.body).toBeLessThanOrEqual(0);

      await page.getByRole('button', { name: /发起议题/ }).first().click();
      await page.getByLabel('议题标题').fill('标签上限验收');
      await page.getByLabel('一句话简介').fill('第六个标签必须明确报错，不能被静默截断。');
      await page.getByLabel('你的名字').fill('标签测试');
      await page.getByLabel('标签（最多 5 个）').fill('一,二,三,四,五,六');
      await page.getByRole('button', { name: '发布议题' }).click();
      await expect(page.getByText('标签最多 5 个')).toBeVisible();
      await page.getByRole('button', { name: '关闭' }).click();
    } finally {
      await cleanupPhaseTopics(request, ids);
    }
  });

  test('上移按钮保存手动顺序，刷新后保持', async ({ page }) => {
    await page.goto('/');
    const targetCard = page.getByRole('article').nth(1);
    const targetTitle = (await targetCard.getByRole('heading').textContent())!;
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/topics/reorder') && response.status() === 204),
      targetCard.getByTitle('上移').click(),
    ]);
    await page.reload();
    await expect(page.getByRole('article').first()).toContainText(targetTitle);
  });

  test('桌面拖动只能从手柄发起，失败时回滚顺序', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', '移动端使用上移/下移按钮排序');
    await page.goto('/');
    const cards = page.getByRole('article');
    const firstTitle = (await cards.first().getByRole('heading').textContent())!;
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/topics/reorder') && response.status() === 204),
      cards.first().getByTitle('拖动排序').dragTo(cards.nth(1)),
    ]);
    await page.reload();
    await expect(cards.nth(1)).toContainText(firstTitle);

    const currentFirst = (await cards.first().getByRole('heading').textContent())!;
    await page.route('**/api/topics/reorder', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"模拟保存失败"}' }));
    await cards.nth(1).getByTitle('上移').click();
    await expect(page.getByText(/排序保存失败/)).toBeVisible();
    await expect(cards.first()).toContainText(currentFirst);
  });

  test('排序保存期间锁定全部排序控件并保持刷新一致', async ({ page }) => {
    await page.goto('/');
    const targetCard = page.getByRole('article').nth(1);
    const targetTitle = (await targetCard.getByRole('heading').textContent())!;
    let releaseRequest!: () => void;
    let signalRequest!: () => void;
    let requestCount = 0;
    const requestStarted = new Promise<void>((resolve) => { signalRequest = resolve; });
    const requestReleased = new Promise<void>((resolve) => { releaseRequest = resolve; });
    await page.route('**/api/topics/reorder', async (route) => {
      requestCount += 1;
      signalRequest();
      await requestReleased;
      await route.continue();
    });

    await targetCard.getByTitle('上移').click();
    await requestStarted;
    await expect(targetCard.getByTitle('上移')).toBeDisabled();
    await expect(targetCard.getByTitle('下移')).toBeDisabled();
    await expect(targetCard.getByTitle('拖动排序')).toBeDisabled();
    await targetCard.getByTitle('上移').click({ force: true });
    expect(requestCount).toBe(1);
    releaseRequest();
    await expect(page.getByText('正在保存顺序…')).toHaveCount(0);
    await page.unroute('**/api/topics/reorder');

    await page.reload();
    await expect(page.getByRole('article').first()).toContainText(targetTitle);
  });

  test('忽略晚到的其他排序响应，手动重排只使用最新快照', async ({ page }) => {
    const initialResponsePromise = page.waitForResponse((response) => response.url().includes('/api/topics?sort=manual'));
    await page.goto('/');
    const initialResponse = await initialResponsePromise;
    const manualTopics = await initialResponse.json() as { id: number; title: string }[];
    const manualVersion = Number(initialResponse.headers()['x-order-version']);
    const manualIds = manualTopics.map(({ id }) => id);
    const manualTitles = manualTopics.map(({ title }) => title);
    let signalNewest!: () => void;
    let releaseNewest!: () => void;
    const newestStarted = new Promise<void>((resolve) => { signalNewest = resolve; });
    const newestReleased = new Promise<void>((resolve) => { releaseNewest = resolve; });
    await page.route('**/api/topics?sort=newest', async (route) => {
      signalNewest();
      await newestReleased;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Order-Version': String(manualVersion) },
        body: JSON.stringify([...manualTopics].reverse()),
      });
    });

    const sortSelect = page.getByLabel('排序方式');
    await sortSelect.selectOption('newest');
    await newestStarted;
    const latestManualResponse = page.waitForResponse((response) => response.url().includes('/api/topics?sort=manual'));
    await sortSelect.selectOption('manual');
    await latestManualResponse;
    const topicCards = page.locator('.topic-card');
    await expect(topicCards).toHaveCount(manualTopics.length);
    expect(await topicCards.getByRole('heading').allTextContents()).toEqual(manualTitles);

    const lateNewestResponse = page.waitForResponse((response) => response.url().includes('/api/topics?sort=newest'));
    releaseNewest();
    await lateNewestResponse;
    expect(await topicCards.getByRole('heading').allTextContents()).toEqual(manualTitles);
    await expect(page.getByText('正在点燃炉火…')).toHaveCount(0);

    let reorderPayload: { orderedIds: number[]; baseVersion: number } | undefined;
    await page.route('**/api/topics/reorder', async (route) => {
      reorderPayload = route.request().postDataJSON() as { orderedIds: number[]; baseVersion: number };
      await route.fulfill({ status: 204, headers: { 'X-Order-Version': String(manualVersion + 1) } });
    });
    await topicCards.nth(1).getByTitle('上移').click();
    await expect.poll(() => reorderPayload).toBeTruthy();
    expect(reorderPayload).toEqual({
      orderedIds: [manualIds[1], manualIds[0], ...manualIds.slice(2)],
      baseVersion: manualVersion,
    });
  });
});
