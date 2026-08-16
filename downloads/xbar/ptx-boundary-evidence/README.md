# PTX XBAR boundary evidence

This directory contains the exact tested CUDA sources recovered from the
original session plus the retained sweep logs referenced by
`GB202_XBAR_PTX_BOUNDARY_20260816.md`.

```text
isolated source  91bfe9ae2f79226c768d940ccde77da05f9a1b4d28344b845638716b38106fa7
mixed source     e8a93d1d8fc2dd459d16be2b750010e51643a24f95add25b70bb5349fb531c16
```

The original compile command was:

```bash
/opt/cuda/bin/nvcc -O3 -std=c++17 -lineinfo -Xptxas=-v \
  -arch=sm_120 -o ptx_xbar_stress ptx_xbar_stress.cu
```

The original executable bytes were not retained. Their hashes in the report
identify the recorded runs, but cannot now be checked against downloadable
binaries. Rebuilding the exact source with the same visible command produced
different executable hashes, so this package does not pretend the rebuild is
the original artifact.

`isolated-sweep/` and `mixed-sweep/` preserve application output, control and
ratio readbacks, kernel-event windows, restoration logs, and voltage-control
receipts. Binary preimages in those directories are historical evidence, not
a portable configuration and must not be replayed on another runtime.
