'use strict';
/**
 * manifest 的反向证伪测试：两种载体，同一种错法
 */

const test = require('node:test');
const assert = require('node:assert');
const { manifest, frontmatter, topKeys } = require('../src/manifest');
const { mk, rm, hasCode, hasYellow, cleanup } = require('./_util');

test.after(cleanup);

function npmPkg(over, dirName) {
  return mk(Object.assign({
    'package.json': { name: 'fx', version: '1.0.0', description: 'd', license: 'MIT' },
    'LICENSE': 'MIT\n',
  }, over || {}), dirName || 'fx');
}

function skillPkg(fm, dirName) {
  return mk({ 'SKILL.md': '---\n' + fm + '\n---\n\n# body\n' }, dirName || 'myskill');
}

/* ------------------------------------------------------------------ npm */

test('npm 干净基线：0 红', function () {
  const r = manifest(npmPkg());
  assert.strictEqual(r.red.length, 0, JSON.stringify(r.red));
  assert.strictEqual(r.kind, 'npm');
});

test('npm 缺 name / version ⇒ 红', function () {
  assert.ok(hasCode(manifest(npmPkg({ 'package.json': { version: '1.0.0' } })), 'NO_NAME'));
  assert.ok(hasCode(manifest(npmPkg({ 'package.json': { name: 'fx' } })), 'NO_VERSION'));
});

test('npm 字段类型不对 ⇒ 红（宿主按字符串取，取到空）', function () {
  const r = manifest(npmPkg({ 'package.json': { name: 'fx', version: '1.0.0', description: ['a', 'b'] } }));
  assert.ok(hasCode(r, 'FIELD_TYPE'), JSON.stringify(r.red));
});

test('npm 布尔写成字符串 ⇒ 红（"false" 会被整条丢弃）', function () {
  const bad = npmPkg({ 'package.json': { name: 'fx', version: '1.0.0', private: 'false' } });
  assert.ok(hasCode(manifest(bad), 'BOOL_LITERAL'));

  const good = npmPkg({ 'package.json': { name: 'fx', version: '1.0.0', private: true } });
  assert.ok(!hasCode(manifest(good), 'BOOL_LITERAL'));
});

test('npm 同名键重复 ⇒ 红（后者静默覆盖前者）', function () {
  const raw = '{"name":"fx","version":"1.0.0","version":"2.0.0"}';
  const d = mk({ 'package.json': raw, 'LICENSE': 'MIT\n' }, 'fx');
  const r = manifest(d);
  assert.ok(hasCode(r, 'DUP_KEY'), JSON.stringify(r.red));
});

test('npm 声明许可却没有全文 ⇒ 红（承诺了查不到依据的事）', function () {
  const d = mk({ 'package.json': { name: 'fx', version: '1.0.0', license: 'Apache-2.0' } }, 'fx');
  assert.ok(hasCode(manifest(d), 'LICENSE_NO_TEXT'));
});

test('topKeys 只数顶层键（嵌套同名不算重复）', function () {
  const raw = '{"a":1,"b":{"a":2,"a":3},"a":4}';
  const c = topKeys(raw);
  assert.strictEqual(c.get('a'), 2, '顶层 a 出现 2 次；嵌套里的 a 不该算进来');
  assert.strictEqual(c.get('b'), 1);
});

/* ---------------------------------------------------------------- skill */

test('skill 干净基线：0 红 0 黄', function () {
  const r = manifest(skillPkg([
    'name: myskill',
    'description: 当用户要求审计发布包自洽性时使用。Use when the user asks for publish audits.',
  ].join('\n')));
  assert.strictEqual(r.red.length, 0, JSON.stringify(r.red));
  assert.strictEqual(r.yellow.length, 0, JSON.stringify(r.yellow));
  assert.strictEqual(r.kind, 'skill');
});

test('skill 缺 description ⇒ 红（整条不进候选集，不是降级）', function () {
  const r = manifest(skillPkg('name: myskill'));
  assert.ok(hasCode(r, 'NO_DESCRIPTION'));
  assert.ok(/整条技能不进候选集/.test(r.red[0].msg));
});

test('skill 目录名 ≠ frontmatter name ⇒ 红（两个视角两种命运）', function () {
  const d = skillPkg('name: other-name\ndescription: 当用户说审计时使用', 'myskill');
  assert.ok(hasCode(manifest(d), 'DIR_NE_NAME'));
});

test('skill 布尔非字面量 ⇒ 红', function () {
  const d = skillPkg('name: myskill\ndescription: 当用户说审计时使用\nuser-invocable: yes');
  assert.ok(hasCode(manifest(d), 'BOOL_LITERAL'));
});

test('skill 白名单外的字段 ⇒ 黄（写了不生效）', function () {
  const d = skillPkg('name: myskill\ndescription: 当用户说审计时使用\nhomepage: http://x');
  assert.ok(hasYellow(manifest(d), 'FIELD_IGNORED'));
});

test('skill description 超上限 ⇒ 红；四段合计超 ⇒ 黄（分母不止一段）', function () {
  const long = 'x'.repeat(1100);
  const d = skillPkg('name: myskill\ndescription: ' + long);
  const r = manifest(d);
  assert.ok(hasCode(r, 'FIELD_TOO_LONG'));
  assert.ok(r.facts.budget.total >= 1100);

  const d2 = skillPkg([
    'name: myskill',
    'description: ' + 'a'.repeat(600),
    'description_en: ' + 'b'.repeat(600),
  ].join('\n'));
  const r2 = manifest(d2);
  assert.ok(!hasCode(r2, 'FIELD_TOO_LONG'), '单段都没超');
  assert.ok(hasYellow(r2, 'BUDGET_OVER'), '但合计超了，意图识别吃的是合计');
});

test('skill description 没有触发语 ⇒ 黄（装着但选不中）', function () {
  const d = skillPkg('name: myskill\ndescription: 一个用于审计发布包的工具');
  assert.ok(hasYellow(manifest(d), 'NO_TRIGGER'));
});

test('skill 没有 frontmatter ⇒ 红', function () {
  const d = mk({ 'SKILL.md': '# just markdown\n' }, 'myskill');
  assert.ok(hasCode(manifest(d), 'NO_FRONTMATTER'));
});

test('frontmatter 解析：引号会被剥掉，非法行忽略', function () {
  const fm = frontmatter('---\nname: "q"\nbad line\nk: v\n---\n');
  assert.strictEqual(fm.get('name'), 'q');
  assert.strictEqual(fm.get('k'), 'v');
  assert.strictEqual(fm.has('bad line'), false);
});

test('载体自动判定：有 SKILL.md 就是 skill', function () {
  const d = mk({ 'SKILL.md': '---\nname: pkg\ndescription: 当用户说 x 时\n---\n', 'package.json': { name: 'pkg' } }, 'pkg');
  assert.strictEqual(manifest(d).kind, 'skill');
});

test('两种载体都不存在 ⇒ noData', function () {
  const d = mk({ 'README.md': '# x\n' });
  const r = manifest(d);
  assert.strictEqual(r.noData, true);
  assert.strictEqual(r.ok, false);
});

/* ------------------------------------------------------- 技能集合包（第三种载体） */

test('技能集合包：包根无 SKILL.md 但 skills/<x>/SKILL.md 成堆 ⇒ 逐个审，不 noData', function () {
  const d = mk({
    '.codebuddy-plugin/plugin.json': { name: 'set', version: '1.0.0' },
    'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: 当用户说甲时使用\n---\n',
    'skills/beta/SKILL.md': '---\nname: beta\ndescription: 当用户说乙时使用\n---\n',
  }, 'set');
  const r = manifest(d);
  assert.strictEqual(r.kind, 'skillset');
  assert.strictEqual(r.facts.skills, 2);
  assert.strictEqual(r.noData, false, '查到了东西就不许标 noData');
  assert.strictEqual(r.red.length, 0, JSON.stringify(r.red));
});

test('技能集合包：某个子技能缺 description ⇒ 红，并标出是哪一个', function () {
  const d = mk({
    'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: 当用户说甲时使用\n---\n',
    'skills/beta/SKILL.md': '---\nname: beta\n---\n',
  }, 'set');
  const r = manifest(d);
  const hit = r.red.filter(function (x) { return x.code === 'NO_DESCRIPTION'; });
  assert.strictEqual(hit.length, 1);
  assert.strictEqual(hit[0].skill, 'beta');
});

test('技能集合包：skills/ 下没有任何 SKILL.md ⇒ noData（不是通过）', function () {
  const d = mk({ 'skills/readme.md': '# empty\n' }, 'set');
  const r = manifest(d);
  assert.strictEqual(r.noData, true);
});

test('frontmatter 块标量（|）必须被读进来，否则每个技能都判「没有触发语」', function () {
  const d = mk({
    'SKILL.md': [
      '---',
      'name: blocky',
      'description: |-',
      '  浏览器自动化：打开网页、点击与填表。',
      '  用我：用户说「帮我操作这个网站」。',
      'when-to-use: 帮我点这个网站',
      '---',
      '',
      '# body',
      '',
    ].join('\n'),
  }, 'blocky');
  const r = manifest(d);
  assert.ok(r.facts.budget.total > 0, 'description 不能是空的：' + JSON.stringify(r.facts.budget));
  assert.ok(!hasYellow(r, 'NO_TRIGGER'), '块标量里已经有触发语：' + JSON.stringify(r.yellow));
});
