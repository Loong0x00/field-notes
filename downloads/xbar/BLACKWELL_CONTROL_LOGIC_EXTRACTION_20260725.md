# GB202 运行时功耗/时钟控制逻辑拆解工作底稿

更新时间：2026-07-25 15:04（Asia/Singapore）

目标不是继续猜某个频率为何变化，而是还原下面这条完整控制链：

```text
传感器与 workload 输入
  -> physical/logical/die 2X observed metrics
  -> candidate tuple estimated metrics
  -> regime 搜索与预算比较
  -> DG0/GPC2CLK、DG1/XBAR 候选
  -> 客户端/热/功耗限制仲裁
  -> V/F 点、电压、离散时钟与实际功耗
```

## 一、已经由本机运行时或二进制直接验证的事实

### 1. LACT 与 V/F 表

- LACT 通过 NVIDIA Clock Client V/F control 接口按点写入频率偏移。
- 当前关键运行时点读回为：
  - 910 mV -> 2857 MHz
  - 950 mV -> 2895 MHz
  - 975 mV -> 约 2932--2947 MHz
  - 1000 mV -> 约 2992--3000 MHz
  - 1020 mV 以上 -> 约 3022--3030 MHz
- 同一个偏移表的绝对频率会随 NVIDIA Boost 基础表重算而变化一个档位左右。
- 固定一张 V/F 表不等于固定工作点；控制器仍可沿表选择不同电压。

### 2. 上游功率预算树

- policy 0 类型是 `0x14 WORKLOAD_COMBINED_2X`。
- policy 2 的 `TOTAL_GPU.CurrValue` 精确等于 policy 0 与 policy 1 当前值之和。
- policy 0 的可用预算满足：

```text
WORKLOAD_COMBINED_2X.CurrLimit
  = TOTAL_GPU.CurrLimit - PROP_LIMIT/MISC0.CurrValue
```

- 因而 600 W 板卡上限不会原封不动交给核心模型；显示、显存、I/O 等上游预算会先被扣除。
- `CurrLimit/CurrValue` 在 policy 0 中使用 mW；电流树另有 mA 单位。

### 3. 2X 模型结构

- `WORKLOAD_COMBINED_2X` 汇总 logical-single 与 die 关系。
- logical-single 继续汇总 physical-single。
- 当前 GSP 中存在对应的构造检查：类型、关系范围、单位和分支数量必须匹配。
- 旧 RM/MODS 保留了完整字段名称，包括：
  - observed logical/die/physical metrics
  - physical workload、voltage、leakage、V/F residency
  - estimated logical/die/physical metrics
  - candidate frequency、effective frequency、estimated value
  - regime 边界、搜索记录和 tuple 状态
- 运行时恒等式证明这些字段不是仅用于打印：分支 observed/estimated 值能精确求和到父级。

### 4. 搜索器的已知行为

- 2X 搜索器不是把当前整卡功耗直接与 600 W 比较。
- 它在候选频率 tuple 上计算 `estimated logical total`，选择不超过 `CurrLimit` 的最高候选。
- CP2077 中 estimated 值通常贴近预算边缘，且未越过 `CurrLimit`。
- `regimesStatus` 至少包含：
  - primary/secondary regime 边界
  - 五个 28 字节搜索记录（本卡前三个有效）
  - tuple 状态槽
  - primary raw ceiling `freqPriStartMHz`
- `freqPriStartMHz` 与发布的 DG0 基本一致；候选 tuple 频率是模型内部求值点，不能直接当作最终核心频率。

### 5. 输出域与仲裁链

- DG0 是核心 `GPC2CLK` 候选。
- DG0 基本逐周期映射到动态限制 `0x43 PERF_LIMIT_PMU_DOM_GRP_1`。
- `0x43` 再进入时钟仲裁，最后落到实际离散核心时钟。
- 对外发布的 DG1 是最终聚合后的 XBAR 候选，并取以下两项的较低值：
  - `0xe9 THERM_POLICY_XBAR`
  - `0xea PWR_POLICY_XBAR`
- 这里需要区分“2X 搜索器的直接输出”和“整个 domain-group 仲裁后的输出”：PMU 内部
  `0x202a817e` 会先把三分量初始化为 `UINT32_MAX`，随后只写 PSTATE 与 GPC2CLK，保留
  XBARCLK 为 `UINT32_MAX`。当前活动 clock-propagation topology 再用 GPC2CLK 派生 XBARCLK，
  最后与热/功耗/客户端限制逐分量取最小值。因此 DG1 不是 2X 功耗公式独立搜索出的第二个频率。
- 已确认可写的严格客户端限制：
  - `0x4c CLIENT_STRICT_GPC_MAX`
  - `0x4d CLIENT_STRICT_GPC_MIN`
  - `0xe4 CLIENT_STRICT_XBAR_MAX`
  - `0xe7 CLIENT_STRICT_XBAR_MIN`
- 写入结构为 frequency 类型，GPC 使用 domain 1，XBAR 使用 domain 2。
- 当前驱动要求 root 权限；普通用户返回 `0x1b NV_ERR_INSUFFICIENT_PERMISSIONS`。

### 6. 2026-07-25 严格控制变量实验

第一组只保持同一 V/F 表，没有固定核心工作点：

| 条件 | FPS | 核心 | 电压 | 板卡功耗 |
|---|---:|---:|---:|---:|
| XBAR 默认 | 8.7333 | 2818.6 MHz | 932.7 mV | 390.5 W |
| XBAR 2800 | 10.8567 | 2900.5 MHz | 988.8 mV | 541.8 W |

这一组不能解释为“XBAR 本身快 24%”，因为写 XBAR 后控制器同时改变了核心 V/F residency 和整卡预算使用；首次/后续运行缓存状态也可能参与差异。

原始记录：

- `benchmark_logs/cp2077_6k_20260725_063010/`
- `benchmark_logs/cp2077_6k_20260725_063432/`

第二组同时固定 GPC min=max 2800 MHz；实际 PLL 稳定在约 2745 MHz，电压全程为 890 mV：

| 条件 | 平均 FPS | 最低 FPS | 最高 FPS | 实际核心 | 电压 | 功耗 |
|---|---:|---:|---:|---:|---:|---:|
| GPC 锁定，XBAR 默认 | 10.6725 | 9.6726 | 12.1809 | 2746.5 MHz | 890 mV | 454.1 W |
| GPC 锁定，XBAR 2800 | 10.7178 | 9.6815 | 12.2864 | 2744.7 MHz | 890 mV | 454.9 W |

严格控制后的纯 XBAR 差异：

- 平均 FPS：+0.424%
- 最低 FPS：+0.092%
- 最高 FPS：+0.866%
- 核心频率：-0.066%
- 功耗：+0.176%

这说明 XBAR 2800 在该 6K PT 场景中的直接收益很小；此前的大幅变化主要来自限制写入对整套控制器的耦合，而非单独的 XBAR 吞吐提升。

原始记录：

- `benchmark_logs/cp2077_6k_20260725_064122/`
- `benchmark_logs/cp2077_6k_20260725_064352/`

测试后 `0x4c/0x4d/0xe4/0xe7` 均已清除，读回 effective 为 `0xffffffff`；无 Xid。

## 二、已收窄的未知部分

### A. 执行边界

实时求值边界已经确定：workload 生产、中值滤波、候选搜索、`V²/V` 定点模型、domain-group 仲裁和
change-sequence 构造都在 PMU。GSP-RM 负责对象配置/状态封送，并执行 PMU 脚本中标为 host/RM 的
受托管步骤。仍未命名的是 GSP 内 PERF/type-7 的具体接收函数，以及它最终调用的受托管硬件步骤。

### B. 数学公式

已经还原 workload 的计数器差分/模型归一化、中值滤波、mW 的 `V²` 与 mA 的 `V` 动态项、漏电加和、
两路 physical 求和、候选索引搜索和约 20 ms 更新链。仍需逐项还原的是 type-5 专用电压曲线的系数表、
leakage 模型内部定点格式、regime 边界/迟滞的全部字段，以及 candidate effective frequency 与公开 V/F
residency 的精确换算。

### C. 限制耦合与仲裁顺序

GPC/XBAR 的主要耦合已经由当前活动传播拓扑解释：GPC 经活动关系 0 以约 `0.899902344` 的比例传播
到 XBAR，XBAR 又通过共享 voltage-rail 关系与 MCLK/SYS/NVD/PWR 等域相连。仍需解释为何：

- 写 `CLIENT_STRICT_XBAR_{MIN,MAX}` 会让未锁定的核心跳到更高电压和更高功耗；
- 写 `CLIENT_STRICT_GPC_{MIN,MAX}` 会改变功耗模型状态，即使显示频率未提高；
- client limits 是仅在 2X 之后参与本轮仲裁，还是还会通过 V/F residency/workload 反馈改变下一控制周期；
- type-5 voltage 关系如何把多个域各自的最低电压要求重新映射为最终 XBAR 离散点。

### D. 真实 XBAR 时钟

已找到并实测只读 `0x20809006` 硬件计数器接口，可分别读取 GPCCLK 与 XBARCLK 的实际瞬时时钟。
下一步缺的不是读法，而是一次 RT 游戏负载下的同时间轴
`policy Limits/Ceiling + actual GPC/XBAR` 采样。

## 三、下一步取证顺序

1. 用已经改好的只读重复采样器，在 RT 游戏基准中同步记录
   `PSTATE/GPC2CLK/XBARCLK Limits/Ceiling` 与实际 GPCCLK/XBARCLK，直接判定请求端和执行端差值。
2. 从活动 topology 的 type-5 voltage relationships 反追 evaluator，确定共享 rail 如何把 0.9 比例结果
   抬高到最终 XBAR 候选；同时继续恢复 leakage evaluator 的系数/定点格式。
3. 把五个 regime 搜索记录与候选索引循环逐字段对齐，确定迟滞和边界切换条件。
4. 在 GSP 中定位 PMU PERF/type-7 接收器，把受托管 change-sequence 步骤闭合到具体 handler。
5. 读取或旁路导出运行中的 XBAR source descriptor row，补齐最终 MMIO register offsets。
6. 维持以下最小闭环逐项验证：

```text
单个 physical-single 输入
  -> observed/estimated value
  -> 一个 regime 内的 tuple 选择
  -> DG0
```

7. 优先用只读运行时状态验证公式；只有只读观测不能区分因果时，才用短时、可逆的 GPC/XBAR 阶跃。

## 四、现有工具与入口

- 当前 GSP ELF：`/tmp/gsp_inner_verify_19f040.elf`
- 旧 MODS/RM：`mods_audit/static/extracted_inner/mods`
- 动态策略/限制探针：`power_cap_limit_probe.c`
- 主动限制探针：`perf_active_limits_probe.c`
- regime 解码器：`scripts/decode-combined2x-regimes.py`
- 总体既有研究：`BLACKWELL_VF_RUNTIME_GOVERNANCE_FINDINGS_20260724.md`

本文件作为控制逻辑拆解的索引；新的地址、函数、公式和验证结果继续追加在这里，避免把已验证事实与推测混写。

## 五、当前 GSP 的动态状态读取边界

已在 `/tmp/gsp_inner_verify_19f040.elf` 中定位方法 `0x2080a619`
（`PowerPoliciesGetDynamicStatus`）：

- 方法描述符位于 file offset `0x00c1d020`，对应 VA `0x01c1d020`；
- 参数区大小为 `0x00060af8`；
- handler 为 VA `0x0176c404`；
- handler 包装层调用 VA `0x0176bca8`，缺少所需对象时返回 `0x56`；
- `0x0176bca8..0x0176c404` 会分配/遍历 BoardObj mask，并通过对象虚函数把各策略的动态状态复制、序列化进输出缓冲区。

因此，这个控制方法是**状态封送器**，不是 `WORKLOAD_COMBINED_2X` 的实时计算函数：
它把已经存在于本地 BoardObj 动态对象里的结果返回给调用者。下一条真正需要追的边是：

```text
PMU / shared surface / RPC 更新
  -> GSP BoardObj 动态状态缓存
  -> 0x2080a619 状态封送
  -> 用户态探针
```

当前 GSP 还包含 `RmPmuRpcProfiling`、`RmPmuSuperSurfaceRPC` 等字符串，且可执行映像末端附近存在
`NVUCODES` 表记号；这些只能证明 PMU 传输/固件描述设施存在，尚不能证明 2X 公式位于 GSP 或 PMU 的哪一侧。

## 六、MODS 内嵌 RISC-V 固件与 PMU bindata

对 `mods_audit/static/extracted_inner/mods` 内全部 `\x7fELF` 命中做完整 ELF header、program header、
section header 和文件边界校验后得到：

- 7066 个原始 magic 命中中只有 76 个是结构有效的 ELF；
- 其中 57 个是 `EM_CUDA`，16 个是 `EM_RISCV`，另有少量其他对象；
- 前六个 RISC-V ELF（file offsets `0x09f88c60..0x0a168a20`）的 section 名称和字符串明确显示为
  SEC2 应用，不是 PMU；
- 余下十个大 RISC-V ELF 位于 `0x0b9589c0..0x0c293c60`，其中三对内容完全相同，去重后为七个映像族；
- 大映像的代码规模约 `0x1ac00..0xbd000`，包含大量 MPU section，section 名称被改写为 `s12`、`s13` 等，
  但 ELF 代码本身未加密，可以直接反汇编；
- 较新的大映像含 `NVRISCV GCC 12.2.0-2024.03.01` 标记，另外几组含
  `NVRISCV GCC 8.3.0-2022.03.28` 标记。

MODS 内部的 bindata 结构已按公开 RM 的 `BINDATA_STORAGE_PVT` 布局实证解析。每条记录是 24 字节：

```text
u32 actualSize
u32 compressedSize
u64 pData
u32 flags
u32 relOffset
```

例如：

```text
record file 0x099896d0:
  actualSize     = 0x11a000
  compressedSize = 0x11a000
  pData file     = 0x0b9545c0
  flags          = 0x2 (referenced, uncompressed)

RISC-V ELF begins at pData + 0x4400 = file 0x0b9589c0
```

其他大映像同样位于 bindata 包头之后 `0x4400`、`0x5400` 或 `0x7400`；ELF extent 与
`actualSize` 的包边界精确吻合。这证明它们是 MODS 正式管理的固件映像，而不是随机夹带数据。

MODS 的 archive lookup `0x06cdc0e0` 已还原：archive 首部为 entry count，每项 16 字节，依次是
字符串 label 指针与 storage 指针。PMU 路径用字符串 `ucode_image` 和 `ucode_desc` 查询这些 archive。
`0x06ce4d70..0x06ce4f10` 是一排每 16 字节一个的 getter，分别直接返回对应 archive 地址；
`0x06cac000` 附近的 HAL 构造器再按芯片族把这些 getter 安装到 GPU 对象的 `+0x3f8..+0x430`。

PMU 选择函数 `0x06a8e5b0..0x06a8e9e9` 的分支也已确认：

- 日志明确区分 encrypted debug、encrypted production 与 unencrypted PMU-RISCV；
- 它通过 GPU HAL 的 `+0x3f8/+0x400/+0x410/+0x418/+0x420/+0x428/+0x430` getter 取得不同
  `ucode_image`/`ucode_desc` archive；
- 因而当前大 RISC-V ELF 中确有未加密 PMU 候选，且可沿 HAL 表进一步精确映射到芯片和 profile。

MODS 自己的设备表还给出内部 ID：`GB202=0x46`、`GB203=0x47`、`GB205=0x49`、
`GB206=0x4a`、`GB207=0x4b`。下一步是把 `GB202=0x46` 经过 HAL mask 的路径还原到上述 getter，
从而选出 GB202 实际对应的未加密 PMU ELF；然后从 PMU 的 power-policy BoardObj dispatch 入口反向定位
`WORKLOAD_COMBINED_2X` 求值函数。

## 七、GB202 PMU 映像精确归属与第一轮代码定位

上一节末尾把 `GB202=0x46` 当成 HAL mask 输入的思路需要更正。`0x46` 是 MODS 的设备枚举，
不是 R570 的 `chipHal` 索引。通过本机官方包
`vm_mods_lab/downloads/NVIDIA-Linux-x86_64-570.86.16.run` 中未剥离的
`nv-kernel.o_binary` 直接反汇编 `registerHalModule_GB202`，得到 R570 的实际值：

```text
GB100  chipHal = 0x39
GB102  chipHal = 0x3a
GB10B  chipHal = 0x3b
GB202  chipHal = 0x3c
GB203  chipHal = 0x3d
GB205  chipHal = 0x3e
GB206  chipHal = 0x3f
GB207  chipHal = 0x40
```

因此 GB202 在 MODS PMU HAL 构造器 `0x06cabf80..0x06cae0ae` 中走 group 1、bit 28，
命中 `0x06cac950` 分支；此前套用 R610 的 index 65 而得到“空桩”的结论是错的。该分支安装了真实的
PMU archive getters，而不是 stub。

沿 getter、archive 和 bindata storage 精确追踪后，GB202 的未加密 PMU 链为：

```text
HAL +0x418 -> getter 0x06ce4e70 -> archive 0x09d7c8f8 -> ucode_image
             pData file 0x0b9545c0 -> RISC-V ELF file 0x0b9589c0
HAL +0x420 -> getter 0x06ce4ea0 -> archive 0x09d7c8b0 -> ucode_desc
```

另一套 getter 指向 file `0x0c03fc60`。bindata archive 给出的精确映像长度为
`0x115c00`；按这个长度切出的两份 ELF 字节完全相同：

```text
SHA256 333d8c4ea22659f65c898579d70806640b7e26357eb6305bd900a807627d2db0
```

所以 `/tmp/mods_rv_0b9589c0.elf` 已不再是“候选”，而是经 R570 GB202 HAL 路径验证的 PMU 固件。
它是 RV64 可执行 ELF，入口 `0x2028b9c2`，主要逻辑代码段为
`0x20298000..0x202fa000`，未加密、可直接反汇编。

此前记录的 `f526...` 是提取范围错误造成的哈希，不能再用于映像身份。当前临时文件还比 archive
声明长度多带了 `0x398` 字节尾部数据，因此它自身的文件哈希也不同；本文对固件身份一律以原包内
两个 archive 的 `0x115c00` 精确切片及上述相同哈希为准。多出的尾部不影响已映射代码段反汇编。

第一轮代码筛选还得到：

- `0x202985fc` 按对象 type/version 返回序列化大小，显式区分 `0x12/0x13/0x14`；这只能证明这份 PMU
  接口代码认识并能搬运 2X 相关对象，不能证明它会在本地实例化或求值；该函数只是消息大小分派。
- `0x2029e6f2` 的常数 `0x14` 是大型传感器/表项读取器的第 20 组索引；它按子索引读取连续 64 位槽，
  不是 `WORKLOAD_COMBINED_2X`。
- `0x202b5c38` 中 `0x12/0x13/0x14` 分支返回硬件字段描述符，也不是实时求值函数。
- `0x202e247e` 注册了周期参数为 `100000/1000000` 的高频定时模块；其邻接代码包含候选条目排序、
  插值、频率上下界和大块状态结构操作，可能位于运行时 governor 邻近区域，但尚未仅凭形状将它命名为
  2X。下一步用动态状态字段偏移和调用图交叉确认，而不是继续按常数猜测。

## 八、执行边界修正与 GSP `0x14` 类注册

对 `/tmp/mods_rv_0b9589c0.elf` 的 BoardObj 构造工厂 `0x202f2a56` 做完整分支复核后，得到一个重要修正：

```text
该工厂实际构造的 policy type：
00, 03, 04, 09, 0b, 0f, 10, 1c, 1d

没有构造：
11 PHYSICAL_SINGLE_2X
12 LOGICAL_SINGLE_2X
13 DIE_2X
14 COMBINED_2X
```

所以“PMU 的通用消息层能识别/搬运 `0x14`”不能再推导为“这份 PMU 在本地运行 `0x14` 的专用求值器”。
这个结论只限于公开 policy type 的构造层；后续已在 PMU 的内部
type `0x0b` 对象中找到实际的两路物理模型求值与候选频率搜索（见第十节）。
因此更准确的分层是：

1. GSP 保有公开 `0x11..0x14` BoardObj 与大状态对象；
2. PMU 用内部较低层对象执行两路物理功耗模型、候选求值和频率搜索，
   而不必在该构造工厂内创建一个同名 type `0x14` 实例。

当前 GSP 已定位到 `0x14` 的真正类构造分支 `0x01af3290`：

- 检查输入 type 等于 `0x14`；
- 分配 `0x3a0` 字节对象；
- 安装专用方法 `0x01791ed8`、`0x01793f4c`、`0x0179504c`、`0x01795b30`、
  `0x01796570`；
- 对象 `+0x318` 安装 validator `0x0178dd38`；
- 与它平行的 type `0x11` 构造分支位于 `0x01af277c`，使用另一组专用方法和 validator
  `0x0178e300`。

这几项 `0x14` 专用方法目前均已逐条检查：它们负责配置、控制和动态状态大块复制，并不是实时功耗方程。
`0x0178dd38` 则验证 logical/die 关系范围、下层对象类型和 limit unit。也就是说，GSP 确实拥有完整的
2X 对象层，但实时 evaluator 仍需从通用调度/更新路径继续追。

另一个包含 `type == 0x14` 的 GSP 分支位于 `0x0181bd9c`，所属函数从 `0x0181ad10` 开始。完整控制流显示
该函数分配 188 字节传输对象、遍历 BoardObj、生成掩码/索引并提交；`0x14` 分支只在确认对象
`+0xac == 0x00400000` 后把它纳入同一传输集合。它是配置初始化/封送路径，不是每周期 governor 方程。

### 旧 `TGP1X` 单点估算接口的直接验证

MODS 的 `GetPowerScalingTgp1XEstimates(temp, gpcClk, workloadItem)` 已还原到控制方法
`0x2080a0d2`。它能一次返回 `powerHint`、workload、leakage、voltage、candidate/effective frequency、
estimated value 和 floor tuple，原本是验证单点估算公式的最短路径。

已把该 ABI 加入 `power_cap_limit_probe --tgp1x-estimate GPC_MHZ WORKLOAD_ITEM` 并在本机 R610/GB202
做只读调用。实际结果是：模型枚举 `0x2080a0d0` 和后续 `0x2080a0d2` 均返回 `0x1f`；即当前驱动不接受
这条旧 TGP1X 路径。GPU 状态正常。该结果排除了“直接借旧 1X 查询器让 R610 计算任意 2X 候选点”的
捷径，但保留了接口实现和参数布局，便于以后在匹配的 R570/MODS 环境交叉验证。

后续 PMU 反汇编已经补上完整在线更新边：公开 `0x14` 状态下面确有内部 type `0x0b` 的两路模型对象；
同一个定时回调先完成周期采样、workload 反推和滤波，再进入策略仲裁、候选频率搜索、逐域最小值合并
和下游请求提交。完整调用链见第十一节；`0x2080a619` 仍只是状态查询包装层。

## 九、`0x14` 大状态复制布局与约 20 ms 原子刷新

继续逐条复核 `0x14` 构造器安装的接口后，`0x0179504c` 的职责已经可以精确描述。它先调用基类复制器，
随后把一个来源状态对象搬到大小为 `0x1720` 的目标记录：

```text
目标 +0x0140 <- 来源 +0x00a4，长度 0x0fd8
目标 +0x1118 <- 来源 +0x107c，长度 0x0550
目标 +0x1668 <- 来源 +0x00a1，1 字节标志
目标 +0x166c <- 来源 +0x15cc，长度 0x00b4
目标 +0x013c <- 来源对象 +0x0380，经基类 helper 复制
```

`0x0fd8 + 0x0550 + 4 + 0x00b4` 加上头部恰好覆盖到 `0x1720` 记录末尾。这给出了
`PowerPoliciesGetDynamicStatus` 中 policy 0 大记录的直接静态来源；它是已经算好的动态状态导出器，
不是 evaluator 本身。

为验证这些区段究竟是配置还是实时状态，`power_cap_limit_probe --policy-dynamic-repeat` 增加了五段独立
FNV-1a 哈希、逐段变化字节数和前 24 个变化 dword。一次 80 次、零额外 sleep 的只读查询得到：

```text
单次 RM 查询：约 10.4--13.5 ms
状态发生变化时：
  +0x0000..+0x013f 变化约 5--7 字节
  +0x0140..+0x1117 变化约 215--256 字节
  +0x1118..+0x1667 变化约 12--17 字节
  +0x1668..+0x166b 0 字节
  +0x166c..+0x171f 0 字节
```

相邻查询通常出现“一份快照重复一次，然后三块同时变化”的模式；先前 240 次采样中，变化快照间隔
均值为 `19.983 ms`，主要落在约 `16--27 ms`。本轮 dword 差分又确认，`CurrLimit/CurrValue`、
observed metrics 的多组计数器，以及 estimated metrics 的少量结果在同一快照边界一起改变，而两个尾块
在空闲桌面下保持常量。

这组结果支持如下窄结论：

- **PROVED**：GSP/RM 返回的是异步维护的原子状态快照，不是每次用户查询临时重算整套 2X 模型；
- **PROVED**：`+0x0140` observed 主体与 `+0x1118` estimated 主体都属于周期更新状态；
- **INFERENCE**：不变尾块更像模式、错误或低频状态，仍需通过另一种负载/状态切换才能给字段命名；
- **PROVED**：PMU 静态调用链中，同一个定时回调先更新采样/workload，随后立即运行策略 evaluator；
- **INFERENCE**：本机实测约 20 ms 快照节拍就是该定时器的活配置周期。静态 ELF 的配置位于 NOBITS，
  尚未直接读出运行时数值，故这里只把调用关系而非 `19.983 ms` 数值相等标为直接证明。

R570 GB202 PMU 中确有一个 `20000 us` 定时注册，但其回调读取三个 power-channel BoardObj 并写入
PMUMON 环形记录。它能解释相同的采样节拍，却不能单凭周期相等命名为 `WORKLOAD_COMBINED_2X`
求值回调。另一个曾按消息值 `0x14` 追到的 PMU 分支属于内部消息总线 unit/type，已经排除，不能与
power-policy type `0x14` 混用。

当前更新边已经收窄为：周期生产者先形成来源状态对象，在线 evaluator 在同一回调内消费它，
`0x0179504c` 再按上述布局导入/导出大记录。下一层尚未命名的是提交请求之后由哪个时钟任务完成最终
硬件编程，而不是 `0x2080a619` 查询包装层。

## 十、PMU 两路估算公式与候选搜索

R570 GB202 PMU 中的通用在线策略求值函数 `0x202a784c` 按内部对象 `+0x03` 的 type 分流：

```text
type 0x0b -> 0x202a817e
type 0x10 -> 0x202a9586
```

`0x202a817e` 开头读取对象 `+0xb8`，非零时立即返回。这里的 `+0xb8` **不是惰性初始化标志**：
`0x202abf88` 每次更新都把 `0x202ac948` 的返回状态写入该字节，而 `0x202ac948` 成功刷新模型后返回
`0`。因此 `0` 表示“本轮状态有效，可以继续求值”，非零表示把刷新错误向后传播。

这使 `0x202a817e` 可以确定为在线候选频率搜索器。每次成功调用时，它先把滤波后的两路 workload
从对象 `+0xfc/+0x11c` 复制到候选状态 `+0x188/+0x19c`，再通过
`0x202c38fc/0x202c399a` 在频率索引与 MHz 之间转换，反复调用 `0x202ac6ae` 计算候选值，并围绕
对象 `+0x34` 的预算搜索可接受边界。末端使用 `+0xe0/+0xe2` 两个 Q12 参数修正边界，把本轮结果
写入对象 `+0x78/+0x80`，供随后仲裁合并。

`0x202ac6ae` 是两路 physical-single 候选求值器。它以 20 字节状态步长循环两次，
每路先取实时/模型电压下界的较大值，转换为 mV，再计算漏电/静态项和动态项。
两路的 `static + dynamic` 在函数末尾用 `addw` 精确相加后返回。

没有专用电压曲线时，明文回退公式可直接写为：

```text
limitUnit == mW:
    vScaled = round(voltmV * voltmV / 1000)
    dynamic = round(workloadQ12 * candidateFreqMHz * vScaled / 4096)

limitUnit == mA:
    dynamic = round(workloadQ12 * candidateFreqMHz * voltmV / 4096)

physicalValue = staticOrLeakageModelValue + dynamic
logicalValue  = physicalValue[0] + physicalValue[1]
```

有专用 type-5 电压曲线时，先计算
`voltQ12 = round(voltmV * 4096 / 1000)`；电流路径只求曲线值，功率路径再与 `voltQ12`
作一次 Q12 乘法。继续展开 `0x202a72be/0x202a72de` 后，type-5 唯一的 32 位参数可确定为 Q12
指数 `p`：`0x202b4f94(x, p)` 是 Q12 幂函数（`p=0` 返回 4096，`p=4096` 原样返回 `x`），所以
两条路径精确为：

```text
curveCurrentQ12 = powQ12(voltQ12, p)                       # V^p
curvePowerQ12   = mulQ12(voltQ12, curveCurrentQ12)         # V^(p+1)
```

当前 A616 的两条 type-5 记录参数均为 `p=5324/4096=1.2998046875`，所以模型实际使用约
`V^1.2998`（mA）和 `V^2.2998`（mW），不是朴素的 `V`/`V²`。动态项最后按
`curveFactor * candidateFreq * 1000 * workload >> 24` 计算并检查 32 位溢出。
漏电模型也有相同的单位分流：mA 路径保留模型输出，mW 路径额外乘实际电压并除以
`1,000,000`，即把漏电换算成功率。

这一形状已用当前 R610 的只读动态状态数值验证。把 12 个空闲快照的
`workload/frequency/voltage/leakage` 代入明文回退公式，分支 0 的预测值稳定比实际固件结果低
`1.12%--1.19%`，分支 1 稳定低 `5.11%--5.14%`。误差随数值变化仍保持稳定，与两路不同电压曲线对
素朴 `V²` 公式作系数修正一致。

证据等级：

- **PROVED**：两路求值、mW/mA 分流、`V²/V` 明文公式、漏电与动态项求和、两路物理值求和、在线候选索引搜索。
- **PROVED**：运行时 combined 的当前值精确等于两个 logical-single 子策略之和；估算 logical 值也精确等于两路 physical 值之和。
- **PROVED**：`+0xb8` 是刷新状态码；`0x202a817e` 从定时策略仲裁路径直接调用并消费本轮滤波值，而不是只在初始化阶段运行。
- **INFERENCE**：内部 type `0x0b` 是 GSP 公开 2X 对象展开后的下层求值对象；其语义由数据流和结构形状确定，但数值 `0x0b` 不能与公开 policy type 直接等同。
- **PROVED**：候选结果提交后依次经过 task 13 的请求接收/序列构造和 task 15 的 2X change-sequence 执行器，见第十二节。
- **UNKNOWN**：执行器内部的某些步骤仍经固件消息通道转发；本地电压/时钟步骤的先后关系已闭合，
  当前 PMU 的 GPC/XBAR 域对象和本地编程链也已定位（见第十五节），但 GSP-RM 受托管步骤的
  实际接收处理器仍未命名。

## 十一、workload 的生产、滤波与定时更新

内部 type `0x0b` 已找到一条从采样一直到下游请求提交的直接定时调用链：

```text
0x202afb14 注册回调 0x202ae76a
  -> 0x202ae876 遍历 BoardObj
     第一阶段：更新本轮观测值
       -> 0x202abd18 按内部 type 分流
       -> type 0x0b: 0x202ac0a4
       -> 0x202abf88
       -> 每路调用 0x202ac2de 生成瞬时 workload
       -> 0x202abe34 对两元样本作滚动中值滤波
     第二阶段：0x202ae78e
       -> 0x202ae2ae 策略仲裁
       -> 0x202a784c 通用策略求值
       -> type 0x0b: 0x202a817e
       -> 0x202ac6ae 反复求值候选频率
       -> 0x202afc3e 按时钟域合并约束
       -> 0x202afcaa 检测聚合结果变化并构造请求
       -> 0x202c205e 取得/分配域请求项
       -> 0x202c209a 提交给下游内部任务
```

`0x202ac2de` 不是普通的 GPU utilization 读取器。进一步追到它的直接取数器 `0x202abf16` 后，原先
“累计计数器差分/采样时间”的解释需要撤回。`0x202abf16` 按每个 physical-single 槽中的源 policy
索引，从统一 policy 状态表的对应记录读取当前 mW/mA 值，并写到槽内 `+0x80`；`0x202ac2de` 随后
检查该值不低于本路静态/漏电基线，计算 `observed - leakage/static`，再按当前频率和与候选估算器相同的
电压曲线归一化为 workload。mW 模式按 `V²`，mA 模式按 `V`。换言之，这个 workload 是从两路供电轨
的实时功率/电流、漏电、频率和电压模型反推出来的，不是 NVML 的忙碌百分比，也没有看到一个硬编码的
“RT 倍率”。

`0x202abe34` 的算法也已逐条确认：样本以二元组写入循环缓冲区，活动样本被复制后按第一 dword 做
插入排序；奇数个样本返回中位项，偶数个样本对中间两个样本的两个分量分别取平均。因此它是严格的
滚动中值滤波器。两路滤波后的第一分量分别落到对象 `+0xfc`、`+0x11c`；同一回调稍后的
`0x202a817e` 又把它们复制到候选状态 `+0x188`、`+0x19c`，所以一个在线 epoch 内使用的是刚完成
滤波的 workload，而不是更旧的一份查询快照。

仲裁端也已逐条确认。`0x202afc3e` 对启用的三个 domain-group 分量执行无符号
`min(dst, src)`，所以多个策略同时约束同一分量时由最低值胜出。三个分量现已由当前状态 ABI 和同包
RM 的打印字符串交叉命名为 `PSTATE / GPC2CLK / XBARCLK`，不是三路任意物理时钟。
`0x202afcaa` 分别处理 `domGrpLimits` 与 `domGrpCeiling` 两个三元组；没有变化就直接返回，有变化才
生成通知并建立六个“约束槽”请求项。它最终把请求对象标记为待提交，再调用 `0x202c209a`；后者组装
一条 32 字节内部消息，通过 PMU 内部任务/队列发送并在需要时等待完成。至此，“估算为何压频”到
“压频请求如何离开 power-policy 仲裁器”已经闭环；尚未展开的是接收任务如何把请求继续变成最终时钟
硬件动作。

定时器注册点 `0x202afb14` 从运行时配置 `+0x208` 读取 16 位值并乘 `1000`，同时读取 `+0x213`
的一个字节参数，再调用定时服务注册 `0x202ae76a`。配置区位于运行时/NOBITS，静态 ELF 不能给出本机
实际数值；只读状态实测的刷新间隔均值为 `19.983 ms`，与该定时链一致，但在读出 PMU 活配置前，
不能把二者的数值相等提升为直接证明。

证据等级：

- **PROVED**：定时回调先进入内部 type `0x0b` 更新器，再在同一回调中进入策略仲裁和在线候选搜索；
  两路源 policy 实测值减去静态/漏电项，再按当前频率与 `V²/V` 模型归一化；成对滚动中值滤波。
- **PROVED**：在线候选搜索消费滤波后的 workload，而非直接消费瞬时 utilization；多个策略的
  `PSTATE/GPC2CLK/XBARCLK` 结果按分量取最小值，`Limits/Ceiling` 聚合结果变化后由
  `0x202c209a` 提交内部请求。
- **INFERENCE**：实测约 20 ms 原子快照由这条定时链驱动；周期形状和数据更新吻合，但 PMU 活配置值尚未直接读出。
- **PROVED**：`0x202c209a` 的直接接收任务、请求对象和 2X change-sequence 执行器已闭合，见第十二节。
- **UNKNOWN**：受托管步骤的最终固件接收端，以及 GPCPLL/XBAR 寄存器编程与 AVFS 生效点的精确函数边界。

## 十二、从 2X 域限制到 change sequencer 执行器的完整队列链

`0x202afcaa -> 0x202c209a` 之后的接收端已经逐条定位，不再只是“下游任务”。
请求对象在 `0x202f715e` 附近初始化：

```text
0x202c1f7e(
    globalSlot = 0x20011990,
    command    = 0x22,
    entryCount = 6,
    completion = NULL)
```

`0x202c1f7e` 分配固定头部和 `0xb4 * entryCount` 字节的约束条目，并设置
`owner +0x1c`、`command +0x1d`、`count +0x1e`、`busy +0x1f` 与 `entries +0x20`。
`0x202afcaa` 读取的正是 `0x20011990` 中这个六槽请求对象。六槽的准确含义是：

```text
domGrpLimits : PSTATE, GPC2CLK, XBARCLK
domGrpCeiling: PSTATE, GPC2CLK, XBARCLK
```

因此它不是六个独立物理时钟域。slot 0 被转换成 type-1 PSTATE 请求；slot 1/2 被转换成 type-2
频率请求，分别使用 domain-group type 1/2 查得的 GPC2CLK/XBARCLK 域索引。

`0x202c209a` 把请求指针放到 32 字节消息 `+0x08`，将调用方任务选择编码放到
消息 byte 0，再投递到 task 13。task 13 的队列循环为 `0x202c7b84`；在
`0x202c7c56..0x202c7c98` 中，byte 0 为 `0x13..0x16` 的消息都直接进入
`0x202bebfa`。这与 `0x202c209a` 的四个调用方编码精确匹配。

`0x202bebfa` 是该请求的确切接收器：

1. 从消息 `+0x08` 取请求指针并锁定其信号量；
2. 将当前 task id 写到 `owner +0x1c`；
3. 按 `count +0x1e` 遍历六个 `0xb4` 字节约束条目；
4. 忽略 domain id 为 0 的空条目，查找其余域对象并验证 subtype bits `[5:4] == 2`；
5. 每个有效条目调用 `0x202bead2(domainObject, entry + 4)`；
6. 全部完成后清除 `busy +0x1f`，调用 `0x202be39a` 组织全局变更，最后解锁并完成请求。

`0x202bead2` 先通过 `0x202be984` 把新域数据与当前状态比较；只有变化时才重建该域的
change-state，更新域 bitmask 和序列计数。`0x202be39a` 继续构建/合并时钟域状态，并在
`0x202be874 -> 0x202bd308 -> 0x202bd180` 中把变更脚本封装成另一条 32 字节消息：

```text
target task = 15
message byte 0 = 0x10
message +0x08 = change-sequence object
```

task 15 的队列循环是 `0x202d01a6`。它以 `a0 = 0x0f` 调用队列接收器，并在
`0x202d0246..0x202d02a6` 把 byte 0 为 `0x10` 的请求指针直接交给 `0x202d0654`。
因此 `0x202d0654` 就是这条 2X 变更请求的执行入口。

`0x202d0654` 有两个主阶段：

```text
0x202d0cae  构建并验证 2X change-sequence script
              - 遍历域与候选状态
              - 验证目标时钟与 V/F 关系
              - 生成带方向和域数据的步骤表

0x202d1b62  逐项运行该 script
              - 本地步骤经 0x202d2154 按 step id 分派
              - 受托管步骤经 0x20290012 发送固件消息
              - 经 0x202d02ee/0x202d02ac 同步等待 type 0x11 回执
```

`0x202d1b62` 不是一次性写入函数。它用对象中的 step count/index 循环，再根据两个 bitmask
决定当前步骤是本地执行、跳过，还是交给另一固件端执行。本轮完成后，`0x202d0654`
再向 task 13 发送 byte 0 = `0x10` 的结果消息，task 13 在 `0x202c7d08` 调用
`0x202bcf2c` 处理完成状态。请求、执行、回执因而构成一个闭环。

这个结果也改变了对“为什么 2X 会压核心频率”的精确表述：

```text
2X 模型不是对某个 XBAR/GPC 寄存器直接减一个偏移。
它产生每域的候选上限，与其他客户端/热/功耗限制取最小值，
然后把整个目标状态交给 2X change sequencer。
sequencer 会校验 V/F，生成有顺序的电压/时钟步骤，再执行或托管每个步骤。
```

证据等级：

- **PROVED**：六域请求对象的初始化、布局和全局槽；task 13 路由、确切接收器与逐域构造；task 15 路由与 `0x202d0654` 执行入口；脚本构建/执行两阶段；成功/错误回执闭环。
- **PROVED**：执行器区分本地步骤和需要发送消息、等待回执的受托管步骤。
- **INFERENCE**：该结构与 MODS/RM 中的 `perfChangeSeqQueueChange`、`ARBITRATION_AND_APPLY` 和 `NV2080_CTRL_PERF_CHANGE_SEQ_2X_*` 完全同形，因而可用这些名称标注功能；PMU ELF 本身没有保留函数名。
- **PROVED**：`0x20290012` 构造标准 Falcon `RM_FLCN_QUEUE_HDR`，发送 PERF/type `0x07`；回程 PERF/type `0x0b` 被转换成 PMU 内部 event `0x11` 后唤醒等待者，见第十四节。
- **INFERENCE**：启用 GSP-RM 时，这些 RM 托管步骤由 GSP-RM 执行，而不是 FSP/SEC2；协议、当前驱动架构和 GSP 镜像中的 change-sequencer 注册项三方一致。
- **UNKNOWN**：哪些受托管 step 最终编程 GPCPLL/XBAR/voltage rail；AVFS 在变更前后的精确介入点。

## 十三、本地步骤的方向与“先升压还是先升频”

`0x202d2154` 的本地步骤分派现已解开。它先要求当前执行上下文返回类型 `0x25`，随后只接受
四个会真正进入本地处理器的 step id：

```text
0x0e 或 0x1c -> 0x202d21c6
0x0f 或 0x1d -> 0x202d2344
```

两个处理器复制的是同一份目标状态，并且最终都更新同一组缓存；真正的区别只有两个子操作的次序：

```text
0x202d21c6:
    0x202eadaa(大块 clock-domain 状态)
    0x202bb4f6(最多四路 rail mask/目标值)

0x202d2344:
    0x202bb4f6(最多四路 rail mask/目标值)
    0x202eadaa(大块 clock-domain 状态)
```

`0x202bb4f6` 的输入开头是 rail bitmask；调用者明确计算其 popcount 并拒绝超过四路的状态。该函数逐路检查
目标值是否落在对象的 min/max 范围，以 step size 转换为离散档位，再经
`0x202bb49c -> 0x202bbe9e -> 0x202ba69a` 分派到具体 rail/device 对象。末端
`0x202bc270` 对由对象索引出的 GPU 内部寄存器窗口作位域更新。它因此是电压 rail 编程支路，
而不是一般的候选频率计算。

`0x202eadaa` 的输入则是 `0x184` 字节 clock-domain 状态。它按 active mask 遍历多个域对象，调用
位于 `0x200ed1f0` 的设备表；表中虚函数落在 `0x202cebxx..0x202cf6xx`，并继续进入具体时钟设备/域
处理。它是时钟域编程支路。由此，两个本地处理器的安全语义可以确定为：

```text
降频/降压方向：先降时钟，再降电压    -> 0x202d21c6
升频/升压方向：先升电压，再升时钟    -> 0x202d2344
```

这不是依据常识给函数起名，而是由同一目标状态、两个互换次序的调用以及各自输入对象形状共同确定。
`0x0e/0x1c` 是降向步骤对，`0x0f/0x1d` 是升向步骤对；为何每个方向各保留两个编号仍未命名，
但它们在本地分派器中分别汇合到完全相同的实现。

作为独立交叉检查，同包 x86 RM 的旧式 2X runner 在 `0x698be8b` 使用 18 项跳转表。
表地址 `0x9cff7e8` 解码后给出 step id `0..17` 的入口：

```text
0:c3d8  1:c7f0  2:c798  3:c6f0  4:cbd0  5:c8e0
6:c6d0  7:c650  8:c560  9:c4a0  10:c450 11:c3e0
12:c3a0 13:c910 14:c340 15:c2c0 16:c278 17:beb0
```

其中保留日志可直接命名：`1=WAIT_FOR_MODESET`、`2=KMD_NOTIFY`、`3=PRE_HW`、
`4=NOISE_UNAWARE_CLKS`、`10=SET_DEEP_L1`、`12=SET_NVVDD_PSI`、
`16=LPWR_FEATURES`、`17=POST_HW`。`5/13` 汇入带方向的 `VOLTAGE_CHANGE`，`6/14`
汇入带方向的 `NOISE_AWARE_CLKS`。这证明旧 RM 同样把变更拆成显式有序的电压和时钟步骤。
不过 x86 host runner 与当前 RISC-V PMU script 使用的编号空间不同，不能仅凭同为十进制 14 就把两个
枚举硬等同；当前 PMU 的方向结论来自它自己的直接数据流。

证据等级：

- **PROVED**：四个本地 step id 的分派；两处理器对子操作的相反排序；rail 支路的 mask、范围、离散档位和设备分派；clock-domain 支路的 active-mask 与设备表分派。
- **PROVED**：`0x0e/0x1c` 先时钟后电压，`0x0f/0x1d` 先电压后时钟；由电气安全顺序可分别确定为降向和升向。
- **PROVED**：同包 x86 RM 的 18 项跳转表及上述有日志名称的旧步骤映射。
- **UNKNOWN**：当前 PMU 每个方向为何有两个 step id；XBAR source 的运行时寄存器描述符值；GSP-RM 中受托管步骤的精确 handler 地址。

## 十四、受托管步骤的 PMU/RM 协议与 GSP-RM 归属

`0x20290012` 发送的不是自定义裸寄存器命令。它在栈上构造了标准四字节 Falcon 队列头：

```text
header[0] = 原消息 byte 1 = 0x13
header[1] = 0x10
header[2] = 0
header[3] = 0
```

已安装的 NVIDIA R610 公开头文件 `flcnifcmn.h` 把同一布局定义为
`RM_FLCN_QUEUE_HDR { unitId, size, ctrlFlags, seqNumId }`，并明确说明 Falcon 发出的 packet
是给 RM 的 message。较新的 NVIDIA nvgpu PMU ABI 又把 unit `0x13` 定义为 `PMU_UNIT_PERF`；
因此这里不是 FAN、SEC2 或 FSP 单元，而是 PMU 的 PERF 单元。

调用者 `0x202d1b62` 对正文的精确构造如下：

```text
message byte 0..1 = 00 13
message byte 2    = 07
message byte 6..7 = 10 00
```

随后它同步发送该 PERF/type-7 消息，并等待自己的辅助队列收到内部 type `0x11`。回执链现已闭合：

```text
PMU change-sequence task
  -> 0x20290012 发出 Falcon PERF/type 7 到 RM
  -> PMU 的 host-message dispatcher 0x20298564
  -> PERF dispatcher 0x20298e84
  -> 收到正文 type 0x0b 时进入 0x20298dd6
  -> 向 0x20010258 辅助队列投递内部 type 0x11
  -> 0x202d02ac 验证 byte 0 == 0x11
  -> 0x202d1b62 继续下一脚本步骤
```

因此，这里有三个不同的编号：PMU→RM 外发 PERF type `0x07`，RM→PMU 返回 PERF type `0x0b`，
PMU dispatcher 再把它转换成内部任务事件 `0x11`。type-7 的通用 PMU 处理分支本身只返回成功；
type-0xb 分支才真正唤醒正在阻塞的 change-sequence task。

这一协议结构与公开 nvgpu 的旧式 change-sequence ABI 相互印证。公开头文件显式区分
`PRE_CHANGE_RM/POST_CHANGE_RM` 和 `PRE_CHANGE_PMU/POST_CHANGE_PMU`，还暴露
`cpu_advertised_step_id_mask` 与 `cpu_step_id_mask`；即 PMU 生成脚本，但可把被 mask 标出的步骤
交给 RM 执行，而不是把所有步骤都留在 PMU 内。

当前 GSP 镜像又给出接收者归属的直接旁证。镜像内存在注册项字符串
`RmPerfChangeSeqOverride`，唯一的代码引用位于 `0x0163a594`。该初始化路径读出 32 位值并检查
bit 0；置位时调用 `0x01639f50(..., clientId = 8, enable = 1)`，把 client 8 加入一个受回调管理的
功能 bitmask。MODS 的解码脚本和 x86 常量初始化器给出了位名与确切数值：

```text
RmPerfChangeSeqOverrideLockSet            = 1 << 0 = 1
RmPerfChangeSeqOverrideSkipVoltRangeTrim  = 1 << 1 = 2
```

MODS 脚本的注释把 bit 0 明确称为“Lock the perf change sequencer”；`-pstate_disable` 会同时锁
perf limits arbiter 与 perf change sequencer，并关闭 power/thermal capping。当前 GSP 镜像这处读取
只实际消费 bit 0；在同一初始化函数中没有看到对读回值 bit 1 的第二次检查，所以不能假定
`SkipVoltRangeTrim` 在该 GSP 构建中仍然生效。

结合三个事实——PMU RFIFO 是 PDAEMON→host、消息头明确以 RM 为目的地、当前 GSP-RM 镜像自身
包含并消费 change-sequencer 的 RM 注册项——可以把受托管步骤的责任边界收窄到 RM；在启用
GSP-RM 的 RTX 5090 上，实际 RM 执行者是 GSP-RM，而不是 FSP/SEC2。尚未完成的是在剥离符号的
GSP ELF 中把 PERF/type-7 和 type-11 的具体 handler 地址命名，以及继续追到它调用的最终
PLL/XBAR/rail 实现。

证据等级：

- **PROVED**：标准 Falcon 队列头的四字段；unit `0x13 = PERF`；PMU 外发 type `0x07`、接收 type `0x0b`、再以内部事件 `0x11` 唤醒 task 15 的完整回执链。
- **PROVED**：公开 change-sequence ABI 的 RM/PMU step 分工与 CPU step mask；GSP 镜像包含并实际读取 `RmPerfChangeSeqOverride`。
- **PROVED**：`LockSet = 1`、`SkipVoltRangeTrim = 2`；当前 GSP 读取路径只检查 bit 0。
- **INFERENCE**：启用 GSP-RM 时，PMU 所称的 host/RM 托管步骤由 GSP-RM 执行；协议、镜像归属和公开驱动架构三者一致，但剥离后的 type-7 GSP handler 尚未定位到地址。
- **UNKNOWN**：当前 GSP 中 type-7/type-11 handler 的精确函数边界；受托管步骤最终落到哪个 GPCPLL/XBAR/rail 写入函数；两个本地升/降方向为何各有两种 step id。当前 PMU 自己执行的 GPC/XBAR 本地路径见第十五节。

## 十五、当前 PMU 的 GPCCLK/XBARCLK 物理域与寄存器描述符边界

第十三节中 `0x202eadaa` 使用的 `0x200ed1f0` 并非运行时全零表。它位于 PMU ELF 的
PROGBITS 区，32 项指针在静态映像中已经完整初始化。非空项如下：

```text
index  domain mask  public name   object
0      0x00000001   GPCCLK        0x200ed398
1      0x00000002   XBARCLK       0x200ed4f0
2      0x00000004   SYSCLK        0x200ed498
4      0x00000010   MCLK          0x200ed5a0
18     0x00040000   XBAR2CLK      0x200ed718
19     0x00080000   PWRCLK        0x200ed7f8
20     0x00100000   NVDCLK        0x200ed548
21     0x00200000   PCIEGENCLK    0x200ed330
```

域名数值由公开 nvgpu `pmu/clk/clk.h` 交叉确认；`0x00040000` 在部分代际也叫
`UTILSCLK`，这里沿用同一头文件中的 `XBAR2CLK` 名称，但不把名字本身当作硬件归属证明。

`0x202eadaa` 对每个 12 字节目标条目把 one-hot domain mask 转成 bit index，再查上述对象。
它先遍历所有活动条目调用对象 vtable `+8` 的 apply 方法，随后再遍历一次调用 vtable `+16`
的 commit 方法。当前映像中的关键分派为：

```text
domain      vtable       apply         commit
GPCCLK      0x200ed078   0x202ceb86    0x202cf1d4
XBARCLK     0x200ed090   0x202cec06    0x202cf234
SYSCLK      0x200ed090   0x202cec06    0x202cf234
MCLK        0x200ed158   0x202cf010    0x202cf63e
XBAR2CLK    0x200ed048   0x202ceb24    0x202cf136
PWRCLK      0x200ed048   0x202ceb24    0x202cf136
NVDCLK      0x200ed090   0x202cec06    0x202cf234
PCIEGENCLK  0x200ed060   0x202ceb32    0x202cf144
```

这直接排除了“XBAR 只是 GPCCLK 的别名”这一解释：GPCCLK 与 XBARCLK 是两个同时存在的
物理域对象，使用不同的顶层 apply/commit 函数和独立状态。`XBAR2CLK` 的 apply/commit 在该映像
中只返回状态 `3`，没有继续走硬件编程链；结合它的 2X 命名，较合理的解释是它属于逻辑/API
聚合域，而物理本地编程落在 `XBARCLK`。后一句是 **INFERENCE**，不是仅凭名称作出的证明。

GPCCLK 与 XBARCLK 在下一层共用同一个 clock-source 类，但对象实例和 source id 仍然分开：

```text
XBARCLK nested object 0x200ed530 -> source id 2
GPCCLK per-GPC objects          -> source ids 3,4,5,6,7,8,12,13
NVDCLK nested object            -> source id 10

common source vtable 0x200ed0e8:
  apply/prepare  0x202cee62
  commit         0x202cf56a
  refresh        0x202cf53c
```

XBAR 的本地路径因而已经闭合到最终寄存器描述符读取之前：

```text
0x202eadaa
  -> XBARCLK apply 0x202cec06
  -> source method 0x202cee62
  -> 0x202b9d9c(source id 2)
  -> 0x202baca6 -> 0x202bb064

0x202eadaa commit phase
  -> XBARCLK commit 0x202cf234 -> 0x202cf144
  -> 0x202cf56a / 0x202cf53c
  -> 0x202bacfa -> 0x202bb0d8
```

更底层并非完全不透明。`0x202bbf3a` 会把计算出的 div/mux 系数打包，并经每个 source 的
寄存器描述符写入 PMU 的 `0xc0000000 + registerOffset` MMIO 窗口；`0x202bc4da` 对描述符中的
控制寄存器更新 bit `0x80`，`0x202bc5c4` 写入另一份打包控制字。描述符按下式索引：

```text
descriptor = 0x2007d800 + sourceId * 0x30
XBARCLK    = 0x2007d800 + 2 * 0x30 = 0x2007d860
```

`0x2007d800` 位于运行时初始化的 NOBITS/扩展区，静态 PMU ELF 不携带本机最终的寄存器偏移值。
所以当前边界不是“不知道谁编程 XBAR”，而是已经知道 source id、对象、apply/commit 和实际 MMIO
写入函数，仍缺本机运行时 descriptor row 中的几个寄存器 offset。

证据等级：

- **PROVED**：当前 PMU 的活动域表、对象/vtable、GPCCLK 与 XBARCLK 的独立分派；XBAR source id `2`，GPCCLK source ids `3,4,5,6,7,8,12,13`；上述本地 apply/commit 调用链。
- **PROVED**：`0x202bbf3a`、`0x202bc4da`、`0x202bc5c4` 最终经 per-source descriptor 写 PMU MMIO 窗口；XBAR descriptor 地址为 PMU DMEM `0x2007d860`。
- **INFERENCE**：`XBAR2CLK` 是不直接执行本地硬件编程的 2X 逻辑/API 域，物理写入由 `XBARCLK` 承担；依据是两个对象并存、前者返回 stub、后者完整进入 source/MMIO 链。
- **UNKNOWN**：XBAR descriptor 在本机运行后的具体 register offsets；六槽请求表 `0x2000bd90`
  中每个 limit ID 的运行时数值；GSP-RM 受托管步骤的精确 handler。

## 十六、当前状态 ABI 与独立 XBAR 硬件测频

同包 x86 RM 的状态打印字符串给出了当前三分量名称，而不再需要从数值形状猜测：

```text
P%d/domGrp.domGrpLimits.value[_PSTATE]
P%d/domGrp.domGrpLimits.value[_GPC2CLK]
P%d/domGrp.domGrpLimits.value[_XBARCLK]
P%d/domGrp.domGrpCeiling.value[_PSTATE]
P%d/domGrp.domGrpCeiling.value[_GPC2CLK]
P%d/domGrp.domGrpCeiling.value[_XBARCLK]
```

当前 R610 GSP 的方法表又直接给出 `0x2080a619` 的参数大小 `0x60af8`。使用该只读
`PWR_POLICY GET_STATUS` 接口，本机空闲快照的头部聚合结果为：

```text
global domGrpLimits : PSTATE=4, GPC2CLK=3090000 kHz, XBARCLK=3135000 kHz
global domGrpCeiling: PSTATE=1, GPC2CLK=UINT32_MAX, XBARCLK=UINT32_MAX

policy 0 WORKLOAD_COMBINED_2X:
  domGrpLimits : 4, 3090000, 3135000
  domGrpCeiling: 4, 3090000, 3135000
```

这里的 `PSTATE=4/1` 是内部 BoardObj 索引/编码，尚未把它们粗暴翻译为公开的 `P0/P1` 名字；两个
频率字段则由状态字符串直接标为 kHz 域。原先工具把 `+0x24` 错当成 `domain_count`，现已修正：
`+0x24..0x2c` 是全局 `Limits` 三元组，`+0x30..0x38` 是全局 `Ceiling` 三元组；type `0x14`
策略记录中的对应两组三元组位于策略条目 `+0x1bc` 和 `+0x1c8`。

时钟侧还找到并实测了当前私有但只读的 `0x20809006`。当前 GSP 方法表确认其参数大小为 8 字节，
实际 ABI 为 `{NvU32 domainMask, NvU32 measuredKHz}`。它读的是硬件计数器得到的瞬时频率，不是
V/F 表、上限或请求目标。本机空闲时的一组实测如下：

```text
GPCCLK   0x00000001   224816 kHz
XBARCLK  0x00000002  1453433 kHz
SYSCLK   0x00000004  1462750 kHz
MCLK     0x00000010 14989051 kHz
NVDCLK   0x00100000  1402980 kHz
PWRCLK   0x00080000  1886715 kHz
XBAR2CLK 0x00040000   107967 kHz
```

这给出了最短的运行时验证回路：同一采样窗口读取 policy 0 的
`PSTATE/GPC2CLK/XBARCLK Limits/Ceiling`，再分别读取 GPCCLK/XBARCLK 硬件实际频率，即可判断游戏中
到底是策略给 XBAR 降了请求上限，还是后面的 change sequencer/AVFS 没有实现请求值。

证据等级：

- **PROVED**：两个三元组的名称与状态布局；六槽请求不是六个物理域；当前空闲状态数值。
- **PROVED**：`0x20809006` 当前参数大小、输入域 mask 和硬件测频输出；GPCCLK/XBARCLK 可被独立读取。
- **INFERENCE**：把策略状态和两个硬件计数器按同一时间轴采样即可把“仲裁压低”与“执行端未达到”
  分开；采样工具已经具备全部只读原语，但尚未在 RT 游戏负载下取得同窗数据。
- **UNKNOWN**：游戏负载时 policy 0 的 XBARCLK 三元组具体数值；内部 PSTATE 索引 4/1 对公开 P-state
  名称的精确映射；XBAR descriptor 的本机寄存器 offsets。

## 十七、当前活动 Clock Propagation Topology：GPC 到 XBAR 的缺失环节

### 17.1 当前 R610 的只读控制方法

从同包 MODS 的 native wrapper 注册表和当前 GSP 方法表交叉恢复了以下只读接口；本机
610.43.03 均已实际调用成功：

```text
0x2080907b  size 0x0188  GetClkProRegimesInfo
0x2080907d  size 0x5f14  GetClkPropTopsInfo
0x2080907e  size 0x002c  Clock Propagation Topology GET_STATUS
0x2080907f  size 0x002c  Clock Propagation Topology GET_CONTROL
0x20809081  size 0x1518  GetClkTopPropRelsInfo
0x20809082  size 0x004c  Clock Topology Relationships GET_STATUS
0x20809083  size 0x0c18  Clock Topology Relationships GET_CONTROL
```

对应探针入口已经加入 `power_cap_limit_probe.c`：

```text
--clk-prop-tops-summary
--clk-prop-status-raw
--clk-prop-control-raw
--clk-top-prop-rels-summary
--clk-top-prop-rels-status-raw
--clk-top-prop-rels-control-raw
```

`0x20809082` 在当前空闲状态下即使带入 INFO 头仍返回 `0x40 = NV_ERR_INVALID_STATE`。这不是未实现
（方法表中有独立 handler），而是当前没有可读取的活动状态对象；因此本轮没有通过制造 GPU 负载去
强行触发它。

### 17.2 活动 topology 不是数组下标 7，而是 top ID 7

当前 GET_CONTROL 返回 override ID `0xff`，即自动选择；GET_STATUS 返回活动 top ID `7`。拓扑信息表
的有效 mask 为 `0x3e3`，其条目布局为 `base=0x0c, stride=0x2f8`。按条目中的 top ID 反查后，
top ID 7 对应数组 index 5，关系 mask 为 `0x000003ff`：

```text
valid_topology_mask=0x000003e3
topology_index=0 top_id=0  relation_mask=0x000007fe
topology_index=1 top_id=1  relation_mask=0x00000bfe
topology_index=5 top_id=7  relation_mask=0x000003ff  <- active
topology_index=6 top_id=8  relation_mask=0x000007fe
topology_index=7 top_id=9  relation_mask=0x000013fe
topology_index=8 top_id=10 relation_mask=0x000023fe
topology_index=9 top_id=11 relation_mask=0x00000bfe
```

因此当前自动拓扑启用关系 0--9，禁用备选关系 10--13。

### 17.3 关系 0 精确给出 GPC2CLK -> XBARCLK 比例

关系信息表有效 mask 为 `0x3fff`，条目布局为 `base=0x128, stride=0x14`；关系控制表条目为
`base=0x24, stride=0x0c`。type 3 的控制值由当前实现按 U16.16 读取，反汇编中的 `1/65536`
常数也与此一致。当前关系 0 为：

```text
type=3
source domain index=0, api mask=0x00000001 (GPC2CLK)
target domain index=1, api mask=0x00000002 (XBARCLK)
bidirectional=1
ratio_raw=0x0000e660 = 58976 / 65536 = 0.89990234375
```

活动关系 1--9 均为 type 5、bidirectional、voltage rail index 1，连接如下：

```text
XBAR <-> SYS
XBAR <-> NVD
MCLK <-> PCIE
MCLK <-> XBAR
MCLK <-> SYS
MCLK <-> NVD
XBAR <-> PWR
XBAR <-> api domain 0x00000008
XBAR <-> api domain 0x00000040
```

未在当前 top ID 7 中启用的关系 10--13 也是 GPC->XBAR type-3 关系，比例分别为
`0.799804688 / 2.0 / 1.199951172 / 1.5`；它们属于其他 topology，不能拿来解释当前运行状态。

### 17.4 与既有负载日志的数值闭环

这条活动关系解释了此前缺失的数据流：`0x202a817e` 的 2X 求值器只直接产生 PSTATE/GPC 候选，
随后 clock propagation 以约 0.9 倍 GPC 派生 XBAR，再经过共享电压关系、时钟网格量化和其他限制
得到最终 DG1。

对已有日志按残差 `DG1 - (58976/65536)*DG0` 重新统计：

```text
CP2077 6K PT, 565 samples:
  |residual| <= 10 MHz : 427
  |residual| <= 30 MHz : 494
  residual range       : -6.514 .. +49.489 MHz

FurMark Vulkan, 335 samples, model estimated frequency pair:
  |residual| <= 10 MHz : 299
  |residual| <= 30 MHz : 310
  residual range       : -6.543 .. +49.489 MHz
```

代表性对值包括 `2962->2662 MHz`、`2955->2655 MHz`、`3000->2700 MHz`。约 -6 到 +50 MHz
的离散残差说明 0.9 关系是传播基线，不是最终 XBAR 必须严格等于的单一方程；时钟网格量化和活动
type-5 共享电压关系仍会改变最终点。

### 17.5 活动条目内的路径矩阵给出了确切传播顺序

`GetClkPropTopsInfo` 每个 topology 条目的 `+0x28` 开始是一个以 U16 关系索引表示的
`domainsDstPath[src][dst]` 矩阵；`0xffff` 表示自身或不可达，其他数值表示从源域到目标域
路径上应先执行的 relationship ID。字段语义由同包 MODS wrapper 对旧布局的访问和
JS 字段名交叉确认；当前条目的每行为 19 个 U16。本机活动 top ID 7 的前 9 个已知域为：

```text
src\\dst   GPC  XBAR  MCLK   SYS   NVD   PWR  PCIE API40 API08
GPC      ffff     0     0     0     0     0     0     0     0
XBAR        0  ffff     4     1     2     7     4     9     8
MCLK        4     4  ffff     5     6     4     3     4     4
SYS         1     1     5  ffff     1     1     5     1     1
NVD         2     2     6     2  ffff     2     6     2     2
PWR         7     7     7     7     7  ffff     7     7     7
PCIE        3     3     3     3     3     3  ffff     3     3
API40       9     9     9     9     9     9     9  ffff     9
API08       8     8     8     8     8     8     8     8  ffff
```

该矩阵与关系图逐项一致。例如 GPC→XBAR 直接从关系 0 开始；GPC→SYS 也先用
关系 0 到 XBAR，再用关系 1；XBAR→PCIE 先用关系 4 到 MCLK，再用关系 3。
因此“2X 只产生 GPC 约束，为什么 XBAR 也降频”的数据路径现已闭合：

```text
2X GPC2CLK limit
  -> relationship 0 (GPC -> XBAR, ratio 0.899902344)
  -> relationship 1/2/7/8/9 (XBAR -> dependent domains)
  -> type-5 shared-rail range conversion and clock-grid quantization
```

`power_cap_limit_probe --clk-prop-tops-summary` 现在会同时读取活动 top ID，并只对活动
条目打印这个路径矩阵，便于以后在不同运行状态下重复验证是否换了 topology。

证据等级：

- **PROVED**：当前自动 topology 的 top ID、关系 mask、关系 0 的源/目标域和 U16.16 比例；
  关系 1--9 的 type、连接域和共享 rail index；所有数值均来自本机 R610 的只读接口。
- **PROVED**：活动 top ID 7 条目中的 `domainsDstPath` 矩阵和上述关系图一致，并确定
  GPC 约束向 XBAR 乃至后续依赖域的首跳关系。
- **PROVED**：`0x202a817e` 初始化三分量后只写 PSTATE/GPC，保留 XBAR 为 `UINT32_MAX`；因此
  2X 搜索器本身没有独立求出一个 XBAR 频率。
- **PROVED（同代系旧 RM）**：type-5 evaluator 不是固定比例，而是把源频率范围先转换成共享 rail
  的电压范围，再从该电压范围转换成目标频率范围，并与目标域范围相交、钳位和量化；精确函数见
  第十八节。当前 R610 的函数地址尚未映射。
- **INFERENCE**：正残差主要来自 type-5 共享电压/VF 传播和离散时钟量化。type-5 算法、当前活动
  关系结构与数值分布支持此解释，但还没有负载中的逐关系中间值证明某一条 type-5 关系当时绑定。
- **UNKNOWN**：负载运行中 top ID 是否会切换；type-5 关系合并多个域电压要求的精确顺序；每个
  topology 的选择条件以及 regime 表中的阈值。

## 十八、type-5 共享电压转换与当前 Client V/F 点表

### 18.1 type-5 不是一个隐藏比例，而是两段范围转换

同包旧 RM 的 relationship type 分派器位于 `0x6dfaed0`，type 3--7 分别进入不同对象；type 5
构造器为 `0x6dfc480`。type-5 的核心转换函数 `0x6999860` 顺序调用：

```text
0x6996cf0  source frequency range -> voltage range on voltRailIdx
0x69994b0  voltage range -> target frequency range on clkDomainIdxOut
```

错误路径的原始字符串也逐字给出参数语义：

```text
Error converting from frequency to voltage: ... clkDomainIdxIn, voltRailIdx,
    freqRangeInTmp.minValue, freqRangeInTmp.maxValue
Error converting from voltage to frequency: ... voltRailIdx, clkDomainIdxOut,
    voltRangeTrans.minValue, voltRangeTrans.maxValue
```

第一段对普通时钟域把最小频率向下换算成 MHz、最大频率向上换算成 MHz，分别调用时钟域虚表
`+0x178` 的 FREQ_TO_VOLT；第二段调用目标时钟域虚表 `+0x170` 的 VOLT_TO_FREQ，再经
`0x6998050` / `0x6998370` 与目标域、program point 和最大频率范围相交、钳位及量化。双向关系会
按相同语义反向传播。因此活动关系 1--9 的作用不是简单令两个域同频，而是令共享 rail 上的电压
需求相容；它完全可以把 `0.899902344 * GPC` 的 XBAR 比例基线推到相邻的更高可行档位。

证据边界：这是同包 MODS 所带旧 RM 的逐指令数据流，与当前 R610 暴露的 type-5 关系类型和字段
一致；它强力说明对象语义，但还不是当前 GB202 PMU 中同一函数的地址级证明。

### 18.2 当前 R610 的 Client V/F 点只读 ABI

当前 GSP 方法表和本机实际调用确认：

```text
0x2080902a  size 0x0324  CLIENT_CLK_VF_POINTS_GET_INFO
0x2080902b  size 0x1810  CLIENT_CLK_VF_POINTS_GET_STATUS
0x2080902c  size 0x1014  CLIENT_CLK_VF_POINTS_GET_CONTROL
```

探针新增 `--clk-client-vf-info-raw`、`--clk-client-vf-status-raw`、
`--clk-client-vf-control-raw` 和 `--clk-client-vf-summary`。当前紧凑 ABI 为：

```text
INFO:    valid mask +0x04; entries base 0x24, stride 0x03
STATUS:  entries base 0x28, stride 0x18
         +0x04 current curve frequency kHz
         +0x08 voltage uV
         +0x10 base-tuple frequency kHz
         +0x14 base-tuple voltage uV
CONTROL: entries base 0x24, stride 0x10
         +0x08 signed frequency offset kHz
         +0x0c signed voltage offset uV
```

字段含义不仅来自数值猜测：已安装 LACT 的精确源码把相应 NVAPI 状态字段命名为 `freq_khz`、
`voltage_uv`、`vf_tuple_base`，并以
`configured_mhz*1000 - current_point.vf_tuple_base.freq_khz` 生成每点控制 offset；LACT 自己的只读
snapshot 与探针逐点一致。

当前有效 mask 覆盖 0--131。0--126 是 LACT 暴露的 127 个可编辑、以电压为横轴的 GPU V/F 点；
127--131 是其他点型，不能当作 GPC 曲线。130/131 的约 14.8/15.0 GHz 数值很像 MCLK 点，但这里只
标为 **INFERENCE**，尚未从内部 type 值完成域映射。

### 18.3 当前自定义曲线的真实落地值

运行时表直接显示了“配置目标、控制 offset、最终曲线点”三者并不总相等。代表点如下：

```text
voltage  LACT config  runtime freq  runtime base  control offset
  910 mV     2858 MHz      2857 MHz      2137 MHz       +721 MHz
  950 mV     2900 MHz      2902 MHz      2655 MHz       +253 MHz
 1000 mV     3000 MHz      3007 MHz      2827 MHz       +180 MHz
 1015 mV     3030 MHz      3037 MHz      2865 MHz       +173 MHz
 1045 mV     3030 MHz      3045 MHz      2940 MHz       +105 MHz
 1100 mV     3030 MHz      3045 MHz      3052 MHz         -7 MHz
 1235 mV     3030 MHz      3052 MHz      3262 MHz       -210 MHz
 1240 mV     3030 MHz      3052 MHz      3270 MHz       -225 MHz
```

在 127 个 GPC 点上统计
`runtime_freq - runtime_base - control_offset`：23 个点非零，范围 `-13..+8 MHz`，平均绝对值
约 `1.055 MHz`。这是最后的时钟网格/曲线约束残差。更大的“配置 3030、实际 3045/3052”差异则说明
设置整条 offset 曲线后固件会重建 base tuple；LACT 在写入前读取 base 来计算 offset，不能保证写入后
重建出的 `freq_khz` 精确等于 YAML 中的 MHz。由 LACT 的写入公式还可反推提交前 base：例如点 95
为 `3030-105=2925 MHz`，当前 base 为 2940 MHz；点 125 为 `3030-(-210)=3240 MHz`，当前 base
为 3262 MHz，分别上移 15 和 22 MHz。连续 12 秒只读同一组点未见继续漂移，因此当前结果是稳定
重建值，不是正在累加的 offset。配置中的 `apply_settings_timer: 5` 是 UI 变更的确认/回滚窗口，不是
周期性重应用定时器。

证据等级：

- **PROVED**：三个只读方法、紧凑布局、127 个可编辑点的实时频率/电压/base/control offset；探针、
  LACT 源码和 LACT snapshot 三方一致。
- **PROVED**：本次配置中的 0.95 V 真正曲线点是 2902 MHz，1.0 V 是 3007 MHz，1.015 V 是
  3037 MHz；YAML 数字不是硬件最终逐点频率的精确回读。
- **PROVED（按 LACT 写入公式反推）**：生成当前 control offset 时采用的提交前 base 与当前回读 base
  在高压段相差 15--22 MHz；这是 YAML 目标与最终点偏离的主要量级。尚未实时捕获同一次 SET 前后
  的逐点快照，因此改变发生在固件曲线重建的哪个子步骤仍为 **UNKNOWN**。
- **UNKNOWN**：当前 PMU 中 type-5 转换的精确函数地址；每条共享 rail 关系在某一游戏帧内的输入、
  中间电压范围与最终绑定关系。

### 18.4 本机还捕获到一次 LACT V/F 曲线残留后重算

LACT 的 `apply_config()` 会先调用 `reset_clocks()`，正常意图是先清旧曲线再应用新曲线。但当前精确
版本存在一个状态依赖：`reset_clocks()` 只有在本 controller 实例的 `vf_curve_written` 为真时才会把
全部 V/F offset 置零。GPU 列表重载时又采用如下顺序：

```text
old_controller.cleanup()
let _ = old_controller.reset_clocks()   // 错误被丢弃
replace with new_controller             // vf_curve_written starts false
new_controller.apply_config(current)
```

而 `reset_clocks()` 在 V/F 清零之前还会重置 locked GPU/VRAM clocks；这些步骤用 `?` 返回，任一步
失败都会跳过后面的 V/F reset。新 controller 随后无法仅靠自己的布尔状态识别硬件上残留的每点
offset，就可能拿残留曲线的 base 再计算一遍当前配置。

本机 06:50 日志恰好记录了 DRM event、controller 重建和 configuration reapplied。由当前配置及
control offset 反推当次写入前 base，再与上一份
`config.yaml.bak.before_vf_rewrite_20260724_204356` 对比：点 79--126 共 48 点，27 点逐 MHz 完全相同；
从点 96 起几乎整段相同，少数差值仅为 7/15 MHz。例如：

```text
point  previous curve  inferred pre-write base
  96      2940 MHz             2940 MHz
 104      3037 MHz             3037 MHz
 116      3165 MHz             3165 MHz
 125      3240 MHz             3240 MHz
```

点 79--95 的旧配置是 2932 MHz 平台，而反推 base 从 2625 MHz 逐步爬到 2925 MHz；这与该平台受
低电压可行性、曲线单调性和时钟网格限制后不能直接落成水平线一致。结合源代码控制流，当前曲线是在
残留自定义 V/F 状态上重算的证据很强。

- **PROVED**：LACT 的状态布尔、reset/apply 顺序、reload 时丢弃 reset 错误；当前 offset 反推出的
  pre-write base 与上一曲线高段 27 点精确一致。
- **INFERENCE**：本机此次残留的直接原因是旧 controller 的 reset 未执行或中途返回；代码没有记录
  被丢弃的错误，无法在日志中区分是哪一步。
- **SAFE NEXT TEST**：等桌面不再由 5090 承载时，先显式将每点 control offset 全部清零、读回确认，
  再只应用一次目标曲线并立刻读回 pre/post base。当前桌面状态下不执行该写入实验。

## 十九、2X 构造参数与动态预算入口

### 19.1 当前 R610 仍把 PMU 主体放在加密映像中

对当前 `/tmp/gsp_inner_19f040_a.elf`（`82577496` 字节，SHA256
`bda917c95547644398eaf77fefe6c7f1b701c962db91f88bffaed6448a218a47`）从真实 chip-HAL
入口 65 重放 Pmu 类构造器，得到：

```text
HAL +0x320 -> getter 0x01a9a6b4 -> UCODE_DESC  bindata index 844
HAL +0x330 -> getter 0x01a9a790 -> UCODE_IMAGE bindata index 855
HAL +0x348 -> getter 0x01a9a844 -> UCODE_IMAGE bindata index 864
```

构造器地址 `0x01bdf97c` 的类 ID 为 `0x00f3d722`，对应 Pmu。index 855/864 都是 Falcon-v6
加密映像；构造路径证明二者都被安装到 GB202 的 Pmu HAL 表，但目前仍不能仅靠静态构造顺序判断
零售卡最终选择哪一个 profile。因此当前 R610 能验证公开对象包装和 bindata 选择边界，无法直接
读取其中的 governor 指令；下面的精确算法地址仍来自同包 R570 的 GB202 明文 PMU。

### 19.2 type `0x0b` 构造器给出 workload 参数的精确布局

内部 type `0x0b` 的工厂条目分配 `0x1f0` 字节并进入 `0x202f344c`。它先调用继承的
domain-group 构造器 `0x202f3092`，再安装 workload 自有字段：

```text
config +0xd4  -> object +0x0b9  (u8)
config +0xd5  -> 每路 median filter 的样本数
config +0xd6  -> object +0x0e0  (u16, Q12 clkUpScale)
config +0xd8  -> object +0x0e2  (u16, Q12 clkDownScale)
config +0xdc  -> object +0x138  (两路 workload/model 关系集合)
```

同一 MODS 主程序的旧 RM GET_INFO 打印器逐字给出公开字段名和布局：workload policy 项中的
`domGrp.b3DBoostVpstateFloor`、`leakageIdx`、`medianFilterSize`，以及独立控制记录中的
`clkUpScale`、`clkDownScale`。结合构造器的继承边界，`+0xd4`/`object+0xb9` 对应
`leakageIdx`，而 3D Boost floor 已由前面的 domGrp 基类处理；`+0xd5` 对应
`medianFilterSize`。这也解释 `0x202a817e` 为何只把 `object+0xb9` 当作零/非零分支：零值走简单的
顺序候选扫描，指定 leakage index 时走带上下界和回退状态的复杂搜索。

`0x202f32ec` 对 `config+0xdc` 的展开还证明它不是一个神秘的单值倍率。该函数构造一个关系集合，
记录启用位、条目数和两组关系索引；需要时按条目数分配索引数组，并为两个 0x20 字节关系槽分别
解析/分配模型对象。`0x202ac6ae` 随后正是遍历这两个槽，把两路 physical-single 的静态/漏电项和
动态项相加。因此目前没有证据支持“2X 只是针对 RT 的一个固定百分比折扣”；它确实按两路关系、
候选频率、电压与 workload 求值。

### 19.3 `object+0x34` 是动态仲裁结果，不是写死功率常数

通用 policy 构造器 `0x202f2990` 用 `0x202ace0e` 初始化 `object+0x20` 的 limit arbiter。其内部
保存带 8 位来源键的多个 32 位 limit；`0x202acd52` 新增或更新某个来源，并根据 arbiter 模式持续
维护 min/max 有效值，`0x202acdd6` 可按来源键读回。构造结束时只做一次：

```text
object +0x24 (arbiter effective value) -> object +0x34 (evaluator budget)
```

运行时并非停在这个初始副本。每轮 policy 求值 `0x202a784c` 一开始调用 `0x202afa90`；后者通过
`0x202acb94` 取得当前 arbiter 值，交给 `0x202a7336` 做可选的历史窗口平滑和上下界钳位，再写回
`object+0x34`。之后才按 type 分派到 `0x202a817e`，用这个最新预算做候选搜索：

```text
keyed upstream limits
  -> object+0x20 limit arbiter
  -> object+0x24 effective limit
  -> 0x202afa90 / 0x202a7336 optional smoothing and clamp
  -> object+0x34 current evaluator budget
  -> 0x202a817e candidate search
```

这与本机 R610 运行时数据完全吻合：policy 0 的 `CurrLimit` 会随 policy 2 总预算和 policy 1
PROP/MISC 消耗变化，而不是固定为 460 W；已有同步样本中满足
`policy0 CurrLimit = policy2 TOTAL_GPU CurrLimit - policy1 PROP_LIMIT CurrValue`。所以 2077 中约
460 W 是当时上游树分给核心 2X 模型的动态余额，不是固件给 RT 游戏硬编码的一堵 460 W 墙。

### 19.4 升降频比例的精确 Q12 公式

候选搜索得到本轮 raw target 后，`0x202a817e` 用构造时的两个 U16 参数做非对称平滑。旧目标记为
`old`，本轮搜索目标记为 `new`：

```text
new > old and clkUpScale != 0:
    out = old + round((new - old) * clkUpScale / 4096)

new < old and clkDownScale != 0:
    out = old - round((old - new) * clkDownScale / 4096)
```

舍入由乘积的 bit 11 加到右移 12 位的结果实现。相应 scale 为 0 时不进入该方向的比例平滑路径。
这两个参数控制的是目标追踪速度，不是 V/F 曲线电压，也不改变候选估算公式本身。

### 19.5 两路输入已闭合到 logical-single policy 5/6 与 NVVDD/MSVDD

`0x202abf16` 遍历 `object+0x138` 的两个 0x20 字节槽。每槽 `+0x00` 是源 policy 索引，
`+0x01` 是模型关系索引；源 policy 索引乘 `0x200` 后定位统一状态表记录，mW/mA 两种单位分别读取
记录 `+0x1c/+0x20`。读取值写入槽 `+0x08`，即上层对象的 `+0x1b8/+0x1d8`，并同步累加到
父 policy 当前值。

当前 R610 `PowerPoliciesGetInfo` 又给出 policy 0 的精确关系范围：

```text
logicalSingleRelIdxFirst..Last = 4..5
dieRelIdxFirst..Last           = 255..255 (未配置)

relationship 4 -> policy 5 WORKLOAD_LOGICAL_SINGLE_2X
relationship 5 -> policy 6 WORKLOAD_LOGICAL_SINGLE_2X
```

一次原子 `GetDynamicStatus` 只读快照进一步满足：

```text
policy0 observed physical 0 = 14652 mW = policy3 NVVDD CurrValue
policy0 observed physical 1 =  8970 mW = policy4 MSVDD CurrValue
policy0 observed logical    = 23622 mW = 14652 + 8970
```

其中 policy 5/6 的当前值分别逐整数重复 policy 3/4，所以当前公开拓扑是
`physical 3/4 -> logical 5/6 -> combined 0`；PMU 下层对象最终消费的仍是两路 NVVDD/MSVDD
观测功率。由此可以排除一个专门识别 RT/PT 工作负载并施加固定倍率的前端：路径追踪与 FurMark 的差异
必须来自两路功率、漏电、电压/频率模型及其反推出的 workload 不同。

证据等级：

- **PROVED**：R610 GB202 Pmu HAL 的 descriptor/image getter 安装项，以及映像仍为加密 Falcon-v6。
- **PROVED（同包 R570 GB202 明文 PMU）**：type `0x0b` 构造字段、两路关系集合、limit arbiter、
  每轮 `+0x34` 刷新链和 Q12 升降目标公式。
- **PROVED（本机 R610 运行时）**：policy 0 的核心预算是总预算扣除 PROP/MISC 后的动态余额；
  `estimated <= CurrLimit` 的候选边界和最终 DG0 已由 CP2077/FurMark 样本闭环；policy 0 两个 observed
  physical 分支与 policy 3/4 当前值在同一快照内逐整数相等。
- **INFERENCE（高置信）**：`config+0xd4/object+0xb9` 的确切 C 字段名为 `leakageIdx`；同一二进制的
  公开字段名、继承边界、相邻字段顺序和分支用途共同支持，但明文 PMU 本身没有符号表。
- **UNKNOWN**：当前零售卡在 R610 的 855/864 中最终选择哪一 profile；R610 加密 PMU 是否对这些
  公式增加了 Blackwell 专用修正；上游为每个 workload/regime 分配 PROP/MISC 余额的完整条件表。

### 19.6 空闲桌面快照区分“当前功耗”与“候选功耗”

在用户明确确认当前只有桌面、没有运行 Minecraft 或其他负载后，取得一组只读原子状态：

```text
policy0 current              = 29046 mW
observed physical 0/1        = 18015 / 11031 mW
estimated logical candidate  = 157680 mW
estimated physical 0/1       = 113992 / 43688 mW
candidate frequency          = 3030 MHz
physical effective freq 0/1  = 3030 / 2767 MHz
workload 0/1                 = 133 / 41
estimated voltage 0/1        = 1020 / 1200 mV
leakage_mX 0/1               = 11066 / 1561
```

同一时段的 policy 树又精确满足：

```text
policy0 CORE/2X current = 27.805 W
policy1 PROP/MISC       = 17.038 W
policy2 TOTAL_GPU       = 44.843 W
27.805 + 17.038         = 44.843 W
```

因此 `157.680 W` 不是显卡此刻实际消耗，而是“若把目标推进到 3030 MHz”时 policy 0 对两路核心轨的
反事实估算。当前实际整卡约为 `44.843 W`；若粗略保持其他部分仍为约 17 W，则该候选对应的整卡量级约
175 W，但这只是便于理解的近似，不能当作下一时刻的精确总功耗预测。

### 19.7 候选点确实取自当前自定义 V/F 表，`1200 mV` 不是核心电压

紧接上述快照读取当前 client V/F 表，候选点 91 的运行时状态为：

```text
freq0_khz       = 3030000
volt0_uv        = 1020000
freq1_khz       = 2880000
volt1_uv        = 1020000
freq_offset_khz = 150000
```

即公开给 governor 的最终点正是：

```text
基础曲线 2880 MHz + 当前自定义偏移 150 MHz = 3030 MHz @ 1.020 V
```

相邻的 1.015 V 点只得到约 3022 MHz，1.020 V 是当前活动表中第一个达到 3030 MHz 的最低电压点。
这逐项排除了“governor 绕过 LACT 自定义曲线，另用默认曲线求候选”的解释。

状态里的 `est_volt1_mv = 1200` 属于第二个 physical-single/MSVDD 模型的电压输入；它与
`est_volt0_mv = 1020` 一起进入两路功率模型，不能解释为 GPU 核心实际申请了第二个 1.20 V 的 V/F
点。第一路 NVVDD 候选已经与实时自定义 V/F 表精确闭合。

证据等级：

- **PROVED（本机 R610 同一活动配置）**：3030 MHz/1020 mV 候选逐值命中当前自定义 V/F 表；
  3030 = 2880 + 150。
- **PROVED**：1200 mV 位于第二个 physical-single 的 estimated voltage 字段，而非 NVVDD 的实际
  候选 V/F 点。
- **INFERENCE（高置信）**：第二路对应 MSVDD；关系 4/5 与 policy 3/4 的 NVVDD/MSVDD 顺序、两路
  observed 值逐整数闭合共同支持，仍待把 equation index 字段名与 rail 对象完全映射。

### 19.8 MODS 已把两组方程索引分到 NVVDD 与 MSVDD

MODS 函数 `0x6a2f6e0` 验证 type `0x0a` 的 power model 对象，并通过 `0x6a08a50` 检查四个方程
索引。失败字符串把索引组明确分轨：

```text
object +0xfc / +0xfd -> MSVDD 的 leakage/scale equation index 组
object +0xcb / +0xcc -> NVVDD 的 leakage/scale equation index 组
```

任一组中任一索引不存在，都会打印对应轨的“update VBIOS leakage/Scale Equation Index”错误。因此
两路 2X 模型各自至少引用一个 leakage equation 和一个 scale equation；组内哪一字节具体对应
leakage、哪一字节对应 scale 仍待消费者调用点确认。

同一 RM 的 equation 工厂分派已精确恢复为：

```text
type 0 -> unsupported
type 1 -> 0x6a36b00
type 2 -> 0x6a36630
type 3 -> unsupported
type 4 -> 0x6a36d10
type 5 -> 0x6a371b0 (DYNAMIC10)
type 6 -> 0x6a36870
type 7 -> 0x6a36f10
```

type 5/6/7 的 record 字段布局已经从构造器与 serializer 双向核对；剩余关键缺口是把两条 rail 的
索引顺序接到 `0x202ac6ae` 的确切定点 evaluator，恢复每个系数的量纲与乘除/舍入顺序。

### 19.9 CP2077 的 observed→estimated 差额几乎全部来自 MSVDD 分支

重新统计 `benchmark_logs/cp2077_6k_20260725_022230/power-policy0-dynamic.csv` 中场景区间的 414 个
样本，得到：

```text
                         observed mean    estimated mean    estimated/observed
NVVDD physical branch       159.949 W        172.140 W            1.076
MSVDD physical branch        98.000 W        275.167 W            2.808
combined                    257.949 W        447.307 W            1.734
```

所以 combined 的约 `189.36 W` 差额中，约 `177.17 W` 来自 MSVDD，NVVDD 只贡献约 `12.19 W`。
这比笼统描述“PT 候选更昂贵”更精确：当前最主要的限频来源是第二路候选模型把约 98 W 的 observed
MSVDD 映射为约 275 W，而不是 NVVDD 核心本身已经接近真实电气功率上限。

同一批候选状态的均值为：

```text
NVVDD: freq 2842.4 MHz, workload 251.6, voltage 951.2 mV
MSVDD: freq 2560.2 MHz, workload 365.2, voltage 1096.4 mV (max 1200 mV)
```

因此 `est_volt1=1.20 V` 不是无关的打印噪声；它位于导致巨大 MSVDD 候选值的同一条数据链上。仍需
恢复 type-6 scale 与 type-7 leakage 的逐字段公式，才能区分这 2.8 倍究竟主要来自候选电压、scale
系数、workload 归一化，还是三者组合。

另外，`MISC0` 不能命名为“显存+风扇”。PMGR 只证明它是 `TOTAL_BOARD - (NVVDD+MSVDD)` 的
精确剩余桶；它可能同时覆盖 FB/显存供电、风扇、板上控制器、供电转换损耗及其他未单列负载。当前
空闲桌面的同帧只读值为：

```text
TOTAL_BOARD 45.591 W = TOTAL_CORE 28.272 W + MISC0 17.319 W
TOTAL_CORE  28.272 W = NVVDD 17.535 W + MSVDD 10.737 W
```

CP2077 中用异步平均值粗算得到约 150 W 的非核心桶是可信量级，但本次日志没有足够的子通道把它继续
拆成显存、风扇和损耗；此前将 `600-460≈140 W` 直接称作显存/风扇预留属于过度简化。

### 19.10 夜神风扇实测与非核心功耗数量级核账

ASUS 公布的 Astral PCB 供电拓扑是 GPU 24 相（MP29816）加显存 7 相（MP2898），两边都使用额定
80 A 的 MP86670 DrMOS，显存为 16 颗 GDDR7。80 A 是单相器件能力，不是该相固定消耗；MPS 公开的
两页 MP86670 数据表没有给出可用于本卡工况的数值效率曲线，不能据此精算损耗。

为直接排除风扇，`scripts/measure-astral-fan-power.sh` 会暂时停止每 500 ms 覆盖转速的 LACT 服务，
按 A-B-A 顺序采集 PMGR `0x2080a613`，最后重新启动 LACT。空闲 6K 桌面、本卡显存固定 15001 MHz
时得到：

```text
风扇状态                 TOTAL_BOARD Δ   TOTAL_CORE Δ   MISC0 Δ
0 rpm -> 60% / ~1707 rpm     +4.493 W        +2.786 W      +1.708 W
0 rpm -> 100% / ~3290 rpm   +12.240 W        +7.591 W      +4.649 W
30%/~560 -> 100%/~3200      +11.949 W        +7.411 W      +4.539 W
```

三次结果的整卡增量互相闭合；但纯风扇变化同时出现在 `TOTAL_CORE` 与 `MISC0`，说明这些 PMGR 桶
存在传感器归属、供电耦合或状态相关偏置，不能逐桶当作独立物理电表。CP2077 场景平均核心温度
62.4°C，对应当前 LACT 曲线约 55--60%，所以四个风扇在该场景的整卡增量约 4--5 W，不可能解释
约 151.35 W 的 `TOTAL_BOARD-TOTAL_CORE`。

显存只能先做数量级参考。Micron 公布的 GDDR7 指标为 4.5 pJ/bit；按本卡 512-bit、当前约
30 Gbit/s/pin 计算：

```text
512 bit * 30e9 bit/s * 4.5e-12 J/bit = 69.12 W
```

这不是本卡 Samsung 颗粒的逐轨实测，也不保证完整覆盖刷新、终端和空闲静态功耗。若仅为了给
7 相显存 VRM 做宽松量级估算，假设 85--95% 效率，则 69.12 W 负载对应约 72.8--81.3 W 板端输入，
转换损耗约 3.6--12.2 W。风扇停转时本机 `MISC0` 约 17.95 W，它已经包含 6K 显示、固定高显存频率、
控制器和静态负载，不能与上述显存数值无脑重复相加。即便故意宽松地相加，
`81.3 + 4.5 + 17.95 = 103.75 W`，对 151.35 W 仍留下约 47.6 W；由于口径混合，这只能证明
“150 W 不是四风扇或简单 VRM 损耗”，不能单凭它证明 PMGR 的 `MISC0` 数值错误。

外部交叉测量也提示板卡遥测不是实验室电表：ComputerBase 在 Astral 遥测 600 W 时从供电端测到
632 W（约 620 W 来自 12V-2x6、11 W 来自插槽）。这个 32 W 偏差包含测量位置/校准等因素，不能
线性套到 409 W 场景，更不能全塞进某一个 PMGR 桶。

因此当前更强、口径更干净的异常仍是 19.9：同一 2X 模型把 CP2077 中 observed MSVDD 约 98 W
映射成 estimated MSVDD 约 275 W，单支路凭空增加约 177 W；风扇、显存或 Astral 的供电规模均
不能解释这一映射。下一次 CP2077 应同步记录 A613 五条功率通道，而不是继续用 NVML 板功率与策略
状态的异步均值相减。

参考：

- ASUS Astral PCB/供电说明：<https://rog-forum.asus.com/t5/push-the-limits/the-rog-astral-rtx-5090-what-comes-after-the-summit/ba-p/1085817>
- MPS MP86670 公开数据表：<https://www.monolithicpower.com/en/documentview/productdocument/index/version/2/document_type/Datasheet/lang/en/sku/MP86670GMJ-C787/document_id/10105/>
- Micron GDDR7 产品简介：<https://www.micron.com/content/dam/micron/global/public/products/product-flyer/gddr7-product-brief.pdf>
- ComputerBase Astral 外部供电测量：<https://www.computerbase.de/artikel/grafikkarten/asus-rog-geforce-rtx-5090-astral-test.91096/seite-2>

### 19.11 同步 A613 证明五通道是固定比例分解，而非五块独立电表

在 `benchmark_logs/cp2077_6k_20260725_221218` 中，策略状态读取之后立即读取一次 A613；每次 A613
调用返回同一快照的五条 mW 通道。97.488 秒场景内得到 475 对相邻样本，A613 均值为：

```text
TOTAL_BOARD  408.784939 W
TOTAL_CORE   253.494611 W
NVVDD        157.186507 W
MSVDD        96.308103 W
MISC0        155.290328 W
```

475/475 帧都以 0 mW 误差满足两条加法恒等式。更关键的是，A612 info 直接暴露了共用输入的 Q12
比例常数：

```text
TOTAL_BOARD scale = 0x1000 = 4096
TOTAL_CORE  scale = 0x09ec = 2540
NVVDD       scale = 0x0627 = 1575

TOTAL_CORE / TOTAL_BOARD = 2540/4096 = 62.01171875%
MISC0      / TOTAL_BOARD = 1556/4096 = 37.98828125%
NVVDD      / TOTAL_BOARD = 1575/4096 = 38.45214844%
MSVDD      / TOTAL_BOARD =  965/4096 = 23.55957031%
NVVDD      / TOTAL_CORE  = 1575/2540 = 62.00787402%
MSVDD      / TOTAL_CORE  =  965/2540 = 37.99212598%
```

仅用 `TOTAL_BOARD` 均值乘这些常数，即预测 `TOTAL_CORE=253.494567 W`、`MISC0=155.290372 W`、
`NVVDD=157.186592 W`、`MSVDD=96.307975 W`，与各通道实测均值只差不到 0.13 mW。全程逐帧比例
波动也只有整数定点取整/传感器量化的数 mW 级误差。此前风扇 0->60% 时整卡增加 4.493 W，却又按
相同比例被分配给 `TOTAL_CORE/MISC0`，现在得到了解释。

因此必须撤回“`MISC0` 是约 155 W 的真实显存/风扇物理功耗”以及“`TOTAL_CORE` 是约 253 W 的
独立核心电气测量”这两个解释。这些名字描述 PMGR 策略拓扑中的逻辑 rail；本卡 VBIOS/PMGR 把整卡
输入传感器按固定比例构造出它们。19.10 的器件核账仍能说明四风扇实际增量很小，但不能再拿器件账
去解释或否定一个本来就是系数生成的 `MISC0`。

同轮 policy0 均值为：

```text
observed  combined/NVVDD/MSVDD = 259.378 / 160.835 / 98.543 W
estimated combined/NVVDD/MSVDD = 448.201 / 173.700 / 274.501 W
```

policy observed 两分支仍严格维持 `1575:965`，所以 observed MSVDD 约 98.5 W 也不是独立 MSVDD
电表读数。模型随后把这个人工分支映射到 estimated MSVDD 约 274.5 W（均值比 2.786 倍，增加
175.96 W）。这仍然是限频的直接数值来源，但更准确的表述是“模型对固定比例构造的 MSVDD 输入产生
巨大候选值”，而不是“真实 MSVDD 物理功耗从 98 W 被错误预测成 275 W”。
