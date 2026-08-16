---
slug: blackwell-independent-clock-domains
serial: "002"
title: "Independent Control of Blackwell's Key Clock Domains: 127-Point GPC, XBAR, SYS, and NVD Curves"
date: 2026-08-16
category: "GPU / Reverse Engineering"
language: en
status: "PUBLISHED"
status_text: "Research note"
summary: "Runtime reverse engineering of Blackwell's global ClockClient control surface shows that GPC, XBAR, SYS, and NVD each have a distinct 127-point V/F curve, a domain-wide frequency offset, and a domain-scoped voltage request, while propagation and shared-rail arbitration still couple their physical outcomes."
finding_number: "4 × 127"
finding_text: "Four separate 127-point type-0x11 curves for GPC, XBAR, SYS, and NVD accept independent writes; all 508 points precisely retained small negative requests before STATUS quantized them onto the effective clock grid."
boundary: "Confirmed only on the tested RTX 5090 with driver R610.57.04 and VBIOS 98.02.2E.80.50. Logical adoption does not prove that a request wins physical rail arbitration, and a short error-free run does not establish daily stability."
external_url: "https://github.com/ilya-zlobintsev/LACT/issues/1159#issuecomment-5305399366"
---

> This article continues the [previous investigation of XBAR as a physical clock domain](/notes/blackwell-xbar-physical-clock-domain/). That work asked whether XBAR is physically independent, how it can be measured, and why a finite MCLK-MAX can pull it down. This article asks the broader question: how many frequency curves does Blackwell actually expose as separately controllable objects?

The answer is not one “core curve” plus several display aliases. In the global ClockClient object on the tested GB202/R610 system, GPC, XBAR, SYS, and NVD each have a 127-point, voltage-indexed type-`0x11` V/F curve. Each domain also has its own domain-wide frequency offset. Each curve adopts a voltage offset from one specific rail slot in its domain record.

These four request surfaces are independently writable, but their physical outcomes are not isolated. Requests are quantized onto the clock grid; the GPC→XBAR ratio propagates constraints; and XBAR, SYS, and NVD share MSVDD. The central result is therefore precise: the control inputs are distinct, while the resulting clocks and voltages remain coupled through a common constraint network.

## At a glance: what can be controlled independently?

| Domain | 127-point curve | Domain-wide offset | Adopted voltage request | Independent hardware measurement | Strict limits | Existing workload evidence |
|---|---|---|---|---|---|---|
| GPC | Confirmed, flat `0..126` | `-1000..+8000 MHz` | rail 0 / NVVDD | Yes | max `0x4c`, min `0x4d` | Public core-clock path is mature; this work verifies curve adoption and quantization |
| XBAR | Confirmed, flat `127..253` | `-1000..+1000 MHz` | rail 1 / MSVDD | Yes | max `0xe4`, min `0xe7` | PTX acceptance tests, physical clock measurement, and game A–B–A controls |
| SYS | Confirmed, flat `259..385` | `-1000..+1000 MHz` | rail 1 / MSVDD | Yes | Not identified | Isolated CP2077 A/B; `+450 MHz` completed, `+600 MHz` combinations failed |
| NVD | Confirmed, flat `386..512` | `-1000..+1000 MHz` | rail 1 / MSVDD | Yes | Not identified | No isolated workload that identifies a specific consumer yet |

All four domains now have equivalent evidence at the level of “the request is retained and adopted by STATUS.” The depth of physical evidence differs. XBAR reaches measured hardware behavior and acceptance-tested workloads; SYS has an isolated game A/B; NVD currently reaches the domain object, hardware counter, and effective curve, but not an identified consumer. Each domain section therefore follows the same order: identity, writable interface, runtime evidence, confirmed facts, inference, and unknowns.

## A unified control model and a strict evidence standard

### Five request classes are not five spellings of one slider

| Layer | Control object | Confirmed targets | Meaning |
|---|---|---|---|
| Per-point frequency request | `CLK_VF_POINTS` | GPC/XBAR/SYS/NVD, 127 points each | Change the frequency offset at one voltage-indexed point |
| Domain-wide frequency request | `CLK_DOMAINS` | GPC/XBAR/MCLK/SYS/NVD | Add a signed-kHz offset to an entire domain |
| Rail-by-domain voltage request | rail slots inside a `CLK_DOMAINS` record | GPC→NVVDD; XBAR/SYS/NVD→MSVDD | Change one domain's logical V/F voltage relationship |
| Strict min/max client | PERF limit clients | GPC and XBAR | Submit min/max constraints to the arbiter; this is not a PLL lock that bypasses arbitration |
| Clock propagation relationship | active topology | GPC↔XBAR type-3; several type-5 relationships elsewhere | Change how constraints propagate between domains, not the final physical clock directly |

A write must pass at least four evidentiary stages before it supports a hardware claim:

```text
SET returns NV_OK
  -> GET_CONTROL precisely retains the request
  -> STATUS folds the request into the effective curve
  -> a hardware counter or a checked workload observes the physical result
```

The first two stages establish storage, not adoption. PWR, PCIe, and API40 are concrete counterexamples: a control value may be retained even though INFO advertises no valid range and neither the observed STATUS field nor the measured clock changes. This article calls a curve adjustable only after STATUS adoption, and calls a physical clock changed only after independent hardware measurement.

### The actual layout of the 648-point object

The global `CLK_VF_POINTS` object uses the following methods:

| Operation | Method | Parameter size |
|---|---:|---:|
| INFO | `0x20809021` | `0x8208` |
| STATUS | `0x20809022` | `0x98208` |
| GET_CONTROL | `0x20809023` | `0x1020c` |
| SET_CONTROL | `0x2080d024` | `0x1020c` |

INFO advertises flat points `0..647`. Segment enumeration and controlled writes produce this map:

| Flat index | Domain | Points | Type | Observed frequency-offset behavior |
|---:|---|---:|---:|---|
| `0..126` | GPC | 127 | `0x11` | CONTROL retains the request; STATUS adopts it |
| `127..253` | XBAR | 127 | `0x11` | CONTROL retains the request; STATUS adopts it |
| `254..258` | MCLK | 5 | `0x0f` | A type-`0x11` field write is cleared or ignored |
| `259..385` | SYS | 127 | `0x11` | CONTROL retains the request; STATUS adopts it |
| `386..512` | NVD | 127 | `0x11` | CONTROL retains the request; STATUS adopts it |
| `513..639` | PWR | 127 | `0x11` | CONTROL retains the request; the observed STATUS field does not change |
| `640..647` | PCIe | 8 | `0x0f` | A type-`0x11` field write is cleared or ignored |

Each STATUS record begins at `0x0d8 + flat_index×0x98`:

| Record offset | Meaning | Format |
|---:|---|---|
| `+0x2c` | Point type and valid state | A valid type-`0x11` point commonly reports `0x00001111` |
| `+0x30` / `+0x5c` | Effective voltage | µV; the two views agree |
| `+0x34` / `+0x58` | Effective frequency | MHz; the two views agree |
| `+0x38` | Base frequency | 16.16 fixed-point MHz |
| `+0x44` | Source voltage | µV |
| `+0x80` | Folded total frequency offset | kHz |
| `+0x88` | Folded total voltage offset | µV |

A CONTROL point begins at `0x108 + flat_index×0x10`. Byte `+0x01` is the point type; for type-`0x11`, the signed frequency offset is at `+0x08` in kHz. The CONTROL request, STATUS total offset, and final effective frequency have different precision and must not be substituted for one another.

## GPC: the 127-point curve behind the public core clock

### Domain identity and writable interface

NVIDIA's Nsight documentation describes GPC clock as a counter that public material may also call Application, Graphics, Base, or Boost clock. On the tested machine, the PMU table identifies mask `0x00000001` as `GPCCLK`, and private hardware measurement method `0x20809006` returns an instantaneous clock for the same mask. The domain identity is therefore not inferred merely from a familiar numeric frequency (see N1 and L4).

GPC uses the 127-point bank at flat `0..126` and `CLK_DOMAINS` record 0. INFO advertises a domain-wide offset range of `-1000..+8000 MHz`. Only `GPC × rail 0/NVVDD` is adopted as the domain-level voltage request. The confirmed strict max/min clients are `0x4c/0x4d`.

### Runtime evidence

Three representative points from one live snapshot are:

| Point | Source/effective voltage | Base | STATUS total Δf | Effective frequency |
|---:|---:|---:|---:|---:|
| 0 | 450 mV | 180 MHz | +45 MHz | 225 MHz |
| 63 | 845 mV | 1230 MHz | +907 MHz | 2137 MHz |
| 126 | 1240 mV | 3225 MHz | +112 MHz | 3337 MHz |

The nonuniform total offsets in the middle of this snapshot come from an existing user GPC curve. They must not be mislabeled as VBIOS FactoryOC. In the all-point negative-shift experiment, CONTROL retained the requested change at 127/127 points. The effective frequency moved down at 125 points, while two remained in the same quantized bin. The complete distribution appears once in the shared-mechanisms section.

### Evidence boundary

**Confirmed.** GPC has a distinct 127-point curve, a domain-wide offset, an NVVDD-scoped voltage request, strict min/max clients, and an independent hardware counter. STATUS adopts per-point requests.

**High-confidence inference.** On this ClockClient, the bank is the complete internal control surface behind the public core/Graphics curve. Its nonuniform offsets are the combined result of the user curve, FactoryOC, reconstructed base values, and quantization.

**Not established.** The `+8000 MHz` INFO limit is an interface capability range, not a physically achievable frequency on any chip. Nor is it established that an arbitrary edited point will become the active point during a workload transition.

### Complete 127-point GPC curve

The table below is the GPC CONTROL/STATUS snapshot captured at the same instant before the experiments. It is collapsed by default, can scroll horizontally, and links to the raw CSV.

[[vf-bank-table:GPC]]

## XBAR: the independent internal domain with the strongest control chain

### Domain identity and writable interface

XBAR uses the 127-point bank at flat `127..253` and `CLK_DOMAINS` record 1. Its domain-wide offset range is `-1000..+1000 MHz`. The PMU static table lists mask `0x00000002` as a distinct `XBARCLK` object. XBARCLK and GPCCLK use different top-level apply/commit dispatches; XBAR's lower-level source ID is 2 and reaches a per-source descriptor/MMIO programming path. Method `0x20809006` also measures XBARCLK independently. Together, these facts exclude “XBAR is only a displayed GPC alias” (L1, L4).

Only `XBAR × rail 1/MSVDD` is adopted as its voltage request. XBAR also has strict max client `0xe4` and strict min client `0xe7`; 2400 and 2600 MHz requests were exercised under load. The active topology's GPC→XBAR type-3 ratio is separately writable, but because it propagates cross-domain constraints it is treated in the shared-mechanisms section.

### Runtime evidence

Current points 0/63/126 report `225/1987/2812 MHz` at source/effective voltages of `450/845/1240 mV`. Those points—and the entire curve—show `total_freq_offset=+45 MHz`, matching the FactoryOC term in the installed Astral 2001 W XOC VBIOS.

CONTROL and STATUS adopted the negative request at 127/127 points in the all-point experiment. Independent hardware measurement, all-170-SM PTX acceptance workloads, and game A–B–A controls extend the evidence to observed outputs. The detailed 2.9–3.0 GHz boundary is retained in the appendix.

### Evidence boundary

**Confirmed.** XBAR is an independent physical clock domain with a distinct curve, domain-wide offset, MSVDD-scoped request, strict min/max clients, hardware counter, and checked workload loop.

**High-confidence inference.** XBAR directly affects transfer behavior between SMs and the L2/VRAM path. Directional PTX results and game A–B–A controls support this interpretation. Saturation at high propagation ratios is caused by the shared rail, source bins, and downstream arbitration—not by SET rejection.

**Not established.** A 3 GHz peak or a short 3 GHz average is not day-long stability. A logical MSVDD target is not an oscilloscope measurement of physical VOUT at every instant.

### Complete 127-point XBAR curve

The table below is the XBAR CONTROL/STATUS snapshot from the same instant. All 127 points include the Astral 2001 W XOC VBIOS's `+45 MHz` FactoryOC term.

[[vf-bank-table:XBAR]]

### Conditional VBIOS projections for XBAR

All 127 points in the current XBAR curve report `total_freq_offset=+45 MHz`, matching the Astral 2001 W XOC VBIOS FactoryOC term. Fifteen local RTX 5090 VBIOS samples contain six unique FactoryOC bins: `0`, `+15`, `+45`, `+60`, `+75`, and `+195 MHz`. Because these projections are XBAR curves, they remain in the XBAR section alongside the live table. The projection is:

```text
F_projected(point) = F_live_Astral(point) + FactoryOC_candidate - 45 MHz
```

Astral `+45 MHz` is a runtime observation. The Lightning 2500 W XOC `+195 MHz` curve is a stronger controlled static projection: the relevant PERFORMANCE, BOOST, Clock Programming, Voltage Map, NAFLL, Base Clock, and voltage-table payloads of the two VBIOS images were compared byte for byte, and the identified difference is FactoryOC. The other bins are conditional results of replacing only that constant. They omit another physical card's fuse/speedo state, driver reconstruction, and thermal state, so they are not measured curves from those boards (L5).

[[vbios-offset-tables:rtx5090-20260816]]

## SYS: independently overclockable, not another XBAR reading

### Domain identity and writable interface

SYS uses the 127-point bank at flat `259..385` and `CLK_DOMAINS` record 3. Its domain-wide offset range is `-1000..+1000 MHz`, and its API mask is `0x00000004`. The active physical-domain table uses SYS bit index 2, while ClockClient uses record index 3: the first is the bit position in a one-hot mask; the second is the record order in the control object. They are not interchangeable.

The private hardware measurement method returns SYSCLK for the same API mask. Only `SYS × rail 1/MSVDD` is adopted as the voltage request. No named and validated strict SYS min/max client has yet been identified.

### Runtime evidence

Current points 0/63/126 are `180/1972/2842 MHz` at source/effective voltages of `450/845/1240 mV`; the total frequency offset was zero at capture time. In the all-point negative-shift experiment, all 127 requests read back exactly and moved downward into new effective bins.

SYS also has isolated workload evidence stronger than “STATUS changed” (L7):

| State | Workload and result | What it establishes |
|---|---|---|
| SYS `+300 MHz` | CP2077 at 6144×3456 path tracing: hardware SYS `2330.7→2613.4 MHz`; GPC/XBAR decreased slightly; mean FPS `+1.0805%` | An independent SYS change affects this path; one sweep does not establish a precise long-term gain |
| SYS `+450 MHz` | GPC max 2400, XBAR automatic; complete 972-frame CP2077 run: SYS `2134.1→2585.4 MHz`; GPC/XBAR nearly unchanged; no Xid | Refutes the claim that `+450 MHz` SYS is necessarily unstable |
| SYS `+600 MHz` | CP2077 froze during startup/loading; one run recorded TLB invalidation failures, Xid 109, PF FLR, and Xid 8 | `+600` exceeds the demonstrated stable region, but the error codes do not uniquely identify the failing consumer |
| SYS `+600`, XBAR `+450`, MSVDD request `+25 mV` | FurMark completed with SYS peaking near 3.03 GHz; CP2077 still froze on the logo path | Rules out the simple explanation that matching XBAR or adding a small MSVDD request necessarily stabilizes SYS |

### Evidence boundary

**Confirmed.** SYS has a distinct curve, domain-wide offset, logical MSVDD request, and hardware measurement. With GPC/XBAR approximately unchanged, a `+450 MHz` request produced a measured `+451.3 MHz` SYS increase and completed CP2077. `+600 MHz` combinations repeatedly failed on the CP2077 path.

**High-confidence inference.** NVIDIA's Nsight Systems User Guide associates the GPU front end, copy engines, and performance monitor with SYS clock. That page explicitly discusses sampling behavior on Turing, GA100, and GA10x, so it supports historical terminology—not a GB202 consumer map. The roughly 1% path-tracing change is more consistent with relief in a front-end or interconnect path than with increased GPC arithmetic throughput (N1).

**Not established.** The complete list of GB202 SYS consumers, the exact RT/L2 clock-domain crossings, an unnamed strict client, the long-term stable region, and the conditions under which a SYS×MSVDD request wins physical rail arbitration remain unknown.

### Complete 127-point SYS curve

The table below is the SYS CONTROL/STATUS snapshot from the same instant. Its zero total-frequency offset does not imply that another board or VBIOS would construct the same curve.

[[vf-bank-table:SYS]]

## NVD: curve and counter found, consumer still unknown

### Domain identity and writable interface

NVD uses the 127-point bank at flat `386..512` and `CLK_DOMAINS` record 4. Its domain-wide offset range is `-1000..+1000 MHz`. The PMU table contains a distinct `NVDCLK` object with mask `0x00100000` and lower-level source ID 10. Method `0x20809006` returns an independent instantaneous clock; a read-only idle-state check during this work reported approximately `1.40 GHz`.

Only `NVD × rail 1/MSVDD` is adopted as the voltage request. No named strict NVD client has been identified. More importantly, the label “NVD” and NVAPI's public `VIDEO` clock ID do not prove that this private curve is NVENC, NVDEC, or any particular codec clock (N2, L4).

### Runtime evidence

Current points 0/63/126 report `180/1867/2715 MHz` at source/effective voltages of `450/845/1240 mV`, with zero total frequency offset. CONTROL retained the `-1/-2 MHz` request at 127/127 points, and STATUS adopted it downward.

At the level of “can this curve be written?”, NVD is as complete as SYS. What is missing is an isolated workload that binds an NVD frequency change to a particular hardware output.

### Evidence boundary

**Confirmed.** NVD has a distinct PMU domain object, source ID, hardware counter, 127-point curve, domain-wide offset, and logical MSVDD request. A rail-1 type-5 relationship also connects it with XBAR and MCLK.

**High-confidence inference.** NVD is a real programmable clock consumer rather than a UI placeholder. It may serve video, display, or data-path logic, but that remains a naming-driven candidate interpretation.

**Not established.** Whether NVD corresponds to NVENC, NVDEC, the display engine, optical flow, or a shared upstream component; whether frequency changes affect encoding, decoding, display, or game performance; its stable region; and its final physical MSVDD response.

### Complete 127-point NVD curve

The table below is the NVD CONTROL/STATUS snapshot from the same instant. It establishes that the curve exists and is readable point by point; it does not replace workload identification of the NVD consumer.

[[vf-bank-table:NVD]]

## Mechanisms shared by all four domains: quantization, voltage, and propagation

### The 508-point experiment, stated once

The four type-`0x11` banks contain 508 points in total. For each bank, the experiment captured the complete GET_CONTROL preimage, submitted a byte-identical no-op SET, applied `-1000 kHz` to every point, compared GET_CONTROL with STATUS, restored the preimage, and repeated the sequence at `-2000 kHz`:

| Bank | Request | Exact CONTROL readback | Effective-frequency Δ |
|---|---:|---:|---|
| GPC | -1/-2 MHz | 127/127 in both runs | Both runs: -15:21, -8:83, -7:21, 0:2 |
| XBAR | -1/-2 MHz | 127/127 in both runs | Both runs: -15:61, -8:66 |
| SYS | -1/-2 MHz | 127/127 in both runs | Both runs: -8:59, -7:68 |
| NVD | -1/-2 MHz | 127/127 in both runs | Both runs: -8:56, -7:71 |

No point moved opposite to the request. All four restored CSVs were byte-identical to their baselines. The identical effective distributions for `-1` and `-2 MHz` show that the request is stored at kHz precision and then folded onto a discrete clock grid of roughly 7.5 MHz; a boundary crossing appears as approximately 15 MHz. GPC's `total_freq_offset` and `effective_freq` distributions are not identical, so the two STATUS fields cannot substitute for each other (L2).

The public evidence boundary matters. The package includes the exact tested source, the original combined console output, and four baseline/restored CSV pairs. The run did not retain a shifted CSV for all 508 points. The table can be checked against the original program and output, but an independent point-by-point reaggregation requires rerunning the experiment. No missing shifted file was reconstructed after the fact. The historical write binary is not distributed; its source is preserved as `.archival.txt` for inspection, not as a cross-version build target (L2).

### Rail-by-domain requests are not global overvolting

All eight single-variable `domain × {NVVDD,MSVDD}` requests returned SET success and exact readback. STATUS adopted only four domain-specific mappings:

```text
GPC  -> rail 0 / NVVDD
XBAR -> rail 1 / MSVDD
SYS  -> rail 1 / MSVDD
NVD  -> rail 1 / MSVDD
```

For each adopted pair, all 127 points reported `effective_voltage-source_voltage=+1000 µV`; every other combination remained zero. This demonstrates that each curve can independently alter its logical voltage relationship. It does not show that the request wins final rail arbitration, nor that physical VOUT changes by exactly 1 mV (L3).

The evidence package includes all 32 complete 127-point CSVs and eight request/readback/restore logs behind this matrix. They allow every cell to be recomputed from application-side captures, but they do not replace an oscilloscope measurement of the physical rail.

### The propagation ratio changes constraints, not frequency directly

The active topology's GPC→XBAR type-3 ratio is an independently writable 16.16 control value. The default is `0xe660/65536=0.899902344`; values of `1.0`, `1.2`, and `2.0` were written, read back exactly, and restored. The intuitive equation below is nevertheless false:

```text
physical XBAR = physical GPC × ratio + XBAR offset
```

At ratio 1.2 and GPC near 2500 MHz, XBAR reached only about 2.40–2.44 GHz. At ratio 2.0 and GPC near 1300 MHz, XBAR moved from about 1440 to 2423 MHz. Type-3 supplies a propagation baseline; the result still passes through type-5 conversion on shared MSVDD, source bins, power constraints, and the clock grid. The ratio changes the constraint network, not the PLL output directly (L4).

### Writing and restoration are part of the ABI

Per-point control must begin with the complete `0x1020c` GET_CONTROL preimage. Only target type-`0x11` records should be changed, after which the entire object must be submitted. Domain control requires the same discipline with the complete `0x83c` preimage. The record base is `0x3c + domain_index×0x40`; `+0x0c` is the signed frequency offset and `+0x10 + rail_index×4` is the signed voltage offset.

At the end of a test, the original preimage must be submitted and GET_CONTROL/STATUS compared again. Hand-constructing a partial object can overwrite other curves or control bits in the same BoardObj.

## The remaining domains: adjustable, non-adjustable, and currently unimportant are different conclusions

### MCLK: domain-wide control, but not a 127-point voltage curve

INFO advertises `CLK_DOMAINS` record 2 for MCLK with a `-1000..+5000 MHz` range, and its domain-wide offset reads back exactly. The distinction is that the global V/F object assigns MCLK five type-`0x0f`, frequency-indexed points. Applying a type-`0x11` field layout to them is cleared or ignored.

The conclusion is not “MCLK has no V/F control.” It is that MCLK does not use the voltage-indexed format of the four 127-point banks in this article. MCLK also participates in rail-1 type-5 relationships with XBAR, SYS, NVD, and PCIe; a finite MCLK-MAX can therefore change other internal domains (L8, L9).

### PWR: a 127-point shape is not evidence of a usable curve

Flat `513..639` resembles a fifth 127-point bank, and CONTROL retains a `+15 MHz` request. But STATUS did not change at sampled points 0 and 63, while INFO gives `CLK_DOMAINS` record 5 a `0..0` range. The PMU/hardware-measurement table does contain `PWRCLK`; that establishes a domain object or counter, not an adjustable curve through the tested field.

### PCIe: eight points of another type, with a zero offset range

PCIe uses eight type-`0x0f` points at flat `640..647`; the type-`0x11` field is invalid. INFO gives domain record 6 a `0..0` range. A test value can be retained in CONTROL without a corresponding hardware-frequency change. A dedicated link-state or gear-control object may exist, but it is not part of the verified curve interface described here.

### XBAR2, API40, and API08: preserve the unknowns

The PMU static table also contains `XBAR2CLK 0x00040000`. Its top-level apply/commit path returns a stub-like status in the current image, while physical XBARCLK reaches the full source/MMIO path. XBAR2 is therefore more likely a 2× logical or API aggregation domain. That is a high-confidence inference, not a conclusion from its name alone.

API40 (`0x40`) has a `0..0` control-record range; API08 (`0x08`) is absent from the `0xff` control mask. Both participate in active type-5 topology relationships, but their consumers and writable entry points remain unidentified. The supported conclusion is “this control object exposes no valid offset,” not “the hardware can never be adjusted.”

## Appendix: deeper XBAR stability testing

This appendix preserves detailed evidence without making it the organizing principle of the four-domain result. It asks where XBAR's physical outcome reaches and how the 3 GHz boundary was tested. Conditional FactoryOC projections for other VBIOS images remain in the XBAR section.

### All-170-SM PTX workloads and the 3 GHz boundary

Four PTX acceptance workloads produced the following results at an approximately 2.9 GHz setting:

| Workload | Mean physical XBAR | Data result |
|---|---:|---|
| Compute | 2902.1 MHz | Zero errors |
| L2 | 2899.3 MHz | Zero errors |
| Atomic | 2900.9 MHz | Zero errors |
| VRAM | 2895.7 MHz | Zero errors |

“Checked” does not mean that all four paths have an independent CPU oracle. Compute output and atomic totals have host-side references. L2 and VRAM use deterministic GPU-side generation and GPU-side comparison. They can detect a mismatch during the run, but they cannot exclude a common-mode implementation error shared by data generation and expected-value calculation. The table therefore establishes zero errors under the implemented acceptance tests, not independent CPU agreement for every value on all four paths (L6).

Near 3 GHz, a short compute run averaged `3000.1 MHz`; the highest error-free mixed-workload average was `2997.0 MHz`. One `+440` L2 run recorded a single silent mismatch in 423,540,817,920 loads. More than 3.23 trillion later operations did not reproduce it. The event must remain in the record, but one non-reproduced sample does not define a deterministic failure point (N4, L6).

The evidence package includes the two exact tested sources whose hashes match the report and the original isolated/mixed sweep logs. Only hashes of the original test binaries were retained; the binary bytes were not. Rebuilding with the same visible command does not reproduce those hashes, so they identify historical runs but are not represented as downloadable originals (L6).

OCN telemetry samples at 3007–3075 MHz establish only that those peaks appeared on external systems. They do not replace a common workload, a time distribution, or checked data output (P4).

## Conclusion

The significant result is not merely that XBAR can finally be overclocked. It is that four important Blackwell domains have complete, distinct 127-point V/F control surfaces. GPC, XBAR, SYS, and NVD can be shaped separately and each has a domain-wide offset. GPC adopts an NVVDD request; the other three adopt MSVDD requests.

The depth of evidence is different for each domain. XBAR reaches independent physical measurement and data acceptance workloads. SYS has isolated A/B evidence and a measured failure boundary. NVD reaches the object, counter, and effective curve, while its exact consumer remains unknown. These differences do not weaken the conclusion that the curves are separately writable; they limit how far the physical interpretation can be taken.

Counterexamples are equally important. MCLK and PCIe use another point format. PWR can retain a control value without STATUS adoption. API40 and API08 participate in the topology without exposing a valid offset through this object. SET success is never the final answer. A reproducible claim must separate capability, request retention, STATUS folding, hardware measurement, and workload output.

The four-domain `-1/-2 MHz` point experiment and the rail-by-domain matrix performed on 2026-08-16 restored their complete preimages. All four curve CSVs were byte-identical after restoration, and the relevant kernel windows contained no new Xid, AER, GSP, or PCIe errors. This scope explicitly excludes the SYS `+600 MHz` failure experiment, which recorded TLB invalidation failures, Xid 109, PF FLR, and Xid 8 before recovery by reboot. Both statements are records of their respective experiments and subsequent health checks, not long-term safety proofs.

## References and evidence index

### Official NVIDIA material

- **N1.** [NVIDIA Nsight Systems User Guide: GPU Metrics and GPC/SYS clock terminology](https://developer.nvidia.com/docs/drive/drive-os/7.0.3/public/nsight/nsight-systems/UserGuide/index.html). Used for public GPC terminology and the historical association of SYS with the front end, copy engines, and performance monitor; generational extrapolation is explicitly limited in the text.
- **N2.** [NVAPI GPU Clock Control Interface](https://docs.nvidia.com/nvapi/group__gpuclock.html). The public API lists Graphics, Memory, Processor, and Video domains. This article does not force a one-to-one mapping between those public IDs and the private NVD bank.
- **N3.** [NVIDIA RTX Blackwell GPU Architecture](https://images.nvidia.com/aem-dam/Solutions/geforce/blackwell/nvidia-rtx-blackwell-gpu-architecture.pdf). Supports only the architectural background of fast dynamic clocks and split rails on Blackwell; it does not document the private ABI analyzed here.
- **N4.** [NVIDIA Parallel Thread Execution ISA](https://docs.nvidia.com/cuda/parallel-thread-execution/). Instruction-semantics reference for the PTX acceptance workloads.

### Local experiments and downloadable records

- **L1.** [Previous article: the XBAR physical domain, control chain, MCLK-MAX, and shared MSVDD](/notes/blackwell-xbar-physical-clock-domain/)
- **L2.** [All-point -1/-2 MHz experiment across four 127-point banks](/downloads/xbar/GB202_VF_ALL_POINT_NEGATIVE_SHIFT_20260816.md)
- **L3.** [Eight-combination rail-by-domain STATUS-adoption matrix](/downloads/xbar/GB202_RAIL_DOMAIN_ADOPTION_MATRIX_20260816.md)
- **L4.** [GB202 PMU/ClockClient control-logic extraction notes](/downloads/xbar/BLACKWELL_CONTROL_LOGIC_EXTRACTION_20260725.md)
- **L5.** [FactoryOC/XBAR projections from 15 RTX 5090 VBIOS images](/downloads/xbar/RTX5090_VBIOS_XBAR_OFFSET_PROJECTIONS_20260816.csv)
- **L6.** [All-170-SM PTX acceptance workloads and the 3 GHz boundary](/downloads/xbar/GB202_XBAR_PTX_BOUNDARY_20260816.md)
- **L7.** [Independent SYS offset, CP2077 A/B, and the +600 MHz failure boundary](/downloads/xbar/GB202_SYS_CLOCK_RUNTIME_AB_20260811.md)
- **L8.** [Global 648-point V/F-bank and domain-offset inventory](/downloads/xbar/GB202_GLOBAL_VF_BANK_INVENTORY_20260816.md)
- **L9.** [Closed-loop evidence for finite MCLK-MAX propagation](/downloads/xbar/MEMORY_MAX_FEEDBACK_CLOSURE_20260728.md)
- **L10.** [Complete evidence-package index and SHA-256 manifest](/downloads/xbar/INDEX.md)

### Public implementations, issue tracking, and external samples

- **P1.** [LACT issue #1159: reading, writing, STATUS validation, and restoration](https://github.com/ilya-zlobintsev/LACT/issues/1159#issuecomment-5305399366)
- **P2.** [LACT PR #1158: draft XBAR and per-domain MSVDD implementation](https://github.com/ilya-zlobintsev/LACT/pull/1158). It remained unmerged as of the article date; round-trip tests are not evidence of hardware adoption.
- **P3.** [NVIDIA open-gpu-kernel-modules issue #1266](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/1266). Public reproduction and evidence exchange for the MCLK-MAX/internal-domain fault.
- **P4.** [OCN RTX 5090 Owners Club telemetry samples at 3007–3075 MHz XBAR](https://www.overclock.net/threads/official-nvidia-rtx-5090-owners-club.1814246/latest#post-29607187). Used only as external peak samples, not as primary evidence for the interface or stability.
