'use strict';
/**
 * gatekit —— 发布前自洽审计（npm 包 + agent 技能包）
 *
 * 三个审计器，各管一问：
 *   identity  发出去的那份，是不是它自己声称的那一份？（版本 / 签名 / 残留物）
 *   manifest  我读到的字段，宿主是不是也这么读？（类型 / 必填 / 预算 / 重复键）
 *   runtime   换了机器，它凭什么能跑？（engines vs 实测下限 / 依赖声明）
 *
 * 三条共同纪律：
 *   1. 只返回结构化结果，不打印、不 exit（判定不许压在打印格式上）
 *   2. 没查到东西 ⇒ noData，rc=2，绝不当通过
 *   3. 每条判据都必须能被注入坏样本打红 —— 见 test/
 */

const { identity } = require('./identity');
const { manifest } = require('./manifest');
const { runtime } = require('./runtime');

const AUDITORS = [
  ['identity', '发布身份：版本 / 签名 / 残留物', identity],
  ['manifest', '清单契约：类型 / 必填 / 预算', manifest],
  ['runtime', '环境可搬：engines / 下限 / 依赖', runtime],
];

/**
 * @param {string} root
 * @param {{only?:string[], fast?:boolean, [k:string]:any}} [opts]
 */
function audit(root, opts) {
  const o = opts || {};
  const only = o.only && o.only.length ? o.only : null;
  const red = [], yellow = [], unmeasured = [], facts = {}, ran = [];
  let noData = false;

  for (const [id, name, fn] of AUDITORS) {
    if (only && only.indexOf(id) < 0) continue;
    ran.push(id);
    let r;
    try {
      r = fn(root, o[id] || {});
    } catch (e) {
      red.push({ gate: id, code: 'AUDITOR_THREW', msg: '审计器自身抛异常（按红处理，不按通过）：' + (e && e.message || e) });
      continue;
    }
    /* 没查到的审计器，它的「红」不是缺陷，是「查不了」。
       混进 red 会让 rc 永远是 1，「没查」这件事就没法表达了——
       而那正是本库最想保住的一档。所以单独进 unmeasured，并且不计入 rc=1。 */
    const bucket = r.noData ? unmeasured : red;
    for (const x of r.red || []) bucket.push(Object.assign({ gate: id }, x));
    for (const x of r.yellow || []) yellow.push(Object.assign({ gate: id }, x));
    facts[id] = Object.assign({}, r.facts || {}, r.noData ? { __noData: true } : {});
    if (r.noData) noData = true;
  }

  const noDataGates = ran.filter(function (id) { return facts[id] && facts[id].__noData; });
  const rc = red.length ? 1 : (unmeasured.length || noData ? 2 : 0);
  return { rc, red, yellow, unmeasured, facts, ran, noData, noDataGates, profile: o.profile || 'auto' };
}

module.exports = { audit, identity, manifest, runtime, AUDITORS };
