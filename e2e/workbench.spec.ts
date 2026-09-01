import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const writeKey = 'e2e-fireside-write-key';
const writeHeaders = { 'X-Fireside-Write-Key': writeKey };

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

    await card.getByRole('button', { name: /编辑/ }).click();
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

  test('自荐发布并可逐步撤销归档、排期和认领', async ({ page }, testInfo) => {
    const title = `自荐发布浏览器验收-${testInfo.project.name}-${Date.now()}`;
    await page.goto('/');
    await page.getByRole('button', { name: /发起议题/ }).first().click();
    await page.getByLabel('议题标题').fill(title);
    await page.getByLabel('一句话简介').fill('从自荐发布走到排期归档，再逐步撤销以验证纠错路径。');
    await page.getByLabel('你的名字').fill('自荐分享者');
    await page.getByLabel('我来分享').check();
    await page.getByRole('button', { name: '发布议题' }).click();
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await expect(card).toContainText('已被认领');
    await expect(card).toContainText('分享 · 自荐分享者');

    await card.getByRole('button', { name: /安排分享/ }).click();
    await page.getByRole('button', { name: '确认排期' }).click();
    await expect(card).toContainText('已排期');

    await card.getByRole('button', { name: /完成归档/ }).click();
    await page.getByLabel('本期最值得留下的收获').fill('浏览器完整纠错链路已验证。');
    await page.getByRole('dialog').getByRole('button', { name: '完成归档' }).click();
    await expect(card).toContainText('已经归档');

    await card.getByRole('button', { name: /撤销归档/ }).click();
    await page.getByRole('button', { name: '确认撤销归档' }).click();
    await expect(card).toContainText('已排期');

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

  test('公网只读脱敏，解锁后协作且失效口令不会丢失表单', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const protectedTitle = `公网隐私验收-${marker}`;
    const secretMeeting = `https://meet.example.test/private/${marker}?passcode=never-public`;
    const created = await request.post('/api/topics', { headers: writeHeaders, data: {
      title: protectedTitle, summary: '公开页面可以看到议题，但不能看到会议凭证和报名姓名。', proposer: '隐私组织者', presenter: '隐私组织者', tags: ['隐私'],
    } });
    const topic = await created.json() as { id: number };
    await request.post(`/api/topics/${topic.id}/schedule`, { headers: writeHeaders, data: {
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
    await Promise.all(cleanupIds.map((id) => request.delete(`/api/topics/${id}`, { headers: writeHeaders })));
  });

  test('报名弹窗遇到活动状态冲突会关闭并同步权威结果', async ({ page, request }, testInfo) => {
    const title = `报名冲突验收-${testInfo.project.name}-${Date.now()}`;
    const created = await request.post('/api/topics', { headers: writeHeaders, data: {
      title, summary: '打开报名后由另一位协调者归档。', proposer: '冲突测试', presenter: '冲突测试', tags: [],
    } });
    const topic = await created.json() as { id: number };
    await request.post(`/api/topics/${topic.id}/schedule`, { headers: writeHeaders, data: {
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), duration: 30, room: '冲突测试会议室', meetingUrl: '',
    } });

    await page.goto('/');
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await card.getByRole('button', { name: '报名参加' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('你的名字').fill('晚到的参与者');
    const archived = await request.post(`/api/topics/${topic.id}/archive`, { headers: writeHeaders, data: { takeaway: '由另一位协调者完成归档。', materialUrl: '' } });
    expect(archived.status()).toBe(200);
    await dialog.getByRole('button', { name: '确认报名' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toContainText('已经归档');
    await expect(page.getByText(/已同步最新状态/)).toBeVisible();

    await request.delete(`/api/topics/${topic.id}`, { headers: writeHeaders });
  });

  test('未来排期一键生成脱敏的 1080×1440 PNG 海报并恢复焦点', async ({ page, request }, testInfo) => {
    const marker = `${testInfo.project.name}-${Date.now()}`;
    const secretUrl = `https://secret.example.test/join/${marker}?passcode=omega`;
    const title = `海报验收 ${marker} https://secret.example.test/title`;
    const future = new Date(Date.now() + 3 * 86_400_000);
    future.setHours(19, 30, 0, 0);
    const past = new Date(Date.now() - 86_400_000);
    const created = await request.post('/api/topics', { headers: writeHeaders, data: {
      title,
      summary: '验证长按预览与隐私脱敏，会议号：998877 密码 alpha。',
      proposer: '海报发起人',
      presenter: '海报分享人 passcode: beta',
      tags: ['海报', '密码: gamma'],
    } });
    expect(created.ok()).toBe(true);
    const topic = await created.json() as { id: number };
    const scheduled = await request.post(`/api/topics/${topic.id}/schedule`, { headers: writeHeaders, data: {
      scheduledAt: future.toISOString(), duration: 45, room: '三楼围炉会议室', meetingUrl: secretUrl,
    } });
    expect(scheduled.ok()).toBe(true);
    const pastCreated = await request.post('/api/topics', { headers: writeHeaders, data: {
      title: `过期海报验收 ${marker}`, summary: '过期排期不能继续宣传。', proposer: '海报测试', presenter: '海报测试', tags: [],
    } });
    expect(pastCreated.ok()).toBe(true);
    const pastTopic = await pastCreated.json() as { id: number };
    const pastScheduled = await request.post(`/api/topics/${pastTopic.id}/schedule`, { headers: writeHeaders, data: {
      scheduledAt: past.toISOString(), duration: 30, room: '旧会议室', meetingUrl: '',
    } });
    expect(pastScheduled.ok()).toBe(true);

    await page.goto('/');
    const card = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    const pastCard = page.locator('.topic-card').filter({ has: page.getByRole('heading', { name: `过期海报验收 ${marker}`, exact: true }) });
    await expect(pastCard).toContainText('待归档');
    await expect(pastCard.getByRole('button', { name: '生成海报' })).toHaveCount(0);

    const requests: string[] = [];
    page.on('request', (outgoing) => requests.push(outgoing.url()));
    const posterButton = card.getByRole('button', { name: '生成海报' });
    await posterButton.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '宣讲海报已为你备好' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '关闭' })).toBeFocused();
    const preview = dialog.getByRole('img', { name: /围炉夜话宣讲海报/ });
    await expect(preview).toBeVisible();
    const dimensions = await preview.evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight, source: image.src }));
    expect(dimensions).toEqual(expect.objectContaining({ width: 1080, height: 1440 }));
    expect(dimensions.source.startsWith('blob:')).toBe(true);
    const dialogText = await dialog.textContent();
    for (const secret of ['secret.example.test', '998877', 'alpha', 'beta', 'gamma', 'omega']) expect(dialogText).not.toContain(secret);
    expect(requests.filter((url) => !url.startsWith('blob:'))).toEqual([]);

    const downloadButton = dialog.getByRole('button', { name: '下载 PNG' });
    expect((await downloadButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const downloadPromise = page.waitForEvent('download');
    await downloadButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^围炉夜话-\d{8}-.*\.png$/);
    const bytes = await readFile((await download.path())!);
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(bytes.readUInt32BE(16)).toBe(1080);
    expect(bytes.readUInt32BE(20)).toBe(1440);

    await page.keyboard.press('Escape');
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
    await page.getByRole('button', { name: '重新生成' }).click();
    await expect(page.getByRole('img', { name: /围炉夜话宣讲海报/ })).toBeVisible();
    await page.getByRole('button', { name: '关闭' }).click();

    await request.delete(`/api/topics/${topic.id}`, { headers: writeHeaders });
    await request.delete(`/api/topics/${pastTopic.id}`, { headers: writeHeaders });
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
    for (let index = 1; index <= 4; index += 1) {
      const title = `月历溢出-${testInfo.project.name}-${Date.now()}-${index}`;
      titles.push(title);
      const created = await request.post('/api/topics', {
        headers: writeHeaders,
        data: { title, summary: '验证同一天超过三个议题后仍可展开查看。', proposer: '月历测试', presenter: '月历测试', tags: [] },
      });
      const topic = await created.json() as { id: number };
      ids.push(topic.id);
      await request.post(`/api/topics/${topic.id}/schedule`, {
        headers: writeHeaders,
        data: { scheduledAt: scheduledAt.toISOString(), duration: 30, room: '月历测试会议室', meetingUrl: '' },
      });
    }

    await page.goto('/');
    await page.getByRole('button', { name: '月历', exact: true }).click();
    const moreButton = page.getByRole('button', { name: '还有 1 个议题' });
    const hiddenEvent = page.locator('.calendar-event').filter({ hasText: titles[3] });
    await expect(moreButton).toBeVisible();
    await expect(hiddenEvent).toHaveCount(0);
    await moreButton.click();
    await expect(hiddenEvent).toBeVisible();
    await expect(page.getByRole('button', { name: '收起' })).toBeVisible();

    await page.getByRole('button', { name: /发起议题/ }).first().click();
    await page.getByLabel('议题标题').fill('标签上限验收');
    await page.getByLabel('一句话简介').fill('第六个标签必须明确报错，不能被静默截断。');
    await page.getByLabel('你的名字').fill('标签测试');
    await page.getByLabel('标签（最多 5 个）').fill('一,二,三,四,五,六');
    await page.getByRole('button', { name: '发布议题' }).click();
    await expect(page.getByText('标签最多 5 个')).toBeVisible();
    await page.getByRole('button', { name: '关闭' }).click();

    await Promise.all(ids.map((id) => request.delete(`/api/topics/${id}`, { headers: writeHeaders })));
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
