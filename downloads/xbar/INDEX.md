# Blackwell XBAR research-file index

This directory contains the source and compact evidence files referenced by
“XBAR in NVIDIA Blackwell GPUs: A Physical Clock Domain Ignored by Public
Tooling.” Files are served without transformation.

## Download

Open any file link below, or download from a shell:

```bash
base=https://loong0x00.com/downloads/xbar
curl -fLO "$base/xbar_clock_demo.c"
curl -fLO "$base/SHA256SUMS"
sha256sum -c SHA256SUMS --ignore-missing
```

To retrieve every file in the hash manifest, including the expanded raw
evidence directories:

```bash
base=https://loong0x00.com/downloads/xbar
curl -fLO "$base/SHA256SUMS"
while read -r hash file; do
  case "$file" in /*|*..*) exit 1;; esac
  mkdir -p "$(dirname "$file")"
  curl -fLo "$file" "$base/$file"
done < SHA256SUMS
sha256sum -c SHA256SUMS
```

## Files

- [xbar_clock_demo.c](xbar_clock_demo.c) — version-pinned ClockClient example for the exact tested GPU/driver/VBIOS; it validates runtime INFO ranges, applies an additional ±100 MHz/30-second public-demo ceiling, permits only the four observed rail mappings at ±1000 uV, checks the entire control-object readback, and verifies CONTROL plus selected V/F STATUS restoration.
- [BLACKWELL_CONTROL_LOGIC_EXTRACTION_20260725.md](BLACKWELL_CONTROL_LOGIC_EXTRACTION_20260725.md) — PMU clock-domain objects, hardware measurement, and propagation topology.
- [MEMORY_MAX_FEEDBACK_CLOSURE_20260728.md](MEMORY_MAX_FEEDBACK_CLOSURE_20260728.md) — closure of the finite MCLK-MAX to XBAR/power-feedback path.
- [LACT_XBAR_EXPERIMENTAL_ISSUE.md](LACT_XBAR_EXPERIMENTAL_ISSUE.md) — experimental XBAR frequency and MSVDD request interface.
- [XBAR_VF_POINTS_RUNTIME_20260812.md](XBAR_VF_POINTS_RUNTIME_20260812.md) — 127-point live XBAR V/F-state evidence.
- [GB202_XBAR_PTX_BOUNDARY_20260816.md](GB202_XBAR_PTX_BOUNDARY_20260816.md) — all-170-SM PTX integrity workloads and the measured 3 GHz boundary.
- [GB202_GLOBAL_VF_BANK_INVENTORY_20260816.md](GB202_GLOBAL_VF_BANK_INVENTORY_20260816.md) — 648-point GPC/XBAR/MCLK/SYS/NVD/PWR/PCIe bank inventory and adoption checks.
- [GB202_VF_ALL_POINT_NEGATIVE_SHIFT_20260816.md](GB202_VF_ALL_POINT_NEGATIVE_SHIFT_20260816.md) — all-point -1/-2 MHz CONTROL acceptance, STATUS quantization, and restoration results for four 127-point banks.
- [GB202_RAIL_DOMAIN_ADOPTION_MATRIX_20260816.md](GB202_RAIL_DOMAIN_ADOPTION_MATRIX_20260816.md) — eight-combination rail-by-domain CONTROL/STATUS matrix for GPC, XBAR, SYS, and NVD.
- [GB202_SYS_CLOCK_RUNTIME_AB_20260811.md](GB202_SYS_CLOCK_RUNTIME_AB_20260811.md) — independent SYS offset, direct hardware-clock measurements, Cyberpunk A/B results, and the +600 MHz failure boundary.
- [vf-508-point-evidence/README.md](vf-508-point-evidence/README.md) — exact archival 508-point test source, original console output, baseline/restored CSV pairs, and the explicit missing-shifted-CSV boundary; the historical write-capable executable is not distributed.
- [rail-domain-matrix-raw/README.md](rail-domain-matrix-raw/README.md) — all 32 full-bank STATUS CSVs and eight logs behind the rail-by-domain matrix.
- [ptx-boundary-evidence/README.md](ptx-boundary-evidence/README.md) — exact isolated/mixed PTX sources, retained sweep logs and control receipts, plus the original-binary retention boundary.
- [gb202-r610.57.04-gpc-live-vf.csv](gb202-r610.57.04-gpc-live-vf.csv) — complete 127-point GPC live CONTROL/STATUS snapshot used by the article disclosure.
- [gb202-r610.57.04-xbar-live-vf.csv](gb202-r610.57.04-xbar-live-vf.csv) — complete 127-point XBAR live CONTROL/STATUS snapshot used by the article disclosure.
- [gb202-r610.57.04-sys-live-vf.csv](gb202-r610.57.04-sys-live-vf.csv) — complete 127-point SYS live CONTROL/STATUS snapshot used by the article disclosure.
- [gb202-r610.57.04-nvd-live-vf.csv](gb202-r610.57.04-nvd-live-vf.csv) — complete 127-point NVD live CONTROL/STATUS snapshot used by the article disclosure.
- [RTX5090_VBIOS_XBAR_OFFSET_PROJECTIONS_20260816.csv](RTX5090_VBIOS_XBAR_OFFSET_PROJECTIONS_20260816.csv) — 15 VBIOS FactoryOC terms, deltas from the live Astral +45 MHz source, three representative projected XBAR points, and evidence classes.
- [astral-2001w-xoc-r610.57.04-xbar.csv](astral-2001w-xoc-r610.57.04-xbar.csv) — complete decoded 127-record live STATUS bank, including raw record offsets and duplicate fields.
- [astral-2001w-xoc-r610.57.04-xbar-vf.png](astral-2001w-xoc-r610.57.04-xbar-vf.png) — rendered base/effective Astral curve plus the explicitly labelled conditional Lightning projection.
- [RTX5090_FACTORY_OC_SAMPLES_20260813.csv](RTX5090_FACTORY_OC_SAMPLES_20260813.csv) — FactoryOC deltas, vPstate targets, versions, hashes, and provenance for 15 representative RTX 5090 VBIOS images.
- [issue1147_ingame_reply_20260812.md](issue1147_ingame_reply_20260812.md) — two game A–B–A controls under the normal state.
- [XBAR2400_MCLKMAX16000_CP2077_AB_20260811.md](XBAR2400_MCLKMAX16000_CP2077_AB_20260811.md) — recovery by XBAR 2400 under the MCLK-MAX fault state.
- [lightning_vbios_mclk_max_ab_20260803.md](lightning_vbios_mclk_max_ab_20260803.md) — MSI Lightning VBIOS cross-experiment.
- [REPRODUCTION_REPORT.md](REPRODUCTION_REPORT.md) — compact public evidence-package reproduction report.
- [VERIFICATION.md](VERIFICATION.md) — raw telemetry and benchmark-output verification method.
- [SHA256SUMS](SHA256SUMS) — hashes of every downloadable file, including every nested raw-evidence artifact.

The older multi-workload archive referenced by the first XBAR article remains
external; its public provenance, archive hash, and verifier are documented in
NVIDIA issue #1266 and in `REPRODUCTION_REPORT.md`. The new 508-point,
rail-by-domain, and PTX-boundary application evidence used by this article is
included here rather than described as if it were downloadable elsewhere.
