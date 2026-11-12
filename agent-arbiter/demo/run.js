'use strict';
/**
 * demo · 四个场景，全部来自绘心的模式矩阵 / 置信门槛 / 路由账本
 *
 *   node demo/run.js
 *
 * 场景一：需求明确        → DECIDED（模式、执行者集合、置信度、理由全落）
 * 场景二：需求模糊        → DEFERRED 入队（宁可排队，不硬答）
 * 场景三：高风险 + 想降档  → DEFERRED（风险不许被降档绕过）
 * 场景四：决策回放 + 接证据 → replay 全链 + agent-evidence 判三级
 */

const path = require('path');
const { arbiter, REASONS } = require('../src/arbiter');

/* 模式矩阵：同一请求在不同模式下，能力域、准入门槛、基线都不同 */
const MODES = {
  quick: { base: 0.80, minConfidence: 0.50, capabilities: ['web', 'calc'] },
  standard: { base: 0.88, minConfidence: 0.65, capabilities: ['web', 'calc', 'memory'] },
  deep: { base: 0.92, minConfidence: 0.75, capabilities: ['web', 'calc', 'memory', 'code'] },
  careful: { base: 0.95, minConfidence: 0.90, capabilities: ['web', 'calc', 'memory', 'code', 'human'] },
};

const REGISTRY = {
  web: { id: 'webSearch', capabilities: ['web'], cost: 1 },
  calc: { id: 'calculator', capabilities: ['calc'], cost: 1 },
  memory: { id: 'vectorMemory', capabilities: ['memory'], cost: 2 },
  code: { id: 'sandbox', capabilities: ['code'], cost: 5 },
  human: { id: 'escalateToHuman', capabilities: ['human'], cost: 10 },
};

function show(title, d) {
  console.log('\n── ' + title);
  console.log('  status      ' + d.status);
  console.log('  mode        ' + (d.mode || '—') + (d.modeThreshold ? '（门槛 ' + d.modeThreshold + '）' : ''));
  console.log('  executors   ' + (d.executors.length ? d.executors.join(' → ') : '—') + (d.cost ? '  成本 ' + d.cost : ''));
  console.log('  confidence  ' + d.confidence);
  console.log('  why         ' + d.why.map((x) => x.code).join('  '));
}

const a = arbiter({ modes: MODES, registry: REGISTRY, threshold: 0.6, ttlDays: 7, cap: 20 });

console.log('════════ 行为统筹：先决定"谁来做、怎么做、够不够格"，再谈执行 ════════');

show('场景一 · 需求明确：改代码 + 查记忆', a.decide({
  request: '把这个函数改成 async，并参考我之前的写法',
  signals: { needsCode: true, needsMemory: true },
}));

show('场景二 · 需求模糊：那句"那个东西弄一下"', a.decide({
  request: '那个东西弄一下',
  signals: { needsWeb: true, ambiguity: 0.85 },
}));

show('场景三 · 高风险只够得上低档 → 拒绝，不许降档', a.decide({
  request: '删库重建（只联网查了下流程）',
  signals: { needsWeb: true, risk: 0.6 },
}));

show('场景四 · 高风险但门槛够：同一件事', a.decide({
  request: '删库重建（已备份、已双人确认）',
  signals: { needsCode: true, needsHuman: true, risk: 0.1 },
}));

console.log('\n── 队列（模糊与高风险都在这，不会假装有答案）');
console.log('  队列长度 ' + a.queue().length + ' · sweep 结果 ' + JSON.stringify(a.sweep()));

/* 决策回放：一个决策从"为什么这么做"到"到底有没有用" */
const d = a.decide({ request: '给缓存层接线', signals: { needsCode: true } });
const rp = a.replay(d.id);
console.log('\n── 回放 ' + rp.id);
for (const s of rp.steps) console.log('   ' + s.step.padEnd(11) + JSON.stringify(s.value));

/* 接 agent-evidence 的三级判定：编排器说自己做完了，证据说有没有人用 */
let ev = null;
try { ev = require(path.join(__dirname, '..', '..', 'agent-evidence', 'src', 'judge')); } catch (e) { /* 未安装则跳过 */ }
if (ev) {
  const fakeJudge = async () => ({ verdict: 'NOT_IN_USE', landed: 'true', effective: 'true', useful: 'false', reasons: [{ level: 'useful', code: 'NOT_CALLED' }] });
  const a2 = arbiter({ modes: MODES, registry: REGISTRY, threshold: 0.6, judge: fakeJudge });
  const d2 = a2.decide({ request: '给缓存层接线', signals: { needsCode: true } });
  a2.verify(d2.id, []).then((v) => {
    console.log('\n── 接上 agent-evidence 之后');
    console.log('   decision  ' + d2.status);
    console.log('   evidence  ' + v.verdict + '（landed=' + v.landed + ' effective=' + v.effective + ' useful=' + v.useful + '）');
    console.log('   结论：编排器说"已完成"，证据说"没人调用"。两个都留下，才叫可追责。\n');
  });
} else {
  console.log('\n（未找到 agent-evidence，跳过联合演示）\n');
}
