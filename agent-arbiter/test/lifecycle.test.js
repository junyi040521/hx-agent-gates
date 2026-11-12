'use strict';
/**
 * 生命周期测试：一半用例是「必须被拒」。
 *
 * 只测「合法迁移能过」是没用的——一个什么都不检查的 move() 也能全过。
 * 真正证明它有价值的是：非法迁移被拒、薄注释被拒、没验过不许 done、
 * 被拒时记录一字不改。
 */

const test = require('node:test');
const assert = require('node:assert');

const lc = require('../src/lifecycle');

const OK_COMMENT = { by: 'orchestrator', what: '派给 sandbox', why: '需要跑测试' };
const FULL_HANDOFF = {
  done: '改了 cacheLayer 的 TTL 逻辑',
  artifacts: 'src/cache.js, test/cache.test.js',
  verify: 'npm test cache',
  issues: '未处理并发写入',
  next: 'reviewer 看边界条件',
};

function seed(state) {
  return { id: 't1', state: state || 'inbox', comments: [], handoff: null, verify: null };
}

/* ------------------------------------------------------------- 正常路径 */

test('全链：inbox → assigned → in_progress → review → done', function () {
  let r = seed();
  for (const to of ['assigned', 'in_progress', 'review']) {
    const m = lc.move(r, to, OK_COMMENT);
    assert.ok(m.ok, to + ' 应被允许：' + m.code);
    r = m.record;
  }
  const m = lc.move(r, 'done', OK_COMMENT, { handoff: FULL_HANDOFF, verify: 'WORKING' });
  assert.ok(m.ok, '验收齐了就该能 done：' + m.code);
  assert.strictEqual(m.record.state, 'done');
  assert.strictEqual(m.record.comments.length, 4);
  assert.deepStrictEqual(lc.trail(m.record), ['inbox', 'assigned', 'in_progress', 'review', 'done']);
});

test('failed 是合法终态，还能重开回 inbox', function () {
  const a = lc.move(seed('in_progress'), 'failed', { by: 'builder', what: '测试挂了 3 条', why: '依赖版本冲突' });
  assert.ok(a.ok, a.code);
  assert.strictEqual(a.record.state, 'failed');
  const b = lc.move(a.record, 'inbox', { by: 'orchestrator', what: '重开', why: '已修依赖' });
  assert.ok(b.ok, 'Failed 必须能重开：' + b.code);
});

/* --------------------------------------------------------- 必须被拒的形态 */

test('跳过流程：inbox 直接 done ⇒ 拒，且写明允许哪些', function () {
  const m = lc.move(seed('inbox'), 'done', OK_COMMENT, { handoff: FULL_HANDOFF, verify: 'WORKING' });
  assert.strictEqual(m.ok, false);
  assert.strictEqual(m.code, lc.CODES.ILLEGAL_TRANSITION);
  assert.deepStrictEqual(m.allowed, ['assigned', 'failed']);
});

test('done 之后不许再动 ⇒ 终态是真的终态', function () {
  const done = { id: 't', state: 'done', comments: [], verify: 'WORKING', handoff: FULL_HANDOFF };
  const m = lc.move(done, 'review', OK_COMMENT);
  assert.strictEqual(m.ok, false);
  assert.strictEqual(m.code, lc.CODES.ILLEGAL_TRANSITION);
});

test('薄注释：只写 what ⇒ 拒，并列出还缺谁和为什么', function () {
  const m = lc.move(seed('inbox'), 'assigned', { what: '派活了' });
  assert.strictEqual(m.ok, false);
  assert.strictEqual(m.code, lc.CODES.THIN_COMMENT);
  assert.deepStrictEqual(m.missing, ['by', 'why']);
});

test('空字符串不算注释（有字段 ≠ 有内容）', function () {
  const m = lc.move(seed('inbox'), 'assigned', { by: '  ', what: '派活', why: '\n' });
  assert.strictEqual(m.ok, false);
  assert.strictEqual(m.code, lc.CODES.THIN_COMMENT);
});

test('没交交接单就 done ⇒ 拒，五要素全缺', function () {
  const r = seed('review');
  const m = lc.move(r, 'done', OK_COMMENT, { verify: 'WORKING' });
  assert.strictEqual(m.ok, false);
  assert.strictEqual(m.code, lc.CODES.THIN_HANDOFF);
  assert.deepStrictEqual(m.missing, lc.HANDOFF_FIELDS);
});

test('交接单缺两项 ⇒ 只报缺的那两项，不整张打回', function () {
  const h = lc.handoff({ done: '改了 A', artifacts: 'src/a.js', verify: 'npm test' });
  assert.strictEqual(h.ok, false);
  assert.deepStrictEqual(h.missing, ['issues', 'next']);
});

test('没验过就 done ⇒ 拒（UNVERIFIED 与空值同等对待）', function () {
  const r = seed('review');
  assert.strictEqual(lc.move(r, 'done', OK_COMMENT, { handoff: FULL_HANDOFF }).code, lc.CODES.UNVERIFIED);
  assert.strictEqual(lc.move(r, 'done', OK_COMMENT, { handoff: FULL_HANDOFF, verify: 'UNVERIFIED' }).code, lc.CODES.UNVERIFIED);
});

test('未知状态 ⇒ 拒（不许把错别字当新状态）', function () {
  assert.strictEqual(lc.move(seed('inbox'), 'doneish', OK_COMMENT).code, lc.CODES.BAD_STATE);
  assert.strictEqual(lc.move(seed('nope'), 'assigned', OK_COMMENT).code, lc.CODES.BAD_STATE);
});

/* --------------------------------------------------- 被拒不许产生副作用 */

test('被拒时原记录一字不改（不部分写入）', function () {
  const r = seed('inbox');
  const before = JSON.stringify(r);
  lc.move(r, 'done', OK_COMMENT, { handoff: FULL_HANDOFF, verify: 'WORKING' });
  lc.move(r, 'assigned', { what: '缺字段' });
  assert.strictEqual(JSON.stringify(r), before, '被拒的迁移不许动原对象');
});

test('move 不改入参：成功时返回的是新对象', function () {
  const r = seed('inbox');
  const m = lc.move(r, 'assigned', OK_COMMENT);
  assert.ok(m.ok);
  assert.notStrictEqual(m.record, r);
  assert.strictEqual(r.state, 'inbox', '入参必须保持原状态');
  assert.strictEqual(r.comments.length, 0);
});

test('迁移表里每个状态都有出处：非法状态集合为空', function () {
  for (const s of lc.STATES) assert.ok(Array.isArray(lc.LEGAL[s]), '缺 ' + s + ' 的迁移定义');
  for (const from of Object.keys(lc.LEGAL)) {
    for (const to of lc.LEGAL[from]) {
      assert.ok(lc.STATES.indexOf(to) >= 0, from + ' 指向了未知状态 ' + to);
    }
  }
});

/* ------------------------------------------- 接缝：决策落成任务 */

const DECIDED = { id: 'd1', status: 'DECIDED', mode: 'deep', executors: ['sandbox'], confidence: 0.92, why: [{ code: 'NEED', note: 'code' }, { code: 'COST', note: '7' }] };
const DEFERRED = { id: 'd2', status: 'DEFERRED', mode: null, executors: [], confidence: 0.4, why: [{ code: 'NO_EXECUTOR' }] };

test('DECIDED ⇒ assigned（已定的决策不再排队）', function () {
  const t = lc.toTask(DECIDED);
  assert.ok(t.ok, t.code);
  assert.strictEqual(t.record.state, 'assigned');
  assert.deepStrictEqual(t.record.executors, ['sandbox']);
  assert.strictEqual(t.record.comments[0].why, 'NEED,COST', '理由必须是可聚合的码');
});

test('DEFERRED ⇒ inbox（排队不是失败）', function () {
  const t = lc.toTask(DEFERRED);
  assert.ok(t.ok);
  assert.strictEqual(t.record.state, 'inbox');
  assert.strictEqual(t.record.comments[0].why, 'NO_EXECUTOR');
});

test('没有理由码的决策不许落成任务（否则注释无法聚合）', function () {
  assert.strictEqual(lc.toTask({ id: 'x', status: 'DECIDED', why: [] }).code, 'MISSING_WHY');
  assert.strictEqual(lc.toTask({ id: 'x', status: 'DECIDED' }).code, 'MISSING_WHY');
});

test('无 id 或状态非二值 ⇒ 拒（不许拿半个决策开工单）', function () {
  assert.strictEqual(lc.toTask({ status: 'DECIDED', why: [{ code: 'A_B' }] }).code, 'NO_ID');
  assert.strictEqual(lc.toTask({ id: 'x', status: 'MAYBE', why: [{ code: 'A_B' }] }).code, 'BAD_DECISION');
});

test('落成的任务能接着走状态机（接缝不漏气）', function () {
  let r = lc.toTask(DECIDED).record;
  assert.strictEqual(r.state, 'assigned');
  const m = lc.move(r, 'in_progress', OK_COMMENT);
  assert.ok(m.ok, m.code);
  assert.deepStrictEqual(lc.trail(m.record), [null, 'assigned', 'in_progress']);
});
