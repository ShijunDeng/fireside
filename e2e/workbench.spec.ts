import { expect, test } from '@playwright/test';

test.describe('议题管理工作台', () => {
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
    await page.getByRole('button', { name: '本周排期' }).click();
    await expect(page.getByRole('button', { name: '周历' })).toHaveClass(/active/);
    await expect(page.getByRole('button', { name: '近期排期' })).toHaveClass(/active/);
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
    await expect(card).toContainText('即将开讲');

    await card.getByRole('button', { name: /完成归档/ }).click();
    await page.getByLabel('本期最值得留下的收获').fill('浏览器完整纠错链路已验证。');
    await page.getByRole('dialog').getByRole('button', { name: '完成归档' }).click();
    await expect(card).toContainText('已经归档');

    await card.getByRole('button', { name: /撤销归档/ }).click();
    await page.getByRole('button', { name: '确认撤销归档' }).click();
    await expect(card).toContainText('即将开讲');

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
