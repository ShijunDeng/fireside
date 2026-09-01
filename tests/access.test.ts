import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { requireProductionWriteKey, writeKeyMatches } from '../server/access';

describe('围炉口令安全边界', () => {
  it('使用固定长度摘要比较口令', () => {
    assert.equal(writeKeyMatches('same-secret', 'same-secret'), true);
    assert.equal(writeKeyMatches('short', 'a-much-longer-secret'), false);
    assert.equal(writeKeyMatches(undefined, 'secret'), false);
  });

  it('生产环境缺少口令时拒绝启动', () => {
    assert.throws(() => requireProductionWriteKey('production', undefined), /FIRESIDE_WRITE_KEY/);
    assert.equal(requireProductionWriteKey('production', 'configured'), 'configured');
    assert.equal(requireProductionWriteKey('test', undefined), undefined);
  });
});
