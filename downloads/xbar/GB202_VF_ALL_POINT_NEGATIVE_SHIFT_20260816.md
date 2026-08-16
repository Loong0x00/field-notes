# GB202 four-bank all-point negative-shift experiment

Date: 2026-08-16
GPU: NVIDIA GeForce RTX 5090
Driver: 610.57.04
VBIOS: 98.02.2E.80.50

## Question and method

For each 127-point type-`0x11` bank (GPC, XBAR, SYS, NVD), the complete
GET_CONTROL preimage was captured, byte-identically resubmitted, shifted by
`-1000` and `-2000` kHz, compared against STATUS point by point, and restored.
A fresh post-restore CSV was then compared byte for byte with the baseline.

## Result

All 508 records accepted and exactly returned both requested values, but the
effective curve was quantized to the hardware clock grid instead of moving by
exactly 1 MHz or 2 MHz.

| bank | request | exact CONTROL readback | effective-frequency delta distribution | total-offset delta distribution |
|---|---:|---:|---|---|
| GPC | -1 MHz | 127/127 | -15: 21, -8: 83, -7: 21, 0: 2 | -8: 96, -7: 16, 0: 15 |
| GPC | -2 MHz | 127/127 | -15: 21, -8: 83, -7: 21, 0: 2 | -8: 96, -7: 31 |
| XBAR | -1 MHz | 127/127 | -15: 61, -8: 66 | -8: 127 |
| XBAR | -2 MHz | 127/127 | -15: 61, -8: 66 | -8: 127 |
| SYS | -1 MHz | 127/127 | -8: 59, -7: 68 | -7: 127 |
| SYS | -2 MHz | 127/127 | -8: 59, -7: 68 | -7: 127 |
| NVD | -1 MHz | 127/127 | -8: 56, -7: 71 | -7: 127 |
| NVD | -2 MHz | 127/127 | -8: 56, -7: 71 | -7: 127 |

All deltas in the final two columns are MHz. No point moved opposite to the
request. XBAR, SYS, and NVD moved at all 127 points; GPC moved at 125/127
effective-frequency points and left two points in the same effective bin.
The identical effective-frequency distributions for -1 MHz and -2 MHz show
that the two requests generally collapse onto the same representable step.

## Restoration and evidence boundary

The restored GPC, XBAR, SYS, and NVD CSVs were byte-identical to their
baselines. The kernel journal contained no new Xid, AER, GSP, or PCIe errors.

The downloadable [evidence directory](vf-508-point-evidence/) contains the
exact source, the original combined application console, and all four
baseline/restored CSV pairs. The run did not retain a
shifted CSV for every point: the console preserves the exact-readback counts,
delta histograms, and representative points, but a fresh point-by-point
reaggregation requires rerunning the source. This missing artifact is not
silently reconstructed. The historical write-capable executable is not
distributed; the byte-exact source is distributed with an `.archival.txt`
suffix as inspection evidence rather than a portable build target.

This confirms CONTROL acceptance, exact readback, downward STATUS adoption,
quantization, and restoration. It does not establish load stability or the
same quantization behavior on another driver, VBIOS, or board.
