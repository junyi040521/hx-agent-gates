# gatekit

**发布前的三个问题，一个命令答完。**

```bash
npx gatekit audit
```

```
  红 1 ｜ 黄 0 ｜ rc 1
  ✗ [identity] FUTURE_VERSION  CHANGELOG.md:12 出现 v1.3.0 > 当前 v1.2.3（不存在未来版本）
  ✗ [manifest] BOOL_LITERAL    private = 「false」不是布尔字面量（yes/1/"false" 都会被整条丢弃）
  ~ [runtime] UNUSED_DEP       声明了 jsdom 但从未 require（虚胖依赖）
  FAIL 不许发布
```

三个问题，各一个审计器：

| 审计器 | 问什么 | 典型病灶 |
|---|---|---|
| `identity` | **发出去的那份，是不是它自己声称的那一份？** | 版本号写在四十几处，签名行还是上一版；`__pycache__` 混进包 |
| `manifest` | **我读到的字段，宿主是不是也这么读？** | `"private": "false"` 被整条丢弃；缺 `description` 整条技能不进候选集 |
| `runtime` | **换了机器，它凭什么能跑？** | 用了 `?.` / `structuredClone`，`engines` 写着 `>=12` |

## 为什么不是又一个 lint

因为这三类错**都能通过所有现有检查**：语法过、测试过、`npm pack` 过、本地装过。它们只在两个时刻暴露——别人装的时候，和三个月后你自己读文档的时候。

三条共同纪律：

1. **只返回结构化结果**，不打印、不 exit。判定不许压在打印格式上——改一句文案就能让闸门失效，那不叫闸门。
2. **没查到东西 ⇒ `rc=2`**，不是 `rc=0`。「扫了 0 个文件」和「全绿」是两件事，本库拒绝把它们混成一个数。
3. **每条判据都必须能被注入坏样本打红**。见 `test/`：61 条用例里一半是「注入 → 必须转红 → 撤除 → 必须归零」。只测「合法输入给绿」等于没测——一个永远给绿的函数也能全过。

## 四种形态，一个命令

同一个包圈子有四类东西，错法完全一样：

```bash
gatekit audit ./my-pkg          # npm 包（package.json）
gatekit audit ./skills/my-skill # 技能包（SKILL.md frontmatter）
gatekit audit ./my-expert-pack  # 技能集合包（skills/<x>/SKILL.md 成堆）
gatekit audit ./plugin          # 插件包（.codebuddy-plugin/plugin.json）
```

目录可以写成位置参数，也可以用 `--root <dir>`，但不许两个一起给——给多了就报错退出，
不猜你想审哪个。早先版本会静默丢掉位置参数、退回审 cwd，输出 `rc=2` 却很像「通过了」。

载体自动判定，四种都不需要配置。判据随载体切换：

| 形态 | 版本清单 | 特有判据 |
|---|---|---|
| npm 包 | `package.json` | 字段类型、必填、重复键、许可全文 |
| 技能包 | `package.json` 或 `plugin.json` | frontmatter 必填、布尔字面量、四段预算、触发语、目录名 = name |
| 技能集合包 | 同上 | 逐个审 `skills/<x>/`，红里带 `skill` 字段说明是哪一个 |
| 插件包 | `.codebuddy-plugin/plugin.json` | 同技能包 |

**技能这一侧基本没人管。** 平台校验器只查结构，不查「description 里有没有触发语」——没有触发语的技能装着但永远选不中，而所有人都以为它生效了。

## 判据码

```bash
gatekit explain     # 全部 30 条，每条一句话
```

几条最贵的：

| 码 | 为什么它值钱 |
|---|---|
| `FUTURE_VERSION` | 唯一可以无条件判红的形态：比清单更高的同主版本号，一定是错的。更低的只有在声明位才算错——写在历史叙述里是证据 |
| `STALE_SIG` | 同一事实写了四十几份，没有东西在它们不一致时变红 |
| `BOOL_LITERAL` | 字段在、内容对、**0 生效**。`"false"` 不是布尔 |
| `DUP_KEY` | 同名键后者静默覆盖前者，读的人以为写的是前者 |
| `FLOOR_MISMATCH` | 本地 Node 22 全绿，用户 Node 16 上第一行就炸 |
| `DIR_NE_NAME` | 宿主按 `name` 索引：按目录找得到它，按 name 找不到 |
| `NO_TRIGGER` | description 是触发条件，不是功能摘要 |
| `RESIDUE` | 打包器排除了 ≠ 包是干净的，换个人手 zip 就带出去 |

## 边界（写明不做的部分）

- **不判第三方包的版本**，只判「声明了没有、用到了没有」。
- **不判动态 `require(变量)`**：名字是运行时拼的，静态不可判。这类会单独计数并报出，不冒充已查。
- **`--check` 只证明语法**，语法下限靠特征表推。特征表是经验的，不是规范——它宁可保守（把 `Array.at` 按 17 计）。
- **不判宿主侧解释器**：`engines` 写对了，用户不装对版本仍然会炸。

## 已知来源

判据来自一套自研 Agent 系统的发布闸门（34 道，Python 实现），这里按 npm/技能包生态重写，**不引用那份代码**。同一套判据在那份包上修前 10 红：5 处陈旧签名 + 5 个字节码残留，修后 0 红。

---

MIT · Node ≥ 18 · 零运行时依赖

签名：gatekit v0.1.0
