# GB202 rail-by-clock-domain adoption matrix

Date: 2026-08-16
GPU: NVIDIA GeForce RTX 5090
Driver: 610.57.04
VBIOS: 98.02.2E.80.50

## Interface and method

The `0x83c`-byte R610.57.04 `CLK_DOMAINS` control object stores a signed
rail-by-domain offset at:

```text
domain base = 0x3c + domain_index * 0x40
rail offset = domain base + 0x10 + rail_index * 4, signed uV
```

Each GPC/XBAR/SYS/NVD × rail-0/rail-1 combination was changed alone by
`+1000 uV`, exactly read back, observed in all four 127-point STATUS banks,
and restored from the complete preimage.

## STATUS adoption matrix

Each cell is `total_volt_offset_uv` across all 127 points:

| requested slot | GPC bank | XBAR bank | SYS bank | NVD bank |
|---|---:|---:|---:|---:|
| GPC × rail 0 (NVVDD) | +1000 | 0 | 0 | 0 |
| GPC × rail 1 (MSVDD) | 0 | 0 | 0 | 0 |
| XBAR × rail 0 (NVVDD) | 0 | 0 | 0 | 0 |
| XBAR × rail 1 (MSVDD) | 0 | +1000 | 0 | 0 |
| SYS × rail 0 (NVVDD) | 0 | 0 | 0 | 0 |
| SYS × rail 1 (MSVDD) | 0 | 0 | +1000 | 0 |
| NVD × rail 0 (NVVDD) | 0 | 0 | 0 | 0 |
| NVD × rail 1 (MSVDD) | 0 | 0 | 0 | +1000 |

Every cell represents 127/127 identical observations. For each adopted
pairing, `effective_voltage_uv - source_voltage_uv` was exactly `+1000 uV` at
all points. All eight requests returned success and exact GET_CONTROL readback,
including the four pairings ignored by STATUS.

The active logical mapping on this build is therefore GPC→NVVDD and
XBAR/SYS/NVD→MSVDD. This proves control retention and logical V/F adoption. It
does not prove final rail-arbiter victory, an exact physical VOUT change, load
stability, or a safe voltage range.

All four post-test bank captures were byte-identical to baseline and the
kernel journal contained no new Xid, AER, GSP, or PCIe error.

The downloadable [raw matrix directory](rail-domain-matrix-raw/) contains all
32 complete 127-point CSVs (eight requests observed across four banks) and the
eight corresponding request/readback/restore logs. The summary table above can
therefore be recomputed from application-side raw captures.
