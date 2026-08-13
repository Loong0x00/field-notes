Yes. I reran two built-in game benchmarks as controlled A-B-A tests. The only change in B was the XBAR clock request (`+450 MHz`) plus the XBAR-domain MSVDD request (`+20 mV`); the latter is required for this card to remain visually stable at that XBAR offset. The LACT configuration and game configuration were unchanged across all three runs.

### Cyberpunk 2077 2.31

6144x3456, DLAA, path tracing, no frame generation, 800 W limit, 15001 MHz physical MCLK:

| Run | XBAR request | Physical XBAR avg | Core clock avg | Core voltage avg | Board power avg | Avg FPS | Min FPS |
|---|---:|---:|---:|---:|---:|---:|---:|
| A1 | 0 / 0 mV | 2396.7 MHz | 3156.1 MHz | 1046.6 mV | 660.4 W | 12.4628 | 10.8882 |
| B | +450 MHz / +20 mV | 2791.3 MHz | 3148.0 MHz | 1045.5 mV | 676.8 W | 12.8436 | 11.1532 |
| A2 | 0 / 0 mV | 2392.4 MHz | 3155.8 MHz | 1046.8 mV | 660.0 W | 12.4886 | 10.9183 |

Using the mean of A1 and A2 as the baseline, B improved average FPS by **2.95%** and minimum FPS by **2.29%**. The core clock was actually about 8 MHz lower in B, while SYS remained effectively unchanged (2382.2 / 2376.6 / 2381.5 MHz for A1/B/A2).

These are new XBAR-only runs. I excluded the older Cyberpunk measurements from NVIDIA issue 1266 because those were collected while testing the finite-MCLK-limit bug and were not a clean XBAR overclock comparison.

### Black Myth: Wukong Benchmark Tool

6144x3456, cinematic preset, full ray tracing level 3, DLSS sampling at 100% (DLAA), no frame generation, same 800 W limit and 15001 MHz physical MCLK:

| Run | XBAR request | Physical XBAR avg | Core clock avg | Core voltage avg | Board power avg | Mean of raw frame samples |
|---|---:|---:|---:|---:|---:|---:|
| A1 | 0 / 0 mV | 2406.0 MHz | 3204.7 MHz | 1050.3 mV | 564.8 W | 8.4394 FPS |
| B | +450 MHz / +20 mV | 2807.0 MHz | 3195.6 MHz | 1050.0 mV | 579.8 W | 8.6794 FPS |
| A2 | 0 / 0 mV | 2405.5 MHz | 3203.4 MHz | 1050.3 mV | 564.1 W | 8.4061 FPS |

The benchmark's rounded summary is 8 FPS in all three runs, so I used its per-sample `FrameRate` records rather than the rounded integer. Relative to the mean of A1 and A2, B improved throughput by **3.05%**. The two baseline runs differed by only 0.40%. Again, B had about 8 MHz less core clock, and SYS stayed effectively unchanged (2392.6 / 2390.2 / 2391.2 MHz).

The Black Myth configuration file SHA-256 was identical before and after every run (`927753da17bcb2217f16a2b58f6398288f777b147f36d870a26290e51ed328e9`). Cyberpunk also used one unchanged settings file for all three runs (`0049e36cb1e76fc5c3bc6ec19582ab4fdd387cd77c477d48cd7fda2196cb34eb`). Cyberpunk telemetry reported no thermal slowdown, hardware slowdown, or power-brake event, and there was no new Xid during either test series.

For completeness, earlier exploratory Steel Nomad DX12 runs produced successful scores of 13659, 14341, 14349, 15244, and 14985. Those runs also changed the core V/F curve and/or power configuration, so I do not consider them valid XBAR-only comparisons and would not use them to quantify this feature.

So the synthetic result does reproduce in two actual game engines. On this setup the gain at `+450 MHz / +20 mV` is about 3% in these 6K ray/path-traced game benchmarks, rather than the 10.6% seen in the much more XBAR-sensitive FurMark case.
