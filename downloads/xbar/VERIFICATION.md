# Independent verification from raw files

This verifier does not read `reproduction-results.json` and does not call the report generator.
It parses each benchmark's native output and recomputes telemetry averages from the raw CSV windows.

- Claimed `summary.csv` values match the independently recomputed values.
- Cyberpunk settings match in all four formal runs: 6144x3456, path tracing on, frame generation off.
- Physical MCLK is 15001 MHz in every formal run.
- No private PERF-limit sample or thermal/hardware/power-brake/software-thermal slowdown sample is active.
- No `NVRM: Xid` line exists in the captured experiment logs.
- The pre-test LACT configuration SHA matches the post-cleanup SHA byte-for-byte; the 647 W power cap and disabled persistence state were restored.
- In every pair, the finite MCLK maximum lowers XBAR and SYS while the reported GPU clock rises.

Cyberpunk pair losses: 11.88%, 11.25%.
Cyberpunk mean: 11.7080 -> 10.3536 FPS; loss 11.57%.
FurMark pair losses: 21.49%, 21.58%, 20.83%.
FurMark mean: 241.00 -> 189.67 FPS; loss 21.30%.

Result: PASS
