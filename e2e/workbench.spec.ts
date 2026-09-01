import { expect, test, type APIRequestContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const writeKey = 'e2e-fireside-write-key';
const writeHeaders = { 'X-Fireside-Write-Key': writeKey };
const revisionHeaders = (revision: number) => ({ ...writeHeaders, 'If-Match': `"${revision}"` });

async function latestTopic(request: APIRequestContext, id: number) {
  const response = await request.get(`/api/topics/${id}`);
  if (!response.ok()) throw new Error(`Failed to read topic ${id}: ${response.status()}`);
  return response.json() as Promise<{ id: number; revision: number; title: string }>;
}

async function deleteLatestTopic(request: APIRequestContext, id: number) {
  const topic = await latestTopic(request, id);
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
  const created = await request.post('/api/topics', { headers: writeHeaders, data: {
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

test.describe('议题管理工作台', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((key) => {
      if (localStorage.getItem('e2e-force-locked') !== '1') sessionStorage.setItem('fireside-write-key', key);
    }, writeKey);
  });
  test('在月历和周历中展示排期，并可从事件进入编辑', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '月历' }).click();
    await expect(page.locator('.calendar-day')).toHaveCount(42);
    const monthEvent = page.locator('.calendar-event').filter({ hasText: '把一个模糊想法做成可用 Demo' });
    await expect(monthEvent).toBeVisible();
    await monthEvent.click();
    await expect(page.getByRole('heading', { name: '编辑议题' })).toBeVisible();
    await expect(page.getByLabel('分享时间')).toHaveValue(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    await page.getByRole('button', { name: '关闭' }).click();

    await page.getByRole('button', { name: '周历' }).click();
    await expect(page.locator('.week-day')).toHaveCount(7);
    await expect(page.locator('.week-event').filter({ hasText: '把一个模糊想法做成可用 Demo' })).toBeVisible();
  });

  test('顶部“本周排期”进入当前周，而不是普通列表筛选', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', '移动端顶部次级导航按设计隐藏，周历通过视图开关进入');
    await page.goto('/');
    await page.getByRole('button', { name: '本周排期', exact: true }).click();
    await expect(page.getByRole('button', { name: '周历' })).toHaveClass(/active/);
    await expect(page.getByRole('button', { name: '已排期', exact: true })).toHaveClass(/active/);
    await expect(page.locator('.week-calendar')).toBeVisible();
  });

  test('完成创建、编辑和删除', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /发起议题/ }).first().click();
    await page.getByLabel('议题标题').fill('浏览器 CRUD 验收议题');
    await page.getByLabel('一句话简介').fill('验证创建、修改与删除能够在同一工作台完成。');
    await page.getByLabel('你的名字').fill('Playwright');
    await page.getByLabel('标签').fill('E2E, CRUD');
    await page.getByRole('button', { name: '发布议题' }).click();
    const card = page.getByRole('article').filter({ hasText: '浏览器 CRUD 验收议题' });
    await expect(card).toBeVisible();

    await card.getByRole('button', { name: '编辑 浏览器 CRUD 验收议题', exact: true }).click();
    await page.getByLabel('议题标题').fill('已更新的 CRUD 验收议题');
    await page.getByRole('button', { name: '保存修改' }).click();
    const updatedCard = page.getByRole('article').filter({ hasText: '已更新的 CRUD 验收议题' });
    await expect(updatedCard).toBeVisible();

    await updatedCard.getByRole('button', { name: /删除/ }).click();
    await expect(page.getByText('此操作不可撤销，请确认是否继续。')).toBeVisible();
    await Promise.all([
      page.waitForResponse((response) => response.request().method() === 'DELETE' && response.status() === 204),
      page.getByRole('button', { name: '确认删除' }).click(),
    ]);
    await expect(page.getByRole('heading', { name: '删除这个议题？' })).toHaveCount(0);
    await expect(updatedCard).toHaveCount(0);
  });

  test('自荐发布并可逐步撤销排期和认领', async ({ page }, testInfo) => {
    const title = `自荐发布浏览器验收-${testInfo.project.name}-${Date.now()}`;
    await page.goto('/');
    await page.getByRole('button', { name: /发起议题/ }).first().click();
    await page.getByLabel('议题标题').fill(title);
    await page.getByLabel('一句话简介').fill('从自荐发布走到排期，再逐步撤销以验证纠错路径。');
    await page.getByLabel('你的名字').fill('自荐分享者');
    await page.getByLabel('我来分享').check();
    await page.getByRole('button', { name: '发布议题' }).click();
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await expect(card).toContainText('已被认领');
    await expect(card).toContainText('分享 · 自荐分享者');

    await card.getByRole('button', { name: /安排分享/ }).click();
    await page.getByRole('button', { name: '确认排期' }).click();
    await expect(card).toContainText('已排期');
    await expect(card.getByRole('button', { name: /完成归档/ })).toHaveCount(0);

    await card.getByRole('button', { name: /取消排期/ }).click();
    await page.getByRole('button', { name: '确认取消排期' }).click();
    await expect(card).toContainText('已被认领');

    await card.getByRole('button', { name: /重新开放/ }).click();
    await page.getByRole('button', { name: '重新开放认领' }).click();
    await expect(card).toContainText('等待添柴');
    await card.getByRole('button', { name: /删除/ }).click();
    await page.getByRole('button', { name: '确认删除' }).click();
    await expect(card).toHaveCount(0);
  });

  test('线上会议可加入，并完成报名、去重和取消报名', async ({ page }, testInfo) => {
    const title = `线上参会浏览器验收-${testInfo.project.name}-${Date.now()}`;
    const meetingUrl = 'https://meet.example.test/fireside/weekly-room';
    await page.goto('/');
    await page.getByRole('button', { name: /发起议题/ }).first().click();
    await page.getByLabel('议题标题').fill(title);
    await page.getByLabel('一句话简介').fill('验证会议入口、报名名单与周历中的独立参会动作。');
    await page.getByLabel('你的名字').fill('线上组织者');
    await page.getByLabel('我来分享').check();
    await page.getByRole('button', { name: '发布议题' }).click();
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await card.getByRole('button', { name: /安排分享/ }).click();
    await page.getByLabel('地点 / 参与说明').fill('线上入口：https://meet.test/x?passcode=must-not-leak');
    await page.getByRole('button', { name: '确认排期' }).click();
    await expect(page.getByRole('alert')).toContainText('地点中不能填写会议链接、会议号或密码');
    await expect(page.getByRole('heading', { name: '安排炉边分享' })).toBeVisible();
    await page.getByLabel('地点 / 参与说明').fill('线上会议');
    await page.getByLabel('线上会议链接（选填）').fill(meetingUrl);
    await page.getByRole('button', { name: '确认排期' }).click();

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
    await expect(participantDialog.getByLabel('你的名字')).toBeFocused();
    await participantDialog.getByLabel('你的名字').fill('Alice');
    await participantDialog.getByRole('button', { name: '确认报名' }).click();
    await expect(participantDialog.getByText('Alice')).toBeVisible();
    await participantDialog.getByLabel('你的名字').fill(' alice ');
    await participantDialog.getByRole('button', { name: '确认报名' }).click();
    await expect(participantDialog.getByText(/已经报名/)).toBeVisible();
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
    await weekEvent.getByRole('button', { name: '加入会议' }).click();
    meetingDialog = page.getByRole('dialog');
    meetingAccessLink = meetingDialog.getByRole('link', { name: '进入线上会议' });
    await expect(meetingAccessLink).toHaveAttribute('href', meetingUrl);
    await meetingDialog.getByRole('button', { name: '关闭' }).click();
    await expect(page.getByRole('heading', { name: '编辑议题' })).toHaveCount(0);

    await page.getByRole('button', { name: '列表' }).click();
    await card.getByRole('button', { name: /删除/ }).click();
    await page.getByRole('button', { name: '确认删除' }).click();
    await expect(card).toHaveCount(0);
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

      const boundary = await createScheduledPhaseTopic(request, {
        title: liveTitle,
        scheduledAt: new Date(Date.now() + 8_000).toISOString(),
        meetingUrl: liveMeeting,
      });
      cleanupIds.push(boundary.id);
      await page.reload();
      const documentLoadsAtUpcoming = await page.evaluate(() => Number(sessionStorage.getItem('e2e-phase-document-loads')));
      const liveCard = page.locator('.topic-card')
        .filter({ has: page.getByRole('heading', { name: liveTitle, exact: true }) })
        .filter({ hasText: `#${String(boundary.id).padStart(3, '0')}` });
      await expect(liveCard.locator('.status-pill')).toHaveText('已排期');
      await liveCard.getByRole('button', { name: '取消排期' }).click();
      const staleUnscheduleDialog = page.getByRole('dialog');
      await expect(staleUnscheduleDialog.getByRole('heading', { name: '取消这次排期？' })).toBeVisible();

      await expect(liveCard.locator('.status-pill')).toHaveText('进行中', { timeout: 15_000 });
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
      const archivedMeeting = await request.get(`/api/topics/${archivedSeed.id}/meeting-access`, { headers: writeHeaders });
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
      const endedMeeting = await request.get(`/api/topics/${archivedSeed.id}/meeting-access`, { headers: writeHeaders });
      expect(endedMeeting.status()).toBe(409);
      expect(await endedMeeting.text()).not.toContain('http');

      await seedCard.getByRole('button', { name: '查看参与' }).click();
      let dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: '本期参与伙伴' })).toBeVisible();
      await expect(dialog.getByText('0 人')).toBeVisible();
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
      await dialog.getByLabel('本期最值得留下的收获').fill(originalArchive.takeaway);
      if (originalArchive.materialUrl) await dialog.getByLabel('资料链接（选填）').fill(originalArchive.materialUrl);
      await dialog.getByRole('button', { name: '完成归档' }).click();
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

      await seedCard.getByRole('button', { name: '未举行 / 重新排期' }).click();
      dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: '确认未举行 / 重新排期？' })).toBeVisible();
      await expect(dialog).toContainText(/旧报名/);
      await expect(dialog).toContainText(/地点/);
      await expect(dialog).toContainText(/会议入口/);
      await dialog.getByRole('button', { name: '确认未举行 / 重新排期' }).click();
      expect(resetRequestCount).toBe(1);
      await expect(seedCard.locator('.status-pill')).toHaveText('已被认领');
      await expect(seedCard).not.toContainText('人报名');
      const unchangedRealParticipants = await request.get(`/api/topics/${archivedSeed.id}/participants`, { headers: writeHeaders });
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

  test('公网只读脱敏，解锁后协作且失效口令不会丢失表单', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const protectedTitle = `公网隐私验收-${marker}`;
    const secretMeeting = `https://meet.example.test/private/${marker}?passcode=never-public`;
    const created = await request.post('/api/topics', { headers: writeHeaders, data: {
      title: protectedTitle, summary: '公开页面可以看到议题，但不能看到会议凭证和报名姓名。', proposer: '隐私组织者', presenter: '隐私组织者', tags: ['隐私'],
    } });
    const topic = await created.json() as { id: number; revision: number };
    await request.post(`/api/topics/${topic.id}/schedule`, { headers: revisionHeaders(topic.revision), data: {
      scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), duration: 40, room: '三楼围炉会议室', meetingUrl: secretMeeting,
    } });
    await request.post(`/api/topics/${topic.id}/participants`, { headers: writeHeaders, data: { name: '不公开的报名人' } });

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
      sessionStorage.removeItem('fireside-write-key');
    });
    await page.reload();
    await expect(page.getByRole('button', { name: '解锁协作' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('never-public');
    await expect(page.locator('body')).not.toContainText('不公开的报名人');
    const protectedCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: protectedTitle, exact: true }) });
    await protectedCard.getByRole('button', { name: '加入会议' }).click();
    let accessDialog = page.getByRole('dialog');
    await expect(accessDialog.getByRole('heading', { name: '解锁围炉协作' })).toBeVisible();
    await accessDialog.getByLabel('围炉口令').fill('wrong-key');
    await accessDialog.getByRole('button', { name: '解锁协作' }).click();
    await expect(accessDialog.getByText('围炉口令不正确')).toBeVisible();
    await accessDialog.getByLabel('围炉口令').fill(writeKey);
    await accessDialog.getByRole('button', { name: '解锁协作' }).click();
    const meetingDialog = page.getByRole('dialog');
    await expect(meetingDialog.getByRole('link', { name: '进入线上会议' })).toHaveAttribute('href', secretMeeting);
    await meetingDialog.getByRole('button', { name: '关闭' }).click();
    await expect(page.getByRole('button', { name: '协作已解锁' })).toBeVisible();

    await page.getByRole('button', { name: '协作已解锁' }).click();
    await expect(page.getByRole('button', { name: '解锁协作' })).toBeVisible();
    await page.getByRole('button', { name: /发起议题/ }).first().click();
    accessDialog = page.getByRole('dialog');
    await accessDialog.getByLabel('围炉口令').fill(writeKey);
    await accessDialog.getByRole('button', { name: '解锁协作' }).click();
    const retainedTitle = `口令失效表单保留-${marker}`;
    await page.getByLabel('议题标题').fill(retainedTitle);
    await page.getByLabel('一句话简介').fill('第一次提交因口令失效而失败，重新解锁后由用户再次确认。');
    await page.getByLabel('你的名字').fill('协作测试者');
    await page.evaluate(() => sessionStorage.setItem('fireside-write-key', 'expired-key'));
    await page.getByRole('button', { name: '发布议题' }).click();
    accessDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '解锁围炉协作' }) });
    await expect(accessDialog).toBeVisible();
    await expect(page.locator('input[name="title"]')).toHaveValue(retainedTitle);
    await accessDialog.getByLabel('围炉口令').fill(writeKey);
    await accessDialog.getByRole('button', { name: '解锁协作' }).click();
    await expect(page.locator('input[name="title"]')).toHaveValue(retainedTitle);
    await page.getByRole('button', { name: '发布议题' }).click();
    await expect(page.getByRole('heading', { name: retainedTitle, exact: true })).toBeVisible();

    const allTopics = await request.get('/api/topics');
    const cleanupIds = (await allTopics.json() as { id: number; title: string }[])
      .filter((item) => item.title === protectedTitle || item.title === retainedTitle)
      .map(({ id }) => id);
    await Promise.all(cleanupIds.map((id) => deleteLatestTopic(request, id)));
  });

  test('报名弹窗遇到取消排期会关闭并同步权威结果', async ({ page, request }, testInfo) => {
    const title = `报名冲突验收-${testInfo.project.name}-${Date.now()}`;
    const created = await request.post('/api/topics', { headers: writeHeaders, data: {
      title, summary: '打开报名后由另一位协调者取消排期。', proposer: '冲突测试', presenter: '冲突测试', tags: [],
    } });
    const topic = await created.json() as { id: number; revision: number };
    const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, { headers: revisionHeaders(topic.revision), data: {
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), duration: 30, room: '冲突测试会议室', meetingUrl: '',
    } });
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

  test('陈旧编辑遇到取消排期会关闭并同步权威状态', async ({ page, request }, testInfo) => {
    const title = `编辑冲突验收-${testInfo.project.name}-${Date.now()}`;
    const created = await request.post('/api/topics', { headers: writeHeaders, data: {
      title, summary: '编辑排期时由另一位协调者取消排期。', proposer: '冲突测试', presenter: '冲突测试', tags: [],
    } });
    const topic = await created.json() as { id: number; revision: number };
    const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, { headers: revisionHeaders(topic.revision), data: {
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), duration: 30, room: '原会议室', meetingUrl: '',
    } });
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
    const created = await request.post('/api/topics', { headers: writeHeaders, data: {
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
    const created = await request.post('/api/topics', { headers: writeHeaders, data: {
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

  test('陈旧删除拒绝抹掉新报名，并要求重新确认', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `陈旧删除报名保护-${marker}`;
    const participantName = `新报名伙伴-${marker}`;
    const created = await request.post('/api/topics', { headers: writeHeaders, data: {
      title, summary: '删除确认期间的新报名必须被完整保留。', proposer: '删除测试', presenter: '删除测试', tags: ['报名'],
    } });
    const topic = await created.json() as { id: number; revision: number };
    const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, {
      headers: revisionHeaders(topic.revision),
      data: { scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), duration: 40, room: '版本测试会议室', meetingUrl: '' },
    });
    expect(scheduled.status()).toBe(200);

    await page.goto('/');
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await card.getByRole('button', { name: `删除 ${title}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: '删除这个议题？' })).toBeVisible();
    const joined = await request.post(`/api/topics/${topic.id}/participants`, {
      headers: writeHeaders,
      data: { name: participantName },
    });
    expect(joined.status()).toBe(201);
    await page.getByRole('button', { name: '确认删除' }).click();

    await expect(page.getByRole('heading', { name: '删除这个议题？' })).toHaveCount(0);
    await expect(page.getByText(/议题已被其他协作者更新/)).toBeVisible();
    await expect(card).toBeVisible();
    await expect(card).toContainText('1 人报名');
    await card.getByRole('button', { name: /报名参加/ }).click();
    const participantsDialog = page.getByRole('dialog');
    await expect(participantsDialog.getByText(participantName)).toBeVisible();
    await participantsDialog.getByRole('button', { name: '关闭' }).click();

    await card.getByRole('button', { name: `删除 ${title}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: '删除这个议题？' })).toBeVisible();
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith(`/api/topics/${topic.id}`)
        && response.request().method() === 'DELETE' && response.status() === 204),
      page.getByRole('button', { name: '确认删除' }).click(),
    ]);
    await expect(card).toHaveCount(0);
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
    const created = await request.post('/api/topics', { headers: writeHeaders, data: {
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
    const created = await request.post('/api/topics', { headers: writeHeaders, data: {
      title, summary: '列表快照过期时必须重新确认排期。', proposer: '海报测试', presenter: '海报测试', tags: ['改期'],
    } });
    const topic = await created.json() as { id: number; revision: number };
    const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, {
      headers: revisionHeaders(topic.revision),
      data: { scheduledAt: originalTime.toISOString(), duration: 35, room: '改期测试会议室', meetingUrl: '' },
    });
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

  test('海报拒绝陈旧的取消排期与删除快照并同步页面', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const createScheduled = async (title: string) => {
      const created = await request.post('/api/topics', { headers: writeHeaders, data: {
        title, summary: '状态改变后不能继续生成旧海报。', proposer: '海报测试', presenter: '海报测试', tags: [],
      } });
      const topic = await created.json() as { id: number; revision: number };
      const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, {
        headers: revisionHeaders(topic.revision),
        data: { scheduledAt: future, duration: 40, room: '状态测试会议室', meetingUrl: '' },
      });
      return { id: topic.id, ...await scheduled.json() as { revision: number } };
    };
    const cancelledTitle = `海报取消排期-${marker}`;
    const deletedTitle = `海报删除议题-${marker}`;
    const cancelledTopic = await createScheduled(cancelledTitle);
    const deletedTopic = await createScheduled(deletedTitle);

    await page.goto('/');
    const cancelledCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: cancelledTitle, exact: true }) });
    const cancelledButton = cancelledCard.getByRole('button', { name: '生成海报' });
    await expect(cancelledButton).toBeVisible();
    const unscheduled = await request.post(`/api/topics/${cancelledTopic.id}/unschedule`, {
      headers: revisionHeaders(cancelledTopic.revision), data: {},
    });
    expect(unscheduled.ok()).toBe(true);
    await cancelledButton.click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toContainText('取消排期或状态已变化');
    await expect(dialog.getByRole('img')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '下载 PNG' })).toHaveCount(0);
    await expect(cancelledCard).toContainText('已被认领');
    await dialog.getByRole('button', { name: '返回议题广场' }).click();
    await expect(cancelledCard).toBeFocused();

    const deletedCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: deletedTitle, exact: true }) });
    const deletedButton = deletedCard.getByRole('button', { name: '生成海报' });
    await expect(deletedButton).toBeVisible();
    const deleted = await request.delete(`/api/topics/${deletedTopic.id}`, { headers: revisionHeaders(deletedTopic.revision) });
    expect(deleted.status()).toBe(204);
    await deletedButton.click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toContainText('议题已被删除');
    await expect(deletedCard).toHaveCount(0);
    await dialog.getByRole('button', { name: '返回议题广场' }).click();
    await expect(page.getByRole('heading', { name: '炉边正在发生什么' })).toBeFocused();

    await deleteLatestTopic(request, cancelledTopic.id);
  });

  test('海报读取失败可显式重试且关闭后忽略迟到响应', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const title = `海报读取重试-${marker}`;
    const created = await request.post('/api/topics', { headers: writeHeaders, data: {
      title, summary: '读取失败时不能降级到列表旧快照。', proposer: '海报测试', presenter: '海报测试', tags: [],
    } });
    const topic = await created.json() as { id: number; revision: number };
    await request.post(`/api/topics/${topic.id}/schedule`, {
      headers: revisionHeaders(topic.revision),
      data: { scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), duration: 40, room: '重试测试会议室', meetingUrl: '' },
    });

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

    await page.unroute(`**/api/topics/${topic.id}`);
    await deleteLatestTopic(request, topic.id);
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
    await expect(page.getByRole('button', { name: '往期归档', exact: true })).toHaveClass(/active/);
  });

  test('月历可展开同日隐藏议题，标签超限不会静默丢弃', async ({ page, request }, testInfo) => {
    const dayOffset = (testInfo.project.name === 'mobile' ? 10 : 1) + testInfo.retry * 2;
    const scheduledAt = new Date(Date.now() + dayOffset * 86_400_000);
    scheduledAt.setHours(18, 0, 0, 0);
    const ids: number[] = [];
    const titles: string[] = [];
    const titlePrefix = `月历溢出-${testInfo.project.name}-${Date.now()}`;
    try {
      for (let index = 1; index <= 4; index += 1) {
        const title = `${titlePrefix}-${index}`;
        titles.push(title);
        const created = await request.post('/api/topics', {
          headers: writeHeaders,
          data: { title, summary: '验证同一天超过三个议题后仍可展开查看。', proposer: '月历测试', presenter: '月历测试', tags: [] },
        });
        const topic = await created.json() as { id: number; revision: number };
        ids.push(topic.id);
        await request.post(`/api/topics/${topic.id}/schedule`, {
          headers: revisionHeaders(topic.revision),
          data: { scheduledAt: scheduledAt.toISOString(), duration: 30, room: '月历测试会议室', meetingUrl: '' },
        });
      }

      await page.goto('/');
      await page.getByRole('button', { name: '月历', exact: true }).click();
      const moreButton = page.getByRole('button', { name: /还有 \d+ 个议题/ });
      const fixtureEvents = page.locator('.calendar-event').filter({ hasText: titlePrefix });
      await expect(moreButton).toBeVisible();
      expect(await fixtureEvents.count()).toBeLessThan(4);
      await moreButton.click();
      await expect(fixtureEvents).toHaveCount(4);
      await expect(page.getByRole('button', { name: '收起' })).toBeVisible();

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
