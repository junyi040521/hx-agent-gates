'use strict';
/**
 * agent-arbiter · 行为统筹决策编排器
 *
 * 和 LangGraph / CrewAI 那一类不同：**它不执行任何东西**。
 * 它只回答四个问题，并保证这四个答案事后都能被追问：
 *
 *   1. 谁来做     —— executor（能力 → 执行者）
 *   2. 怎么做     —— mode（同一请求在不同模式下能力域不同）
 *   3. 够不够格   —— confidence vs 门槛；不够就 deferred，绝不硬答
 *   4. 凭什么     —— why[] + verify() 接 agent-evidence 的三级判定
 *
 * 第 3、4 条是这个库的全部价值。市面上的编排器都擅长"调度"，没有几个敢"拒绝调度"，
 * 更几乎没有人为每个调度留凭据。
 *
 * 三条不变式（写进测试，不可绕过）：
 *   · 置信度不足 ⇒ deferred。宁可进队列，不给一个看起来完成的答案。
 *   · 每个决策必须有 why[]。空 why 的决策等于没解释，直接拒绝生成。
 *   · 未 verify 的决策只能是 'decided'，永远不能自称 'WORKING'。
 */

const REASONS = {
  DECIDED: 'DECIDED',
  DEFERRED: 'DEFERRED',
  NO_MODE: 'NO_MODE',
  NO_EXECUTOR: 'NO_EXECUTOR',
  CONFIDENCE_BELOW_THRESHOLD: 'CONFIDENCE_BELOW_THRESHOLD',
  CONFIDENCE_BELOW_MODE: 'CONFIDENCE_BELOW_MODE',
  AMBIGUOUS_REQUEST: 'AMBIGUOUS_REQUEST',
  HIGH_RISK: 'HIGH_RISK',
  DUPLICATE_DEFERRED: 'DUPLICATE_DEFERRED',
  EXPIRED: 'EXPIRED',
  UNVERIFIED: 'UNVERIFIED',
  VERIFIED: 'VERIFIED',
  MISSING_WHY: 'MISSING_WHY',
};

/** 需求信号 → 需要的能力。只认需求信号，不认字数/词表 —— 那两种判据必然误判。 */
const NEED_KEYS = ['needsCode', 'needsWeb', 'needsMemory', 'needsTool', 'needsHuman'];

function hash(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function arbiter(opts) {
  const o = opts || {};
  const modes = o.modes || {};
  const registry = o.registry || {};
  const threshold = Number(o.threshold != null ? o.threshold : 0.6);
  const ttlMs = Number(o.ttlDays != null ? o.ttlDays : 7) * 86400000;
  const cap = Number(o.cap != null ? o.cap : 50);
  const judge = typeof o.judge === 'function' ? o.judge : null;
  const now = typeof o.now === 'function' ? o.now : () => Date.now();

  const decisions = new Map();
  let queue = [];
  let seq = 0;

  function needed(signals) {
    const out = [];
    for (const k of NEED_KEYS) if (signals && signals[k]) out.push(k.replace(/^needs/, '').toLowerCase());
    return out;
  }

  /** 覆盖所需能力的全部模式（不排序，排序在 decide 里按"资格"做） */
  function candidates(need) {
    const out = [];
    for (const name of Object.keys(modes)) {
      const m = modes[name] || {};
      const caps = (m.capabilities || []).map((x) => String(x).toLowerCase());
      const missing = need.filter((n) => caps.indexOf(n) < 0);
      if (missing.length) continue;
      out.push({
        name,
        base: Number(m.base != null ? m.base : 0.9),
        minConfidence: Number(m.minConfidence != null ? m.minConfidence : threshold),
        missing,
      });
    }
    return out;
  }

  /**
   * 一个决策往往需要不止一个执行者（联网 + 跑代码 + 查记忆）。
   * 贪婪覆盖：每轮选"能覆盖剩余需求最多"的执行者，同覆盖数取便宜的。
   * 覆盖不了的部分返回 uncovered —— 由调用方决定是补注册还是 defer，绝不假装覆盖了。
   */
  function planExecutors(need) {
    const left = need.slice();
    const picked = [];
    let cost = 0;
    while (left.length) {
      let best = null;
      for (const name of Object.keys(registry)) {
        const r = registry[name] || {};
        const caps = (r.capabilities || [name]).map((x) => String(x).toLowerCase());
        const hit = left.filter((n) => caps.indexOf(n) >= 0).length;
        if (!hit) continue;
        const c = Number(r.cost != null ? r.cost : 1);
        if (!best || hit > best.hit || (hit === best.hit && c < best.cost)) best = { name, id: r.id || name, hit, cost: c, caps };
      }
      if (!best) return { picked, uncovered: left.slice(), cost };
      picked.push(best.id);
      cost += best.cost;
      for (const n of best.caps) { const i = left.indexOf(n); if (i >= 0) left.splice(i, 1); }
    }
    return { picked, uncovered: [], cost };
  }

  /** 置信度 = 模式基线 − 歧义惩罚 − 风险惩罚 − 能力缺口惩罚。全部可解释，不是魔法权重。 */
  function score(mode, signals) {
    const amb = Math.min(1, Math.max(0, Number((signals && signals.ambiguity) || 0)));
    const risk = Math.min(1, Math.max(0, Number((signals && signals.risk) || 0)));
    const gap = mode && mode.missing ? mode.missing.length : 0;
    const c = (mode ? mode.base : 0) - amb * 0.4 - risk * 0.3 - gap * 0.3;
    return Math.round(Math.max(0, Math.min(1, c)) * 100) / 100;
  }

  /** 高风险不许靠降档绕过：要求候选模式的准入门槛本身足够高 */
  const HIGH_RISK_BAR = 0.85;
  const HIGH_RISK_AT = 0.3;

  function decide(input) {
    const req = String((input && input.request) || '');
    const signals = (input && input.signals) || {};
    const need = needed(signals);
    const why = [];
    const id = 'd' + (++seq) + '-' + hash(req);

    if (!req) { why.push({ code: REASONS.AMBIGUOUS_REQUEST, note: 'request 为空' }); }
    if (need.length) why.push({ code: 'NEED', note: need.join(',') });

    /* 有资格的模式 = 置信度过全局门槛 且 过该模式自己的门槛；其中取"门槛最高"的那个。
       优先够用的最低档；高风险信号会强制升档（见下面 HIGH_RISK_BAR）。 */
    const cands = candidates(need);
    const scored = cands.map((c) => Object.assign({}, c, { confidence: score(c, signals) }));
    const riskVal = Math.min(1, Math.max(0, Number(signals.risk || 0)));
    let pass = scored.filter((c) => c.confidence >= threshold && c.confidence >= c.minConfidence);
    if (riskVal >= HIGH_RISK_AT) {
      const before = pass.length;
      pass = pass.filter((c) => c.minConfidence >= HIGH_RISK_BAR);
      if (before && !pass.length) why.push({ code: REASONS.HIGH_RISK, note: '风险 ' + riskVal + ' ≥ ' + HIGH_RISK_AT + '，档位门槛须 ≥ ' + HIGH_RISK_BAR + '；不允许降档绕过' });
    }
    /* 够用就好：在合格档里取门槛最低的那个（省成本、少打扰）；升档靠风险信号驱动。
       选最严会让所有请求都落到 careful —— 那是过度保守，不是安全。 */
    pass.sort((a, b) => (a.minConfidence - b.minConfidence) || (b.confidence - a.confidence));
    const m = pass[0] || null;
    const conf = m ? m.confidence : (scored.length ? Math.max.apply(null, scored.map((c) => c.confidence)) : 0);

    if (!m) {
      if (!scored.length) why.push({ code: REASONS.NO_MODE, note: '没有任何模式覆盖所需能力：' + need.join(',') });
      else {
        const best = scored.slice().sort((a, b) => b.confidence - a.confidence)[0];
        const code = best.confidence < threshold ? REASONS.CONFIDENCE_BELOW_THRESHOLD : REASONS.CONFIDENCE_BELOW_MODE;
        why.push({ code, note: '最好的候选是 ' + best.name + '（' + best.confidence + ' vs 门槛 ' + Math.max(threshold, best.minConfidence) + '）' });
      }
    }

    const plan = planExecutors(need);
    if (need.length && plan.uncovered.length) why.push({ code: REASONS.NO_EXECUTOR, note: '注册表里没有能承担 ' + plan.uncovered.join(',') + ' 的执行者' });
    if (plan.cost) why.push({ code: 'COST', note: '预计成本 ' + plan.cost });

    let status = REASONS.DECIDED;
    if (!m) status = REASONS.DEFERRED;
    else if (need.length && plan.uncovered.length) status = REASONS.DEFERRED;
    else if (!plan.picked.length && need.length) { status = REASONS.DEFERRED; why.push({ code: REASONS.NO_EXECUTOR, note: '无执行者' }); }

    const rec = {
      id,
      request: req,
      status,
      mode: m ? m.name : null,
      modeThreshold: m ? m.minConfidence : null,
      executor: plan.picked[0] || null,
      executors: plan.picked,
      uncovered: plan.uncovered,
      cost: plan.cost,
      confidence: conf,
      why,
      need,
      deferredAt: null,
      verify: null,
      at: now(),
    };

    if (status === REASONS.DEFERRED) {
      const dup = queue.some((q) => q.request === req);
      if (dup) { why.push({ code: REASONS.DUPLICATE_DEFERRED, note: '同一请求已在队列，不重复入队' }); rec.duplicate = true; }
      else { rec.deferredAt = rec.at; queue.push(rec); }
    }
    decisions.set(id, rec);
    return rec;
  }

  /** 队列维护：过期清理 + 去重 + 上限。对应"提案积压就加预算制"那条纪律。 */
  function sweep() {
    const t = now();
    const before = queue.length;
    const seen = new Set();
    queue = queue.filter((q) => {
      if (t - (q.deferredAt || q.at) > ttlMs) return false;
      if (seen.has(q.request)) return false;
      seen.add(q.request);
      return true;
    });
    while (queue.length > cap) { const drop = queue.shift(); if (drop) drop.expiredInSweep = true; }
    return { before, after: queue.length, cap, ttlDays: Math.round(ttlMs / 86400000) };
  }

  /**
   * 接 agent-evidence 的三级判定。没传 judge 就永远返回 UNVERIFIED ——
   * 不给"看起来验证过"的假象。
   */
  async function verify(id, checks) {
    const rec = decisions.get(id);
    if (!rec) return { id, status: 'UNKNOWN', reason: 'NO_SUCH_DECISION' };
    if (!judge) { rec.verify = { status: REASONS.UNVERIFIED }; return rec.verify; }
    const r = await judge({ claim: rec.request, checks: checks || [] });
    rec.verify = { status: REASONS.VERIFIED, verdict: r.verdict, landed: r.landed, effective: r.effective, useful: r.useful, reasons: r.reasons };
    return rec.verify;
  }

  /** 决策回放：一个决策从"为什么这么做"到"到底有没有用"的完整链。 */
  function replay(id) {
    const rec = decisions.get(id);
    if (!rec) return null;
    return {
      id: rec.id,
      request: rec.request,
      steps: [
        { step: 'need', value: rec.need },
        { step: 'mode', value: rec.mode },
        { step: 'executor', value: rec.executor },
        { step: 'confidence', value: rec.confidence },
        { step: 'status', value: rec.status },
        { step: 'why', value: rec.why },
        { step: 'verify', value: rec.verify },
      ],
    };
  }

  return {
    decide,
    sweep,
    verify,
    replay,
    queue: () => queue.slice(),
    decisions: () => Array.from(decisions.values()),
    status: () => ({ modes: Object.keys(modes).length, executors: Object.keys(registry).length, threshold, queue: queue.length, decisions: decisions.size }),
  };
}

module.exports = { arbiter, REASONS, NEED_KEYS, hash };
