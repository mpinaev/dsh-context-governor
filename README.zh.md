# dsh-context-governor

[English](README.md) | [Русский](README.ru.md) | **中文**

[![npm](https://img.shields.io/npm/v/dsh-context-governor)](https://www.npmjs.com/package/dsh-context-governor)
[![CI](https://github.com/mpinaev/dsh-context-governor/actions/workflows/ci.yml/badge.svg)](https://github.com/mpinaev/dsh-context-governor/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-context-governor)](LICENSE)

一个 DeepSeek Harness 插件：会话上下文指示器——prompt 大小、单步费用、缓存命中、
档位与压缩阈值、DeepSeek 余额与高峰/低谷费率，外加一个交接按钮。

**它从不调用模型，也完全不消耗 token**——详见下文。

## 界面预览

会话头部的胶囊（chip）展开后就是下面的面板。面板支持英语、中文和俄语：

| English | 中文 | Русский |
|---|---|---|
| ![Session context panel in English](https://raw.githubusercontent.com/mpinaev/dsh-context-governor/main/assets/screenshot-1.png) | ![会话上下文面板（中文）](https://raw.githubusercontent.com/mpinaev/dsh-context-governor/main/assets/screenshot-2.png) | ![Панель контекста сессии (русский)](https://raw.githubusercontent.com/mpinaev/dsh-context-governor/main/assets/screenshot-3.png) |

交接按钮位于模型选择器旁边：

![交接按钮](https://raw.githubusercontent.com/mpinaev/dsh-context-governor/main/assets/screenshot-4.png)

## 不消耗 token，不调用模型

插件显示的一切都是**测量与算术**。它从 harness 投影读取 token 和窗口，用配置的费率
计算费用，并通过 HTTP 获取余额。

- **没有生成请求。** 不做审阅、不做摘要、不在后台：插件从不请求模型计算任何东西。
- **零 token。** 插件不向提供方发送请求，不花你一分预算。它唯一接触 LLM 层的地方是
  读取模型目录（`resolveModelInfo`）以获取窗口和上限；那不是生成，也不计费。
- **不改动任何东西。** 它不碰历史、系统提示词或前缀缓存，因此不会影响 prompt 缓存。
- **只有余额会用到网络。** harness 账户服务（已登录时）和
  `api.deepseek.com/user/balance` 都不是模型。另外，点击交接时会在本地执行一次
  `git status`。

## 安装

作为包安装：

```sh
dsh plugin --profile web add dsh-context-governor
```

从源码安装：

```sh
dsh plugin --profile web add github:mpinaev/dsh-context-governor
```

本地免安装：把目录放进 `~/.dsh/profiles/web/plugins/`，并在 profile 的
`cordis.patch.yml` 中引用该文件：

```yaml
- insert:
    - id: context-governor
      name: /absolute/path/to/dsh-context-governor/index.js
```

按包安装时，宿主半部分在启动时读取，因此要重启 `dsh web` 并刷新页面——客户端半部分
是按版本快照下发的。

用 `npm test` 检查：冒烟测试在桩 harness 上运行宿主半部分，不用网络、不调用模型，
并锁定压缩阈值、缓存分桶、单步费用和余额的提供方门槛。

## 支持的 DSH 版本

| DSH 版本 | 状态 |
|---|---|
| `0.1.7-rc.2` … `<0.2.0` | 支持，已在线验证 |
| `0.2.0-rc.1` … `<0.3.0` | 已声明范围；CI 每周探测 |

当声明的范围不覆盖正在运行的版本时，DSH 会**停用**插件（peer 范围匹配包含预发布
版本）。因此宿主会在启动时记录 token 来源和费率：如果缺少那几行，插件多半被停用了，
`dsh --dump-config` 会说明原因。

## 开发

```sh
git clone https://github.com/mpinaev/dsh-context-governor.git
cd dsh-context-governor
npm test                     # 58 项断言：不用网络，不调用模型
./scripts/compat-check.sh    # 在 3099 端口启动一个临时实例并请求其 API
dsh plugin --profile web add "link:$PWD"
```

规则与发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 它会显示什么

- prompt 大小（未命中输入 + 缓存 token）以及 **单步费用的美元估算**
  （仅 DeepSeek；其他提供方显示为*价格未知*）；
- 相对 `base` 的费用倍数（新输入 = 1.0，缓存读取 =
  `cacheReadRate/freshRate`，对 deepseek-flash 约为 0.02）；
- 按会话总量计算的缓存命中率，%（部分命中永远不会被四舍五入成 100）；
- 单步冷输入（最后一次请求中的新 token）；
- 档位：0 = 正常，1 = 警告，2 = 偏高，3 = 危急；
- **DeepSeek 余额**（只有数字；密钥永远不会到达客户端）；
- **高峰/低谷费率**，以及距切换的倒计时。

**为什么直接用 prompt 乘倍数会骗人。** 对 deepseek-flash，一次缓存读取比新输入便宜
50 倍（低谷时每 1M 为 $0.003 对 $0.15）。在 99% 缓存命中下，260k 上下文的单步费用
约为 $0.0015，而 `prompt/base` 会报成 x2.6。因此费用按分桶计算：新输入 ×
`freshRate`，缓存读取 × `cacheReadRate`，缓存写入 × `cacheWriteRate`，输出 ×
`outputRate`。

## 数据来源

**Token。** prompt 大小、缓存命中与输出来自 harness 投影 `tokenUsage`（服务
`ctx.sessionProjections`）：`uncachedInputTokens`、`cacheReadTokens`、
`cacheWriteTokens`、`outputTokens`。这些是提供方的权威数字：它们能在分页和压缩后
保持正确，并在重试（`llm/retry-started`）时正确收口，因此重复尝试不会重复计数。
构建里没有投影时，插件回退到自己对 `llm/stream` 的折叠。

缓存命中按会话总量计算，而不是只看最后一步，因此与 harness 的缓存命中胶囊一致。
部分命中永远不会被四舍五入成 100——而是补足小数位，只有零未命中的命中才显示恰好
`100%`。

**窗口与阈值。** 模型窗口与压力来自 `contextPressure` 投影（`contextWindow`、
`pressureTokens`）；输出预留来自 `request/header`（请求的 `maxTokens`）。压缩阈值
与 harness（`dsh-compaction-basic`）完全一致：

```
threshold = min(thresholdRatio * window, window - reserve - headroom)
```

**阈值只属于该会话。** 窗口和预留按会话保存：路由尚未知的会话报告“窗口未知”，
而不是套用另一个模型的阈值。窗口未知时不会臆造档位。

**三个输入桶，各有各的费率。** 缓存读取（默认 $0.003/1M）比新输入便宜 50 倍，
而 DeepSeek 的缓存写入按普通输入计费（`cacheWriteRate`，默认 = `freshRate`）。
缓存命中是 prompt 中**在读取时**由缓存提供的比例；缓存写入不算命中。

**钱。** DSH 和提供方都不在任何地方以美元报告 token 费用，因此插件自带费率表
（对它不认识的提供方默认关闭）。所以胶囊/余额的逻辑是：

- 单步费用和 `relative` 倍数**只在插件有该提供方费率时**显示——目前就是 DeepSeek
  （`deepseek-official`，以及以 `deepseek` 开头的 id）。对任何其他提供方（cline、
  clinebot、OpenRouter、pi-ai……）费用未知，胶囊/面板写“价格未知”，而不编造数字；
- 高峰/低谷标记（⚡/🌙）始终显示，因为它只是读出时钟，不是某个提供方的费用。

## 信号

- 当会话进入某个档位、出现冷预填、或单步费用偏高时，写入一条服务端日志；
- 会话头部的客户端胶囊，按档位着色，并带详情面板；
- 胶囊上：余额和费率标记（高峰 / 低谷 + 倒计时）。

## 高峰/低谷费率与余额

**费率。** DeepSeek 的规则是固定的：高峰为北京时间（UTC+8）的周一至周五
09:00–12:00 与 14:00–18:00；其余时间（包括整个周末）都是低谷，价格减半。本地时区
不参与判定，只用于显示。配置中的费率（freshRate、cacheReadRate、cacheWriteRate、
outputRate）是低谷价；高峰时乘以 peakMultiplier（默认 2），因此单步费用与告警都
跟随当下的实际费率。倒计时指向下一次真实切换：周末内部的边界会被跳过，所以周五
18:00 之后是倒数到周一 09:00，而不是周六。高峰时段，费率标记、北京时间与余额在
胶囊和面板中都显示为红色，昂贵的时段一眼可见。

**中国法定节假日。** 官方规则有一个容易漏掉的附加说明：高峰是周一至周五，**不含
中国法定节假日**，而在这些节假日里 DeepSeek 全天保持低谷。插件从受维护的来源获取
当年的日历（`holidayUrl`，默认是 `chinese-days` 包的数据），在磁盘上缓存一次
（`holidayCacheDir`，默认 `<DSH_HOME>/cache/context-governor`）并自行刷新——不需要
每年改代码。网络只在后台使用：如果日历还没到，费率回退到周一至周五的规则，面板会
如实说明“节假日日历未加载”。也可以用 `holidays` 配置自行补充日期——一个由
`'YYYY-MM-DD'` 或 `'YYYY-MM-DD..YYYY-MM-DD'` 范围组成的数组；它们立即生效、优先于
来源、且离线可用。节假日当天费率行显示“低谷（中国法定节假日）”，倒计时会跳过整个
假期，指向下一个工作日高峰。也可以完全关闭网络：`holidayFetch: false`。

**余额。** 来源顺序：

1. **官方平台账户**——harness 服务 `ctx.deepseekAccount`（`getBalance`）。已登录账户
   且客户端发来了构建版本时可用；钱包以字符串返回，货币可能是 CNY 或 USD，赠送
   钱包单独列出。
2. **API 密钥**——`GET https://api.deepseek.com/user/balance`，密钥来自凭据通道
   （`DEEPSEEK_API_KEY`）或环境变量。

`source` 字段说明数字来自哪里：`account` 或 `api-key`。回退到第二个来源是刻意的：
别的构建可能没有平台登录，余额不该因此消失。

**余额只对 DeepSeek 提供方显示。** 在 cline、clinebot 或任何其他提供方上，把别人的
金额显示在胶囊里就是误导：那里不显示余额，面板用“仅限 DeepSeek”的说明替代数字。
提供方列表通过 `balanceProviders` 配置（默认 `['deepseek-official']`），并接受任何
以 `deepseek` 开头的 id。如果会话还没有自己的路由，就不猜提供方，余额保持隐藏。

密钥**永不离开宿主**：只有数字到达客户端（总量、赠送、充值、货币、可用性）。并发
读取会合并，失败会退化为一种状态（no-credential、error、disabled）而不是抛异常。
刷新按钮会清空缓存并重新读取余额和费率。

**货币不做换算。** 单步费用和配置的费率（`freshRate`、`cacheReadRate`、
`cacheWriteRate`、`outputRate`，均为 $/1M）以美元计，而余额按来源返回的货币显示
（DeepSeek 为 USD 或 CNY），保留到分。插件不在两者之间换算，所以同一个胶囊里的
`¥` 余额与 `$` 单步费用是不同单位——要比较请先自行换算。

**路由访问。** `/context-governor/api/*` 由服务头和 Origin 校验保护：请求必须携带
`x-dsh-context-governor: 1`（只有本插件客户端会设置）且不得跨源。没有该头——403，
带外部 `Origin`——403。不带 `Origin` 的本机回环 GET 是允许的，方便用 `curl` 排查。

实际要点：在 99% 缓存命中下，昂贵的单步不是大上下文，而是新输入或缓存未命中，而
费率会把这份差额翻倍。

## 交接按钮

一键完成：宿主组装会话摘要（任务、状态、cwd、触及的文件、子会话），客户端通过
`ctx.uiWorkspace.startSession()` 在**同一工作区打开新会话**，并把摘要放进它的草稿。
没有分支或回退：没有 Alt+点击、没有插入当前会话、没有剪贴板。

两个声明的服务保证了它的可靠性：

- 客户端声明 `inject = ['slots', 'uiWorkspace']`：没有这个声明 Cordis 就不会交付
  服务，按钮会滑进回退路径而不是打开会话；
- 宿主声明 `inject = [... 'sessionQuery']`：没有它，摘要里就没有任务、状态和路径
  （只有占位符）。

摘要以惰性方式到达新会话：点击时记住文本，`startSession()` 打开会话，其输入槽渲染，
同一个组件通过 `inputActions.setDraft` 把文本放进草稿。

## 界面语言

语言：**en**（默认）、**zh**、**ru**。切换按钮是胶囊头部刷新控件旁边的小按钮：它显示
当前代码（EN / 中文 / RU）并循环切换。选择会记在浏览器里
（`localStorage: dsh-context-governor.lang`），并立即重绘胶囊和交接按钮。

语言覆盖所有界面文本（面板标签、告警、工具提示）以及交接按钮插入新会话的文档语言：
客户端把 `lang` 传给 `/api/handoff`。宿主返回不含文本的数据（档位、费率和告警都是
代码），所以切换语言无需重新取数。

## 阈值

**插件从不硬编码模型窗口——它从 harness 读取：**

1. 主要来源是 `ctx.sessionProjections` 的 `contextPressure` 投影（`contextWindow`、
   `pressureTokens`）：实时会话的权威窗口。
2. 输出预留是 `request/header` 事件里的请求 `maxTokens`；在那之前，`request/context`
   （`contextWindow`）作为提示。
3. 模型目录（对 `agentDefaultModel.currentSelection()` 调用
   `ctx.llm.resolveModelInfo`）在首次请求前只是提示。

窗口和预留**按会话**保存。

压缩阈值与档位由窗口推导：

```
reserve               = request maxTokens
compaction threshold  = min(thresholdRatio * window, window - reserve - headroomTokens)
band i                = bandRatios[i] * compaction threshold
```

窗口 1,000,000、预留 256,000 时，阈值为 678,464，档位为 237k / 407k / 577k。窗口
800,000 时，阈值为 478,464，档位为 167k / 287k / 407k。该公式与 `dsh-compaction-basic`
一致（window - reserve - headroom）；若用固定档位，危急档会落在真实的前缀重写阈值
之下。

插件能适配不同会话中的不同模型：每个会话保留自己的路由窗口，绝不套用别的会话的
窗口。如果窗口还没解析出来，就不会臆造档位（没有档位），面板显示“模型窗口未知”的
告警。

在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `context-governor` 块里只能调
`bandRatios`、`headroomTokens`、`thresholdRatio`，费率（`freshRate`、
`cacheReadRate`、`cacheWriteRate`、`outputRate`、`peakMultiplier`）与信号阈值
（`anomalyDelta`、`anomalyCostUsd`、`cacheHitFloorPct`）；节假日日历——`holidays`、
`holidayFetch`、`holidayUrl`、`holidayCacheDir`、`holidayRetryMs`、`holidayTimeoutMs`；
余额——`balanceEnabled`、`useAccountBalance`、`balanceProviders`、`balanceTtlMs`、
`balanceTimeoutMs`。`windowTokens` 和 `reservedTokens` 可以强制指定，但默认是 `0`，
意思是“问 harness”；把它们写死会失去自适应性。

## 说明

档位由模型窗口推导；warn/high/critical 这些标签不会被回读。插件只测量、从不裁剪：
它不改动历史或 prompt。

## 许可证

MIT——见 [LICENSE](LICENSE)。
