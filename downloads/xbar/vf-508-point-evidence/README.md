# 508-point negative-shift evidence

This directory preserves the exact test program and the application-side
outputs used by `GB202_VF_ALL_POINT_NEGATIVE_SHIFT_20260816.md`.

- `xbar_vf_point_demo.c.archival.txt` is a byte-exact archival text copy of the
  source used for the eight bank-shift runs. The non-`.c` suffix is deliberate.
- `VF_508_POINT_NEGATIVE_SHIFT_CONSOLE_20260816.log` is the original combined
  console output for GPC/XBAR/SYS/NVD at -1000 and -2000 kHz.
- `*-live.csv` and `*-restored.csv` are the four pre/post captures. Each pair
  is byte-identical.

The run printed exact CONTROL counts, per-delta histograms, and representative
points, but did not save a shifted CSV containing every post-write point.
Consequently the published histograms can be checked against the original
program and console output, while a new point-by-point reaggregation requires
rerunning the test. No missing per-point file has been reconstructed.

The historical executable is deliberately not distributed. The archival text
contains an old, broad write path without the public demo's runtime gates; it
is evidence for source inspection, not a build target, and must not be renamed,
compiled, or run. Use `../xbar_clock_demo.c` for the identity/range-gated,
small-range example.

Retained source identity:

```text
source  33ee70d5769164a1ef42b35bccc8f3fc677ac411cc629acf38d47152a111a41f
```
