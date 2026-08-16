# GB202 global V/F-point and clock-offset inventory — 2026-08-16

Runtime target: RTX 5090, NVIDIA driver `610.57.04`, active VBIOS/state.

## Global `CLK_VF_POINTS` object

Commands and sizes:

- INFO `0x20809021`, `0x8208` bytes
- STATUS `0x20809022`, `0x98208` bytes
- GET_CONTROL `0x20809023`, `0x1020c` bytes
- SET_CONTROL `0x2080d024`, `0x1020c` bytes

INFO advertises flat points 0 through 647:

| Flat indices | Count | Type | Domain | Tested frequency-point result |
|---:|---:|---:|---|---|
| 0..126 | 127 | `0x11` | GPC | effective point 0: 225 -> 240 MHz; restored |
| 127..253 | 127 | `0x11` | XBAR | effective point 0: 225 -> 240 MHz; restored |
| 254..258 | 5 | `0x0f` | MCLK | tested `0x11` field cleared/ignored |
| 259..385 | 127 | `0x11` | SYS | effective point 0: 180 -> 195 MHz; restored |
| 386..512 | 127 | `0x11` | NVD | effective point 0: 180 -> 195 MHz; restored |
| 513..639 | 127 | `0x11` | PWR | CONTROL retained +15 MHz; sampled STATUS unchanged |
| 640..647 | 8 | `0x0f` | PCIe | tested `0x11` field cleared/ignored |

Every bank accepted a root, byte-identical SET and returned the original
GET_CONTROL preimage. A real +15000 kHz write changed both CONTROL and STATUS
only for GPC, XBAR, SYS, and NVD. This distinguishes command acceptance,
request retention, and effective-state adoption.

The type-`0x0f` result does not prove that MCLK or PCIe has no type-specific
control. It proves only that these frequency-indexed points do not accept the
tested type-`0x11` voltage-point frequency-offset field.

## Global `CLK_DOMAINS` offsets

INFO `0x20809019` reports nine domains. GET/SET_CONTROL
`0x2080901b/0x2080d01c` exposes records 0 through 7:

| Index | API mask | Domain | INFO range MHz | +15 MHz readback | Classification |
|---:|---:|---|---:|---|---|
| 0 | `0x00000001` | GPC | -1000..8000 | exact | advertised adjustable |
| 1 | `0x00000002` | XBAR | -1000..1000 | exact | advertised adjustable |
| 2 | `0x00000010` | MCLK | -1000..5000 | exact | advertised adjustable |
| 3 | `0x00000004` | SYS | -1000..1000 | exact | advertised adjustable |
| 4 | `0x00100000` | NVD | -1000..1000 | exact | advertised adjustable |
| 5 | `0x00080000` | PWR | 0..0 | retained | not advertised; no decisive shift |
| 6 | `0x00200000` | PCIe | 0..0 | retained | not advertised; measurement unchanged |
| 7 | `0x00000040` | API40 | 0..0 | retained | not advertised; measurement unchanged |
| 8 | `0x00000008` | API08 | 0..0 | no record | no control-mask bit |

An accepted low-level SET is not a capability signal. The advertised INFO
range plus STATUS or independent hardware behavior distinguishes the five
real frequency-offset domains from inert control slots.

## Voltage boundary and restoration

Each exposed domain record contains signed rail-by-domain storage at
`record + 0x10 + rail_index * 4`. A later eight-combination STATUS experiment
separated storage from adoption. The adopted logical pairings are GPC to
rail 0/NVVDD and XBAR, SYS, and NVD each to rail 1/MSVDD; every adopted request
appeared at all 127 points of its own bank and nowhere else. See
`GB202_RAIL_DOMAIN_ADOPTION_MATRIX_20260816.md` for the full matrix.

This establishes logical V/F adoption, not final physical-rail arbitration.
Only XBAR-domain rail 1/MSVDD has separate load evidence that a larger request
can alter the winning MSVDD target. Similar storage in ignored domain/rail
pairings is not proof of effective voltage control.

All writes were immediately restored. Final GET_CONTROL and STATUS reads
matched their preimages, and no new Xid was logged.
