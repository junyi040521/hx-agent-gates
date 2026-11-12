'use strict';
/**
 * gatekit · runtime —— 环境可搬（语法过了 ≠ 换了机器能跑）
 *
 * 一句话：**`node --check` 通过证明的是语法，不是环境。**
 *
 * 判据来源：junyi 环境可搬律。真包实测：14 个脚本 py_compile 全过、各有自测，
 * 但换 `python -I -S` 后 6 个第一步就 ModuleNotFoundError，且全是顶层导入——
 * 缺包时连 --help 都起不来。全包能说清「别人的东西凭什么能发」，
 * 说不清「发出去的东西凭什么能跑」。
 *
 * JS 版的对应病灶：代码用了 `?.` / `structuredClone` / `Array.at` / `node:` 前缀，
 * 而 engines 写着 `>=14`。本地（Node 22）全绿，用户 Node 16 上第一行就炸。
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

/**
 * 版本敏感特征表：语法层能过、老版本运行时才炸的那一层。
 * [特征名, 正则, 需要的最低主版本, 说明]
 */
const FEATURES = [
  ['optional-chaining', /[?]\.[A-Za-z_$[(]/, 14, '?. 与 ?? 是 14 才有的语法'],
  ['nullish', /[^?]\?\?[^?]/, 14, '?? 同上'],
  ['flat', /\.flat\s*\(\s*\)/, 11, 'Array.flat 是 11+'],
  ['fromEntries', /Object\.fromEntries\s*\(/, 12, 'Object.fromEntries 是 12+'],
  ['replaceAll', /\.replaceAll\s*\(/, 15, 'String.replaceAll 是 15+'],
  ['array-at', /\.at\s*\(\s*-?\d/, 16, 'Array.at 是 16.6+（按 17 计，保守）'],
  ['structuredClone', /\bstructuredClone\s*\(/, 17, 'structuredClone 是 17+'],
  ['error-cause', /\bnew\s+Error\s*\([^)]*\{[^}]*cause\s*:/, 16, 'Error cause 是 16.9+（按 17 计，保守）'],
  ['node-prefix', /require\s*\(\s*['"]node:/, 16, 'require("node:") 需要 14.18/16+'],
  ['private-field', /\bthis\.#[a-zA-Z_]/, 12, '#private 字段是 12+'],
  ['import-meta', /\bimport\.meta\b/, 12, 'import.meta 只在 ESM 且 12+'],
  ['top-level-await', /^await\s/m, 14, '顶层 await 需要 14.8+（按 15 计）'],
  ['hashbang-fs', /fs\.rmSync\s*\(/, 14, 'fs.rmSync 是 14.14+（按 15 计）'],
  ['abortsignal-timeout', /AbortSignal\.timeout\s*\(/, 17, 'AbortSignal.timeout 是 17.3+'],
  ['array-findlast', /\.findLast(Index)?\s*\(/, 18, 'findLast 是 18+'],
];
const FLOOR = {
  'array-at': 17, 'error-cause': 17, 'top-level-await': 15, 'hashbang-fs': 15,
};

const CODE = /\.(js|cjs|mjs)$/i;
const SKIP = /^(node_modules|\.git|data|backups|attic|_archive|distill_data|coverage|logs|tmp|_out)$/i;

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }

function walk(dir, out) {
  out = out || [];
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const n of names) {
    if (SKIP.test(n) || n[0] === '.') continue;
    const fp = path.join(dir, n);
    if (isDir(fp)) walk(fp, out); else if (CODE.test(fp)) out.push(fp);
  }
  return out;
}

/**
 * 抹掉注释与字符串内容（否则示例代码里的 `?.` 会把下限抬高）
 *
 * keepText=true 时反过来：**保留字符串内容**，只把「字符串里的 require 这个词」
 * 打成空格。为什么需要两种：（a）判语法下限要抹内容，注释里的 `obj?.a` 不该算；
 * （b）取依赖要保内容，而 `require('left-pad')` 的实参正是字符串。
 * 第一版只做了（a）却没做（b），于是 UNDECLARED 判据静默永远为假——
 * 一个永远为假的判据，和没装一样。
 */
function maskText(src, keepText) {
  const s = String(src);
  const a = s.split('');
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i], nx = s[i + 1];
    if (ch === '/' && nx === '/') { while (i < n && s[i] !== '\n') { a[i] = ' '; i++; } continue; }
    if (ch === '/' && nx === '*') {
      a[i] = ' '; a[i + 1] = ' '; i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) { if (s[i] !== '\n') a[i] = ' '; i++; }
      if (i < n) { a[i] = ' '; a[i + 1] = ' '; i += 2; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const start = i + 1;
      i++;
      while (i < n) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === ch) break;
        i++;
      }
      const end = Math.min(i, n);
      if (keepText) {
        const seg = s.slice(start, end);
        let p = 0;
        while ((p = seg.indexOf('require', p)) >= 0) {
          for (let k = 0; k < 7; k++) a[start + p + k] = ' ';
          p += 7;
        }
      } else {
        for (let k = start; k < end; k++) if (s[k] !== '\n') a[k] = ' ';
      }
      i = end + 1;
      continue;
    }
    i++;
  }
  return a.join('');
}

/** engines 范围 → 最低主版本（只取第一个数字，够用且不会骗人） */
function floorOf(range) {
  const m = String(range || '').match(/(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

function requiresOf(src) {
  const out = [];
  const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const code = maskText(src, true);   /* 保留字符串内容：实参就是依赖名 */
  let m;
  while ((m = re.exec(code)) !== null) out.push(m[1]);
  return out;
}

/**
 * @param {string} root
 * @param {{scan?:string[], maxCheck?:number, enginesKey?:string}} [opts]
 */
function runtime(root, opts) {
  const o = opts || {};
  const red = [], yellow = [], facts = {};

  let pkg = null;
  const raw = read(path.join(root, 'package.json'));
  if (raw) { try { pkg = JSON.parse(raw); } catch (e) { pkg = null; } }

  const files = (o.scan && o.scan.length
    ? [].concat.apply([], o.scan.map(function (d) { const p = path.join(root, d); return isDir(p) ? walk(p) : (fs.existsSync(p) ? [p] : []); }))
    : walk(root));

  facts.files = files.length;
  if (!files.length) {
    red.push({ code: 'NO_SCAN', msg: '一个代码文件都没扫到 ⇒ 按没查处理（不是通过）' });
    return { ok: false, red, yellow, facts, noData: true };
  }

  /* 声明面 */
  const declaredRange = pkg && pkg.engines && pkg.engines.node;
  const declaredFloor = floorOf(declaredRange);
  facts.engines = declaredRange || null;

  /* 实测面 1：语法下限（按特征表推） */
  const seen = new Map();
  for (const fp of files) {
    const code = maskText(read(fp) || '');
    for (const f of FEATURES) {
      if (!f[1].test(code)) continue;
      const need = FLOOR[f[0]] || f[2];
      const prev = seen.get(f[0]);
      if (!prev || need > prev.need) seen.set(f[0], { need, why: f[3], file: path.relative(root, fp).split(path.sep).join('/') });
    }
  }
  let measured = 0;
  for (const [k, v] of seen) measured = Math.max(measured, v.need);
  facts.syntaxFloor = measured;
  facts.features = [...seen.entries()].map(function (e) { return e[0] + '@' + e[1].need + '（' + e[1].file + '）'; });

  /* 实测面 2：真跑 --check（当前解释器能不能解析；最低 200 个，超出报抽样） */
  const maxCheck = Number(o.maxCheck || 200);
  const sample = files.slice(0, maxCheck);
  let bad = 0;
  for (const fp of sample) {
    const r = cp.spawnSync(process.execPath, ['--check', fp], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) {
      bad++;
      const first = String(r.stderr || '').trim().split('\n').slice(-3).join(' ｜ ');
      red.push({ code: 'SYNTAX', msg: path.relative(root, fp).split(path.sep).join('/') + ' 语法不过：' + first.slice(0, 160) });
    }
  }
  facts.checked = sample.length;
  if (files.length > sample.length) yellow.push({ code: 'CHECK_SAMPLED', msg: '只对 ' + sample.length + '/' + files.length + ' 个文件做了 --check（其余未核验）' });

  if (!declaredFloor) {
    /* 没有 package.json 的载体（插件包 / 技能包）没有地方写 engines——
       判红等于要求它长成 npm 包的样子。降为黄，并明说这是「没查」不是「缺陷」。 */
    if (!pkg) {
      yellow.push({ code: 'NO_MANIFEST_RUNTIME', msg: '没有 package.json，engines 无处声明：' + files.length + ' 个代码文件的环境要求未核验' });
    } else {
      red.push({ code: 'NO_ENGINES', msg: '有 ' + files.length + ' 个代码文件却没有 engines.node：说不清要什么解释器，用户跑到一半才炸' });
    }
  } else if (measured > declaredFloor) {
    const detail = [...seen.entries()].filter(function (e) { return (FLOOR[e[0]] || e[1].need) > declaredFloor; })
      .map(function (e) { return e[0] + '（需 ' + (FLOOR[e[0]] || e[1].need) + '+，' + e[1].file + '）'; });
    red.push({ code: 'FLOOR_MISMATCH', msg: 'engines 声明 ' + declaredRange + '（按 ' + declaredFloor + '），实测下限 ' + measured + '：' + detail.slice(0, 4).join('，') });
  }

  /* 依赖：用到没声明 ⇒ 红；声明没用 ⇒ 黄（devDependencies 除外） */
  const declared = new Set();
  for (const k of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const n of Object.keys((pkg && pkg[k]) || {})) declared.add(n);
  }
  const dev = new Set(Object.keys((pkg && pkg.devDependencies) || {}));
  let builtin = [];
  try { builtin = require('module').builtinModules || []; } catch (e) {}
  const bset = new Set(builtin.concat(builtin.map(function (b) { return 'node:' + b; })));

  const used = new Map();
  for (const fp of files) {
    for (const r of requiresOf(read(fp) || '')) {
      if (r[0] === '.' || path.isAbsolute(r)) continue;
      if (bset.has(r)) continue;
      const name = r[0] === '@' ? r.split('/').slice(0, 2).join('/') : r.split('/')[0];
      if (!/^[@a-z0-9._-]+$/i.test(name)) continue;
      if (!used.has(name)) used.set(name, path.relative(root, fp).split(path.sep).join('/'));
    }
  }
  facts.used = [...used.keys()].sort();
  for (const [u, where] of used) {
    if (declared.has(u) || dev.has(u)) continue;
    red.push({ code: 'UNDECLARED', msg: 'require 了 ' + u + '（' + where + '），package.json 没声明 ⇒ 换机器装不上' });
  }
  for (const d of declared) {
    if (used.has(d)) continue;
    yellow.push({ code: 'UNUSED_DEP', msg: '声明了 ' + d + ' 但从未 require（虚胖依赖，白背供应链风险）' });
  }

  return { ok: red.length === 0, red, yellow, facts };
}

module.exports = { runtime, FEATURES, floorOf, maskText, requiresOf };
