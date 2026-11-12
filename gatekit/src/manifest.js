'use strict';
/**
 * gatekit · manifest —— 清单契约（字段在 ≠ 宿主读它）
 *
 * 一句话：**我读到的字段，宿主是不是也这么读。** 真源不是文档，是消费方实现。
 *
 * 判据来源：junyi 的清单契约律（宿主只解析白名单文本字段、布尔字段走 typeof
 * 断言、缺 name/description 整条不进候选集、预算分母不止 description 一段）。
 * 这里同时管两种载体——npm 的 package.json 与 agent 技能包的 SKILL.md frontmatter，
 * 因为这两边的错法一模一样：字段写了、类型错了、宿主播 quietly 丢掉。
 */

const fs = require('fs');
const path = require('path');

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }

/** 顶层键出现次数：JSON.parse 会让后一个同名键静默覆盖前一个，这是最隐蔽的一类错。 */
function topKeys(raw) {
  const s = String(raw);
  const counts = new Map();
  let depth = 0, i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '"') {
      let j = i + 1, buf = '';
      while (j < n) {
        if (s[j] === '\\') { buf += s[j + 1]; j += 2; continue; }
        if (s[j] === '"') break;
        buf += s[j]; j++;
      }
      if (depth === 1) {
        let k = j + 1;
        while (k < n && /\s/.test(s[k])) k++;
        if (s[k] === ':') counts.set(buf, (counts.get(buf) || 0) + 1);
      }
      i = j + 1;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    i++;
  }
  return counts;
}

const TEXT_FIELDS = ['name', 'version', 'description', 'license', 'homepage', 'main', 'types', 'author', 'repository'];
const BOOL_FIELDS = ['private', 'typeIsModule'];
/* 技能 frontmatter：宿主只解析这些，其余写了不生效 */
const SKILL_TEXT = ['name', 'display_name', 'description', 'description_zh', 'description_en', 'when-to-use', 'license', 'version'];
const SKILL_BOOL = ['disable', 'disable-model-invocation', 'user-invocable'];
const SKILL_IGNORED = ['homepage', 'metadata', 'author', 'tags', 'icon'];
const SKILL_BUDGET = 1024;   /* description 一段的上限；四段合计也按它算 */

/** 极简 frontmatter 解析：认 `---` 包起来的 `key: value`，**支持块标量**（| / >）
 *
 * 块标量这段是被真包逼出来的：browser-use 与 junyi 的技能全用
 *   description: |-
 *     浏览器自动化：打开网页…
 *     用我：用户说「帮我操作这个网站」…
 * 第一版只取 `|-` 这一行，于是 description 长度 = 2、内容为空，
 * 触发语判据对每一个技能都报「选不中」——14 个技能 14 条假黄。
 */
function frontmatter(md) {
  const s = String(md || '');
  if (s.slice(0, 3) !== '---') return null;
  const end = s.indexOf('\n---', 3);
  if (end < 0) return null;
  const lines = s.slice(3, end).split(/\r?\n/);
  const kv = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (/^[|>][+-]?$/.test(val)) {
      const buf = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || /^\s+\S/.test(lines[j]))) {
        buf.push(lines[j].trim());
        j++;
      }
      val = buf.join(' ').trim();
      i = j - 1;
    }
    kv.set(m[1], val.replace(/^['"]|['"]$/g, ''));
  }
  return kv;
}

/**
 * npm 清单契约
 */
function npmManifest(root, opts) {
  const o = opts || {};
  const red = [], yellow = [], facts = {};
  const raw = read(path.join(root, o.file || 'package.json'));
  if (raw === null) { red.push({ code: 'NO_MANIFEST', msg: '找不到 package.json' }); return { red, yellow, facts, noData: true }; }

  let meta;
  try { meta = JSON.parse(raw); } catch (e) {
    red.push({ code: 'BAD_JSON', msg: 'package.json 不是合法 JSON：' + (e && e.message || e) });
    return { red, yellow, facts };
  }

  for (const [k, c] of topKeys(raw)) {
    if (c > 1) red.push({ code: 'DUP_KEY', msg: '清单里同名键 "' + k + '" 出现 ' + c + ' 次：后者静默覆盖前者，读的人以为写的是前者' });
  }

  for (const k of TEXT_FIELDS) {
    if (!(k in meta)) continue;
    if (typeof meta[k] !== 'string') red.push({ code: 'FIELD_TYPE', msg: k + ' 应为字符串，实际是 ' + (Array.isArray(meta[k]) ? 'array' : typeof meta[k]) + '（宿主按字符串取，取到空）' });
  }
  for (const k of BOOL_FIELDS) {
    if (!(k in meta)) continue;
    if (typeof meta[k] !== 'boolean') red.push({ code: 'BOOL_LITERAL', msg: k + ' 必须是布尔字面量，实际是 ' + JSON.stringify(meta[k]) + '（写成 "false" 会被整条丢弃，字段在、内容对、0 生效）' });
  }
  if (!meta.name) red.push({ code: 'NO_NAME', msg: '缺 name（宿主按 name 索引）' });
  if (!meta.version) red.push({ code: 'NO_VERSION', msg: '缺 version' });
  if (meta.license && typeof meta.license === 'string' && meta.license !== 'UNLICENSED') {
    if (!fs.existsSync(path.join(root, 'LICENSE')) && !fs.existsSync(path.join(root, 'LICENSE.md'))) {
      red.push({ code: 'LICENSE_NO_TEXT', msg: '声明了 ' + meta.license + ' 但包里没有许可全文——对外承诺了一件查不到依据的事' });
    }
  }
  facts.name = meta.name || null;
  facts.license = meta.license || null;
  return { red, yellow, facts };
}

/**
 * 技能清单契约（SKILL.md frontmatter）
 */
function skillManifest(root, opts) {
  const o = opts || {};
  const red = [], yellow = [], facts = {};
  const rel = o.file || 'SKILL.md';
  const md = read(path.join(root, rel));
  if (md === null) { red.push({ code: 'NO_SKILL', msg: '找不到 ' + rel }); return { red, yellow, facts, noData: true }; }

  const fm = frontmatter(md);
  if (!fm) { red.push({ code: 'NO_FRONTMATTER', msg: rel + ' 没有 --- frontmatter 块，宿主读不到任何元数据' }); return { red, yellow, facts }; }

  const name = fm.get('name');
  const desc = fm.get('description');
  /* 硬前提比类型更狠：缺任一，整条技能不进候选集——不是降级，不是用目录名兜底 */
  if (!name) red.push({ code: 'NO_NAME', msg: 'frontmatter 缺 name ⇒ 整条技能不进候选集（不是降级，是消失）' });
  if (!desc) red.push({ code: 'NO_DESCRIPTION', msg: 'frontmatter 缺 description ⇒ 整条技能不进候选集' });

  if (name) {
    const base = path.basename(path.resolve(root));
    if (name !== base) red.push({ code: 'DIR_NE_NAME', msg: '目录名 ' + base + ' ≠ frontmatter name ' + name + '（宿主按 name 索引：按目录找得到它，按 name 找不到）' });
  }

  for (const k of SKILL_BOOL) {
    if (!fm.has(k)) continue;
    const v = fm.get(k);
    if (v !== 'true' && v !== 'false') red.push({ code: 'BOOL_LITERAL', msg: k + ' = 「' + v + '」不是布尔字面量（yes/1/"false" 都会被整条丢弃）' });
  }
  for (const k of SKILL_IGNORED) {
    if (fm.has(k)) yellow.push({ code: 'FIELD_IGNORED', msg: k + ' 写了但宿主不解析（白写，且会让人以为生效）' });
  }

  /* 预算的分母不止 description 一段：意图识别吃 name + description + zh/en + when-to-use。
     只量一档会系统性低估（实测漏 26.5%）。 */
  const parts = ['name', 'description', 'description_zh', 'description_en', 'when-to-use'];
  let total = 0;
  const per = {};
  for (const k of parts) {
    const v = fm.get(k) || '';
    per[k] = v.length;
    total += v.length;
  }
  facts.budget = { total, per, cap: SKILL_BUDGET };
  for (const k of ['description', 'description_zh', 'description_en', 'when-to-use']) {
    if (per[k] > SKILL_BUDGET) red.push({ code: 'FIELD_TOO_LONG', msg: k + ' ' + per[k] + ' 字符，超过 ' + SKILL_BUDGET + '（超限截断往往正好截掉触发词）' });
  }
  if (total > SKILL_BUDGET) yellow.push({ code: 'BUDGET_OVER', msg: '四段合计 ' + total + ' 字符，超过 ' + SKILL_BUDGET + ' 预算（意图识别吃的是合计，不是单段）' });

  /* 触发语检查：description 是触发条件，不是功能摘要。
     没有「何时用」的句子，技能装着但永远选不中。 */
  if (desc && !/(当你|当用户|用户说|使用时机|何时|触发|用我|加载|Use when|use this when|When the user|TRIGGER)/i.test(desc)) {
    yellow.push({ code: 'NO_TRIGGER', msg: 'description 里没有触发语（「当用户说…」「Use when…」）——技能装着但选不中' });
  }
  facts.name = name || null;
  return { red, yellow, facts };
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }

/**
 * 技能集合包：包根没有 SKILL.md，但 skills/<x>/SKILL.md 有一堆。
 *
 * 这是第三种载体（真实存在：junyi 包 14 个技能 + 13 个第三方技能）。
 * 不认它，整个 manifest 审计就会 noData——而「查不了」会被读成「没问题」。
 */
function skillset(root, opts) {
  const o = opts || {};
  const red = [], yellow = [], facts = { skills: 0, names: [] };
  const base = path.join(root, o.skillsDir || 'skills');
  let names = [];
  try { names = fs.readdirSync(base).sort(); } catch (e) { names = []; }

  for (const n of names) {
    const dir = path.join(base, n);
    if (!isDir(dir) || read(path.join(dir, 'SKILL.md')) === null) continue;
    facts.skills++;
    facts.names.push(n);
    const r = skillManifest(dir, { file: 'SKILL.md' });
    for (const x of r.red) red.push(Object.assign({ skill: n }, x));
    for (const x of r.yellow) yellow.push(Object.assign({ skill: n }, x));
  }

  if (!facts.skills) {
    return { red: [{ code: 'NO_SKILL', msg: 'skills/ 下没有任何 SKILL.md，无法审技能清单' }], yellow, facts, noData: true };
  }
  return { red, yellow, facts };
}

/**
 * 自动判定载体，四种：
 *   根 SKILL.md        → skill
 *   根 package.json    → npm
 *   skills/<x>/SKILL.md → skillset（技能集合包）
 *   都没有             → noData
 */
function manifest(root, opts) {
  const o = opts || {};
  const hasSkill = fs.existsSync(path.join(root, 'SKILL.md'));
  const kind = o.kind || (hasSkill ? 'skill' : (fs.existsSync(path.join(root, 'package.json')) ? 'npm' : 'skillset'));
  const r = kind === 'skill' ? skillManifest(root, o)
    : kind === 'skillset' ? skillset(root, o)
      : npmManifest(root, o);
  return { kind, ok: !r.red.length, red: r.red, yellow: r.yellow, facts: r.facts, noData: !!r.noData };
}

module.exports = { manifest, npmManifest, skillManifest, skillset, frontmatter, topKeys };
