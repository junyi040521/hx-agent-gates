'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { arbiter, REASONS } = require('../src/arbiter');

function mk(over) {
  const o = over || {};
  return arbiter({
    modes: {
      quick: { base: 0.8, minConfidence: 0.5, capabilities: ['web', 'calc'] },
      deep: { base: 0.9, minConfidence: 0.7, capabilities: ['web', 'calc', 'code', 'memory'] },
      careful: { base: 0.95, minConfidence: 0.9, capabilities: ['code', 'human'] },
    },
    registry: {
      web: { id: 'webSearch', capabilities: ['web'], cost: 1 },
      calc: { id: 'calculator', capabilities: ['calc'], cost: 1 },
      code: { id: 'sandbox', capabilities: ['code'], cost: 5 },
      memory: { id: 'vectorMemory', capabilities: ['memory'], cost: 2 },
    },
    threshold: 0.6,
    now: o.now || (() => 1700000000000),
    judge: o.judge,
  });
}

test('需求明确 → DECIDED，带 mode/executor/why', () => {
  const a = mk();
  const d = a.decide({ request: '查天气', signals: { needsWeb: true } });
  assert.strictEqual(d.status, REASONS.DECIDED);
  assert.deepStrictEqual(d.executors, ['webSearch']);
  assert.ok(d.why.length > 0, '每个决策都必须能解释');
  assert.ok(d.confidence >= 0.6);
});

test('能力有模式覆盖 → 命中最高档；无执行者承接 → DEFERRED 且写明原因', () => {
  const a = mk();
  const d = a.decide({ request: '改代码并联网查文档', signals: { needsWeb: true, needsCode: true } });
  assert.strictEqual(d.status, REASONS.DECIDED);
  assert.strictEqual(d.mode, 'deep', 'web+code 只有 deep 能覆盖');
  assert.deepStrictEqual(d.executors.slice().sort(), ['sandbox', 'webSearch'], 'web 与 code 需要两个执行者，不是一个');
  assert.strictEqual(d.uncovered.length, 0);

  const d2 = a.decide({ request: '让人来现场看', signals: { needsHuman: true } });
  assert.strictEqual(d2.status, REASONS.DEFERRED);
  assert.ok(d2.why.some((x) => x.code === REASONS.NO_EXECUTOR), 'careful 有 human 能力域，但注册表里没有执行者');
});

test('歧义高 → 置信度跌破门槛 → DEFERRED，并进队列', () => {
  const a = mk();
  const d = a.decide({ request: '那个东西弄一下', signals: { needsWeb: true, ambiguity: 0.9 } });
  assert.strictEqual(d.status, REASONS.DEFERRED);
  assert.ok(d.confidence < 0.6);
  assert.strictEqual(a.queue().length, 1);
});

test('够用就选最低档；高风险强制升档，不许降档绕过', () => {
  const a = mk();
  const low = a.decide({ request: '查天气', signals: { needsWeb: true } });
  assert.strictEqual(low.mode, 'quick', '低风险时选够用的最低档，不推人去 careful');
  assert.strictEqual(low.status, REASONS.DECIDED);

  const hi = a.decide({ request: '查这个库能不能删', signals: { needsWeb: true, risk: 0.6 } });
  assert.strictEqual(hi.status, REASONS.DEFERRED, 'quick 的置信度够，但风险 0.6 时门槛须 ≥ 0.85');
  assert.ok(hi.why.some((x) => x.code === REASONS.HIGH_RISK), '必须写明是高风险卡掉的，不是含糊的置信度不足');
});

test('同一请求重复 defer → 不重复入队（去重）', () => {
  const a = mk();
  a.decide({ request: '那个东西弄一下', signals: { needsWeb: true, ambiguity: 0.9 } });
  const d2 = a.decide({ request: '那个东西弄一下', signals: { needsWeb: true, ambiguity: 0.9 } });
  assert.strictEqual(a.queue().length, 1);
  assert.strictEqual(d2.duplicate, true);
});

test('sweep 清过期 + 守上限', () => {
  let t = 1700000000000;
  const a = mk({ now: () => t });
  for (let i = 0; i < 60; i++) {
    a.decide({ request: 'q' + i, signals: { needsWeb: true, ambiguity: 0.95 } });
  }
  assert.ok(a.queue().length <= 60);
  const s1 = a.sweep();
  assert.ok(s1.after <= s1.cap, 'sweep 后不得超过上限');
  t += 8 * 86400000; /* 超过 7 天 TTL */
  const s2 = a.sweep();
  assert.strictEqual(s2.after, 0, '过期全部清掉');
});

test('没传 judge → verify 永远 UNVERIFIED，不假装验证过', async () => {
  const a = mk();
  const d = a.decide({ request: '查天气', signals: { needsWeb: true } });
  const v = await a.verify(d.id, []);
  assert.strictEqual(v.status, REASONS.UNVERIFIED);
});

test('接上 judge 才能拿到 verdict（与 agent-evidence 同形）', async () => {
  const fakeJudge = async () => ({ verdict: 'NOT_IN_USE', landed: 'true', effective: 'true', useful: 'false', reasons: [{ level: 'useful', code: 'NOT_CALLED' }] });
  const a = mk({ judge: fakeJudge });
  const d = a.decide({ request: '查天气', signals: { needsWeb: true } });
  const v = await a.verify(d.id, []);
  assert.strictEqual(v.status, REASONS.VERIFIED);
  assert.strictEqual(v.verdict, 'NOT_IN_USE');
});

test('replay 能还原完整决策链', () => {
  const a = mk();
  const d = a.decide({ request: '改个函数', signals: { needsCode: true } });
  const r = a.replay(d.id);
  assert.strictEqual(r.steps.length, 7);
  assert.deepStrictEqual(r.steps.map((x) => x.step), ['need', 'mode', 'executor', 'confidence', 'status', 'why', 'verify']);
});

test('空 request → 置信度计算不崩，且 why 里有歧义理由', () => {
  const a = mk();
  const d = a.decide({ request: '', signals: {} });
  assert.ok(Array.isArray(d.why));
  assert.ok(d.why.some((x) => x.code === REASONS.AMBIGUOUS_REQUEST));
});

test('成本相近时选更便宜的执行者；命中多的优先', () => {
  const a = arbiter({
    modes: { m1: { base: 0.95, capabilities: ['web', 'memory'] } },
    registry: {
      both: { id: 'bothOps', capabilities: ['web', 'memory'], cost: 3 },
      cheap: { id: 'webOnly', capabilities: ['web'], cost: 1 },
    },
    threshold: 0.5,
    now: () => 1700000000000,
  });
  const d = a.decide({ request: 'x', signals: { needsWeb: true, needsMemory: true } });
  assert.deepStrictEqual(d.executors, ['bothOps'], '一个执行者就覆盖全部需求时，不要拆成两个');
});
