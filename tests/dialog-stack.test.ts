import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDialogStack, createDialogToken } from '../src/dialog-stack.js';

describe('共享弹窗栈', () => {
  it('只把最后注册的唯一 token 视为栈顶并通知栈变化', () => {
    const style = { overflow: '' };
    const stack = createDialogStack({ getBodyStyle: () => style });
    const first = createDialogToken('first');
    const second = createDialogToken('second');
    const snapshots: (readonly symbol[])[] = [];
    const unsubscribe = stack.subscribe(() => snapshots.push(stack.getSnapshot()));

    const releaseFirst = stack.register(first);
    const firstSnapshot = stack.getSnapshot();
    const releaseSecond = stack.register(second);

    assert.equal(stack.isRegistered(first), true);
    assert.equal(stack.isTop(first), false);
    assert.equal(stack.isTop(second), true);
    assert.deepEqual(stack.getSnapshot(), [first, second]);
    assert.notEqual(stack.getSnapshot(), firstSnapshot);
    assert.equal(style.overflow, 'hidden');

    releaseSecond();
    assert.equal(stack.isTop(first), true);
    releaseFirst();
    unsubscribe();
    assert.deepEqual(stack.getSnapshot(), []);
    assert.deepEqual(snapshots, [[first], [first, second], [first], []]);
  });

  it('乱序和重复释放不会提前解除滚动锁或产生负计数', () => {
    const style = { overflow: 'clip' };
    let styleReads = 0;
    const stack = createDialogStack({
      getBodyStyle: () => {
        styleReads += 1;
        return style;
      },
    });
    const first = createDialogToken('first');
    const second = createDialogToken('second');
    const third = createDialogToken('third');
    const releaseFirst = stack.register(first);
    const releaseSecond = stack.register(second);
    const releaseThird = stack.register(third);

    releaseSecond();
    releaseSecond();
    assert.deepEqual(stack.getSnapshot(), [first, third]);
    assert.equal(stack.isTop(third), true);
    assert.equal(style.overflow, 'hidden');

    releaseFirst();
    assert.equal(style.overflow, 'hidden');
    releaseThird();
    releaseThird();
    assert.equal(style.overflow, 'clip');
    assert.deepEqual(stack.getSnapshot(), []);
    assert.equal(styleReads, 1);
  });

  it('仅首次打开时拍摄 overflow 并在每轮最后释放时恢复该轮原值', () => {
    const style = { overflow: 'scroll' };
    const stack = createDialogStack({ getBodyStyle: () => style });
    const releaseFirst = stack.register(createDialogToken());
    style.overflow = 'auto';
    const releaseOverlay = stack.register(createDialogToken('overlay'));

    assert.equal(style.overflow, 'hidden', '叠层注册应重新加锁但不得覆盖首次快照');
    releaseOverlay();
    assert.equal(style.overflow, 'hidden');
    releaseFirst();
    assert.equal(style.overflow, 'scroll');

    style.overflow = 'visible';
    const releaseNextRound = stack.register(createDialogToken('next-round'));
    assert.equal(style.overflow, 'hidden');
    releaseNextRound();
    assert.equal(style.overflow, 'visible');
  });

  it('同一 token 的重叠注册只占一个栈位且等待全部持有者释放', () => {
    const style = { overflow: '' };
    const stack = createDialogStack({ getBodyStyle: () => style });
    const token = createDialogToken('shared');
    const releaseA = stack.register(token);
    const stableSnapshot = stack.getSnapshot();
    const releaseB = stack.register(token);

    assert.equal(stack.getSnapshot(), stableSnapshot);
    assert.deepEqual(stack.getSnapshot(), [token]);
    releaseA();
    assert.equal(stack.isRegistered(token), true);
    assert.equal(style.overflow, 'hidden');
    releaseB();
    assert.equal(stack.isRegistered(token), false);
    assert.equal(style.overflow, '');
  });

  it('承受 StrictMode 式注册清理重放且旧 release 保持幂等', () => {
    const style = { overflow: '' };
    const stack = createDialogStack({ getBodyStyle: () => style });
    const token = createDialogToken('strict-mode');

    const releaseFirstEffect = stack.register(token);
    releaseFirstEffect();
    const releaseSecondEffect = stack.register(token);
    releaseFirstEffect();

    assert.equal(stack.isTop(token), true);
    assert.equal(style.overflow, 'hidden');
    releaseSecondEffect();
    assert.equal(stack.isRegistered(token), false);
    assert.equal(style.overflow, '');
  });

  it('取消订阅幂等且无 document 环境也能维护所有权', () => {
    const stack = createDialogStack({ getBodyStyle: () => null });
    const token = createDialogToken();
    let notifications = 0;
    const unsubscribe = stack.subscribe(() => { notifications += 1; });
    const release = stack.register(token);
    unsubscribe();
    unsubscribe();
    release();

    assert.equal(notifications, 1);
    assert.equal(stack.isTop(token), false);
    assert.deepEqual(stack.getSnapshot(), []);
  });
});
