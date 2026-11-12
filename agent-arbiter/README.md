# agent-arbiter

**An orchestrator that can refuse.**

Agent 编排器都在回答「谁先跑、谁后跑」。这个库回答另外四个问题，并且保证四个答案事后都能被追问：

| 问题 | 字段 | 没有它会怎样 |
|---|---|---|
| 谁来做 | `executors[]` | 一个执行者盖不住全部需求，却假装盖住了 |
| 怎么做 | `mode` | 闲聊和删库重建用同一档 |
| 够不够格 | `confidence` vs `modeThreshold` | 把握不足也硬答，答错了才发现 |
| 凭什么 | `why[]` + `verify()` | 事后没人能还原当时为什么这么定 |

**它不执行任何东西。** 执行交给你的 sandbox / MCP / 工具层。这是刻意的：编排器的价值是决策质量，不是多一层抽象。

## 三条不变式（都在测试里）

1. **置信度不足 ⇒ `deferred`**，进队列，不给一个看起来完成的答案。
2. **每个决策必须有 `why[]`**；理由码机器可读（`HIGH_RISK` / `CONFIDENCE_BELOW_MODE` / `NO_EXECUTOR` / `DUPLICATE_DEFERRED`）。
3. **未 `verify()` 的决策只能是 `DECIDED`**，永远不自称 `WORKING`。

## 理由码

| 码 | 意思 |
|---|---|
| `DECIDED` | 能定：模式、执行者、置信度都够 |
| `DEFERRED` | 不能定，入队等条件（**不是失败**） |
| `NO_MODE` | 没有任何模式覆盖所需能力 |
| `NO_EXECUTOR` | 注册表里没人能承担这项能力 |
| `CONFIDENCE_BELOW_THRESHOLD` | 没过全局门槛 |
| `CONFIDENCE_BELOW_MODE` | 过了全局门槛，但没过该档更高的门槛 |
| `AMBIGUOUS_REQUEST` | 请求本身为空或无法解析 |
| `HIGH_RISK` | 高风险请求只够得上低门槛档 ⇒ 拒，不许降档绕过 |
| `DUPLICATE_DEFERRED` | 同一请求已在队列里，不重复排 |
| `EXPIRED` | 队列项超期被 sweep 掉 |
| `UNVERIFIED` | 没有接证据源，不敢称已验证 |
| `VERIFIED` | 接上 `judge` 并给出了结论 |
| `MISSING_WHY` | 决策没带理由码 ⇒ 不许落成任务 |


## 用

```js
const { arbiter } = require('agent-arbiter');

const a = arbiter({
  modes: {
    quick:    { base: 0.80, minConfidence: 0.50, capabilities: ['web', 'calc'] },
    standard: { base: 0.88, minConfidence: 0.65, capabilities: ['web', 'calc', 'memory'] },
    deep:     { base: 0.92, minConfidence: 0.75, capabilities: ['web', 'calc', 'memory', 'code'] },
    careful:  { base: 0.95, minConfidence: 0.90, capabilities: ['web', 'calc', 'memory', 'code', 'human'] },
  },
  registry: {
    web:    { id: 'webSearch',       capabilities: ['web'],    cost: 1 },
    code:   { id: 'sandbox',         capabilities: ['code'],   cost: 5 },
    human:  { id: 'escalateToHuman', capabilities: ['human'],  cost: 10 },
  },
  threshold: 0.6,
});

const d = a.decide({
  request: '把这个函数改成 async，并参考我之前的写法',
  signals: { needsCode: true, needsMemory: true },
});
// { status:'DECIDED', mode:'deep', executors:['vectorMemory','sandbox'], confidence:0.92, why:[...] }
```

`signals` 只收**需求信号**，不收字数、不收关键词：`needsCode / needsWeb / needsMemory / needsTool / needsHuman`，加上 `ambiguity`（0–1）和 `risk`（0–1）。

用字数或词表当判据必然误判 —— 多一个感叹号就跨档的事，我们踩过。

## 三个刻意的设计

**够用就选最低档。** 不是选最严的那档。选最严会让所有请求都落到 `careful`（成本最高、还要拉人），那是过度保守不是安全。升档由风险信号驱动。

**高风险不许靠降档绕过。** `risk ≥ 0.3` 时，只允许 `minConfidence ≥ 0.85` 的模式。低档即使置信度够，也一律拒绝，且理由写 `HIGH_RISK` —— 不能含糊成「置信度不足」。

**一个决策可以有多个执行者。** `web + code` 需要两个人干，贪婪覆盖：每轮选能覆盖剩余需求最多的，同覆盖数取便宜的。盖不住的部分进 `uncovered[]`，直接 `deferred`，不假装盖住了。

## 队列不是垃圾桶

```js
a.queue();   // 被 defer 的决策
a.sweep();   // 过期清理（默认 7 天）+ 去重 + 上限（默认 50）
```

对应一条硬纪律：**队列消化率不到 100%，就别急着产新提案。** 只产不消的系统，队列会替它记住所有欠账。

## 接上证据

编排器说自己做完了，`agent-evidence` 说有没有人在用 —— 两个都留下，才叫可追责。

```js
const { judge, probes } = require('agent-evidence');
const a = arbiter({ modes, registry, judge });

const d = a.decide({ request: '给缓存层接线', signals: { needsCode: true } });
await a.verify(d.id, [
  probes.fileLanded({ file: 'src/chatEngine.js', since: t0 }),
  probes.processLoaded({ file: 'src/chatEngine.js', startedAt: pmStartedAt }),
  probes.calledFrom({ symbol: 'cacheLayer', callers: ['src/chatEngine.js'] }),
]);
// verify: { status:'VERIFIED', verdict:'NOT_IN_USE', landed:'true', effective:'true', useful:'false' }
```

<!-- selfgate: foreign-code NOT_IN_USE 这是 agent-evidence 的结论码，不是本包的定义 -->

不传 `judge` ⇒ `verify()` 永远返回 `UNVERIFIED`。不给你「看起来验证过」的假象。

## 回放

```js
a.replay(d.id);
// steps: need → mode → executor → confidence → status → why → verify
```

## 决策之后：任务要走到哪一步

决策只回答「谁来做、够不够格」，回答不了「现在到哪一步、上次为什么退回来」。
所以包里带一个状态机，规则只有四条：

```
inbox → assigned → in_progress → review → done | failed
```

- **编排者拥有迁移权**，不指望执行者自报状态；
- **每次迁移必须带注释** `{by, what, why}`，缺一项即拒（`THIN_COMMENT`）；
- **`failed` 是合法终态**，能重开回 `inbox`；
- **进 `done` 有两道额外闸**：交接五要素齐全（做了什么 / 产物在哪 / 怎么验 / 已知问题 / 下一步），且 `verify` 不为 `UNVERIFIED`。

```js
const { lifecycle } = require('agent-arbiter');
let t = lifecycle.toTask(decision);      // DECIDED ⇒ assigned，DEFERRED ⇒ inbox
t = lifecycle.move(t.record, 'in_progress', { by: 'orch', what: '派给 sandbox', why: '要跑测试' }).record;
const h = lifecycle.handoff({ done: '改了 TTL', artifacts: 'src/cache.js', verify: 'npm test cache' });
h.missing;   // [ 'issues', 'next' ] —— 缺哪两项，说清楚
```

`toTask` 把决策的 `why[]` 抄成任务的第一条注释，所以**排队不是一句道歉，是一次可回放的迁移**。

生命周期自己的码：`LEGAL`（迁移合法）· `ILLEGAL_TRANSITION`（表里没有这条路）· `THIN_COMMENT`（注释三要素没写全）· `THIN_HANDOFF`（交接五要素没写全）· `BAD_STATE`（状态名不认识，错别字不算新状态）。

## 自证闸门

一个永远给绿的判定器，与一个不判定的判定器，输出完全一样。所以这个包先审自己：

```bash
node demo/run.js
```

装好后同一件事写成 `npx agent-arbiter audit`。六道闸门：依赖声明 vs 实际 require（双向）· `files`/`main` 声明 vs 磁盘 + 实加载 · README 命令能不能真跑 · 测试是否有断言且**至少一条能否定** · 文档理由码 vs 代码常量（双向）· `src/` 有没有偷偷写盘。

退出码：`0` 全绿 / `1` 有红 / `2` 没查到东西（按没查处理，不许当通过）。

## 边界

- 它不执行、不重试、不做流控。执行层出问题不归它管。
- 状态机不管并发：两个进程同时改同一条记录会互相覆盖。要并发，自己加 fencing token（一个事实，一个写者）。
- `confidence` 是**可解释的加权**（基线 − 歧义×0.4 − 风险×0.3 − 能力缺口×0.3），不是模型自评。数值是可复算的，不是拍脑袋。
- 默认策略是保守（defer 而非硬答）。要激进就调 `threshold`，但要接受后果。

## License

MIT

签名：agent-arbiter v0.1.0
