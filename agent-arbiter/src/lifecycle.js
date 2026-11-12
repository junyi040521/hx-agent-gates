'use strict';
/**
 * 任务生命周期与交接契约
 *
 * 设计来源：junyi 专家包的 agent-team-orchestration 技能（不是抄代码，是对齐判据）：
 *   · 状态机 Inbox → Assigned → In Progress → Review → Done | Failed
 *   · 三条硬规矩：① 编排者拥有状态迁移权，不指望执行者自报
 *                 ② 每次迁移必须带注释（谁 · 做了什么 · 为什么）
 *                 ③ Failed 是合法终态，不是事故
 *   · 交接五要素：做了什么 / 产物在哪 / 怎么验 / 已知问题 / 下一步
 *
 * 为什么 arbiter 需要它：决策只回答「谁来做、够不够格」，回答不了
 * 「这件事现在到哪一步了、上一次为什么退回来」。没有状态机，defer 会变成
 * 一句道歉；有了状态机，defer 是一次可回放的迁移。
 *
 * 三条自我约束（与 arbiter 主模块一致）：
 *   · 不抛异常：校验失败返回 {ok:false, code, missing}，让调用方决定怎么办
 *   · 不修改入参：move 返回新对象，被拒时原记录一字不动
 *   · 不写盘：账本由调用方持有，本模块只在内存里算
 */

const STATES = ['inbox', 'assigned', 'in_progress', 'review', 'done', 'failed'];

/** 合法迁移表：写在表里就是允许，不在表里就是不允许，没有隐式特例。 */
const LEGAL = {
  inbox: ['assigned', 'failed'],
  assigned: ['in_progress', 'inbox'],
  in_progress: ['review', 'failed'],
  review: ['done', 'in_progress', 'failed'],
  done: [],
  failed: ['inbox'],
};

const CODES = {
  LEGAL: 'LEGAL',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  THIN_COMMENT: 'THIN_COMMENT',
  THIN_HANDOFF: 'THIN_HANDOFF',
  UNVERIFIED: 'UNVERIFIED',
  BAD_STATE: 'BAD_STATE',
};

/** 交接五要素：少一项就不叫交接，叫「做完了，你自己找」。 */
const HANDOFF_FIELDS = ['done', 'artifacts', 'verify', 'issues', 'next'];

function _s(v) { return typeof v === 'string' ? v.trim() : ''; }

/**
 * 迁移是否合法（只查状态机，不查注释）
 * @returns {{ok:boolean, code:string, allowed:string[]}}
 */
function can(from, to) {
  if (STATES.indexOf(from) < 0) return { ok: false, code: CODES.BAD_STATE, allowed: [] };
  if (STATES.indexOf(to) < 0) return { ok: false, code: CODES.BAD_STATE, allowed: [] };
  const allowed = LEGAL[from] || [];
  return { ok: allowed.indexOf(to) >= 0, code: allowed.indexOf(to) >= 0 ? CODES.LEGAL : CODES.ILLEGAL_TRANSITION, allowed: allowed.slice() };
}

/**
 * 交接单校验。五要素缺任一项就返回缺哪几项。
 * @param {object} fields
 * @returns {{ok:boolean, code:string, missing:string[]}}
 */
function handoff(fields) {
  const f = fields || {};
  const missing = HANDOFF_FIELDS.filter(function (k) { return !_s(f[k]); });
  return { ok: missing.length === 0, code: missing.length ? CODES.THIN_HANDOFF : CODES.LEGAL, missing: missing };
}

/**
 * 执行一次迁移。返回新记录，原记录不动。
 *
 * @param {object} rec     {id, state, comments:[], handoff?, verify?}
 * @param {string} to      目标状态
 * @param {object} comment {by, what, why}  三个字段都必填
 * @param {{handoff?:object, verify?:string}} [extra]
 * @returns {{ok:boolean, code:string, record:object, missing?:string[], allowed?:string[]}}
 */
function move(rec, to, comment, extra) {
  const r = rec || {};
  const e = extra || {};
  const from = r.state;

  const t = can(from, to);
  if (!t.ok) {
    return { ok: false, code: t.code, record: r, allowed: t.allowed };
  }

  /* 规矩②：迁移必须带注释。空注释、只写「已完成」都算薄注释——
     判据不是「有没有说话」，是「三件事说全没有」。 */
  const c = comment || {};
  const thin = ['by', 'what', 'why'].filter(function (k) { return !_s(c[k]); });
  if (thin.length) {
    return { ok: false, code: CODES.THIN_COMMENT, record: r, missing: thin, allowed: t.allowed };
  }

  /* 进 done 是唯一有附加条件的迁移：必须交得出手，且必须验过。
     这两条对应 arbiter 的 verify 字段与交付契约的「生效」行。 */
  if (to === 'done') {
    const h = handoff(e.handoff || r.handoff);
    if (!h.ok) return { ok: false, code: CODES.THIN_HANDOFF, record: r, missing: h.missing };
    const v = _s(e.verify || r.verify);
    if (!v || v.toUpperCase() === 'UNVERIFIED') {
      return { ok: false, code: CODES.UNVERIFIED, record: r, missing: ['verify'] };
    }
  }

  const next = Object.assign({}, r, {
    state: to,
    handoff: to === 'done' ? Object.assign({}, e.handoff || r.handoff) : r.handoff,
    verify: _s(e.verify) || r.verify || null,
    comments: (r.comments || []).concat([{
      at: Number(e.at || (r.comments || []).length),
      from: from, to: to,
      by: _s(c.by), what: _s(c.what), why: _s(c.why),
    }]),
  });
  return { ok: true, code: CODES.LEGAL, record: next };
}

/** 一条记录走过哪些状态（给 replay 用，纯读） */
function trail(rec) {
  const r = rec || {};
  const out = [r.state];
  const cs = (r.comments || []).slice().reverse();
  for (const c of cs) out.unshift(c.from);
  return out;
}

/**
 * 把一次决策落成一条任务。这是 arbiter 与 lifecycle 的接缝：
 *   DECIDED  ⇒ assigned（有人接、有执行者）
 *   DEFERRED ⇒ inbox   （排队等条件，不是失败）
 * 为什么不是「都是 inbox」：决策已定的任务再排一次队，等于把做过的判断作废。
 *
 * @param {object} d decide() 的返回记录
 * @returns {{ok:boolean, code:string, record?:object}}
 */
function toTask(d) {
  const dec = d || {};
  if (!dec.id) return { ok: false, code: 'NO_ID' };
  if (dec.status !== 'DECIDED' && dec.status !== 'DEFERRED') {
    return { ok: false, code: 'BAD_DECISION' };
  }
  const codes = (dec.why || []).map(function (w) { return w && w.code; }).filter(Boolean);
  if (!codes.length) return { ok: false, code: 'MISSING_WHY' };

  const decided = dec.status === 'DECIDED';
  return {
    ok: true,
    code: 'TASK',
    record: {
      id: dec.id,
      state: decided ? 'assigned' : 'inbox',
      executors: dec.executors || [],
      mode: dec.mode || null,
      confidence: dec.confidence,
      handoff: null,
      verify: null,
      comments: [{
        at: 0,
        from: null,
        to: decided ? 'assigned' : 'inbox',
        by: 'arbiter',
        what: decided ? '决策 ' + dec.mode + ' 档，执行者 ' + (dec.executors || []).join(',') : '决策未定，入队等待条件',
        /* 理由必须是码，不是自然语言：否则这条注释无法聚合统计 */
        why: codes.join(','),
      }],
    },
  };
}

module.exports = { STATES, LEGAL, CODES, HANDOFF_FIELDS, can, handoff, move, trail, toTask };
