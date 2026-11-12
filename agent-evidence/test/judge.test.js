'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { judge, report, REASONS, VERDICTS } = require('../src/judge');
const probes = require('../src/probes');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-'));
function mk(name, body) {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, body, 'utf8');
  return f;
}
const okc = (level, ok, extra) => ({ level, id: level + '-' + Math.random().toString(36).slice(2, 6), run: async () => Object.assign({ ok, observedAt: 1 }, extra || {}) });
const nul = (level, code, extra) => ({ level, id: level + '-null', run: async () => Object.assign({ ok: null, reason: code, observedAt: 1 }, extra || {}) });

test('三级全真 → WORKING', async () => {
  const r = await judge({ claim: 'x', now: 10, checks: [okc('landed', true), okc('effective', true), okc('useful', true)] });
  assert.strictEqual(r.verdict, VERDICTS.WORKING);
  assert.deepStrictEqual([r.landed, r.effective, r.useful], ['true', 'true', 'true']);
});

test('落了且加载了，但没人调用 → NOT_IN_USE（最值钱的结论）', async () => {
  const r = await judge({ claim: 'x', now: 10, checks: [okc('landed', true), okc('effective', true), okc('useful', false, { reason: REASONS.NOT_CALLED })] });
  assert.strictEqual(r.verdict, VERDICTS.NOT_IN_USE);
  assert.strictEqual(r.useful, 'false');
  assert.ok(r.reasons.some((x) => x.code === REASONS.NOT_CALLED));
});

test('落了没加载 → NOT_LOADED，且 useful 必须是 null 不是 false', async () => {
  const r = await judge({ claim: 'x', now: 10, checks: [okc('landed', true), okc('effective', false, { reason: REASONS.STALE_PROCESS }), okc('useful', false)] });
  assert.strictEqual(r.verdict, VERDICTS.NOT_LOADED);
  assert.strictEqual(r.useful, 'null');
  assert.ok(r.reasons.some((x) => x.code === REASONS.UPSTREAM_NOT_TRUE));
});

test('什么都没变 → NO_CHANGE，下游全 null', async () => {
  const r = await judge({ claim: 'x', now: 10, checks: [okc('landed', false, { reason: REASONS.NO_CHANGE }), okc('effective', true), okc('useful', true)] });
  assert.strictEqual(r.verdict, VERDICTS.NO_CHANGE);
  assert.deepStrictEqual([r.landed, r.effective, r.useful], ['false', 'null', 'null']);
});

test('零样本却判通过 → 降级 null + NO_DATA（放水拦截）', async () => {
  const r = await judge({ claim: 'x', now: 10, checks: [okc('landed', true), okc('effective', true), okc('useful', true, { n: 0 })] });
  assert.strictEqual(r.useful, 'null');
  assert.strictEqual(r.verdict, VERDICTS.UNKNOWN);
  assert.ok(r.reasons.some((x) => x.code === REASONS.NO_DATA));
});

test('0 样本的否定结论合法，不被降级', async () => {
  const r = await judge({ claim: 'x', now: 10, checks: [okc('landed', true), okc('effective', true), okc('useful', false, { n: 0, reason: REASONS.NOT_CALLED })] });
  assert.strictEqual(r.useful, 'false');
  assert.strictEqual(r.verdict, VERDICTS.NOT_IN_USE);
});

test('样本 < 3 的肯定结论标 LOW_SAMPLE', async () => {
  const r = await judge({ claim: 'x', now: 10, checks: [okc('landed', true), okc('effective', true), okc('useful', true, { n: 1 })] });
  assert.strictEqual(r.useful, 'true');
  assert.ok(r.reasons.some((x) => x.code === REASONS.LOW_SAMPLE));
});

test('超出容差窗口的证据 → UNJUDGEABLE', async () => {
  const r = await judge({ claim: 'x', now: 1000, checks: [okc('landed', true), okc('effective', true), okc('useful', true, { observedAt: 1000 + 10 * 60e3 })] });
  assert.strictEqual(r.useful, 'null');
  assert.ok(r.reasons.some((x) => x.code === REASONS.UNJUDGEABLE));
});

test('探针抛错 → CHECK_THREW，不崩', async () => {
  const boom = { level: 'useful', id: 'boom', run: async () => { throw new Error('io'); } };
  const r = await judge({ claim: 'x', now: 10, checks: [okc('landed', true), okc('effective', true), boom] });
  assert.strictEqual(r.useful, 'null');
  assert.ok(r.reasons.some((x) => x.code === REASONS.CHECK_THREW));
});

test('fileLanded 用 sha1 判变化，不受 mtime 欺骗', async () => {
  const f = mk('a.js', 'v1');
  const before = await probes.fileLanded({ file: f, since: Date.now() + 60000 }).run();
  assert.strictEqual(before.ok, false);

  const old = Date.now() - 3600e3;
  fs.writeFileSync(f, 'v2', 'utf8');
  fs.utimesSync(f, old / 1000, old / 1000); /* 把 mtime 倒回去：cp -p 的真实行为 */
  const after = await probes.fileLanded({ file: f, since: Date.now() - 60e3, expectSha: probes.sha1(Buffer.from('v2')) }).run();
  assert.strictEqual(after.ok, true, 'mtime 被倒回去了，但 sha1 对上了');
});

test('processLoaded：进程比文件旧 → STALE_PROCESS', async () => {
  const f = mk('b.js', 'x');
  const st = fs.statSync(f);
  const p = await probes.processLoaded({ file: f, startedAt: st.mtimeMs - 5000 }).run();
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, REASONS.STALE_PROCESS);
});

test('processLoaded：没有启动时刻 → null（不猜）', async () => {
  const f = mk('c.js', 'x');
  const p = await probes.processLoaded({ file: f }).run();
  assert.strictEqual(p.ok, null);
});

test('calledFrom：定义了没接线 → NOT_CALLED', async () => {
  const caller = mk('main.js', 'const cacheLayer = require("./x");\n// cacheLayer(1)\n');
  const p = await probes.calledFrom({ symbol: 'cacheLayer', callers: [caller] }).run();
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, REASONS.NOT_CALLED);
});

test('calledFrom：有调用点 → 真', async () => {
  const caller = mk('main2.js', 'cacheLayer(a);\ncacheLayer(b);\n');
  const p = await probes.calledFrom({ symbol: 'cacheLayer', callers: [caller] }).run();
  assert.strictEqual(p.ok, true);
});

test('ledgerHasProduct：只有心跳字段的账本 → NO_PRODUCT', async () => {
  const f = mk('heartbeat.jsonl', '{"ts":1,"totalEntries":20,"level":"OK"}\n{"ts":2,"totalEntries":20,"level":"OK"}\n');
  const p = await probes.ledgerHasProduct({ file: f }).run();
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, REASONS.NO_PRODUCT);
});

test('ledgerHasProduct：有产物字段 → 真', async () => {
  const f = mk('product.jsonl', '{"ts":1,"product":"sha1:abc","consumedBy":"src/main.js"}\n');
  const p = await probes.ledgerHasProduct({ file: f }).run();
  assert.strictEqual(p.ok, true);
});

test('report 把 null 打成 ? 而不是 ✓', () => {
  const txt = report({ claim: 'x', verdict: 'UNKNOWN', landed: 'true', effective: 'null', useful: 'null', reasons: [{ level: 'effective', code: 'NO_START_TIME' }] });
  assert.ok(txt.includes('?'));
  assert.ok(!/effective\s+✓/.test(txt));
});

test('空 checks → UNKNOWN 而不是 WORKING', async () => {
  const r = await judge({ claim: 'x', checks: [] });
  assert.strictEqual(r.verdict, VERDICTS.UNKNOWN);
  assert.deepStrictEqual([r.landed, r.effective, r.useful], ['null', 'null', 'null']);
});


test('calledFrom：只有定义没有调用 → NOT_CALLED', async () => {
  const caller = mk('def.js', 'function cacheLayer(x) { return x; }\nmodule.exports = cacheLayer;\n');
  const p = await probes.calledFrom({ symbol: 'cacheLayer', callers: [caller] }).run();
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, REASONS.NOT_CALLED);
});

test('calledFrom：块注释里的调用不算', async () => {
  const caller = mk('blk.js', '/* cacheLayer(1); */\nconst a = 1;\n');
  const p = await probes.calledFrom({ symbol: 'cacheLayer', callers: [caller] }).run();
  assert.strictEqual(p.ok, false);
});


test('被上游继承覆盖的层级不保留自己的理由码（理由卫生）', async () => {
  const r = await judge({ claim: 'x', now: 10, checks: [okc('landed', true), okc('useful', false, { reason: REASONS.NOT_CALLED })] });
  assert.strictEqual(r.useful, 'null');
  assert.ok(!r.reasons.some((x) => x.level === 'useful' && x.code === REASONS.NOT_CALLED), '不能既说没调用又说没查');
  assert.ok(r.reasons.some((x) => x.level === 'useful' && x.code === REASONS.UPSTREAM_NOT_TRUE));
});


test('缺某一级探针 → 记 NO_CHECK，不静默', async () => {
  const r = await judge({ claim: 'x', now: 10, checks: [okc('landed', true), okc('useful', false)] });
  assert.ok(r.reasons.some((x) => x.level === 'effective' && x.code === REASONS.NO_CHECK));
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
