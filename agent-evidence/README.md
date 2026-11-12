# agent-evidence

**Your agent said done. Prove it.**

每个「AI 已改好」的声明，都拆成三个互不蕴含的问题：

| 问题 | 含义 | 常见骗局 |
|---|---|---|
| `landed` | 产物真的变了？ | 文件写了但内容一样；mtime 被 `cp -p` 伪造成旧时间 |
| `effective` | 运行中的系统真的加载了？ | 文件改对了，进程还是旧代码 |
| `useful` | 业务路径真的调用了？ | 接线只存在于注释里；账本记的是心跳不是产物 |

答案不只 true / false —— **`null` 是一等公民**。因为大多数验证工具在这三处放水，于是它们永远给你一个漂亮的绿色，而那个绿色是拿「我没查」换来的。

```
  claim   缓存层已接入对话主链
  verdict NOT_IN_USE
  landed     ✓  产物变了？
  effective  ✓  系统加载了？
  useful     ✗  有人真在调用？
  reasons  useful:NOT_CALLED
```

## 安装

```bash
npm i agent-evidence
```

零依赖，Node ≥ 18。

## 用

```js
const { judge, probes, report } = require('agent-evidence');

const r = await judge({
  claim: '缓存层已接入对话主链',
  checks: [
    probes.fileLanded({ file: 'src/chatEngine.js', since: t0 }),
    probes.processLoaded({ file: 'src/chatEngine.js', startedAt: pmStartedAt }),
    probes.calledFrom({ symbol: 'cacheLayer', callers: ['src/chatEngine.js'] }),
  ],
});

r.verdict;    // 'WORKING' | 'NOT_IN_USE' | 'NOT_LOADED' | 'NO_CHANGE' | 'UNKNOWN'
r.landed;     // 'true' | 'false' | 'null'
process.stdout.write(report(r));
```

自定义探针只要长这样，一个函数就够：

```js
{
  level: 'effective',
  id: 'k8s:rollout-complete',
  run: async () => ({ ok: true, n: 12, observedAt: Date.now(), evidence: { ... } }),
}
```

## CLI

四条命令，**都在仓库里直接跑得起来**（不用先 `npm i`，也不用信我）：

```bash
node bin/cli.js audit
```
```bash
node bin/cli.js check --file src/judge.js --since 2020-01-01 --symbol judge --caller bin/cli.js
```
```bash
node bin/cli.js ledger --file demo/fixtures/learn_heartbeat.jsonl
```

装好之后同样的事写成 `npx agent-evidence audit` / `npx agent-evidence check ...`。

退出码：`0` = WORKING（或闸门全绿），`1` = 其它结论（或有红），`2` = 用法错误 / 没查到东西。**故意让「不是 WORKING」也非零** —— CI 里能直接拦。

## 它先审自己

一个永远给绿的判定器，与一个根本不判定的判定器，输出完全一样。所以包里带六道自证闸门（`node bin/cli.js audit`）：

| 闸 | 查什么 | 抓的典型病 |
|---|---|---|
| G1 | 依赖声明 ↔ 实际 `require`，双向 | 声明了没用到（虚胖）、用到了没声明（别人装不上） |
| G2 | `files`/`main`/`bin` ↔ 磁盘 + **实加载** | 残包、空壳导出、`bin` 没进 `files`（本机跑得通、装完没这条命令） |
| G3 | README 里的 `node ...` 命令真跑一遍 | 文档写了三个月前就不成立的命令 |
| G4 | 每个测试有断言，且全包**至少一条否定断言** | 从没证明过自己能抓假的测试集 |
| G5 | 文档理由码 ↔ 代码枚举，双向 | 文档承诺一个不存在的诊断；新码加了没人知道 |
| G6 | `src/` 有没有偷偷写盘 | `require` 一个判定库就往生产账本里写 |

三条纪律：**闸门自身抛异常按红处理**（不许静默变绿）；**扫描面为 0 ⇒ rc=2**（按没查处理，不许当通过）；**每条闸门都能被注入坏样本打红**（19 条反向证伪用例写在 `test/selfgate.test.js` 里，撤除缺陷必须回到 0 红）。

闸门设计来自同一作者内部专家包的 34 道 R 闸门体系，这里只固化与「库自证」相关的六条，实现零耦合、零依赖。

## 理由码（机器可消费，别写自然语言）

`verdict` 回答「到什么程度」，`reasons[]` 回答「凭什么」。分开是因为前者只有一个，后者可能有好几个。

| 码 | 类型 | 什么时候出现 |
|---|---|---|
| `WORKING` | 结论 | 三级全 true —— 唯一给 rc=0 的结论 |
| `NOT_IN_USE` | 结论 | landed + effective 都为真，但没人调用 |
| `NOT_LOADED` | 结论 | 文件改了，进程没加载 |
| `NO_CHANGE` | 结论 | 文件根本没变 |
| `UNKNOWN` | 结论 | 证据不足以下结论 |
| `EVIDENCE_OK` | 诊断 | 该级探针通过 |
| `STALE_PROCESS` | 诊断 | 进程启动早于文件 mtime |
| `NOT_CALLED` | 诊断 | 声明的调用点里没有这个符号的调用 |
| `NO_PRODUCT` | 诊断 | 账本有行数，但没有产物字段 |
| `NO_DATA` | 诊断 | 零样本却判通过 ⇒ 降级 null |
| `NO_CHECK` | 诊断 | 某一级没给探针（不静默继承） |
| `LOW_SAMPLE` | 诊断 | 样本 < 3 的肯定结论 |
| `UNJUDGEABLE` | 诊断 | 证据采集时刻超出结论窗口 |
| `UPSTREAM_NOT_TRUE` | 诊断 | 上游不是 true，下游强制 null |
| `CHECK_THREW` | 诊断 | 探针抛异常（按红处理，不按通过） |
| `MIN_SAMPLE` | 常量 | 样本门槛默认值 3 |

**理由码必须能被程序聚合**：写「置信度不足」这种短语，等于把可统计的东西变成不可统计的。

## 三条不可让步的规矩

1. **链断不猜** —— 上游不是 `true`，下游一律 `null`。绝不给 `false` 来假装「查过了」。
2. **零样本不许判通过** —— 声称成功但样本为 0 ⇒ 降级 `null` + `NO_DATA`；样本 < 3 的肯定结论标 `LOW_SAMPLE`。否定结论不受限（「扫到 0 个调用点」本身就是结论）。
3. **超窗证据不可判** —— 证据采集时刻超出结论时刻 5 分钟窗口 ⇒ `UNJUDGEABLE`。这条拦的是「先下结论、后补证据」。要严格模式传 `posthocToleranceMs: 0`。

## 边界（不假装没有）

- `calledFrom` 是**静态扫描**：能看到「定义了但没接线」，看不到运行期分支是否真走到。要判断后者，传 `ledger` 读真实调用条数，或自己写 runtime 探针。
- 静态扫描已剔除注释、函数定义、`require` 引用，但**字符串字面量里同形文本无法完全区分**。
- `processLoaded` 依赖你提供进程启动时刻；对容器请传 `started_at`。
- 它不替你修，只替你**拒绝撒谎**。

## 为什么要这个库

一个跑了六千次自改的线上单体告诉我们：**执行率 97%，兑现率 17.6%**。差的不是能力，是没人量过「改了之后到底有没有人在用」。

于是账本越积越厚：三万三千条学习记录，字段只有 `ts / totalEntries / level`。它证明「我又跑了一次、我数到了 20 条」，不证明「我吸进来一条东西，它现在在起作用」。

这个库只做一件事：把这三句话分清楚。

## License

MIT

签名：agent-evidence v0.1.0
