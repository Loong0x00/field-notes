# GB202 XBAR live VF-point status (R610.43.03)

This note records only fields distinguished by reversible runtime A/B tests.

## Capture path

- RM control: `NV2080_CTRL_CMD_CLK_VF_POINTS_GET_STATUS`, `0x20809022`
- Parameter size: `0x98208`
- The INFO header/mask is fetched first and copied into the STATUS request.
- The XBAR bank begins at absolute parameter offset `0x4c40`.
- It contains 127 consecutive records with stride `0x98`.

## Record fields established by A/B

Offsets below are relative to each `0x98`-byte point record.

| Offset | Observed role | Evidence |
|---:|---|---|
| `+0x2c` | type/valid marker; low 16 bits are `0x1111` | constant across all 127 points |
| `+0x30` | effective/tuned voltage in uV | every point increases by exactly 10000 after a +10 mV MSVDD request |
| `+0x34` | effective/tuned frequency in MHz | every point increases by exactly 60 after a +60 MHz XBAR request |
| `+0x38` | base frequency as 16.16 fixed-point MHz | unchanged by both A/Bs; low 16 bits are zero |
| `+0x44` | source/original voltage in uV | unchanged by the +10 mV A/B |
| `+0x58` | duplicate effective frequency in MHz | same +60 change as `+0x34` |
| `+0x5c` | duplicate effective voltage in uV | same +10000 change as `+0x30` |
| `+0x80` | total frequency tuning offset in kHz | 45000 baseline, 105000 after +60 MHz |
| `+0x88` | voltage tuning offset in uV | 0 baseline, 10000 after +10 mV |

At baseline, all points satisfy exactly:

`effective_freq_mhz = (base_freq_fixed_16_16 >> 16) + freq_tuning_offset_khz / 1000`

The card therefore already has a factory +45 MHz XBAR tuning offset in this
status object. The first point is 450 mV / 225 MHz (180 MHz base + 45 MHz), and
the last is 1240 mV / 2812 MHz (2767 MHz base + 45 MHz).

## Negative result

`CLK_VF_POINTS_GET_CONTROL` is byte-identical before and after both A/Bs. The
effective curve is exposed by STATUS; CONTROL does not mirror the regenerated
per-point curve. The same is true of the previously tested VF_TUPLES INFO and
CONTROL objects.

## Decoder

`decode_clk_vf_points_status.py` accepts either the binary RM buffer or the raw
text produced by `power_cap_limit_probe`. It validates all observed invariants
before emitting CSV, so an unrelated/changed ABI is rejected rather than
silently mislabeled.
