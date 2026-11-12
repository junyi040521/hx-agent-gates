'use strict';
/**
 * agent-evidence · 三级判定核心
 *
 * 一切「AI 改好了」的声明都拆成三个互不蕴含的问题：
 *   landed    产物真的变了？        （内容/账本层面）
 *   effective 系统真的加载了？      （进程/注册表层面）
 *   useful    业务路径真的调用了？  （调用点 + 非零结果）
 *
 * 三条不可让步的规矩，也是这个库存在的理由：
 *   1. 链断不猜 —— 上游不是 true，下游一律 null，绝不给 false 来假装"查过了"
 *   2. 无样本不给结论 —— 0 条 ⇒ NO_DATA；样本 < 3 ⇒ LOW_SAMPLE（标注不可用于决策）
 *   3. 事后观测不可判 —— 证据采集时刻晚于结论时刻 ⇒ UNJUDGEABLE
 *
 * 大多数"验证工具"在这三条上放水，于是它们永远给出一个漂亮的绿色，
 * 而那个绿色是拿"我没查"换来的。这里宁可给你 null。
 */

const LEVELS = ['landed', 'effective', 'useful'];

/** 机器可读的理由码。不要用自然语言当理由——那没法被程序消费，也没法聚合。 */
const REASONS = {
  EVIDENCE_OK: 'EVIDENCE_OK',
  NO_CHANGE: 'NO_CHANGE',
  STALE_PROCESS: 'STALE_PROCESS',
  NOT_CALLED: 'NOT_CALLED',
  NO_PRODUCT: 'NO_PRODUCT',
  NO_DATA: 'NO_DATA',
  NO_CHECK: 'NO_CHECK',
  LOW_SAMPLE: 'LOW_SAMPLE',
  UNJUDGEABLE: 'UNJUDGEABLE',
  UPSTREAM_NOT_TRUE: 'UPSTREAM_NOT_TRUE',
  CHECK_THREW: 'CHECK_THREW',
  MIN_SAMPLE: 'MIN_SAMPLE',
};

const MIN_SAMPLE = 3;

const VERDICTS = {
  WORKING: 'WORKING',            // true / true / true
  NOT_IN_USE: 'NOT_IN_USE',      // true / true / false   ← 最值钱的结论
  NOT_LOADED: 'NOT_LOADED',      // true / false / null
  NO_CHANGE: 'NO_CHANGE',        // false / null / null
  UNKNOWN: 'UNKNOWN',            // 任一环断
};

function tri(v) {
  if (v === true) return 'true';
  if (v === false) return 'false';
  return 'null';
}

/**
 * @typedef {Object} Check
 * @property {'landed'|'effective'|'useful'} level
 * @property {string} id           人类可读的探针标识
 * @property {()=>Promise<{ok:boolean|null, reason?:string, n?:number, observedAt?:number, evidence?:any}>} run
 */

/**
 * 执行一组探针并归并成三级判定。
 * @param {{claim?:string, checks:Check[], now?:number, minSample?:number}} input
 */
async function judge(input) {
  const claim = String((input && input.claim) || '');
  const checks = Array.isArray(input && input.checks) ? input.checks : [];
  const now = Number((input && input.now) || Date.now());
  const minSample = Number((input && input.minSample) || MIN_SAMPLE);
  /* 事后补证的容差：同一轮采集必然晚于 now 几毫秒，这是正常时序，不能判 UNJUDGEABLE；
     只有超出窗口（默认 5 分钟）才认定为"先下结论、后补证据"。要严格模式传 0。 */
  const tol = Number((input && input.posthocToleranceMs) >= 0 ? input.posthocToleranceMs : 300000);

  const byLevel = {};
  const evidence = {};
  const reasons = [];

  for (const c of checks) {
    const level = c && c.level;
    if (!LEVELS.includes(level)) { reasons.push({ level: 'unknown', id: (c && c.id) || '?', code: 'BAD_LEVEL' }); continue; }
    if (!byLevel[level]) byLevel[level] = [];
    let r;
    try {
      r = await c.run();
    } catch (e) {
      r = { ok: null, reason: REASONS.CHECK_THREW, evidence: { error: String((e && e.message) || e) } };
    }
    r = r || { ok: null, reason: REASONS.NO_DATA };

    /* 规矩 3：证据时刻超出结论时刻的容差窗口 ⇒ 这是事后补的证据，不具备判定资格 */
    if (r.observedAt && Number(r.observedAt) > now + tol) {
      r = { ok: null, reason: REASONS.UNJUDGEABLE, evidence: { observedAt: r.observedAt, now, tol } };
    }
    /* 规矩 2：样本不足不许给**肯定**结论。
       注意边界：0 样本下的否定结论是合法的（"扫了 0 个调用点"本身就是结论），
       真正要拦的是「零样本还判通过」—— 那才是放水。 */
    if (r.ok === true && typeof r.n === 'number') {
      if (r.n === 0) r = { ok: null, reason: REASONS.NO_DATA, evidence: r.evidence };
      else if (r.n < minSample) {
        r.lowSample = true;
        r.reason = r.reason || REASONS.LOW_SAMPLE;
      }
    }
    byLevel[level].push({ id: c.id || level, ok: r.ok, code: r.reason || (r.ok === true ? REASONS.EVIDENCE_OK : r.reason), lowSample: !!r.lowSample, evidence: r.evidence });
  }

  /* 每一级：任一探针 false ⇒ false；没有任何 true 且全 null ⇒ null；全 true ⇒ true */
  const levelResult = {};
  for (const lv of LEVELS) {
    const list = byLevel[lv] || [];
    if (!list.length) {
      levelResult[lv] = { value: null, code: REASONS.NO_CHECK, probes: [] };
      reasons.push({ level: lv, code: REASONS.NO_CHECK });
      continue;
    }
    let value;
    if (list.some((p) => p.ok === false)) value = false;
    else if (list.every((p) => p.ok === null)) value = null;
    else value = true;
    const code = value === true ? REASONS.EVIDENCE_OK
      : value === false ? (list.find((p) => p.ok === false) || {}).code || 'FALSE'
        : (list.find((p) => p.ok === null) || {}).code || REASONS.NO_DATA;
    levelResult[lv] = { value, code, probes: list };
    evidence[lv] = list;
    if (value !== true) reasons.push({ level: lv, code });
    if (list.some((p) => p.lowSample)) reasons.push({ level: lv, code: REASONS.LOW_SAMPLE });
  }

  /* 规矩 1：链断不猜。上游不是 true，下游强制 null（并把理由记成继承，不冒充独立结论） */
  let broke = false;
  for (const lv of LEVELS) {
    if (broke && levelResult[lv].value !== null) {
      levelResult[lv] = { value: null, code: REASONS.UPSTREAM_NOT_TRUE, probes: levelResult[lv].probes, inherited: true };
      reasons.push({ level: lv, code: REASONS.UPSTREAM_NOT_TRUE });
    }
    if (levelResult[lv].value !== true) broke = true;
  }

  const L = levelResult.landed.value, E = levelResult.effective.value, U = levelResult.useful.value;
  /* 理由卫生：已被上游继承覆盖的层级，不再保留它自己的理由码 ——
     否则报告里会同时出现 "useful:NOT_CALLED" 和 "useful:UPSTREAM_NOT_TRUE"，
     让人以为真去查了调用点（其实没查到能判的程度）。 */
  const inheritedLevels = new Set(LEVELS.filter(function (lv) { return levelResult[lv].inherited; }));
  const cleanReasons = dedupe(reasons).filter(function (x) {
    return !(inheritedLevels.has(x.level) && x.code !== REASONS.UPSTREAM_NOT_TRUE);
  });

  let verdict = VERDICTS.UNKNOWN;
  if (L === false) verdict = VERDICTS.NO_CHANGE;
  else if (L === true && E === true && U === true) verdict = VERDICTS.WORKING;
  else if (L === true && E === true && U === false) verdict = VERDICTS.NOT_IN_USE;
  else if (L === true && E === false) verdict = VERDICTS.NOT_LOADED;

  return {
    claim,
    verdict,
    landed: tri(L), effective: tri(E), useful: tri(U),
    levels: levelResult,
    reasons: cleanReasons,
    judgedAt: now,
  };
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = x.level + '|' + x.code;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/** 终端报告：故意把 null 打成 `?`，不让人误读成通过 */
function report(r) {
  const sym = (v) => (v === 'true' ? '✓' : v === 'false' ? '✗' : '?');
  const lines = [];
  lines.push('');
  lines.push('  claim    ' + (r.claim || '(none)'));
  lines.push('  verdict  ' + r.verdict);
  lines.push('  landed     ' + sym(r.landed) + '  产物变了？');
  lines.push('  effective  ' + sym(r.effective) + '  系统加载了？');
  lines.push('  useful     ' + sym(r.useful) + '  有人真在调用？');
  if (r.reasons.length) {
    lines.push('  reasons  ' + r.reasons.map((x) => x.level + ':' + x.code).join('  '));
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { judge, report, REASONS, VERDICTS, LEVELS, MIN_SAMPLE, tri };
