---
slug: blackwell-xbar-physical-clock-domain-zh
serial: "001-ZH"
title: "NVIDIA Blackwell GPU 中的 XBAR：一个被公开工具忽略的物理时钟域"
date: 2026-08-13
category: "GPU / 逆向工程"
status: "DRAFT"
status_text: "草稿"
summary: "以 GB202 运行时控制、硬件测频、V/F 状态和负载对照，区分 XBAR 请求、共享 MSVDD 仲裁、驱动遥测与物理电压。"
finding_number: "3%"
finding_text: "在两个游戏的 A–B–A 对照中，独立提高 XBAR 带来约 3% 吞吐提升；核心和 SYS 并未升频。"
boundary: "仅确认已测 GB202、驱动与 VBIOS 组合。私有 ABI、长期稳定性、跨样品适用性以及芯片内部拓扑仍未确认。"
external_url: "https://github.com/ilya-zlobintsev/LACT/issues/1147"
---

# NVIDIA Blackwell GPU 中的 XBAR：一个被公开工具忽略的物理时钟域

> 草稿。本文只讨论已经由 GB202 运行时实验、驱动对象和固件代码支持的结论；凡是无法从现有证据确定的芯片内部拓扑，均明确标为推断或未知。

在 NVIDIA GPU 的公开超频界面里，人们通常只会看到核心、显存、电压和功耗上限。XBAR 很少出现，以至于它很容易被理解成某个软件统计项、核心频率的派生值，或者一个没有实际调节意义的内部名字。但在 RTX 5090 的 GB202 上，这几种解释都不成立：XBARCLK 有自己的 PMU 对象、时钟源、V/F 点状态、硬件测频入口和运行时控制；改变它会改变真实测得的时钟以及实际渲染吞吐。它不是 GPCCLK 的别名，也不是 MCLK 的另一种记法，而是一个会参与电压、功耗和跨域时钟仲裁的物理时钟域。

这里的“物理时钟域”不等于已经知道芯片版图上某一个方框的准确边界。现有证据能证明，一组由固件独立管理的硬件逻辑使用 XBARCLK，有独立的时钟源和寄存器编程路径；它在负载中表现出对 GPU 内部数据通路吞吐的影响。XBAR 这个名字通常使人联想到 crossbar 或片上互连，但仅凭名称和性能表现，尚不足以断言它具体连接哪些缓存、分区或控制器。因此，本文把它称为“XBAR 物理时钟域”，而不虚构一张 NVIDIA 没有公开的 GB202 互连框图。

## XBARCLK 为什么不是 GPCCLK 的附属读数

GB202 当前 PMU 映像中的活动时钟域表同时包含以下对象：

| 域 | mask | PMU 对象 | 本地 source id |
|---|---:|---:|---:|
| GPCCLK | `0x00000001` | `0x200ed398` | `3,4,5,6,7,8,12,13` |
| XBARCLK | `0x00000002` | `0x200ed4f0` | `2` |
| SYSCLK | `0x00000004` | `0x200ed498` | — |
| MCLK | `0x00000010` | `0x200ed5a0` | — |
| XBAR2CLK | `0x00040000` | `0x200ed718` | — |

GPCCLK 和 XBARCLK 不仅对象地址不同，顶层 `apply`、`commit` 分派和内部状态也不同。XBARCLK 随后的本地编程链可以闭合为：

```text
clock request
  -> XBARCLK object apply/commit
  -> common clock-source class, source id 2
  -> per-source descriptor at PMU DMEM 0x2007d860
  -> div/mux control word packing
  -> PMU MMIO window write
```

这已经排除了“XBAR 只是驱动用 GPCCLK 算出来的显示值”。固件确实会为 XBARCLK 选择并提交独立的时钟源参数，最终进入硬件寄存器写入路径。当前尚缺的是运行后 descriptor 中保存的具体寄存器 offset，而不是“有没有硬件写入”。

另一个名为 XBAR2CLK 的域与 XBARCLK 同时存在，但当前 PMU 映像中它的 `apply/commit` 只是返回状态，并未进入同一条本地硬件编程链。因此，XBAR2CLK 更可能是 2X 策略使用的逻辑或 API 聚合域，而 XBARCLK 才是物理本地编程对象。这一解释有对象行为作为支持，但仍属于推断，不能因为名字相近就把两个域合并。

## XBAR 确实可控，以及控制到底怎样完成

这里的“可控”不是从超频软件界面猜出来的。R610 的私有 ClockClient 同时提供域信息、域控制和独立硬件测频，已使用的四个 RM control 为：

| 操作 | command | R610.57.04 参数大小 | 用途 |
|---|---:|---:|---|
| `CLK_CLK_DOMAINS_GET_INFO` | `0x20809019` | `0x3030` | 取得活动/可控时钟域及 offset 范围 |
| `CLK_CLK_DOMAINS_GET_CONTROL` | `0x2080901b` | `0x083c` | 读取当前域控制对象 |
| `CLK_CLK_DOMAINS_SET_CONTROL` | `0x2080d01c` | `0x083c` | 提交完整域控制对象 |
| `CLK_MEASURE_FREQ` | `0x20809006` | `0x0008` | 用硬件计数器测量指定物理时钟域 |

在已经实机验证的 R610.57.04 `0x83c` 控制块中：

```text
+0x04  controllable-domain mask，本机为 0x000000ff

domain header = 0x3c bytes
domain stride = 0x40 bytes
XBAR domain index = 1
XBAR domain base = 0x3c + 1 * 0x40 = 0x7c

+0x84  XBAR frequency-offset mode，即 XBAR base + 0x08
+0x88  signed XBAR frequency offset，单位 kHz
+0x90  signed rail-1/MSVDD offset，单位 µV
```

`+0x90` 不是一个恰好挨着 XBAR 频率的“物理电压寄存器”。域记录从 `+0x8c` 开始保存按 voltage-rail index 排列的请求，MSVDD 在本机为 rail index 1，所以对应 `XBAR base + 0x10 + 1 × 4 = 0x90`。写进去的是 XBAR 域交给共享 MSVDD 仲裁器的电压 offset 请求，而不是绕过 GSP 直接给稳压器写死一个输出。

一条完整、可验证而且可恢复的控制流程应当是：

1. 先从目标驱动的 method table 或已验证版本描述核对各 command 参数大小；尺寸未知或不匹配就拒绝写入，不能只按版本字符串猜布局。
2. 调用 `GET_INFO`，核对活动域 mask、XBAR 域身份和驱动返回的 offset 范围。
3. 调用 `GET_CONTROL`，保存整个原始控制块，而不只是保存准备修改的 4 或 8 个字节。
4. 在保存副本中设置 XBAR frequency-offset mode，并写入有符号 kHz offset；需要时再写 XBAR 域的 MSVDD µV offset。
5. 通过 `SET_CONTROL` 提交整个控制块。
6. 再次 `GET_CONTROL`，确认驱动保存了请求值。
7. 通过 `CLK_MEASURE_FREQ`、domain mask `0x2` 读取物理 XBARCLK，而不是拿回读值冒充实际频率。
8. 同时测量工作量输出；只有物理时钟和有用吞吐确实变化，才能说请求成为了有效硬件控制。
9. 实验结束或收到可处理的退出信号后，把步骤 3 保存的完整控制块写回，再次读取并核对恢复值。

本机返回的 XBAR frequency-offset 名义范围是 `-1000` 到 `+1000 MHz`。这只是驱动报告“可接受的请求范围”，不是这张卡在所有负载中的稳定范围，更不是建议把 `+1000 MHz` 用作日常设置。

### 最小可运行示例

项目中的 [`xbar_clock_demo.c`](xbar_clock_demo.c) 是针对 R610.57.04 固定布局写的最小证明程序。它不尝试成为跨版本库；无参数时只读取当前 XBAR offset 和物理测频，带三个参数时保存控制块、写入、回读、每 100 ms 测频并在结束时恢复。

编译：

```bash
cc -std=gnu11 -O2 -Wall -Wextra -Wpedantic -Werror \
  xbar_clock_demo.c -o xbar_clock_demo
```

只读当前状态：

```bash
sudo ./xbar_clock_demo
```

临时请求 `+60 MHz` XBAR、`0 µV` 电压 offset，保持两秒后恢复：

```bash
sudo ./xbar_clock_demo 60000 0 2
```

一次实测输出为：

```text
before:  xbar_offset_khz=0 measured_xbar_khz=1439616
readback: xbar_offset_khz=60000 measured_xbar_khz=1462144
restored: xbar_offset_khz=0 measured_xbar_khz=1440061
```

同时请求 `+450 MHz` XBAR 和 `+20 mV` XBAR-domain MSVDD 的参数写法为：

```bash
sudo ./xbar_clock_demo 450000 20000 2
```

同一程序还保留了实验中用于区分 XBAR 与 SYS 效应的对照入口：

```bash
# 只读 SYS offset 和物理 SYSCLK
sudo ./xbar_clock_demo --sys

# 临时请求 SYS +150 MHz，不改 MSVDD；两秒后恢复
sudo ./xbar_clock_demo --sys 150000 2

# 同时请求 SYS +150 MHz 和 XBAR-domain MSVDD +20 mV
sudo ./xbar_clock_demo --sys 150000 20000 2

# 同时请求 SYS +150 MHz、XBAR +450 MHz、XBAR-domain MSVDD +20 mV
sudo ./xbar_clock_demo --sys-xbar 150000 450000 20000 2
```

这里的 MSVDD 参数仍写在 XBAR domain record 的 rail-1 offset，不是另找了一个 SYS 专用电压字段；`--sys` 和 `--sys-xbar` 是域间对照工具，不扩大本文对私有结构稳定性的承诺。

程序对 `SIGINT` 和 `SIGTERM` 只设置退出标志，随后走统一恢复路径；它也会在正常结束时把完整原控制块写回并比较关键字段。但这不等于绝对故障安全：`SIGKILL`、内核崩溃、进程被直接杀死、GPU/PCIe 丢失或恢复时 `SET_CONTROL` 失败，都可能让用户态程序来不及恢复。日常工具必须另外处理启动时残留检测、版本拒绝、异常恢复和持久化策略，不能把这个最小 demo 原样包装成“安全超频功能”。

需要指出一个实现边界：当前 demo 为了保持最小，硬编码了 R610.57.04 的 `0x83c` 大小、mask、domain index 和字段偏移，并没有先用 `GET_INFO` 动态生成结构描述。因此它证明“这个精确构建上可用”，却不能证明“升级驱动后仍可用”。一个准备交给普通用户的实现必须把 GET_INFO/尺寸校验、未知字段保留、独立测频和完整恢复都作为前置条件。

### “可用”“可能稳定”和“稳定接口”不是一回事

本文把三个结论分开：

| 等级 | 当前能否宣称 | 证据边界 |
|---|---|---|
| 控制路径可用 | **可以，仅限已测组合** | R610.57.04、这一张 GB202 上完成写入、精确回读、物理测频、吞吐变化和恢复 |
| `+450 MHz / +20 mV` 可能是可用候选 | **只能称候选** | 通过短 FurMark 和两个游戏 A–B–A，没有在这些窗口内出现新 Xid；但没有长期、多场景、冷热启动和多样本稳定性资格 |
| 设置已经长期稳定 | **不可以** | `+450 MHz / 0 mV` 已出现灰屏破图和长帧；短测中加 `+20 mV` 消除症状不构成长稳证明 |
| 私有 ABI 可跨版本稳定使用 | **不可以** | NVIDIA 未公开也未承诺该结构；命令号相同仍可能改变参数大小、域数量、字段语义或固件策略 |

所以“可用”在这里指一个输入能通过已验证路径改变物理机器并恢复；“可能稳定”只是值得继续做稳定性测试的设置；“稳定接口”则需要版本契约或运行时自描述验证。三者不能互相替代。

### 驱动版本已经实际展示了这种不稳定性

本地保留的 610.43.02、610.43.03 和 610.57.04 官方 Linux GSP 包中，四个相关 method 的参数大小恰好相同：`GET_INFO=0x3030`、`GET/SET_CONTROL=0x83c`、`VF_POINTS_GET_STATUS=0x98208`。但这只能证明三份 method table 的外部尺寸相同。运行时证据并不相同：

- 610.43.03 上完成了 MCLK-MAX 异常、传播拓扑和 XBAR V/F STATUS 的取证；
- NVIDIA 工程师在 610.43.02、另一张 RTX 5090/5070 Ti 上未复现同一 MCLK-MAX 性能异常；
- 610.57.04 上又以 2/2 组 CP2077 和 3/3 组 FurMark 配对重新复现该异常，同时完成了上述 XBAR offset/MSVDD offset 的直接运行时控制。

这说明“method size 没变”并不等于策略行为没变，也不等于同一问题必然在所有卡上重现。

Windows R572 又给出更直接的 ABI 反例。离线拆出的 572.42、572.47、572.60 三份 GSP 在两次小版本升级中都变成了不同二进制；三份 inner-RM SHA-256 分别为：

```text
572.42  665e1cfcfa4fd9a09e656431d350b6346cd6a9193c33ee30df79ecd29a55d670
572.47  978422282729d9210c3a4dc2ec102b06cf3aa7b1e515c5c26b281d1720c53ea7
572.60  f55ea7525728162a47ff95378beb792907fc5c9d567b07121fa935da33ee8049
```

这三版的 control ID 仍相同，但 `GET_INFO` 是 `0x2730`、`GET/SET_CONTROL` 是 `0x7bc`，与 R610 的 `0x3030/0x83c` 已经不同。572.42 与 572.47 的 method-table 位置和尺寸相同；572.60 的 GSP 构建、对象地址和 handler 地址又发生移动，参数尺寸仍未变化。换言之，驱动能够在不改变 command ID、甚至不改变参数总尺寸的情况下改内部对象、曲线输入或策略实现。

作者的三版实机观察是：572.42→572.47 和 572.47→572.60 都改变过 XBAR/MSVDD 行为，即三个小版本中实际变了两次；离线 GSP/inner-RM 哈希也在两次升级中分别变化。这足以把“驱动策略不是固定常量”写进结论。但当前项目归档没有同一张卡在这三版下各自抓取的完整 127 点 live STATUS，只有二进制和部分屏幕记录。因此，这两层证据必须分开：**实机观察确认行为两次改变；归档能够逐字节复核的是三个不同实现；每次改变对应的完整 V/F 曲线和准确字段差异尚未闭合。**不能把“某版统一降低 50 mV”进一步写成已经逐点验证的驱动曲线。

最后，R610 的私有时钟测量方法 `0x20809006` 接收一个域 mask，并返回由硬件计数器测得的瞬时频率，而不是 V/F 表目标、软件上限或驱动缓存。在同一个空闲状态中曾经测得：

```text
GPCCLK      224816 kHz
XBARCLK    1453433 kHz
SYSCLK     1462750 kHz
MCLK      14989051 kHz
XBAR2CLK    107967 kHz
```

一次 `+60 MHz` 可逆 A/B 中，`SET_CONTROL` 后软件精确回读，同时物理 XBAR 测频从约 1.440 GHz 变为约 1.462 GHz；恢复原控制块后又回到约 1.440 GHz。这里同时具备写入、回读、独立硬件测量和恢复，因而证明的是实际控制，不是只改了一个软件显示值。

## XBAR 有自己的 V/F 状态

`NV2080_CTRL_CMD_CLK_VF_POINTS_GET_STATUS` 返回的状态对象中，XBAR bank 位于参数绝对偏移 `0x4c40`，包含 127 个连续记录，每条步长为 `0x98`。通过频率和电压的可逆 A/B，可以区分出每个点中的有效频率、有效电压、基础频率和 tuning offset。

基线下全部 127 个点都严格满足：

```text
有效频率 MHz = 基础频率 16.16 的整数部分 + 频率 tuning offset kHz / 1000
```

这张卡的状态对象中原本就带有 `+45 MHz` XBAR tuning offset：第一个点为 `450 mV / 225 MHz`，其中基础频率是 180 MHz；最后一个点为 `1240 mV / 2812 MHz`，基础频率是 2767 MHz。提交 `+60 MHz` 后，所有 127 个点的有效频率字段和总 offset 都增加 60 MHz；提交 `+10 mV` 后，所有有效电压字段增加 10000 µV，而基础频率和源电压字段保持不变。

这说明 XBAR 的运行状态不是一个从 GPC 频率临时乘出来的标量。驱动为它维护了一整组可调 V/F 点，而且频率和域电压请求能够分别改变重新生成的有效曲线。另一个有意义的负结果是：这些变化只出现在 STATUS，`GET_CONTROL` 返回的逐点对象在 A/B 前后逐字节相同。也就是说，CONTROL 并不是最终有效曲线的镜像；只看可写对象会漏掉固件重新计算后的真实状态。

## XBAR 不是孤立工作的：时钟传播与共享电压轨

当前机器的活动 Clock Propagation Topology ID 为 7。它包含一条从 GPC2CLK 指向 XBARCLK 的 type-3 双向关系，比例为：

```text
58976 / 65536 = 0.89990234375
```

已有 CP2077 和 FurMark 日志中的大量 DG0/DG1 对值落在这条约 0.9 的传播基线附近，但最终 XBAR 并不被强制等于 `0.89990234375 × GPC`。时钟网格量化、V/F 点、共享电压关系、功耗限制和后续仲裁都可能改变最终结果。因此，这个比例描述的是传播过程中的一条约束，不是一个能从核心频率唯一求出 XBAR 实频的公式。

同一活动拓扑还启用了多条 type-5 双向共享电压关系，全部指向 rail 1，其中包括：

```text
XBAR <-> SYS
MCLK <-> XBAR
MCLK <-> SYS
XBAR <-> NVD
XBAR <-> PWR
```

同代 RM/MODS 中恢复出的 type-5 算法并不是让两个域同频，而是：

```text
源时钟频率范围
  -> 通过源域 FREQ_TO_VOLT 转成共享电压范围
  -> 与 rail 上已有范围相交
  -> 通过目标域 VOLT_TO_FREQ 转回目标时钟范围
  -> 与目标 V/F 点和最大频率相交、钳位并量化
```

这套结构解释了一个反直觉事实：即使 MCLK 的物理频率完全没有碰到所设置的上限，一个有限的 MCLK 最大端点仍可能先被转换为共享电压范围，再传播成 XBAR 和 SYS 的频率上限。真正参与传播的是“请求范围的端点”，不一定是当时实际运行的显存频率。

当前 R610 的活动拓扑、关系类型和输入输出行为已经在运行时得到验证；上述 endpoint conversion 算法则来自同代旧 RM/MODS 的地址级恢复。二者语义能够闭合，但当前 R610 内部执行 type-5 转换的准确函数和动态 range 对象仍未定位。因此，“有限 MCLK MAX 经 type-5 关系传播到 XBAR/SYS”是高可信机制解释，而不是已经逐指令跟完当前加密 GSP 路径的事实。

## 一个显存上限怎样暴露 XBAR 的实际作用

XBAR 最初变得不可忽略，并不是因为一个超频选项，而是因为一个显存锁频异常。在相同的 CP2077 6K Path Tracing 场景中，分别提交 `MCLK MIN = 15000 MHz` 和 `MCLK MAX = 15000 MHz`，两组实验的物理 MCLK 都约为 15001 MHz，但只有 MAX 使 XBAR、SYS、电压、功耗和吞吐进入另一个状态：

| 请求 | 平均 FPS | 物理 MCLK | XBAR | SYS | 板卡功耗 |
|---|---:|---:|---:|---:|---:|
| MIN-only 15000 | 11.7864 | 约 15001 MHz | 2356.0 MHz | 2332.4 MHz | 560.6 W |
| MAX-only 15000 | 9.9580 | 约 15001 MHz | 1493.6 MHz | 1501.0 MHz | 414.2 W |
| MAX-only 16000 | 9.8533 | 约 15001 MHz | 1492.7 MHz | 1500.0 MHz | 413.7 W |

16000 MHz 是决定性的反例：它高于实际 MCLK，因而没有限制显存运行频率，却仍然制造了几乎相同的低 XBAR/SYS 状态。这排除了“显存真的降频导致性能下降”，也排除了 MAX 只是普通物理频率天花板的解释。

为了区分 XBAR 降低究竟是原因还是伴随现象，另一个实验绕过 MCLK，直接提交严格的 `XBAR MAX = 1493 MHz`。在相同 FurMark 负载中，MCLK MAX 16000 和直接 XBAR MAX 1493 得到了几乎一致的内部状态：

| 状态 | XBAR/branch-1 | 电压 | 归一化 workload | 候选估算功耗 | DG0 目标 |
|---|---:|---:|---:|---:|---:|
| MCLK MAX 16000 | 1498.2 MHz | 870.0 mV | 526.2 | 234.1 W | 3018.9 MHz |
| XBAR MAX 1493 | 1492.3 MHz | 870.0 mV | 522.4 | 233.8 W | 3021.8 MHz |

这里闭合的不只是跑分，而是下游控制器的电压、workload、候选功耗和 DG0 目标。有限 MCLK MAX 足以制造低 XBAR/共享电压轨状态，而直接制造同一 XBAR 状态也足以重现后续估算器状态。

这条反馈链大致为：

```text
有限 MCLK MAX
  -> 在现有 topology 中传播 rail-1/XBAR/SYS 范围
  -> XBAR/branch-1 实际状态降至约 1.49 GHz / 870 mV
  -> workload 生成器按较低的实际状态归一化观测功耗
  -> 归一化 workload 上升
  -> 候选估算器又把它代入约 2.56 GHz / 1.1 V 的候选状态
  -> branch-1 候选功耗被高估
  -> WORKLOAD_COMBINED_2X 改变 GPC/DG0 目标
```

最终性能方向依赖负载。CP2077 中，这条链降低 GPC 目标并留下大量未使用的板卡功耗；FurMark 中，它反而把加载后的 GPC 从约 2.35 GHz 推高到约 2.96 GHz，但渲染吞吐仍然下降。因而这里发现的不是一句“锁显存会降低核心频率”，而是一个跨域状态进入功耗估算反馈后，可以按 workload 组成向不同方向移动核心目标的问题。

同一物理卡换用 MSI Lightning VBIOS 后，该异常仍然重现：CP2077 平均 FPS 下降 10.48%，XBAR 下降 34.87%，SYS 下降 35.83%，而物理 MCLK 仍为约 15001 MHz。这排除了 ASUS Astral 单一 VBIOS 实现导致问题，但仍不能代替第二张 GPU、第二台机器的独立复现。

## 四个公开 issue 是同一条研究链，不是四项独立发现

截至 2026-08-13，下面四个由本文作者提交的 issue 均为 open。它们分别保存了初始症状、因果隔离、面向 LACT 用户的误用警告，以及 XBAR 直接控制方法。把它们并排列出，是为了保留公开时间线和可复现入口；它们不应被拆成四篇内容重复的“研究”。

| issue | 在研究链中的作用 | 其中实际包含的内容 |
|---|---|---|
| [NVIDIA #1265](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/1265) | 最初的性能异常 | 在 R610.43.03 上调用 `nvmlDeviceSetMemoryLockedClocks(15000,15000)` 后，CP2077 平均性能下降 16.43%，GPU 平均频率低 118.1 MHz、板卡功耗少 142.1 W，而物理 MCLK 仍约为 15001 MHz；`nvmlDeviceResetMemoryLockedClocks` 可恢复。它记录了症状，但当时还没有把 MIN 和 MAX 两个端点分开。 |
| [NVIDIA #1266](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/1266) | 端点反例与 XBAR/SYS 因果隔离 | 把 MIN-only、MAX-only 和高于实际 MCLK 的 MAX=16000 分开，证明触发条件是“有限最大端点”而不是显存真的降频；附有 CP2077、FurMark、直接 XBAR-MAX 等对照以及机器可校验的证据包。 |
| [LACT #1128](https://github.com/ilya-zlobintsev/LACT/issues/1128) | 防止普通用户误把锁频当 offset | 建议在 LACT 中明确区分 memory offset 与 NVML locked-clock range，并对有限 maximum 可能压低 XBAR/SYS 和性能给出警告；同时明确 LACT 只是调用相同 NVML API，并不是异常来源。 |
| [LACT #1147](https://github.com/ilya-zlobintsev/LACT/issues/1147) | 公开 XBAR/MSVDD 的运行时控制方法 | 给出 ClockClient command、结构尺寸、XBAR domain index、字段位置、读写/恢复顺序、最小 C 实现和风险边界；后续评论补充两个游戏的 A–B–A 结果。 |

### NVIDIA #1266 的公开 bug 复现方法

这个复现只使用 NVIDIA 已公开的 `nvidia-smi` memory locked-clock 界面，不需要私有 XBAR 写入。先清除旧状态并跑一遍同场景基线：

```bash
sudo nvidia-smi --reset-memory-clocks
# 运行固定场景并保存 MCLK、XBAR、SYS、GPC、功耗和吞吐日志
```

然后提交一个包含有限 maximum 的范围并重复同一场景：

```bash
sudo nvidia-smi --lock-memory-clocks=15000,16000
# 重复同一负载和日志采集
sudo nvidia-smi --reset-memory-clocks
```

关键判据不是只看 FPS，也不是只看命令是否成功，而是同时确认：物理 MCLK 仍约为 15001 MHz、并没有触及 16000 MHz 上限；XBAR/SYS 却显著下降；吞吐和控制器内部状态随之改变；reset 后状态恢复。这样才能排除“显存被上限实际钳住”这个更简单的解释。

NVIDIA 工程师随后在 CachyOS、610.43.02、另一张 RTX 5090 和一张 RTX 5070 Ti 上没有复现，并要求补充频率和 bug report。这个负结果不能被省略：它说明问题可能依赖具体驱动构建、VBIOS、板卡或其他状态。作者随后在全新安装的 610.57.04、VBIOS `98.02.2E.C0.0F`、子系统 `1462:530B` 上按原配置重新做配对实验：CP2077 为 2/2 组复现、平均下降 11.57%；FurMark 为 3/3 组复现、平均下降 21.30%；各组 MCLK 都固定在约 15001 MHz，同时 XBAR/SYS 坍缩、GPU clock 反而上升，且没有 slowdown reason 或新 Xid。恢复原配置后现象消失。

该 fresh-repro 证据包的 SHA-256 为：

```text
19390dac72556647e524119a5bd6759e4ed9f669e95bf44fed894e6ad0f80d78
```

它附带独立 verifier，校验结果为 PASS。这里能够写成“610.57.04 上可复现”；不能据此写成“所有 RTX 5090 和所有驱动都必现”。

### LACT #1147 的使用方法与实现边界

#1147 中公开的 [最小控制实现](https://gist.github.com/Loong0x00/959d7e934366a721399a84e7943cf442)与本文前面的 `xbar_clock_demo.c` 属于同一条控制路径：`GET_CONTROL` 保存整块状态，在 XBAR domain record 中写 frequency offset 和可选的 MSVDD offset，`SET_CONTROL` 后用 `CLK_MEASURE_FREQ` 验证物理时钟，最后恢复完整原块。issue 中的游戏复测也不是拿一次前后跑分相减，而是 A–B–A：

| 负载 | XBAR `+450 MHz`、MSVDD `+20 mV` 的 B 相对两次 A 均值 | 物理状态 |
|---|---:|---|
| Cyberpunk 2077 | +2.95% 平均 FPS，+2.29% 最低 FPS | XBAR 约 2394→2791 MHz；GPC 低约 8 MHz；SYS 不变 |
| Black Myth: Wukong | +3.05% 平均 FPS | XBAR 约 2406→2807 MHz；GPC 低约 8 MHz；SYS 不变 |

因此 #1147 足以证明该精确软硬件组合上“接口可用，而且 XBAR 的物理变化能产生独立吞吐收益”。它不证明这组 offset 长期稳定，更不证明 command 和字段布局是 NVIDIA 承诺的 ABI。LACT 若实现该功能，应把驱动版本/结构校验、完整快照恢复、物理测频、危险提示和未知构建拒绝作为功能的一部分，而不是只加两个输入框。

另有 [NVIDIA #1268](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/1268) 讨论最终 GPC 仲裁完成后重新评估电压，属于同一套功耗/V/F 控制器研究的相邻问题；它不是 XBAR 控制接口，也不是 MCLK-MAX 的公开复现入口，不能与 #1265/#1266 混写。

## XBAR 的实际性能价值有多大

MCLK MAX 异常下，提交严格 XBAR 2400 请求可以恢复 17.668% 的 CP2077 平均吞吐。但这不是“XBAR 超频 17.668%”：它是把已经被错误压低到约 1.5 GHz 的 XBAR/SYS 状态拉回正常区域。把这个数字当作普通超频收益，会混淆故障恢复与硬件加速。

正常状态下，更干净的证据是上一节列出的两个游戏 A–B–A。它们的重要性不在于约 3% 的数字很大，而在于收益没有来自更高的 GPC 或 SYS：GPC 反而略低，SYS 基本一致，改变的是 XBAR 请求。它说明某些游戏负载确实会受到这一内部数据通路时钟的限制。

短时 FurMark Vulkan 阶梯实验中，XBAR `+60/+120/+240/+300 MHz` 的平均 FPS 变化依次约为 `+2.0%/+5.3%/+8.6%/+8.6%`，`+450 MHz` 配合 `+20 mV` 时约为 `+10.6%`。但这些只有 8—10 秒计分窗口，只能证明控制会改变物理时钟和有用吞吐，不能证明长期稳定。`+450 MHz` 且不加电压时曾出现灰屏破图和长帧；加入 `+20 mV` 只是在短测中消除了症状。反过来，单独增加 `+20 mV` 还会因为消耗功耗预算而降低 FPS。

因此 XBAR 调节同时受至少三类资源约束：自身 V/F 可达性、共享 MSVDD 仲裁以及整卡功耗预算。频率 offset 和电压 offset 是两个独立请求，却不是两个能够脱离其他域独立实现的物理旋钮。

## 写入成功为什么仍然可能什么也没发生

活动 topology 的 GPC→XBAR 比例控制也可以被写入。一次实验把比例从 `0.899902344` 改为 `0.910003662`，驱动返回成功，完整控制块只有对应数值的两个字节发生变化，回读精确一致，实验结束后也成功恢复。但 FurMark 分数从 1962 变为 1959，约 `-0.15%`；平均物理 XBAR 从 2173.4 MHz 变为 2170.7 MHz，约 `-0.12%`。在测量精度内，没有出现预期的 XBAR 提升。

这不是一个没有价值的失败。它证明该比例在当时的固定功耗 FurMark 状态中不是最终活动约束，或者它的结果被 type-5 电压关系、V/F 点、功耗策略或后续仲裁覆盖。它也给所有私有 RM 控制实验提供了一条必要规则：

> 命令成功只证明命令成功；回读一致只证明对象保存了请求。只有独立硬件测量和工作量输出变化，才能证明请求改变了实际机器状态。

类似的边界也出现在 SYSCLK 上。SYS `+600 MHz` 可以在 FurMark 中运行并提高短时吞吐，却在 CP2077 中冻结并产生过上下文切换超时与恢复事件；给 XBAR 域增加电压并不能普遍修复。这说明 XBAR、SYS 和共享电压轨虽然耦合，却仍可能服务不同的物理消费者，单一频率比值不足以描述稳定性。

## 一个公开反例：EVC2 没有抬高 XBAR，不等于软件不能控制 XBAR

Overclock.net 的 RTX 5090 Owner's Club 从 [第 1945 页](https://www.overclock.net/threads/official-nvidia-rtx-5090-owners-club.1814246/page-1945)到 2026-08-13 的 [当前末页](https://www.overclock.net/threads/official-nvidia-rtx-5090-owners-club.1814246/latest)，恰好形成了一组公开的自然实验。它先展示了怎样从一个真实负结果推出错误的“不可能”，随后又由不同控制路径和多张显卡给出反例。

第 1945 页中，多名用户通过 EVC2、Afterburner 的 AUX/I²C 路径或直接 VRM offset 提高物理 MSVDD 输出，却观察到 XBAR 不变，或只增加约 15 MHz；外加约 40 mV 时也只有一两个 clock bin。讨论因而一度得出以下判断：驱动阻止访问 XBAR；必须修改 VBIOS power table、使用外置时钟发生器或做其他硬件改造；NVIDIA 不会提供 XBAR slider。

这个负结果本身没有错，错的是它所排除的对象。I²C/EVC2 直接改变稳压器输出时，GSP、VBIOS 状态对象和驱动中的 voltage request 未必知道物理电压已经变化，因此 XBAR V/F 状态不会像收到一个合法 MSVDD VID/offset request 那样重新生成。它只能证明：

```text
只提高 VRM 的实际 VOUT
  ≠ 更新驱动/GSP 看见的 MSVDD request
  ≠ 必然沿 XBAR V/F 曲线选择更高频点
```

它不能证明“不存在软件控制路径”，也不能证明“XBAR 只能靠硬改”。这与本文的本地负比例实验是同一类逻辑：写到了一个真实对象，但没有写到当时的活动约束。

第 1947 页的 [melonVolt 发布帖](https://www.overclock.net/threads/official-nvidia-rtx-5090-owners-club.1814246/page-1947#post-29605167)随后提供了反例。该工具没有伪装成直接 XBAR frequency offset；作者称它通过 Windows NVAPI 解析 NVIDIA 私有的 MSVDD voltage-offset 路径，以 5 mV 步长修改驱动可见的 request。本文没有取得并审计该闭源二进制，因此这里确认的是工具作者的实现声明与多个用户的输入/输出报告，不把内部实现声明冒充源码证明。论坛用户随后在 Aorus、Astral/Matrix、Lightning、PNY、TUF、FE、5090D HOF 以及不同交叉刷写 VBIOS 上报告了物理 XBAR 变化。公开文本中可以直接复核的代表值包括：

| 板卡/状态 | 请求或驱动报告值 | 用户报告的 XBAR 变化 | 证据含义 |
|---|---|---:|---|
| Matrix 5090 | 驱动 offset `-50→0 mV` | `2655→2755 MHz` | 驱动可见 request 能使 XBAR 重新选点 |
| 未注明具体板卡、MSI 2500 W VBIOS | melonVolt | `2647→2784 MHz`，`+137 MHz` | 增益远大于同讨论中的外部 I²C `+40 mV→约 +15 MHz` |
| 同卡三点阶梯 | `-50/-25/0 mV` | `2677/2730/2782 MHz` | request 与 XBAR 呈有序响应，不是单张前后截图 |
| PNY 5090 | HWiNFO/驱动报告 MSVDD `1.015→1.065 V`，最高有效 offset 为 `0 mV` | `2600→2700 MHz` | 另一 AIB 样品可复现，但存在驱动/样品上限；该数字不是外部 VOUT 测量 |
| Lightning 5090 | offset 到 `0 mV` | 约 `2630→2730 MHz` | 同一用户随后报告 CP2077 约 `+2–3%`，板卡功耗约 `640→680 W` |
| Astral Black + Matrix VBIOS | `+50 mV`，HWiNFO/驱动报告 MSVDD 封顶 `1.125 V` | `2692→2782 MHz` | 用户声称约 `+3%`，但未提供本文级别的原始配对日志，也没有外部 VOUT 测量 |
| 5090 FE stock | HWiNFO/驱动报告 `1.04→1.11 V` | `2448→2578 MHz`，`+130 MHz` | 现象不局限于高功耗非公版 PCB；电压数字仍只是逻辑遥测 |

这些结果是对“无硬改就不能通过软件提高 XBAR”这一绝对命题的直接反例；只需要一张卡成功就足以推翻“不可能”，论坛中实际出现了多张不同板卡。它们也从 Windows 侧独立支持了本文的物理模型：关键不是“MSVDD 铜排上电压更高”这一件事，而是 request 是否进入 GSP 管理的域状态和 V/F 选择。

第 1950 页还有一个需要防止错误归因的组合结果：同一用户报告 Lightning XOC 单用 melonVolt 时 XBAR 峰值约 2790 MHz，叠加 ECB 外置时钟发生器后约为 2966 MHz。2966 MHz 证明“驱动内 MSVDD request + 外部时钟修改”的组合路径到达过更高峰值，却不能写成 melonVolt 单独把 XBAR 提到了 2966 MHz；ECB 会影响时钟本身，必须另做单变量对照。

### 反面案例：把输入上限、仲裁结果和物理 VOUT 混成一个“1.15 V”

第 1959 页发布的 melonVolt 0.2a 同时暴露了更危险的误读。作者明确把它称为一次匆忙发布，尤其前端可能有问题；只在 RTX 5090 上测试过，并写了“风险自负”。界面提供所谓 `XOC mode`、NVVDD/core 最大目标和 MSVDD 最大目标，也会接受并显示 `1.150 V`。这些 UI 行为证明工具接受了一个输入，不能自动证明该输入已经通过 NVIDIA 的控制对象、rail 仲裁器和稳压器依次成为物理输出。

第 1960 页一张 Matrix 截图把混淆完整地放在了同一画面里：melonVolt 0.2a 显示 `MSVDD current max 1.150 V` 和 `target max 1.150 V`；HWiNFO 显示 `GPU MSVDD Voltage 1.150 V`；HWiNFO 的独立测频同时显示物理 XBAR 为 `2869.2 MHz`。最后一个数字证明 XBAR 时钟确实提高，却不反过来证明前两个 `1.150 V` 是物理 rail VOUT。截图中的 NVVDD/core 仍约为 `1.085/1.090 V`，所以它更不能证明“NVVDD 已经运行在 1.15 V”。另一张出现显存 `+3999` 的截图使用 MSI XOC VBIOS；它不能证明 Matrix 或 stock VBIOS 本身支持同样的显存范围。论坛随后把软件里的 `XOC mode`、XOC VBIOS、MSVDD 1.15 V 和 NVVDD 1.15 V 交叉使用，正好展示了命名怎样替代了测量。

NVIDIA 的 rail status 对象本身已经把这些层分开。已审计的版本中，同一 rail record 分别保存 `current/default`、`current_target`、`sensed`、maximum limit、reliability limit、alternate reliability limit 和 overvoltage limit。一次版本固定的只读探针在本机 rail 1/MSVDD 上得到：`current/default = 880 mV`、`current_target = 880 mV`、`maximum limit = 1000 mV`、`alternate reliability limit = 1070 mV`，而 `sensed = 0`，即该路径不提供传感值。当前已安装的用户态库哈希后来改变，探针按设计拒绝在未审计构建上运行；因此这里引用的是归档运行结果，不把旧布局外推到当前构建。这个结果也不否定另一张 Matrix 可能真的达到 1.15 V；它只证明 NVIDIA API 能返回请求/目标和多种上限，而没有独立物理传感值，且 UI 目标与仲裁器上限本来就是不同字段。

论坛自己的 EVC2 对照比字段名更有判别力：EVC2 可以把 VRM 的物理 VOUT 从约 `1.090 V` 提到约 `1.145 V`，但 HWiNFO 仍停在约 `1.085/1.090 V`，XBAR 也没有按物理 VOUT 继续增长。这直接证明 HWiNFO 的 `GPU MSVDD Voltage` 至少在该控制路径下不能被当成外部测得的 VOUT。该标签既没有写 `VID/requested`，也没有写 `VR VOUT`。HWiNFO 官方版本历史又显示，8.42 是专门为 MSI RTX 5090 Lightning 增加 VRM monitoring；Matrix 截图中没有出现一个明确的板载 VRM VOUT 通道。因此最保守、也最符合现有证据的说法是：该字段与 NVIDIA/GSP rail status 的逻辑值一致，但它在这个 HWiNFO 构建和这张卡上准确映射到哪个内部字段仍未确认。

正确的证据层级是：

```text
UI 接受输入
  ≠ 控制对象接受并回读
  ≠ 仲裁器选中的 rail target
  ≠ GSP/HWiNFO 报告的逻辑电压
  ≠ sensed/物理 VRM VOUT
  ≠ 外部测量
```

只有独立 EVC2 VRM VOUT、万用表或示波器测量能直接建立物理 rail 电压；如果某张卡的 `sensed` 字段确实受支持并经过外部仪器标定，也可以把它提升为传感证据，但本机只读结果为 0。论坛中“把电压加到黑屏，再把黑屏前一档当成日用安全值”的建议同样无效：短时功能不崩溃只能提供功能稳定性下界，不能证明电迁移、老化和寿命安全。`NVVDD 1.15 V` 的主张证据更弱；XOC VBIOS 或软件暴露一个目标范围，并不证明仲裁成功、物理电压实现或长期安全。

最新几页的另一个混杂变量是冷却与交叉刷写。许多结果来自水冷、AIO、冷水机或纯跑分机器，而不是保留原厂风扇和全部输出口的日用风冷卡。第 1960 页有参与者明确指出，ASUS 卡交叉刷 MSI XOC 会失去一个正在使用的 ASUS HDMI 输出。对水冷用户无关的风扇、接头和控制映射问题，可能在风冷跨刷中成为实质故障。因此这些结果不能省略 VBIOS、冷却方式、视频输出和板卡控制器差异后再推广到普通用户。

但这组公开反例不能升级成“melonVolt 设置普遍稳定”或“所有 XBAR 增长都等比例提高性能”。同一串讨论也完整展示了反边界：

- 有样品最初只增加约 15 MHz；不少卡在 `0` 或约 `+25/+35 mV` 后停止扩展，继续加 offset 没有更多 XBAR；
- 不同卡的驱动可见 MSVDD 分别封顶在约 `1.04/1.065/1.085/1.09/1.10/1.12/1.125 V`，换用 2500 W XOC VBIOS 也不保证解除本卡的 stock voltage limit；
- 一张 Matrix 在 EVC2 把实测 MSVDD 从 `1.090` 提至 `1.145 V`、melonVolt 甚至提交 `+100 mV` 时，XBAR 仍封顶约 2755 MHz，再次说明物理 VOUT 与驱动/GSP 选点不能混为一谈；
- 有用户在比 `-20 mV` 更高的设置遇到黑屏，另一用户报告总 offset `+75 mV` 黑屏而 `+70 mV` 尚可；因此每张卡的短稳阈值不同；
- 游戏报告有约 `+1.85%`、`+2–3%` 和约 `+3%`，也有人提高 XBAR 后 Steel Nomad 仍低于旧成绩、回退驱动也无法恢复个人最高分；频率上升不保证任意 workload、驱动和功耗状态下都净增；
- GPU-Z Render Test 曾出现被参与者自己判定“不接近真实负载”的电压/频率组合。截图、单次峰值和合成负载不能代替 A–B–A 游戏日志。

因此这段论坛材料的证据等级应写成“多样本公开复现/反例”，而不是本文本地实验同等级的审计记录：它扩展了 PCB、VBIOS、Windows 驱动和样品覆盖，足以否定软件控制的物理不可能性；但各帖子缺少统一 workload、统一遥测、原始数据和长期稳定测试，不能用来宣布某个 offset 普遍安全。还必须保持三条路径的区别：

| 路径 | 实际控制对象 | 能由现有证据推出什么 |
|---|---|---|
| EVC2/I²C VRM override | 稳压器物理输出 | 能改实际电压；GSP 不知情时不保证 XBAR V/F 重选 |
| melonVolt/NVAPI MSVDD offset | 驱动可见的 MSVDD request | 能经 V/F/仲裁间接提高 XBAR；受电压上限、曲线和样品约束 |
| 本文 ClockClient XBAR offset | XBAR domain 的频率 request，可另带 MSVDD request | 直接控制 XBAR 请求；仍受实际仲裁、稳定性和私有 ABI 约束 |

## 目前能够确认和不能确认的事

**已经确认：**

- GB202 的 XBARCLK 是独立于 GPCCLK、SYSCLK 和 MCLK 的活动硬件时钟域；
- 它有独立 PMU 对象、source id、apply/commit 路径和最终 MMIO 写入链；
- 私有硬件计数器能够独立测量 XBARCLK；
- XBAR 频率和域电压请求能够改变 127 点有效 V/F 状态；
- R610.57.04 上，运行时 XBAR/MSVDD offset 请求能精确回读、改变物理测量值和渲染吞吐，并能恢复原状态；
- 当前 topology 中存在 GPC→XBAR 比例关系，以及 MCLK/XBAR/SYS 间的 rail-1 共享电压关系；
- 一个不约束实际 MCLK 的有限最大端点，可以把 XBAR/SYS 推入另一个硬件和控制器状态；
- 直接制造低 XBAR 状态足以重现该 MCLK MAX 状态的关键下游反馈。
- NVIDIA rail status 把 current/default、current target、sensed 和多种 limit 分成独立字段；HWiNFO 的单一 `GPU MSVDD Voltage` 截图不足以证明物理 VOUT；

**高可信推断：**

- 当前 R610 使用现有 type-5 关系，把有限 MCLK 最大端点转换成共享电压范围，再传播为 XBAR/SYS 范围；
- XBARCLK 承担物理本地编程，而 XBAR2CLK 更接近逻辑或策略聚合域；
- 游戏中的约 3% 独立收益来自某种由 XBARCLK 驱动的片上数据路径吞吐提升，而不是 GPC 或 SYS 升频。

**仍然未知：**

- XBARCLK 在 GB202 版图上覆盖的全部模块、端点和互连拓扑；
- 当前 R610 中执行 type-5 转换的准确私有函数与动态 range 字段；
- XBAR source descriptor 运行时填入的具体硬件寄存器 offsets；
- NVIDIA 是否把非约束 MCLK MAX 的跨域传播视为预期行为；
- 本文直接 ClockClient XBAR-frequency 路径在不同 GB202 样品、驱动分支和 VBIOS 下的普遍性；论坛的多样本 MSVDD 间接路径不能替代它；
- 私有 ClockClient command 在未来驱动中的字段布局和语义是否继续兼容；
- HWiNFO 在上述构建和 Matrix 上把 `GPU MSVDD Voltage` 准确映射到了 NVIDIA rail status 的哪个字段；HWiNFO 闭源且目前没有作者确认，现有行为只支持“与逻辑 rail 状态一致”的保守判断；
- 可长期使用的 XBAR 电压/频率稳定边界。

## 结语

XBAR 最值得研究的地方，不是它能在某个短跑分里增加多少百分比，而是它展示了现代 GPU 控制系统的真实形态：一个公开界面中几乎不可见的物理时钟域，可以有自己的 V/F 状态和硬件编程路径，同时又通过时钟传播、共享电压轨和功耗估算器与核心、显存和 SYS 形成闭环。任何一个软件请求都只是这张约束网络的输入，最终硬件状态取决于哪条约束真正成为活动边界。

MCLK MAX 异常恰好提供了一个足够强的实验扰动，使这条隐藏路径从遥测相关性变成了可以控制、复现和反向验证的因果链。它也说明，在私有驱动和固件研究中，最有价值的结果往往不是找到一个“能写的偏移量”，而是证明这个写入经过了哪条硬件路径、改变了什么实际状态、在哪些条件下又会被别的仲裁器覆盖。

## 主要证据入口

- [可运行的 R610.57.04 XBAR ClockClient 最小示例](xbar_clock_demo.c)
- [GB202 PMU 时钟域、XBAR 硬件测频与传播拓扑](BLACKWELL_CONTROL_LOGIC_EXTRACTION_20260725.md)
- [有限 DRAM-MAX 到 XBAR/功耗反馈链闭合](power_governor_reverse/MEMORY_MAX_FEEDBACK_CLOSURE_20260728.md)
- [XBAR 运行时频率与域电压控制](LACT_XBAR_EXPERIMENTAL_ISSUE.md)
- [XBAR 127 点实时 V/F 状态](XBAR_VF_POINTS_RUNTIME_20260812.md)
- [正常状态下两个游戏的 XBAR-only A–B–A](issue1147_ingame_reply_20260812.md)
- [MCLK MAX 错误状态下的 XBAR 2400 恢复实验](XBAR2400_MCLKMAX16000_CP2077_AB_20260811.md)
- [MSI Lightning VBIOS 交叉实验](lightning_vbios_mclk_max_ab_20260803.md)
- [NVIDIA #1265：初始 memory locked-clock 性能异常](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/1265)
- [NVIDIA #1266：有限 MCLK MAX 对 XBAR/SYS 的传播与 fresh repro](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/1266)
- [LACT #1128：区分 memory offset 与 locked-clock range](https://github.com/ilya-zlobintsev/LACT/issues/1128)
- [LACT #1147：XBAR/MSVDD 直接控制请求与游戏 A–B–A](https://github.com/ilya-zlobintsev/LACT/issues/1147)
- [公开证据包复现实验](issue1266-public-evidence-20260810/summary/REPRODUCTION_REPORT.md)
- [原始遥测和 benchmark 输出复算](issue1266-public-evidence-20260810/summary/VERIFICATION.md)
- [Overclock.net 第 1945 页：外部 I²C/MSVDD 失败与“必须硬改”的推断](https://www.overclock.net/threads/official-nvidia-rtx-5090-owners-club.1814246/page-1945)
- [Overclock.net 第 1947 页：melonVolt 私有 NVAPI 路径及首批复现](https://www.overclock.net/threads/official-nvidia-rtx-5090-owners-club.1814246/page-1947#post-29605167)
- [Overclock.net 第 1949 页：多卡 XBAR 增长、饱和与黑屏](https://www.overclock.net/threads/official-nvidia-rtx-5090-owners-club.1814246/page-1949)
- [Overclock.net 第 1950 页：三点阶梯、MSVDD 饱和与 melonVolt+ECB](https://www.overclock.net/threads/official-nvidia-rtx-5090-owners-club.1814246/page-1950)
- [Overclock.net 第 1956 页：XOC VBIOS、MSVDD 上限与 EVC2 物理 VOUT 的分歧](https://www.overclock.net/threads/official-nvidia-rtx-5090-owners-club.1814246/page-1956)
- [Overclock.net 第 1959 页：melonVolt 0.2a 的匆忙发布与风险声明](https://www.overclock.net/threads/official-nvidia-rtx-5090-owners-club.1814246/page-1959#post-29605610)
- [Overclock.net 第 1960 页：1.15 V 截图、MSI XOC 显存范围与 HDMI 交叉刷写代价](https://www.overclock.net/threads/official-nvidia-rtx-5090-owners-club.1814246/page-1960)
- [Overclock.net 第 1961 页：把黑屏阈值当作日用安全值的反例](https://www.overclock.net/threads/official-nvidia-rtx-5090-owners-club.1814246/page-1961)
- [HWiNFO 官方版本历史：8.42 的 MSI RTX 5090 Lightning VRM monitoring](https://www.hwinfo.com/version-history/)
- [Overclock.net 当前末页：截至 2026-08-13 的后续样品](https://www.overclock.net/threads/official-nvidia-rtx-5090-owners-club.1814246/latest)
- [Overclock.net 第 1945 页的只读文本镜像](https://r.jina.ai/https://www.overclock.net/threads/official-nvidia-rtx-5090-owners-club.1814246/page-1945)
