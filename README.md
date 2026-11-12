# hx-agent-gates

三个零依赖的闸门。每个只回答一个**可以被证伪**的问题 —— 也就是说，它能给出「不通过」，并且给出不通过的具体位置。

不是框架，没有插件系统，不需要配置。`git clone` 完直接 `node` 跑，没有 `npm install`。

```
证据链 agent-evidence ｜ 冲突裁决 agent-arbiter ｜ 包结构 gatekit
Node >= 18.13 ｜ 零运行时依赖 ｜ 213 条用例 ｜ CI: Node 18/20/22 + engines 一档
```

---

## 30 秒看懂

| 包 | 它只回答这一个问题 | 它**不**回答什么 |
|---|---|---|
| [`agent-evidence`](agent-evidence/) | 这份结论里，有几条能在代码里找到证据？找不到的那几条，缺什么命令才能补上？ | 结论对不对。它只查「有没有证据」，不查「证据支不支持」 |
| [`agent-arbiter`](agent-arbiter/) | 两个真源打架时，该信哪个？凭什么？ | 哪个数据源更权威。权威性由你声明，它只负责让冲突收敛或显式认输 |
| [`gatekit`](gatekit/) | 这份产物是它自称的那个东西吗？宿主真会读你写的字段吗？ | 产物好不好用。它只看结构契约：清单、签名、版本下限 |

三个都遵守同一条纪律：**判定是函数返回值，不是一段说明文字。**
凡是「审计器自己没跑起来」「样本是 0」「链路断了」，一律不折算成通过。

## 判定只有四态，不是两态

| 状态 | 含义 | 退出码 |
|---|---|---|
| `red` 红 | 确实有缺陷，能指到文件:行 | 1 |
| `yellow` 黄 | 能跑，但会误导使用者（例如写了宿主不解析的字段） | 0 |
| `unmeasured` 不可判 | **没查到** —— 既不算过，也不算错 | 0（但单独列出） |
| 空跑 | 0 个样本 / 0 个文件 | **2** |

把「没查到」和「查了没问题」并成一档，是这类工具最常见、也最难发现的放水方式 —— 因为它的表现是**绿**。
所以空跑的退出码是 `2`，永远不与「通过」共用 `0`。

## 怎么跑

```bash
git clone https://github.com/junyi040521/hx-agent-gates && cd hx-agent-gates

npm test        # 三包全部用例，零依赖、不需要 npm install
npm run audit   # 用 gatekit 审自己 + 另两包
npm run sync    # 两份 selfgate 必须字节一致（防改一份忘另一份）
npm run check   # 以上三件一起
```

审任意一个包，只读、不改任何东西：

```bash
node gatekit/bin/cli.js audit ./some-pkg
```

```
  root   /path/to/some-pkg
  ran    identity / manifest / runtime
  红 0 ｜ 黄 1 ｜ rc 0
  ~ [identity] NO_SIG  全包没有一处版本签名声明——没法用签名验「发出去的是不是这一份」，只能靠版本号一处
```

黄的那条不想懂？直接问它：

```bash
node gatekit/bin/cli.js explain NO_SIG
```

```
  NO_SIG              全包没有一处版本签名，没法验「发出去的是不是这一份」
```

不带参数则列出全部判据码；问一个不存在的码会以 `rc=2` 退出，**不会**退回全表糊过去。

## 目录

```
agent-evidence/            证据链审计：结论 → 每条挂一个可跑命令 → 跑不出来的显式记账
  src/                     审计器本体
  test/                    73 条用例（含反向证伪）
agent-arbiter/             冲突裁决：多真源对撞 → 收敛到一个口径 / 显式 unjudgeable
  src/  test/              74 条用例
gatekit/                   包结构审计：npm 包 / 技能包 / 技能集合包 / 插件包 四种载体
  bin/cli.js               唯一出口：audit ／ explain
  src/identity.js          清单发现、semver、签名形状（不按目录判，按形状判）
  src/manifest.js          四类清单解析（frontmatter 支持块标量 | 与 >）
  src/runtime.js           15 条版本敏感特征 + FLOOR 表 + 单步词法器
  test/                    66 条用例
scripts/test-all.js        跨包串行跑测试，每包独立计时
scripts/audit-all.js       跨包自审，任何红即失败
check-selfgate-sync.js     两份 selfgate 的 sha1 必须一致
.github/workflows/ci.yml   CI：三档 Node 矩阵 + 一档专验 engines 真拦得住
```

## 测试

```bash
npm test
```

```
包                 用例      通过      失败      耗时        结果
------------------------------------------------------------
agent-evidence    73      73      0       1841ms    PASS
agent-arbiter     74      74      0       1626ms    PASS
gatekit           66      66      0       3984ms    PASS

[PASS] 全部 3 个包通过
```

重点不是「合法输入给绿」，而是**注入坏样本必须转红，撤除必须归零**。
一个永远返回 `ok` 的函数能通过全部合法输入用例 —— 所以每条判据都配一条反向证伪。
`gatekit explain` 的四条用例就是最小样本：不带参数打全表、带码只打一条、小写也认、乱写必须 `rc=2` 且不许退回全表。

## CI 是真在跑

`.github/workflows/ci.yml`，push 到 main 与 PR 都触发。首跑 4 个 job 全绿：

| Job | 断言什么 |
|---|---|
| `test / node 18.20.4` | 213 条用例 + 两份 selfgate 同步 + 自审 rc=0 |
| `test / node 20` | 同上 |
| `test / node 22` | 同上 |
| `engines 下限必须真的拦住` | 在 Node 16 上 `npm install` 必须失败，且**必须是被 `EBADENGINE` 拦的** |

最后一档是重点：原来的写法是「只要装不上就算通过」—— registry 5xx、网络抖动都会让它变绿，而 `engines` 可能根本没生效。
现在要求输出里出现 `npm ERR! code EBADENGINE`，否则 `::error::` 退出 1。日志原文留档在对应的 Actions run 里。

## 它不做的事

- 不做「代码质量评分」。评分没有可证伪的形状，只有可解释的形状 —— 这里只出能指到 `文件:行` 的红。
- 不猜。缺清单、缺字段、目录名对不上包名，都直接报，不替你补一个默认值。
- 不联网。三个包全部零依赖，审计过程不发任何请求。
- 不因为「跑完了没报错」就说通过 —— 没查到东西就是 `rc=2`。

## License

MIT
