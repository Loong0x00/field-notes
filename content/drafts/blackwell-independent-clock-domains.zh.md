---
slug: blackwell-xbar-physical-clock-domain-zh
serial: "002"
title: "独立控制 Blackwell 的重要时钟域：GPC、XBAR、SYS、NVD 的 127 点曲线"
date: 2026-08-16
category: "GPU / 逆向工程"
status: "DRAFT"
status_text: "本地草稿"
summary: "逆向并实测 Blackwell 的全局 ClockClient 控制面：GPC、XBAR、SYS、NVD 各自拥有 127 点 V/F 曲线、整域 offset 与域专属电压请求，并受传播关系和共享 rail 仲裁。"
finding_number: "4 × 127"
finding_text: "GPC、XBAR、SYS、NVD 的四组 127 点 type-0x11 曲线均可独立写入；508 点的细粒度负偏移均精确回读并被 STATUS 量化采用。"
boundary: "结论仅覆盖已测 RTX 5090、R610.57.04 与 98.02.2E.80.50 VBIOS。逻辑采用不等于物理 rail 最终获胜，短时无错不等于日用稳定。"
external_url: "https://github.com/ilya-zlobintsev/LACT/issues/1159#issuecomment-5305399366"
---

> 本文是[上一篇 XBAR 物理域研究](/notes/blackwell-xbar-physical-clock-domain/)的续篇。上一篇回答“XBAR 是否真是独立物理时钟、怎样测、为什么 MCLK-MAX 会把它拉低”；本文回答更大的问题：Blackwell 究竟暴露了多少条可以分别控制的频率曲线。

答案不是一条“核心曲线”外加几个显示别名。当前 GB202/R610 的全局 ClockClient 对象里，GPC、XBAR、SYS、NVD 各有一组 127 点、以电压为索引的 type-`0x11` V/F 曲线。每个域还有独立的整域频率 offset；每组曲线也只采用一个特定供电轨的域级电压 offset。

这四组请求可以分别提交，但最终结果并不彼此隔绝。时钟栅格会量化请求，GPC→XBAR 比例会传播约束，XBAR/SYS/NVD 又共享 MSVDD。本文的核心因此是“控制入口彼此独立，物理结果仍由同一约束网络仲裁”。

## 一页读懂：四个域能控制到什么程度

| 域 | 127 点曲线 | 整域 offset | 采用的电压请求 | 独立硬件测频 | 严格上下限 | 已有负载证据 |
|---|---|---|---|---|---|---|
| GPC | 已验证，flat `0..126` | `-1000..+8000 MHz` | rail 0 / NVVDD | 有 | max `0x4c`、min `0x4d` | 公共核心时钟路径成熟；本文验证曲线采用和量化 |
| XBAR | 已验证，flat `127..253` | `-1000..+1000 MHz` | rail 1 / MSVDD | 有 | max `0xe4`、min `0xe7` | PTX 数据完整性、物理测频、游戏 A–B–A |
| SYS | 已验证，flat `259..385` | `-1000..+1000 MHz` | rail 1 / MSVDD | 有 | 尚未找到 | CP2077 隔离 A/B；`+450 MHz` 完成，`+600 MHz` 组合失败 |
| NVD | 已验证，flat `386..512` | `-1000..+1000 MHz` | rail 1 / MSVDD | 有 | 尚未找到 | 尚无能识别具体消费者的隔离负载 |

四组曲线在“能否写入并被 STATUS 采用”这一层已经对齐；证据深度则不同。XBAR 已闭合到可校验负载，SYS 有独立游戏 A/B，NVD 目前只闭合到域对象、硬件计数器和曲线采用。后文每章都按同一顺序说明：域身份、可写接口、运行时实证、已确认、推断和未知。

## 统一控制模型与判定标准

### 五类请求不是五种写法的同一个滑块

| 层级 | 控制对象 | 已验证目标 | 实际含义 |
|---|---|---|---|
| 逐点频率请求 | `CLK_VF_POINTS` | GPC/XBAR/SYS/NVD，各 127 点 | 改某个电压点上的频率 offset |
| 整域频率请求 | `CLK_DOMAINS` | GPC/XBAR/MCLK/SYS/NVD | 给整个域叠加 signed kHz offset |
| rail×domain 电压请求 | `CLK_DOMAINS` record 内 rail slots | GPC→NVVDD；XBAR/SYS/NVD→MSVDD | 改某个域的逻辑 V/F 电压关系 |
| 严格上下限 client | PERF limit clients | GPC、XBAR | 向仲裁器提交 min/max 约束，不是绕过仲裁的 PLL lock |
| 时钟传播关系 | active topology | GPC↔XBAR type-3；其余多条 type-5 | 改域间约束如何传播，而不是直接写最终频率 |

一条写入从接口到硬件至少要过四级证据：

```text
SET 返回 NV_OK
  -> GET_CONTROL 精确保留请求
  -> STATUS 把请求折算到有效曲线
  -> 硬件计数器 / 可校验负载观察到真实结果
```

前两级只能证明存储。PWR、PCIe 和 API40 已经给出反例：控制值可以被保存，但 INFO 不广告有效范围，STATUS 或硬件频率也不随所测字段变化。本文只有在 STATUS 采用后才称“曲线可调”，只有取得独立硬件测频后才称“物理频率已变”。

### 648 点对象的实际布局

全局 `CLK_VF_POINTS` 对象使用以下接口：

| 操作 | method | 参数大小 |
|---|---:|---:|
| INFO | `0x20809021` | `0x8208` |
| STATUS | `0x20809022` | `0x98208` |
| GET_CONTROL | `0x20809023` | `0x1020c` |
| SET_CONTROL | `0x2080d024` | `0x1020c` |

INFO 广告 flat point `0..647`。逐段枚举和写入验证得到：

| flat index | 域 | 点数 | 类型 | 所测 frequency offset 结果 |
|---:|---|---:|---:|---|
| `0..126` | GPC | 127 | `0x11` | CONTROL 保存，STATUS 采用 |
| `127..253` | XBAR | 127 | `0x11` | CONTROL 保存，STATUS 采用 |
| `254..258` | MCLK | 5 | `0x0f` | type-`0x11` 字段被清除/忽略 |
| `259..385` | SYS | 127 | `0x11` | CONTROL 保存，STATUS 采用 |
| `386..512` | NVD | 127 | `0x11` | CONTROL 保存，STATUS 采用 |
| `513..639` | PWR | 127 | `0x11` | CONTROL 保存，所测 STATUS 不变 |
| `640..647` | PCIe | 8 | `0x0f` | type-`0x11` 字段被清除/忽略 |

每个 STATUS record 位于 `0x0d8 + flat_index×0x98`：

| record 内偏移 | 含义 | 格式 |
|---:|---|---|
| `+0x2c` | 点类型与 valid 状态 | type-`0x11` 有效点常见 `0x00001111` |
| `+0x30` / `+0x5c` | effective voltage | µV，两个视图一致 |
| `+0x34` / `+0x58` | effective frequency | MHz，两个视图一致 |
| `+0x38` | base frequency | 16.16 fixed-point MHz |
| `+0x44` | source voltage | µV |
| `+0x80` | 已折算的 total frequency offset | kHz |
| `+0x88` | 已折算的 total voltage offset | µV |

CONTROL point 位于 `0x108 + flat_index×0x10`；`+0x01` 是点类型，type-`0x11` 的 signed frequency offset 位于 `+0x08`，单位 kHz。CONTROL 请求、STATUS total offset 和最终 effective frequency 不是同一个精度，也不能彼此替代。

## GPC：公开核心时钟背后的 127 点曲线

### 域身份与可写接口

NVIDIA 的 Nsight 文档把 GPC clock 描述为公开资料中也可能称作 Application、Graphics、Base 或 Boost clock 的计数器。本机 PMU 表则把 `0x00000001` 明确列为 `GPCCLK`；私有硬件测频接口 `0x20809006` 也能按该 mask 返回瞬时时钟。因此这里不是凭数值猜测“核心频率”（见文末 N1、L4）。

GPC 使用 flat `0..126` 的 127 点 bank 和 `CLK_DOMAINS` record 0。整域 offset 的 INFO 范围是 `-1000..+8000 MHz`；电压方向只采用 `GPC × rail 0/NVVDD`；已验证的 strict max/min clients 是 `0x4c/0x4d`。

### 运行时实证

同一实时快照的三个代表点为：

| 点 | source/effective voltage | base | STATUS total Δf | effective frequency |
|---:|---:|---:|---:|---:|
| 0 | 450 mV | 180 MHz | +45 MHz | 225 MHz |
| 63 | 845 mV | 1230 MHz | +907 MHz | 2137 MHz |
| 126 | 1240 mV | 3225 MHz | +112 MHz | 3337 MHz |

中间点的非均匀 total offset 来自抓取时已经存在的用户 GPC 曲线，不能误写成 VBIOS FactoryOC。全点微小负偏移实验中，127/127 CONTROL 均精确保存请求，125 个 effective point 下移，另 2 个仍留在同一量化档；完整分布统一放在“四域共同机制”一节。

### 证据边界

**已确认。** GPC 有独立的 127 点曲线、整域 offset、NVVDD 域级电压请求、strict min/max client 和硬件计数器；逐点请求会被 STATUS 采用。

**高可信推断。** 这组 bank 是公开核心/Graphics 曲线在当前 ClockClient 中的完整内部控制面。127 点上的非均匀 offset 是用户曲线、FactoryOC、base 重建和量化共同折算的结果。

**尚未证明。** `+8000 MHz` 的 INFO 上限只是接口范围，不是任何芯片可达到的物理频率；也未证明任意单点改变在负载迁移中一定成为最终活动点。

### GPC 完整 127 点曲线

下表是本文实验前同一时刻读取的 GPC CONTROL/STATUS 快照，默认折叠；展开后可横向滚动，并可下载原始 CSV。

[[vf-bank-table:GPC]]

## XBAR：控制链最完整的独立内部域

### 域身份与可写接口

XBAR 使用 flat `127..253` 的 127 点 bank 和 `CLK_DOMAINS` record 1，整域 offset 范围为 `-1000..+1000 MHz`。PMU 静态表把 `0x00000002` 列为独立 `XBARCLK` 对象；它与 GPCCLK 使用不同的顶层 apply/commit 分派，下层 source id 为 2，并最终进入 per-source descriptor/MMIO 编程路径。`0x20809006` 又能单独测得 XBARCLK。这些证据已经排除“XBAR 只是 GPC 显示别名”（见 L1、L4）。

电压方向只采用 `XBAR × rail 1/MSVDD`。XBAR 还拥有 strict max `0xe4` 和 strict min `0xe7`，2400/2600 MHz 请求均做过负载实验。活动 topology 里的 GPC→XBAR type-3 比例也可以独立修改，但它属于跨域传播，统一留到后文说明。

### 运行时实证

当前点 0/63/126 分别为 `225/1987/2812 MHz`，source/effective voltage 为 `450/845/1240 mV`。三点和整组曲线都显示 `total_freq_offset=+45 MHz`，与当前 Astral 2001 W XOC VBIOS 的 FactoryOC 项一致。

全点负偏移实验中，127/127 请求都被 CONTROL 和 STATUS 采用。独立硬件测频、全 170 SM PTX 数据完整性负载和游戏 A–B–A 又把证据推进到真实输出层；详细的 2.9—3.0 GHz 稳定性边界放在文末附录。

### 证据边界

**已确认。** XBAR 是独立物理时钟域，拥有独立曲线、整域 offset、MSVDD 请求、strict min/max、硬件计数器和可校验负载闭环。

**高可信推断。** XBAR 直接影响 SM 与 L2/显存路径之间的交互吞吐；PTX 负载方向性和游戏 A–B–A 支持这一解释。高比例收益饱和来自共享 rail、source 档位和后续仲裁，而不是 SET 被拒绝。

**尚未证明。** 任何 3 GHz 峰值或短时平均都不等于全天稳定；逻辑 MSVDD target 也不等于外置仪器在每个瞬间测得的物理 VOUT。

### XBAR 完整 127 点曲线

下表是同一时刻读取的 XBAR CONTROL/STATUS 快照。当前 127 点均包含 Astral 2001 W XOC 的 `+45 MHz` FactoryOC 项。

[[vf-bank-table:XBAR]]

### XBAR 的 VBIOS 条件投影

当前 XBAR 曲线的 127 点都显示 `total_freq_offset=+45 MHz`，与 Astral 2001 W XOC VBIOS 的 FactoryOC 项一致。本地 15 份 RTX 5090 VBIOS 样本共有六个唯一 FactoryOC 档：`0`、`+15`、`+45`、`+60`、`+75`、`+195 MHz`。它们全是 XBAR 曲线，所以与 XBAR 的运行时实测表放在同一栏目。投影使用：

```text
F_projected(point) = F_live_Astral(point) + FactoryOC_candidate - 45 MHz
```

Astral `+45 MHz` 是运行时实测。Lightning 2500 W XOC 的 `+195 MHz` 是较强的受控静态投影，因为两份 VBIOS 的相关 PERFORMANCE、BOOST、Clock Programming、Voltage Map、NAFLL、Base Clock 与电压表 payload 已逐字节对照，确认差项是 FactoryOC。其余档位只是“仅替换 FactoryOC 常量”的条件结果，不包含另一张卡的 fuse/speedo、驱动重建或温度状态，不能叫实体卡实测曲线（见 L5）。

[[vbios-offset-tables:rtx5090-20260816]]

## SYS：可以独立超频，不是另一个 XBAR 数字

### 域身份与可写接口

SYS 使用 flat `259..385` 的 127 点 bank 和 `CLK_DOMAINS` record 3，整域 offset 范围为 `-1000..+1000 MHz`，API mask 为 `0x00000004`。PMU 活动物理域表里的 SYS bit index 是 2，而 ClockClient record index 是 3：前者来自 one-hot mask 位号，后者是控制对象的记录顺序，不能混用。

私有硬件测频接口能按同一 mask 返回 SYSCLK。电压方向只采用 `SYS × rail 1/MSVDD`；当前没有找到已命名并验证的 SYS strict min/max client。

### 运行时实证

当前点 0/63/126 是 `180/1972/2842 MHz`，source/effective voltage 为 `450/845/1240 mV`，抓取时 total frequency offset 为 0。全点负偏移实验中，127/127 请求精确回读并向下落入新的有效档。

SYS 还有比“STATUS 变了”更强的隔离负载证据（见 L7）：

| 状态 | 负载与结果 | 证据含义 |
|---|---|---|
| SYS `+300 MHz` | CP2077 6144×3456 PT：硬件 SYS `2330.7→2613.4 MHz`，GPC/XBAR 略降，平均 FPS `+1.0805%` | 独立 SYS 变化能影响该路径；一次 sweep 不足以给精确长期收益 |
| SYS `+450 MHz` | GPC max 2400、XBAR automatic；完整 972 帧 CP2077：SYS `2134.1→2585.4 MHz`，GPC/XBAR 几乎不变，无 Xid | 反证“+450 SYS 必然不稳定” |
| SYS `+600 MHz` | CP2077 启动/加载冻结；一次留下 TLB invalidation、Xid 109、PF FLR、Xid 8 | `+600` 超出已证明稳定区，但错误码不能唯一定位消费者 |
| SYS `+600`、XBAR `+450`、MSVDD request `+25 mV` | FurMark 完成且 SYS 峰值约 3.03 GHz；CP2077 仍在 logo 路径冻结 | 排除“同步抬 XBAR 或小幅加 MSVDD 就稳定”的简单解释 |

### 证据边界

**已确认。** SYS 有独立曲线、整域 offset、MSVDD 逻辑电压请求和硬件测频。保持 GPC/XBAR 近似不变时，`+450 MHz` 请求产生 `+451.3 MHz` 实测 SYS 并完成 CP2077；`+600 MHz` 组合则能在 CP2077 路径重复失败。

**高可信推断。** NVIDIA 的 Nsight Systems User Guide 把 GPU front end、copy engines 和 performance monitor 与 SYS clock 联系起来。该页只明确讨论 Turing、GA100、GA10x 的采样行为，所以它只能支持架构命名和历史语义，不能替代 GB202 实测。路径追踪约 1% 的变化更像前端或互连瓶颈被缓解，而不是 GPC 算力增加（见 N1）。

**尚未证明。** GB202 SYS 的完整消费者列表、RT/L2 交互的具体 crossing、未命名 strict client、长期稳定区以及 SYS×MSVDD 请求何时赢得物理 rail 仲裁都仍未知。

### SYS 完整 127 点曲线

下表是同一时刻读取的 SYS CONTROL/STATUS 快照。抓取时整组 total frequency offset 为 0，不代表另一张卡或另一份 VBIOS 会生成相同曲线。

[[vf-bank-table:SYS]]

## NVD：曲线和计数器已找到，消费者仍未知

### 域身份与可写接口

NVD 使用 flat `386..512` 的 127 点 bank 和 `CLK_DOMAINS` record 4，整域 offset 范围为 `-1000..+1000 MHz`。PMU 表存在独立 `NVDCLK` 对象，mask 为 `0x00100000`，下层 source id 为 10；`0x20809006` 也能返回独立瞬时时钟，本次只读复查在空闲状态得到约 `1.40 GHz`。

电压方向只采用 `NVD × rail 1/MSVDD`。当前没有找到已命名的 NVD strict client。更重要的是，“NVD”名字和 NVAPI 公开 `VIDEO` clock ID 都不能单独证明这条私有曲线就是 NVENC、NVDEC 或某个特定编解码器时钟（见 N2、L4）。

### 运行时实证

当前点 0/63/126 分别为 `180/1867/2715 MHz`，source/effective voltage 为 `450/845/1240 mV`，total frequency offset 为 0。全点实验中，127/127 的 `-1/-2 MHz` 请求都被 CONTROL 保存并被 STATUS 向下采用。

因此从“能不能写曲线”看，NVD 与 SYS 一样完整；缺的是一个能把 NVD 频率变化与特定硬件产出绑定起来的隔离负载。

### 证据边界

**已确认。** NVD 有独立 PMU 域对象、source id、硬件计数器、127 点曲线、整域 offset 和 MSVDD 逻辑电压请求；它还通过 rail 1 的 type-5 关系连接 XBAR 与 MCLK。

**高可信推断。** NVD 是真实可编程的时钟消费者，而不是纯 UI 占位符。它可能服务某种 video/display/data-path 逻辑，但这仍是命名驱动的候选解释。

**尚未证明。** NVD 是否对应 NVENC、NVDEC、display engine、optical flow 或它们的共享上游；频率变化是否影响编码、解码、显示或游戏性能；以及它的稳定区和最终物理 MSVDD 响应。

### NVD 完整 127 点曲线

下表是同一时刻读取的 NVD CONTROL/STATUS 快照。它证明曲线对象存在并可逐点读取，不替代对具体 NVD 消费者的负载识别。

[[vf-bank-table:NVD]]

## 四域共同机制：量化、电压和传播

### 508 点实验只在这里完整列一次

四组 type-`0x11` bank 共 508 点。每个 bank 都执行完整 GET_CONTROL preimage、byte-identical no-op SET、全点 `-1000 kHz`、GET_CONTROL/STATUS 对照、恢复，再对 `-2000 kHz` 重复：

| bank | 请求 | CONTROL 精确回读 | effective-frequency Δ |
|---|---:|---:|---|
| GPC | -1/-2 MHz | 两次均 127/127 | 两次均 -15:21，-8:83，-7:21，0:2 |
| XBAR | -1/-2 MHz | 两次均 127/127 | 两次均 -15:61，-8:66 |
| SYS | -1/-2 MHz | 两次均 127/127 | 两次均 -8:59，-7:68 |
| NVD | -1/-2 MHz | 两次均 127/127 | 两次均 -8:56，-7:71 |

没有点朝相反方向移动；四个恢复后 CSV 与基线逐字节一致。`-1` 与 `-2 MHz` 落到完全相同的 effective 分布，说明请求先以 kHz 精度保存，再被约 7.5 MHz 的离散时钟栅格折算；跨档点会表现为约 15 MHz。GPC 的 `total_freq_offset` 与 `effective_freq` 量化分布也不完全相同，因此 STATUS 的两个字段不能互相替代（见 L2）。

这里的公开证据边界需要说清楚：证据包包含精确测试源、原始组合控制台和四组 baseline/restored CSV；当次运行没有保存 508 个点的 shifted CSV。所以上表可以逐项对照原程序和原始输出，但若要脱离原输出重新逐点聚合，仍需重跑测试，缺失的逐点文件没有事后伪造补齐。历史写入二进制没有公开，旧源码以 `.archival.txt` 归档，仅供检查，不是跨版本构建目标（见 L2）。

### rail×domain 不是全局加压

八个 `domain × {NVVDD,MSVDD}` 单变量请求全部 SET 成功且精确回读，但 STATUS 只采用四个域专属映射：

```text
GPC  -> rail 0 / NVVDD
XBAR -> rail 1 / MSVDD
SYS  -> rail 1 / MSVDD
NVD  -> rail 1 / MSVDD
```

每个有效组合都在自己的 127/127 点表现为 `effective_voltage-source_voltage=+1000 µV`，其他组合全部为零。这证明四条曲线可以分别改变自己的逻辑电压关系，不证明请求一定赢得最终 rail 仲裁，也不证明物理 VOUT 精确变化 1 mV（见 L3）。

这一矩阵的 32 份完整 127 点 CSV 和八份请求/回读/恢复日志已经随 L3 发布，不再只有汇总表。它们允许从应用态原始捕获重新计算每个 cell；仍然不能替代示波器对物理 rail 的测量。

### 传播比例改变约束，不直接指定频率

活动 topology 的 GPC→XBAR type-3 ratio 是独立可写的 16.16 控制量。默认 `0xe660/65536=0.899902344`；`1.0`、`1.2`、`2.0` 都已精确写入、回读并恢复。但下面这个直觉公式并不成立：

```text
physical XBAR = physical GPC × ratio + XBAR offset
```

比例 1.2、GPC 约 2500 MHz 时，XBAR 只有约 2.40—2.44 GHz；比例 2.0、GPC 约 1300 MHz 时，XBAR 才从约 1440 拉到 2423 MHz。type-3 提供传播基线，随后仍会经过共享 MSVDD 的 type-5 转换、source 档位、功耗约束和时钟栅格。比例改变的是约束网络，不是直接写 PLL 输出（见 L4）。

### 写入和恢复属于 ABI 本身

逐点控制必须先 GET 完整 `0x1020c` preimage，只修改目标 type-`0x11` record，再提交完整对象。整域控制同理，要保存完整 `0x83c` preimage；record 基址为 `0x3c + domain_index×0x40`，`+0x0c` 是 signed frequency offset，`+0x10 + rail_index×4` 是 signed voltage offset。

测试结束必须提交原始 preimage，并再次比较 GET_CONTROL/STATUS。局部手拼结构可能覆盖同一 BoardObj 中其他曲线或控制位。

## 其余域：能调、不能调和当前不重要是三种结论

### MCLK：整域可调，但不是 127 点电压曲线

MCLK 的 `CLK_DOMAINS` record 2 被 INFO 正式广告为 `-1000..+5000 MHz`，整域 offset 可精确回读。区别在于全局 V/F 对象只给 MCLK 5 个 type-`0x0f` frequency-indexed 点；把 type-`0x11` 的字段写法套上去会被清除或忽略。

所以结论不是“MCLK 没有 V/F 控制”，而是“它不使用本文四组 bank 的逐电压点格式”。MCLK 还通过 rail 1 type-5 relation 与 XBAR、SYS、NVD、PCIe 相连，有限 MCLK-MAX 因而会改变其他内部域（见 L8、L9）。

### PWR：有 127 点外形，不等于有可用曲线

flat `513..639` 看起来像第五组 127 点 bank，CONTROL 也会保存 `+15 MHz`。但抽查点 0/63 时 STATUS 不变，`CLK_DOMAINS` record 5 的 INFO 范围也是 `0..0`。PMU/硬件测频表确实存在 `PWRCLK`，这只能证明域对象或计数器存在，不能把当前字段升级为可调能力。

### PCIe：八个不同类型的点，当前 offset 范围为零

PCIe 使用 flat `640..647` 的 8 个 type-`0x0f` 点，type-`0x11` 字段无效。domain record 6 的 INFO 范围为 `0..0`；测试值虽能保存在 CONTROL 中，硬件测频没有对应变化。它可能有专用 link-state/gear 控制对象，但不属于本文已验证的曲线接口。

### XBAR2、API40 与 API08：保留真实未知

PMU 静态表还有 `XBAR2CLK 0x00040000`。它的顶层 apply/commit 在当前映像中返回 stub-like 状态，而物理 XBARCLK 走完整 source/MMIO 路径，因此 XBAR2 更像 2X 逻辑/API 聚合域；这是高可信推断，不是命名即证明。

API40 (`0x40`) 的 control record 范围为 `0..0`，API08 (`0x08`) 不在 `0xff` control mask 内。二者都参加活动 topology 的 type-5 关系，但消费者名称和可写入口尚未确定。正确结论是“当前控制对象不提供有效 offset”，而不是“硬件一定不能调”。

## 附录：XBAR 的深度稳定性验证

这部分保留完整证据，但不参与四域主叙事。它回答的是“XBAR 的物理结果走到哪里、3 GHz 边界怎样验证”，而不是“Blackwell 有多少条可调曲线”。不同 VBIOS 的 FactoryOC 条件投影已经归回 XBAR 栏目。

### 全 170 SM PTX 与 3 GHz 边界

四种可校验 PTX 负载在约 2.9 GHz 设置下得到：

| workload | 平均物理 XBAR | 数据结果 |
|---|---:|---|
| compute | 2902.1 MHz | 零错误 |
| L2 | 2899.3 MHz | 零错误 |
| atomic | 2900.9 MHz | 零错误 |
| VRAM | 2895.7 MHz | 零错误 |

这里的“校验”不是四条路径都拥有 CPU 独立 oracle。compute 输出和 atomic 总数有 host-side reference；L2 与 VRAM 则由 GPU 端确定性生成并在 GPU 端比较，可以发现运行中的数据不一致，却不能排除生成和 expected 计算共同出错的 common-mode 实现错误。所以下表证明的是已实现 acceptance test 内零错，不是四类路径都与 CPU 逐值结果独立一致（见 L6）。

3 GHz 附近，短 compute 平均为 `3000.1 MHz`；无错混合负载最高平均为 `2997.0 MHz`。一次 `+440` L2 测试在 423,540,817,920 次加载中出现 1 次静默错误，之后超过 3.23 万亿次操作未复现。这个样本必须保留，但不足以定义确定性坏点（见 N4、L6）。

PTX 证据包已经补入两份哈希吻合的精确测试源和原始 isolated/mixed sweep 日志。原测试二进制只保留了哈希，字节本体没有留存；以同一可见命令重编译也不会得到相同二进制哈希，因此该哈希只能定位历史运行，不能冒充可下载原件（见 L6）。

OCN 的 3007—3075 MHz 遥测只证明外部样本出现过对应峰值，不替代统一 workload、时间分布和数据零错验证（见 P4）。

## 结论

当前 Blackwell 控制面的重点不是“终于能拉 XBAR”，而是已经确认四个重要域各自拥有完整的 127 点 V/F 控制面。GPC、XBAR、SYS、NVD 可以分别塑形，也分别拥有整域 offset；GPC 采用 NVVDD 请求，另外三组采用 MSVDD 请求。

四个域的证据深度不同：XBAR 已闭合到独立物理时钟和数据完整性负载；SYS 已有隔离 A/B 与失败边界；NVD 已闭合到对象、计数器和曲线采用，但准确消费者仍未知。这种差别不会削弱“曲线分别可写”的结论，只决定我们能把物理解释推进到哪一步。

反例同样重要：MCLK/PCIe 使用另一种点格式；PWR 能保存控制值却没有 STATUS 采用；API40/API08 参加拓扑却没有有效 offset。SET 成功从来不是最终答案。真正可复核的结论必须把 capability、请求保存、STATUS 折算、硬件测频和负载输出分开。

2026-08-16 的四域逐点 `-1/-2 MHz` 与 rail×domain 矩阵实验均恢复到完整 preimage；四组曲线恢复后 CSV 逐字节一致，相关内核窗口没有新增 Xid、AER、GSP 或 PCIe 错误。这一范围不包括 SYS `+600 MHz` 失败实验：后者明确记录过 TLB invalidation、Xid 109、PF FLR 与 Xid 8，并通过重启恢复。两种结果都只是各自当次实验的恢复与健康记录，不是长期安全证明。

## 参考文献与证据索引

### NVIDIA 官方资料

- **N1.** [NVIDIA Nsight Systems User Guide：GPU Metrics / GPC 与 SYS clock 定义](https://developer.nvidia.com/docs/drive/drive-os/7.0.3/public/nsight/nsight-systems/UserGuide/index.html)。用于 GPC 公共命名和 SYS front end/copy/performance-monitor 的官方语义；文中已限制其代际外推。
- **N2.** [NVAPI GPU Clock Control Interface](https://docs.nvidia.com/nvapi/group__gpuclock.html)。公开 API 列出 Graphics、Memory、Processor、Video domains；本文明确不把公开 ID 与私有 NVD bank 强行一一映射。
- **N3.** [NVIDIA RTX Blackwell GPU Architecture](https://images.nvidia.com/aem-dam/Solutions/geforce/blackwell/nvidia-rtx-blackwell-gpu-architecture.pdf)。官方只支持 Blackwell 具有新的快速动态时钟与分 rail 架构背景，不公开本文私有 ABI。
- **N4.** [NVIDIA Parallel Thread Execution ISA](https://docs.nvidia.com/cuda/parallel-thread-execution/)。XBAR 可校验 workload 所用 PTX 指令语义来源。

### 本站实验与可下载记录

- **L1.** [上一篇：XBAR 物理域、控制链、MCLK-MAX 与共享 MSVDD](/notes/blackwell-xbar-physical-clock-domain/)
- **L2.** [四组 127 点全点 -1/-2 MHz 实验](/downloads/xbar/GB202_VF_ALL_POINT_NEGATIVE_SHIFT_20260816.md)
- **L3.** [八组 rail×domain STATUS adoption 矩阵](/downloads/xbar/GB202_RAIL_DOMAIN_ADOPTION_MATRIX_20260816.md)
- **L4.** [GB202 PMU/ClockClient 控制逻辑拆解记录](/downloads/xbar/BLACKWELL_CONTROL_LOGIC_EXTRACTION_20260725.md)
- **L5.** [15 份 RTX 5090 VBIOS 的 FactoryOC/XBAR 投影表](/downloads/xbar/RTX5090_VBIOS_XBAR_OFFSET_PROJECTIONS_20260816.csv)
- **L6.** [全 170 SM PTX 完整性负载与 3 GHz 边界](/downloads/xbar/GB202_XBAR_PTX_BOUNDARY_20260816.md)
- **L7.** [SYS 独立 offset、CP2077 A/B 与 +600 MHz 失败边界](/downloads/xbar/GB202_SYS_CLOCK_RUNTIME_AB_20260811.md)
- **L8.** [648 点全局 V/F bank 与 domain offset 清单](/downloads/xbar/GB202_GLOBAL_VF_BANK_INVENTORY_20260816.md)
- **L9.** [有限 MCLK-MAX 的传播闭环](/downloads/xbar/MEMORY_MAX_FEEDBACK_CLOSURE_20260728.md)
- **L10.** [完整证据包索引与 SHA-256](/downloads/xbar/INDEX.md)

### 公共实现、问题追踪与外部样本

- **P1.** [LACT issue #1159：读取、写入、STATUS 验证与恢复方法](https://github.com/ilya-zlobintsev/LACT/issues/1159#issuecomment-5305399366)
- **P2.** [LACT PR #1158：XBAR 与 per-domain MSVDD 草案实现](https://github.com/ilya-zlobintsev/LACT/pull/1158)。截至本文日期尚未合并；round-trip 测试不等于硬件采用。
- **P3.** [NVIDIA open-gpu-kernel-modules issue #1266](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/1266)。公开的 MCLK-MAX/内部域异常复现与证据交流。
- **P4.** [OCN RTX 5090 Owners Club 的 3007—3075 MHz XBAR 遥测样本](https://www.overclock.net/threads/official-nvidia-rtx-5090-owners-club.1814246/latest#post-29607187)。只作为外部峰值样本，不承担接口与稳定性主证据。
