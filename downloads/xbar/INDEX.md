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

To retrieve the complete compact set:

```bash
base=https://loong0x00.com/downloads/xbar
for file in \
  xbar_clock_demo.c \
  BLACKWELL_CONTROL_LOGIC_EXTRACTION_20260725.md \
  MEMORY_MAX_FEEDBACK_CLOSURE_20260728.md \
  LACT_XBAR_EXPERIMENTAL_ISSUE.md \
  XBAR_VF_POINTS_RUNTIME_20260812.md \
  astral-2001w-xoc-r610.57.04-xbar.csv \
  astral-2001w-xoc-r610.57.04-xbar-vf.png \
  RTX5090_FACTORY_OC_SAMPLES_20260813.csv \
  issue1147_ingame_reply_20260812.md \
  XBAR2400_MCLKMAX16000_CP2077_AB_20260811.md \
  lightning_vbios_mclk_max_ab_20260803.md \
  REPRODUCTION_REPORT.md \
  VERIFICATION.md \
  SHA256SUMS; do
  curl -fLO "$base/$file"
done
sha256sum -c SHA256SUMS
```

## Files

- [xbar_clock_demo.c](xbar_clock_demo.c) — version-pinned minimal ClockClient read/write/readback/measure/restore example for R610.57.04.
- [BLACKWELL_CONTROL_LOGIC_EXTRACTION_20260725.md](BLACKWELL_CONTROL_LOGIC_EXTRACTION_20260725.md) — PMU clock-domain objects, hardware measurement, and propagation topology.
- [MEMORY_MAX_FEEDBACK_CLOSURE_20260728.md](MEMORY_MAX_FEEDBACK_CLOSURE_20260728.md) — closure of the finite MCLK-MAX to XBAR/power-feedback path.
- [LACT_XBAR_EXPERIMENTAL_ISSUE.md](LACT_XBAR_EXPERIMENTAL_ISSUE.md) — experimental XBAR frequency and MSVDD request interface.
- [XBAR_VF_POINTS_RUNTIME_20260812.md](XBAR_VF_POINTS_RUNTIME_20260812.md) — 127-point live XBAR V/F-state evidence.
- [astral-2001w-xoc-r610.57.04-xbar.csv](astral-2001w-xoc-r610.57.04-xbar.csv) — complete decoded 127-record live STATUS bank, including raw record offsets and duplicate fields.
- [astral-2001w-xoc-r610.57.04-xbar-vf.png](astral-2001w-xoc-r610.57.04-xbar-vf.png) — rendered base/effective Astral curve plus the explicitly labelled conditional Lightning projection.
- [RTX5090_FACTORY_OC_SAMPLES_20260813.csv](RTX5090_FACTORY_OC_SAMPLES_20260813.csv) — FactoryOC deltas, vPstate targets, versions, hashes, and provenance for 15 representative RTX 5090 VBIOS images.
- [issue1147_ingame_reply_20260812.md](issue1147_ingame_reply_20260812.md) — two game A–B–A controls under the normal state.
- [XBAR2400_MCLKMAX16000_CP2077_AB_20260811.md](XBAR2400_MCLKMAX16000_CP2077_AB_20260811.md) — recovery by XBAR 2400 under the MCLK-MAX fault state.
- [lightning_vbios_mclk_max_ab_20260803.md](lightning_vbios_mclk_max_ab_20260803.md) — MSI Lightning VBIOS cross-experiment.
- [REPRODUCTION_REPORT.md](REPRODUCTION_REPORT.md) — compact public evidence-package reproduction report.
- [VERIFICATION.md](VERIFICATION.md) — raw telemetry and benchmark-output verification method.
- [SHA256SUMS](SHA256SUMS) — hashes of every downloadable evidence file above.

The much larger raw evidence archive is not duplicated here. Its public
provenance, archive hash, and verifier are documented in NVIDIA issue #1266 and
in `REPRODUCTION_REPORT.md`.
