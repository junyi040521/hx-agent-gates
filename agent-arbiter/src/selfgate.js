'use strict';
/**
 * selfgate —— 包自证闸门
 *
 * 设计取自 junyi 专家包的闸门体系（34 道 R 闸门 / publish_audit.py run_all()），
 * 实现零耦合：只用 Node 内建模块，不引用那份包的任何代码。
 *
 * 为什么一个「判定库」要先审自己：
 *   一个永远给绿的判定器，与一个根本不判定的判定器，输出完全一样。
 *   junyi R25 的原话是「返回 0 但输出为空，与没跑无法区分」——所以本库的
 *   每条闸门都必须能被注入坏样本打红。打不红的闸门等于没装。
 *
 * 四条设计约束（每条都对应一次真实返工）：
 *   1. audit() 只返回结构化结果：不打印、不 exit、不读时钟。
 *      判定不许压在打印格式上——改一句文案就能让闸门失效，那不叫闸门。
 *   2. 每条闸门独立 try/catch：闸门自己抛异常 ⇒ 记红，不许静默变绿。
 *   3. 扫描面为 0 ⇒ rc=2（按没查处理），不许当通过。
 *   4. 判据看见的是代码，不是「关于代码的文字」：扫源码前必须先剥注释。
 *      第一版没剥，注释里举例写的那句 require 被当成真依赖，把本库自己判红了。
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

/* ---------------------------------------------------------------- 基础设施 */

function _read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

function _isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function _walk(dir, ext, out) {
  out = out || [];
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const n of names) {
    if (n === 'node_modules' || n === '.git') continue;
    const fp = path.join(dir, n);
    if (_isDir(fp)) { _walk(fp, ext, out); continue; }
    if (fp.endsWith(ext)) out.push(fp);
  }
  return out;
}

function _rel(root, fp) { return path.relative(root, fp).split(path.sep).join('/'); }

function _stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/**
 * 把「非代码文本」全部抹成空格：注释、字符串内容、模板字符串内容都抹，
 * 但保留定界符与换行位置。剩下的才是代码。
 *
 * 这条是第三次撞同一面墙：
 *   ① 第一版连注释都没剥，注释里举例的 require 被当成真依赖；
 *   ② 第二版剥了注释，但没剥字符串 —— 真仓库里
 *      `eq('try { const x = require("a"); } catch (e) {}', ...)`
 *      一次报出 3 个假包（a / x / y）。**判据看见的是代码，不是关于代码的文字。**
 *
 * 为什么不能简单地把整段字符串删掉：`require('fs')` 的 `require` 在字符串外，
 * 而 `'require("a")'` 的 `require` 在字符串内。判据要的是「require 这个词是不是代码」，
 * 不是「实参是什么」。所以抹内容、留定界符。
 *
 * 已知缺口：模板字符串里的 ${} 会被一起抹掉，`require(`${x}`)` 这类写法会漏计。
 * 宁可漏一个极罕见的动态形态，也不要每跑一次多报三个不存在的包。
 */
function _maskNonCode(src, keepStringText) {
  const s = String(src);
  const a = s.split('');
  const n = s.length;
  let i = 0;
  while (i < n) {
    const ch = s[i], nx = s[i + 1];
    if (ch === '/' && nx === '/') {
      while (i < n && s[i] !== '\n') { a[i] = ' '; i++; }
      continue;
    }
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
      if (!keepStringText) {
        for (let k = start; k < end; k++) if (s[k] !== '\n') a[k] = ' ';
      } else {
        /* keepStringText：保留内容（G1 需要实参名字），只把「字符串里的 require 这个词」
           打成空格。'try { require("a") }' 就不再是一条依赖声明，
           而 require('fs') 的 fs 原样留下。 */
        const seg = s.slice(start, end);
        let p = 0;
        while ((p = seg.indexOf('require', p)) >= 0) {
          a[start + p] = ' ';
          a[start + p + 1] = ' ';
          a[start + p + 2] = ' ';
          a[start + p + 3] = ' ';
          a[start + p + 4] = ' ';
          a[start + p + 5] = ' ';
          a[start + p + 6] = ' ';
          p += 7;
        }
      }
      i = end + 1;
      continue;
    }
    i++;
  }
  return a.join('');
}

function _push(res, gate, msg) { res.red.push({ gate, msg }); }
function _warn(res, gate, msg) { res.yellow.push({ gate, msg }); }

/** Node 内建模块集合（含 node: 前缀形态） */
function _builtins() {
  const set = new Set();
  let list = [];
  try { list = require('module').builtinModules || []; } catch (e) { /* 老版本没有此项 */ }
  for (const b of list) { set.add(b); set.add('node:' + b); }
  for (const b of ['fs', 'path', 'crypto', 'os', 'module', 'child_process', 'util', 'assert']) set.add(b);
  return set;
}

/** 合法的模块名形态。用它把「字符串拼接」挡在外面——见 _requires 的注释。 */
const MODNAME = /^[@a-zA-Z0-9_./-]+$/;

/**
 * 抽出源码里的依赖声明（只取 require 的字面量形态）
 *
 * 为什么必须校验名字形态：生成代码的模板里会写 `require(' + spec + ')`，
 * 两个单引号之间是 ` + spec + `，正则把它当成模块名，于是在真仓库上
 * 一次性报出 5 条「代码 require 了 + JSON.stringify(spec) +，没声明」。
 * 那不是缺陷，是判据把拼接当字面量。名字里有空格 / 加号 / 美元符的，
 * 一律不是模块名，而是动态 require——单独计数，让分母可见，但不判红。
 */
function _requires(src) {
  const out = { names: [], dynamic: 0 };
  /* 先抹非代码文本，再找 require：require 这个词必须是代码，不是字符串里的示例 */
  const code = _maskNonCode(src, true);
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const n = m[1];
    if (!MODNAME.test(n)) { out.dynamic++; continue; }
    out.names.push(n);
  }
  return out;
}

/** 递归收文件，跳过依赖与「归档/数据/快照」类目录（那些不是活的代码） */
const SKIP_DIR = /^(\.|node_modules$|data$|backups$|attic$|_archive$|archive$|distill_data$|coverage$|logs$|tmp$|_out$|r\d+[a-z0-9_]*_snapshots?$)/i;

function _walkAny(dir, exts, out) {
  out = out || [];
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const n of names) {
    const fp = path.join(dir, n);
    if (_isDir(fp)) { if (!SKIP_DIR.test(n)) _walkAny(fp, exts, out); continue; }
    if (exts.some(function (e) { return fp.endsWith(e); })) out.push(fp);
  }
  return out;
}

/**
 * 自动判载体：这是「别人 require 的包」还是「自己跑的应用」。
 *
 * 不写这条，默认只能是 lib —— 而 lib 判据比 app 严得多（G6 要求判定库不许写盘）。
 * 对一个应用套 lib 判据，实测在绘心上刷出 **412 条假红**：每个模块都在写日志、
 * 写账本、写账本快照，那是主业不是副作用。一次错 412 条，人就再也不看这个
 * 闸门的输出了——判据严格不等于判据有用，只等于判据被无视。
 *
 * 判错的两个方向代价不对称：lib→app 只是少报几条，app→lib 会一次淹掉整个报告。
 * 所以这里只问一个问题：**别人会 require 它吗？**
 *   没 main      ⇒ 不会（被 require 的包必须有 main）      ⇒ app
 *   main 不存在  ⇒ 残包，仍按 lib 判，让 G2 把这条错报出来
 *   main 里 listen ⇒ 长驻服务                              ⇒ app
 *   其余         ⇒ lib
 */
function _inferProfile(root, pkg) {
  const main = pkg && typeof pkg.main === 'string' ? pkg.main.trim() : '';
  if (!main) return 'app';
  const abs = path.join(root, main);
  if (!fs.existsSync(abs)) return 'lib';
  const src = _maskNonCode(_read(abs) || '');
  if (/\.listen\s*\(/.test(src)) return 'app';
  return 'lib';
}

/**
 * 解析扫描面。
 *
 * 这条是被真仓库逼出来的：G1 原来写死只扫 `src/` 与 `bin/`，
 * 而绘心（4,553 个可扫文件）里 src/ 只占 951 个 = 20.9%——
 * 闸门报了 rc=1，却完全没说它只看了五分之一。
 * 「扫了一个目录就报结论」比「扫 0 个就报结论」更难发现。
 *
 * profile=lib（默认）：src + bin，与 npm 包的发布面一致。
 * profile=app：全仓递归（跳过 data/backups/attic/快照等），因为应用没有发布面。
 */
function _resolveScan(root, o) {
  if (Array.isArray(o.scan) && o.scan.length) {
    const files = [];
    for (const rel of o.scan) {
      const p = path.join(root, rel);
      if (_isDir(p)) files.push.apply(files, _walkAny(p, ['.js', '.cjs', '.mjs']));
      else if (fs.existsSync(p)) files.push(p);
    }
    return { dirs: o.scan.slice(), files: files, explicit: true };
  }
  if (o.profile === 'app') {
    const top = [];
    try {
      for (const n of fs.readdirSync(root)) {
        if (SKIP_DIR.test(n)) continue;
        const fp = path.join(root, n);
        if (_isDir(fp)) top.push(n);
      }
    } catch (e) { /* 读不到就是空面，G7 会按没查处理 */ }
    return { dirs: top, files: _walkAny(root, ['.js', '.cjs', '.mjs']), explicit: false };
  }
  const dirs = ['src', 'bin'];
  const files = [];
  for (const d of dirs) {
    const p = path.join(root, d);
    if (_isDir(p)) files.push.apply(files, _walkAny(p, ['.js', '.cjs', '.mjs']));
  }
  return { dirs: dirs, files: files, explicit: false };
}

/** 测试面识别：命名模式 + 目录，排除夹具（夹具不是测试） */
function _isTestFile(rel) {
  const r = String(rel);
  if (/(^|\/)(fixtures?|mocks?|stubs?|testdata|__snapshots__)\//i.test(r)) return false;
  return /(^|\/)(test|tests|__tests__)\//.test(r) || /\.(test|spec)\.[cm]?js$/.test(r) || /[_-]test\.[cm]?js$/.test(r);
}

/**
 * 断言机制识别。返回命中的机制名列表，空数组 = 这个文件没有任何可失败的判定。
 *
 * 只报 assert 关键字是不够的：真仓库里 `test/core_smoke.js` 用 CASES 表 +
 * `m.clamp(5,0,3) === 3` 自研比较，被 G4 判成「没有断言」——那是假红。
 * 但一味放宽就成了放水（一个什么都不检查的文件也能有 `===`）。
 * 所以只认「能让进程变红的出口」：抛错、非零退出、断言库、自研 fail()。
 */
const ASSERTIONS = [
  ['assert', /\bassert\s*[.(]/],
  ['throws', /\bthrow\s+(new\s+)?[\w(]/],
  /* 只排除字面 0：process.exit(failN ? 1 : 0) 也是出口。第一版写成 [1-9]，
     把绘心 test/core_smoke.js 与 mechanismProbes.test.js 全判成「没有出口」。 */
  ['exit1', /process\.exit\(\s*(?!0\s*\))/],
  ['expect', /\bexpect\s*\(/],
  ['t.ok', /\bt\.(ok|equal|strictEqual|deepEqual|throws)\s*\(/],
  ['ok/fail', /\b(ok|fail|eq|ne|eqM|must)\s*\(\s*['"`]/],
  ['failCounter', /\b(FAIL|failures?|failed)\s*(\+\+|\+=|=)/],
  ['node:test', /\b(node:test|describe|it)\s*\(/],
];

function _assertions(src) {
  const code = _maskNonCode(src);
  const hit = [];
  for (const pair of ASSERTIONS) if (pair[1].test(code)) hit.push(pair[0]);
  return hit;
}

/** require 目标 → npm 包名（scoped 保留两段） */
function _pkgName(r) {
  const parts = String(r).split('/');
  return r.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/* ------------------------------------------------------------------- G1 依赖 */

/**
 * G1 · 声明 vs 实测（依赖双向对撞）
 * 声明面 = package.json 的 dependencies / devDependencies / peerDependencies
 * 实测面 = 扫描面里 require 的非相对、非内建模块（lib 模式 = src+bin；app 模式 = 全仓）
 * 任一边多出来都判红：声明了没用到是虚胖，用到了没声明是装不上。
 *
 * 分级：prod 面（非 test）缺声明 ⇒ 红；test 面缺声明 ⇒ 黄。
 * 因为测试夹具故意 require 一个不存在的模块是合法手法，不该和生产代码同罪。
 */
function gateDeps(root, pkg, res, opts) {
  const declared = new Set();
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const n of Object.keys(pkg[k] || {})) declared.add(n);
  }
  const builtin = _builtins();
  const used = new Map();      // pkgName -> 证据（第一处出现的文件）
  let dynamic = 0;
  const files = (res.facts.scan && res.facts.scan.files) || [];
  for (const fp of files) {
    const rel = _rel(root, fp);
    /* 必须喂原始文本：先 _stripComments 再 mask 是错的——行注释里出现一个单引号
       （`// don't`）就会让后面整个文件的词法状态错乱，字符串内容被当成代码，
       真仓库上因此又报出 a / x / y 三个假包。两步词法互相破坏，只能一步。 */
    const req = _requires(_read(fp) || '');
    dynamic += req.dynamic;
    for (const r of req.names) {
      if (r.startsWith('.') || path.isAbsolute(r)) continue;
      if (builtin.has(r) || builtin.has(r.replace(/^node:/, ''))) continue;
      const name = _pkgName(r);
      if (!used.has(name)) used.set(name, rel);
    }
  }

  res.facts.deps = {
    declared: declared.size,
    used: [...used.keys()].sort(),
    dynamicRequires: dynamic,
    scannedFiles: files.length,
  };

  for (const [u, where] of used) {
    if (declared.has(u)) continue;
    const inTest = _isTestFile(where);
    const msg = '代码 require 了 ' + u + '（' + where + '），package.json 没声明';
    if (inTest) _warn(res, 'G1', msg + '——测试夹具可接受，但 npm i 装不上它');
    else _push(res, 'G1', msg + '（别人 npm i 装不上）');
  }
  /* 虚胖依赖只在 prod 面判红：devDependencies 常常只在脚本里用，
     若 app 模式的扫描面没覆盖到那些脚本，判红就是判据在撒谎。 */
  for (const d of declared) {
    if (used.has(d)) continue;
    const isDev = Object.prototype.hasOwnProperty.call(pkg.devDependencies || {}, d);
    if (isDev) _warn(res, 'G1', '声明为 devDependency 的 ' + d + ' 在扫描面里从未 require（可能只在未纳入扫描的脚本里用）');
    else _push(res, 'G1', 'package.json 声明了 ' + d + '，代码里从未 require（虚胖依赖，白背供应链风险）');
  }
  if (dynamic) _warn(res, 'G1', dynamic + ' 处动态 require（名字是拼出来的，静态不可判）——这部分依赖既查不到缺失，也查不到虚胖');
}

/**
 * 清掉目标包在本次进程里的模块缓存。
 *
 * 这条是被自己抓出来的：第一次 audit 时 main 是坏的（导出空对象），
 * 改好文件再 audit，仍然判红——因为 require 返回的是缓存，读到的还是旧代码。
 * 也就是说，闸门自己犯了它要抓的那个病：STALE_PROCESS。
 * 审计前不清缓存，第二次审计就永远在审上一次的包。
 */
function _purgeCache(root) {
  const abs = path.resolve(root) + path.sep;
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf(abs) === 0) { try { delete require.cache[k]; } catch (e) {} }
  }
}

/* ------------------------------------------------------------- G2 文件可加载 */

/**
 * G2 · 声明面（files / main / bin）与磁盘对撞 + 实加载
 * junyi 的验证纪律：只做语法检查就当能跑 = 假通过，必须实加载。
 * 所以 main 不只看存在，还真的 require 一次，并要求导出非空。
 *
 * app 模式的三条不同结论（在绘心真仓上量出来的，不是想出来的）：
 *   ① 没有 main 不是缺陷——应用靠 `node server.js` / scripts.start 启动；
 *   ② files 覆盖性不适用——不发布到 npm，就没有「发布后缺文件」这件事；
 *   ③ **绝不实加载入口**——require 一个 server.js 会真的把生产服务起起来。
 *      这不是保守，是副作用红线：审计器不许因为「想核验」而启动被审对象。
 */
function gateFiles(root, pkg, res, opts) {
  const app = (opts || {}).profile === 'app';
  const missing = [];
  for (const rel of (pkg.files || [])) if (!fs.existsSync(path.join(root, rel))) missing.push(rel);
  res.facts.files = { declared: (pkg.files || []).length, missing };

  if (app) {
    /* 入口：main → scripts.start 里那一段 node 之后的文件 → 常见入口名 */
    let entry = null;
    if (pkg.main && fs.existsSync(path.join(root, pkg.main))) entry = pkg.main;
    if (!entry && pkg.scripts && pkg.scripts.start) {
      const m = String(pkg.scripts.start).match(/node\s+(?:[^-\s][^\s]*)/);
      if (m) {
        const rel = m[0].replace(/^node\s+/, '');
        if (fs.existsSync(path.join(root, rel))) entry = rel;
      }
    }
    if (!entry) for (const cand of ['server.js', 'index.js', 'app.js', 'src/index.js']) {
      if (fs.existsSync(path.join(root, cand))) { entry = cand; break; }
    }
    res.facts.files.entry = entry;
    for (const m of missing) _push(res, 'G2', 'package.json files 声明了 ' + m + '，磁盘上不存在（清单与磁盘不一致，与发不发布无关）');
    if (!entry) _push(res, 'G2', '找不到入口（main / scripts.start / server.js|index.js|app.js 全无）——装上去不知道从哪起');
    if (!pkg.main) _warn(res, 'G2', '没有 main 字段：应用型仓库靠 scripts.start 或 ' + (entry || '入口文件') + ' 启动，这不算缺陷');
    if (pkg.files && pkg.files.length) _warn(res, 'G2', 'app 模式不判 files 覆盖性（不发布到 npm，没有「发布后缺文件」这件事）');
    /* 不实加载：这一条是本闸门唯一会「主动放弃核验」的地方，必须出声 */
    _warn(res, 'G2', 'app 模式不实加载入口 ' + (entry || '(无)') + '：require 它会真的启动服务——未核验的部分明写，不冒充已查');
    return;
  }

  for (const m of missing) _push(res, 'G2', 'package.json files 声明了 ' + m + '，磁盘上不存在 ⇒ 发出去就是残包');

  if (!pkg.main) _push(res, 'G2', '没有 main 字段，require 包名会失败');
  else if (!fs.existsSync(path.join(root, pkg.main))) _push(res, 'G2', 'main 指向 ' + pkg.main + '，磁盘上不存在');

  const bins = typeof pkg.bin === 'string' ? { _: pkg.bin } : (pkg.bin || {});
  for (const k of Object.keys(bins)) {
    if (!fs.existsSync(path.join(root, bins[k]))) _push(res, 'G2', 'bin.' + k + ' 指向 ' + bins[k] + '，磁盘上不存在');
  }

  /* 覆盖性：main / bin 指向的文件必须在 files 里，否则 npm 打包会把它排除掉——
     本地跑得通，装到别人机器上就是「命令不存在」。这条本地全局安装测不出来。 */
  const covered = function (rel) {
    const r = rel.replace(/^\.\//, '').split(path.sep).join('/');
    for (const f of (pkg.files || [])) {
      const e = String(f).replace(/^\.\//, '').split(path.sep).join('/');
      if (r === e || r.indexOf(e.replace(/\/$/, '') + '/') === 0) return true;
    }
    return false;
  };
  if (pkg.files && pkg.files.length) {
    if (pkg.main && !covered(pkg.main)) _push(res, 'G2', 'main（' + pkg.main + '）不在 files 里 ⇒ 发布后 require 不到');
    for (const k of Object.keys(bins)) {
      if (!covered(bins[k])) _push(res, 'G2', 'bin.' + k + '（' + bins[k] + '）不在 files 里 ⇒ 发布后命令不存在，而本机照样能跑');
    }
  }

  if (pkg.main && fs.existsSync(path.join(root, pkg.main))) {
    try {
      _purgeCache(root);
      const mod = require(path.resolve(root, pkg.main));
      const keys = Object.keys(mod || {});
      res.facts.files.exports = keys;
      if (!keys.length) _push(res, 'G2', 'main 能 require 但导出空对象——调用方拿到的是空壳');
    } catch (e) {
      _push(res, 'G2', 'main 实加载失败：' + (e && e.message || e));
    }
  }
}

/* ------------------------------------------------------------------- G3 文档 */

function _fencedBlocks(md, lang) {
  const out = [];
  const re = /```([a-zA-Z]*)\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const l = (m[1] || '').toLowerCase();
    if (lang && l !== lang) continue;
    out.push(m[2]);
  }
  return out;
}

/**
 * G3 · 文档跑得到（最容易腐烂的一条）
 * README 里 fenced bash 块中的 `node ...` 命令必须真跑得起来。
 * 判据：退出码 ∈ {0,1} 且输出不含模块找不到 / 语法错误。
 * 不要求 rc=0 —— NOT_IN_USE 这类结论本来就该是 1，硬要 0 只会逼人删掉真结论。
 *
 * app 模式默认 **不实跑**：应用的文档命令可能是 `pm2 restart` / `npm run deploy`，
 * 审计器一跑就是生产事故。「想核验」不是执行被审对象的理由，必须 opts.runDocs 显式开。
 */
function gateDocs(root, pkg, res, opts) {
  const o = opts || {};
  const app = o.profile === 'app';
  let readme = _read(path.join(root, 'README.md'));
  if (readme === null) {
    const alt = ['AGENTS.md', 'CLAUDE.md', 'CODEBUDDY.md', 'README.zh.md'].filter(function (n) {
      return _read(path.join(root, n)) !== null;
    });
    res.facts.docs = { commands: 0, broken: 0, docFile: alt[0] || null, ran: false };
    if (alt.length) {
      _warn(res, 'G3', '没有 README.md，用 ' + alt[0] + ' 当入门文档（应用可以这样，但发布包不行）');
      readme = _read(path.join(root, alt[0])) || '';
    } else {
      _push(res, 'G3', '没有任何入门文档（README.md / AGENTS.md / CLAUDE.md 全无）——新人只能靠读代码');
      return;
    }
  }
  if (o.fast) { _warn(res, 'G3', '--fast：跳过文档命令实跑（未核验）'); return; }

  const depth = Number(process.env.SELFGATE_DEPTH || 0);
  const cmds = [];
  for (const block of _fencedBlocks(readme, 'bash')) {
    for (const line of block.split(/\r?\n/)) {
      const t = line.trim().replace(/^\$\s+/, '');
      if (!/^node\s/.test(t)) continue;
      const shellMeta = /[|><;&$`]/;
      if (shellMeta.test(t)) { _warn(res, 'G3', '跳过含 shell 语法的示例（无法安全复现）：' + t); continue; }
      /* 自引用排除：会把本闸门再跑一遍的命令不实跑，否则 audit → 跑 README → audit 无限递归 */
      if (/\baudit\b/.test(t)) { _warn(res, 'G3', '跳过自引用命令（再跑会递归）：' + t); continue; }
      cmds.push(t);
    }
  }
  res.facts.docs = { commands: cmds.length, broken: 0, depth: depth, ran: false };
  if (!cmds.length) { _warn(res, 'G3', '文档里没有可直接复现的 node 命令——别人只能听你说'); return; }
  if (depth >= 1) { _warn(res, 'G3', '嵌套审计（depth=' + depth + '），跳过命令实跑'); return; }
  if (app && !o.runDocs) {
    _warn(res, 'G3', 'app 模式不实跑 ' + cmds.length + ' 条文档命令（可能是重启/部署命令）——未核验，要跑请显式 runDocs');
    return;
  }

  res.facts.docs.ran = true;
  for (const c of cmds) {
    const parts = c.split(/\s+/).slice(1);
    const r = cp.spawnSync(process.execPath, parts, {
      cwd: root, encoding: 'utf8', timeout: 20000,
      env: Object.assign({}, process.env, { SELFGATE_DEPTH: String(depth + 1) }),
    });
    const out = String(r.stdout || '') + String(r.stderr || '');
    const broken = /Cannot find module|MODULE_NOT_FOUND|SyntaxError|ERR_REQUIRE/i.test(out);
    if (broken || (r.status !== 0 && r.status !== 1)) {
      res.facts.docs.broken++;
      const first = out.trim().split('\n')[0] || '';
      _push(res, 'G3', 'README 命令跑不通（rc=' + r.status + '）：' + c + (first ? ' ｜ ' + first : ''));
    }
  }
}

/* ------------------------------------------------------------------- G4 测试 */

/**
 * G4 · 测试要么有断言，要么就是装饰
 *   a) 每个 test 文件至少一处「能让进程变红的出口」——否则它跑过只能证明「文件被加载了」
 *   b) 全包至少一条否定断言（期望 false / 期望抛错）
 *      —— 全是正向断言的测试集，永远无法证明这个库能抓假。
 *
 * 两处在真仓库上改过的判据：
 *   ① 只认 `test/` 目录 ⇒ 绘心 42 个文件被审，而全仓 371 个 `require.main === module`
 *      内嵌自测一个都没看到。应用没有 test/ 目录是常态，不是缺陷。
 *   ② 只认 `assert` 关键字 ⇒ `test/core_smoke.js`（CASES 表 + 自研比较 + exit 0）
 *      被判成「没有断言」，假红。改成认「可失败出口」并报出机制名。
 */
function gateTests(root, pkg, res, opts) {
  const app = (opts || {}).profile === 'app';
  /* 测试面用全仓（res._repo），不用「代码扫描面」：lib 模式只扫 src+bin，
     若测试面也跟着收窄，test/ 目录会被整片漏掉 —— 这一版第一次自审就踩了，
     G4 报「没有任何 test 文件」，而它自己包里就有 3 个。 */
  const scan = res._repo || (res.facts.scan && res.facts.scan.files) || [];
  const files = scan.filter(function (fp) { return _isTestFile(_rel(root, fp)); });

  /* 内嵌自测：应用常见的形态，必须单独计数，否则「0 个测试文件」是假结论 */
  let embedded = 0;
  for (const fp of scan) {
    if (files.indexOf(fp) >= 0) continue;
    if (/require\.main\s*===\s*module/.test(_read(fp) || '')) embedded++;
  }
  const negatives = [];
  const mechanisms = new Map();
  let asserts = 0;

  for (const fp of files) {
    const src = _read(fp) || '';
    const code = _maskNonCode(src);
    const hit = _assertions(src);
    for (const h of hit) mechanisms.set(h, (mechanisms.get(h) || 0) + 1);
    const n = (code.match(/\bassert\s*[.(]/g) || []).length;
    asserts += n;
    if (!hit.length) {
      /* 第三种形态：判定外包。真仓库里 hx/cortex/_bridge_test.cjs 导出
         run() → {ok, pass, total}，由探针调用它判 ok。它有真判据（pass>=6），
         但**自身永远不会 exit 非零** —— CI 跑它永远是 0。
         这不算装饰，但也不能算「能变红的测试」，所以黄而不是红，
         并且必须写明「变红的责任在调用方」——否则下一次没人知道该改哪一边。 */
      const delegated = /module\.exports\s*=\s*\{[^}]*\b(run|main|status|check|verify)\b/.test(code)
        && /(^|[^.\w])(ok|pass)\s*:/.test(code);
      if (delegated) {
        _warn(res, 'G4', _rel(root, fp) + ' 是「判定外包」形态（导出 run/status 返回 {ok,pass}）：有判据，但自身不会变红，变红的责任在调用方');
        continue;
      }
      _push(res, 'G4', _rel(root, fp) + ' 是测试文件但没有任何可失败的出口——跑过它只能证明文件被加载了');
    }
    if (/assert\.throws|assert\.ok\(\s*!|assert\.[a-zA-Z]+\([^)]*,\s*false\s*\)|\bthrows\s*\(|process\.exit\(\s*(?!0\s*\))/.test(code)) negatives.push(_rel(root, fp));
  }

  res.facts.tests = {
    files: files.length,
    asserts: asserts,
    negatives: negatives.length,
    embeddedSelftests: embedded,
    mechanisms: [...mechanisms.keys()],
    scanned: scan.length,
  };

  if (!files.length) {
    if (embedded > 0) {
      _push(res, 'G4', '没有任何 test 文件，只有 ' + embedded + ' 个内嵌自测（require.main === module）——没人会在 CI 里跑它们，等于没有回归');
    } else {
      _push(res, 'G4', '没有任何测试文件，也没有内嵌自测——这个仓库从未被自动验证过');
    }
    return;
  }
  if (app && embedded > 0) {
    _warn(res, 'G4', '另有 ' + embedded + ' 个内嵌自测（require.main === module）未纳入本闸门：它们不在 ' + files.length + ' 个 test 文件里，需要一个入口统一跑');
  }
  if (!negatives.length) _push(res, 'G4', '全仓没有一条否定断言（期望 false / 期望抛错）——这套测试从未证明过自己能抓假');
}

/* ----------------------------------------------------------- G5 理由码同一份 */

/**
 * G5 · 同一事实只能有一份声明
 * 文档说的理由码 ↔ 代码里的 REASONS / VERDICTS，双向对撞：
 *   文档提到代码没有的 ⇒ 红（承诺了一个不存在的诊断）
 *   代码有文档从不提的 ⇒ 黄（诊断存在但没人知道）
 */
function gateReasons(root, pkg, res) {
  const scan = (res.facts.scan && res.facts.scan.files) || [];
  const files = scan.length ? scan : _walk(path.join(root, 'src'), '.js');
  if (!files.length) { _warn(res, 'G5', '扫描面为空，跳过理由码对撞（按没查处理，不是通过）'); return; }

  /* 理由码可以在任意 src 文件里定义（本包在 judge.js，兄弟包在 arbiter.js 与
     lifecycle.js），所以按「找枚举常量块」定位真源，不写死文件名。
     枚举名必须在这里列全：第一版只认 REASONS，把 README 里合法的 NOT_IN_USE /
     NOT_LOADED 判成「代码里没有」；第二版补了 VERDICTS，又漏掉 lifecycle 的
     CODES，把 THIN_COMMENT 判成假缺陷。**判据漏一个分支，就会把真结论量成缺陷。** */
  const ENUMS = ['REASONS', 'VERDICTS', 'CODES'];
  const code = new Set();
  let blocks = 0;
  for (const fp of files) {
    const src = _maskNonCode(_read(fp) || '');
    for (const name of ENUMS) {
      const re = new RegExp('const\\s+' + name + '\\s*=\\s*\\{([\\s\\S]*?)\\};');
      const m = src.match(re);
      if (!m) continue;
      blocks++;
      for (const x of (m[1].match(/^\s*[A-Z][A-Z0-9_]*\s*:/gm) || [])) code.add(x.replace(/[\s:]/g, ''));
    }
  }
  const readme = _read(path.join(root, 'README.md')) || '';

  /* 没有枚举不是缺陷：纯工具包本来就不需要理由码。
     只有「文档在用理由码、代码却没有」才是缺陷——否则会给每一个
     不带诊断码的小库判一条假红，闸门从此被当成噪音。 */
  if (!code.size) {
    if (/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(readme)) {
      _push(res, 'G5', 'README 在用理由码，但 src/ 里没有任何 REASONS / VERDICTS / CODES 定义——文档在描述一套不存在的诊断');
    } else {
      _warn(res, 'G5', '本包没有理由码枚举，跳过对撞（不适用，不是缺陷）');
    }
    return;
  }
  /* 外来码登记：文档里可能引用兄弟包的结论码（本包演示里就引用了 NOT_IN_USE）。
     这类码不该判红，但也不许悄悄放过——必须在 README 里写明出处与理由：
       <!-- selfgate: foreign-code NOT_IN_USE 来自 agent-evidence 的 VERDICTS -->
     不给理由的登记视同没有登记。 */
  const foreign = new Map();
  const fre = /selfgate:\s*foreign-code\s+([A-Z][A-Z0-9_]*)\s+(\S.{3,})/g;
  let fm;
  while ((fm = fre.exec(readme)) !== null) foreign.set(fm[1], fm[2].replace(/\s*-->\s*$/, '').trim());

  /* 文档侧只认「带下划线的全大写」作为理由码候选，避免把 README / MIT 当成码 */
  const doc = new Set(readme.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || []);
  res.facts.reasons = { code: code.size, doc: doc.size, blocks: blocks, foreign: foreign.size };

  for (const d of doc) {
    if (code.has(d)) continue;
    if (foreign.has(d)) { _warn(res, 'G5', '外来码 ' + d + ' 已登记出处：' + foreign.get(d)); continue; }
    _push(res, 'G5', 'README 提到 ' + d + '，代码里没有，也没登记为外来码——文档在承诺一个不存在的诊断');
  }
  /* 代码侧按整词查，不要求带下划线：否则 UNKNOWN / WORKING 这类短码永远查不到，
     等于给每个短码判一条假黄。 */
  const unseen = [...code].filter(function (c) { return !new RegExp('\\b' + c + '\\b').test(readme); });
  if (unseen.length) _warn(res, 'G5', code.size + ' 个码里有 ' + unseen.length + ' 个从未出现在 README：' + unseen.join(','));
}

/* ------------------------------------------------------------- G6 探测副作用 */

/**
 * G6 · 仪器不许有副作用
 * 这条有真实来历：另一个模块的自测曾把夹具写进生产账本（require 即写入），
 * 六条假记录被自省读成了真实事故。
 * 判据：扫描面里出现写盘调用 ⇒ 红，除非该文件显式标注 selfgate: write-ok <理由>（理由必填）。
 *
 * app 模式降级为黄：有状态的应用写盘是主业（账本、缓存、报告），一律判红等于
 * 让闸门在第一天就被当成噪音关掉。但数量必须报出来——不判罪不等于不记账。
 */
function gateSideEffect(root, pkg, res, opts) {
  const app = (opts || {}).profile === 'app';
  const scan = (res.facts.scan && res.facts.scan.files) || [];
  const files = scan.length ? scan : _walk(path.join(root, 'src'), '.js');
  const WRITE = /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|rmSync|unlinkSync|mkdirSync)\s*\(/g;
  let hits = 0;
  const touched = [];
  for (const fp of files) {
    const src = _read(fp) || '';
    if (src.indexOf('writeFile') < 0 && src.indexOf('appendFile') < 0 && src.indexOf('createWriteStream') < 0 && src.indexOf('unlinkSync') < 0 && src.indexOf('rmSync') < 0 && src.indexOf('mkdirSync') < 0) continue;
    const mark = src.match(/selfgate:\s*write-ok\s+(\S.{4,})/);
    const found = _maskNonCode(src).match(WRITE);
    if (!found) continue;
    if (mark) { _warn(res, 'G6', _rel(root, fp) + ' 有写盘但已标注豁免：' + mark[1].slice(0, 40)); continue; }
    hits += found.length;
    touched.push(_rel(root, fp));
    if (app) continue;
    _push(res, 'G6', _rel(root, fp) + ' 有 ' + found.length + ' 处写盘，却没有任何豁免标注——require 一个判定库就写盘，是最脏的一种副作用');
  }
  res.facts.sideEffect = { files: files.length, writes: hits, touched: touched.length };
  if (app && hits) {
    _warn(res, 'G6', 'app 模式：' + touched.length + ' 个文件共 ' + hits + ' 处写盘（有状态应用属主业，不判红；数量记账）');
  }
}

/* --------------------------------------------------------------- G7 扫描面 */

/**
 * G7 · 分母必须可见
 *
 * 这条是本闸门在真仓库上跑过之后才加的：G1 只扫 src/ 时报了 rc=1，
 * 却完全没说它只看了 951/4,553 = 20.9% 的文件。用户看到的是一个结论，
 * 看不到结论背后少看了五分之四。**扫了 1 个目录就报结论，比扫 0 个更难发现。**
 *
 * 判据：扫 0 个文件 ⇒ 按没查处理（rc=2）；覆盖率 < 50% ⇒ 黄，并写出分母。
 */
function gateCoverage(root, pkg, res) {
  const s = res.facts.scan || { files: [], dirs: [], repoFiles: 0, explicit: false };
  const scanned = s.files.length;
  const repo = s.repoFiles;
  const ratio = repo ? Math.round((scanned / repo) * 1000) / 1000 : null;
  res.facts.coverage = { scanned: scanned, repo: repo, ratio: ratio, dirs: s.dirs, explicit: !!s.explicit };

  if (scanned === 0) { _push(res, 'G7', '扫描面为 0 个文件——按没查处理，不许当通过'); return; }
  /* lib 模式的边界由 package.json 的 files 定义：只审发布面是设计，不是漏扫。
     若在这里也按 50% 判黄，每个正经的 npm 包（src+bin 五六个文件、test 十几个）
     都会常驻一条黄，闸门第一天就被当成噪音。分母照样写进 facts，让人看得到。 */
  const libFace = !s.explicit && !(res.facts.scan && res.facts.scan.profile === 'app');
  if (ratio !== null && ratio < 0.5 && !libFace) {
    const pct = Math.round(ratio * 100);
    const why = s.explicit
      ? '（这是调用方指定的子集，不代表全仓）'
      : '（未被扫到的文件里的缺陷，这条闸门看不见）';
    _warn(res, 'G7', '只扫了 ' + scanned + '/' + repo + ' 个可扫文件（' + pct + '%）' + why);
  }
}

/* -------------------------------------------------------------------- 入口 */

const GATES = [
  ['G1', '依赖：声明 vs 实测', gateDeps],
  ['G2', '文件：声明 vs 磁盘 + 实加载', gateFiles],
  ['G3', '文档：README 命令跑得到', gateDocs],
  ['G4', '测试：有断言且能抓假', gateTests],
  ['G5', '理由码：文档 vs 代码同一份', gateReasons],
  ['G6', '副作用：仪器不许写盘', gateSideEffect],
  ['G7', '扫描面：分母必须可见', gateCoverage],
];

/**
 * 审一个包。只返回结构，不做任何输出。
 * @param {string} root 包根目录
 * @param {{fast?:boolean, only?:string[]}} [opts]
 * @returns {{rc:number, red:Array, yellow:Array, facts:object, ran:string[], why:string}}
 */
function audit(root, opts) {
  const o = Object.assign({}, opts || {});
  const res = { rc: 0, red: [], yellow: [], facts: {}, ran: [], why: '' };

  const pkgTxt = _read(path.join(root, 'package.json'));
  if (pkgTxt === null) { res.rc = 2; res.why = '没有 package.json（按没查处理，不许当通过）'; return res; }
  let pkg;
  try { pkg = JSON.parse(pkgTxt); } catch (e) {
    _push(res, 'G1', 'package.json 不是合法 JSON：' + (e && e.message || e));
    res.rc = 1;
    return res;
  }

  /* 载体必须在算扫描面之前定下来：扫描面、G2、G6、G7 全都看它。
     显式指定才尊重调用方，否则自动判——默认 lib 是错的默认值（应用会被
     套上「判定库不许写盘」的判据，一次刷出几百条假红）。 */
  o.profile = (o.profile === 'app' || o.profile === 'lib') ? o.profile : _inferProfile(root, pkg);

  /* 扫描面在进闸门之前算一次，所有闸门共用同一个分母——
     各闸门自己决定扫哪儿，就会像原来那样：G1 看 src/，G4 看 test/，
     两个目录之外的东西谁都不负责，而报告看起来是完整的。 */
  const scan = _resolveScan(root, o);
  const repoList = _walkAny(root, ['.js', '.cjs', '.mjs']);
  res._repo = repoList;   /* 内部用：测试面不该受「代码扫描面」限制，见 gateTests */
  res.facts.scan = {
    dirs: scan.dirs,
    files: scan.files,
    repoFiles: repoList.length,
    explicit: scan.explicit,
    profile: o.profile,
  };

  const hasReadme = _read(path.join(root, 'README.md')) !== null;
  if (!hasReadme && !scan.files.length) {
    /* 早退也要把分母写出来：不然调用方只拿到一个 rc=2，
       看不见「一个文件都没扫」这个事实，会以为是闸门环境出错。 */
    res.facts.coverage = { scanned: 0, repo: res.facts.scan.repoFiles, ratio: 0, dirs: scan.dirs, explicit: !!scan.explicit };
    res.rc = 2; res.why = '扫描面为空（既无 README 也无代码文件）⇒ 按没查处理';
    return res;
  }

  const only = o.only && o.only.length ? o.only : null;
  for (const g of GATES) {
    const id = g[0], name = g[1], fn = g[2];
    if (only && only.indexOf(id) < 0) continue;
    res.ran.push(id + ' ' + name);
    try {
      fn(root, pkg, res, o);
    } catch (e) {
      _push(res, id, '闸门自身抛异常（按红处理，不按通过）：' + (e && e.message || e));
    }
  }

  res.rc = res.red.length ? 1 : 0;
  /* 扫 0 个文件不是「没红」，是「没查」——rc 必须区分这两件事 */
  if (res.facts.coverage && res.facts.coverage.scanned === 0) {
    res.rc = 2;
    res.why = '扫描面为 0 个文件 ⇒ 按没查处理';
  }
  return res;
}

module.exports = { audit, GATES };
