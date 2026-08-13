#!/usr/bin/env python3
from __future__ import annotations

import csv
from pathlib import Path

import matplotlib.pyplot as plt


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "downloads/xbar/astral-2001w-xoc-r610.57.04-xbar.csv"
OUTPUT = ROOT / "downloads/xbar/astral-2001w-xoc-r610.57.04-xbar-vf.png"


def main() -> None:
    with SOURCE.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))

    if len(rows) != 127:
        raise ValueError(f"expected 127 XBAR points, found {len(rows)}")

    voltage_mv = [int(row["effective_voltage_uv"]) / 1000 for row in rows]
    base_mhz = [int(row["base_freq_mhz"]) for row in rows]
    effective_mhz = [int(row["effective_freq_mhz"]) for row in rows]
    offset_mhz = [int(row["freq_tuning_offset_khz"]) / 1000 for row in rows]

    if set(offset_mhz) != {45.0}:
        raise ValueError(f"expected a uniform +45 MHz offset, found {set(offset_mhz)}")
    if any(effective != base + 45 for base, effective in zip(base_mhz, effective_mhz)):
        raise ValueError("effective frequency is not base frequency + 45 MHz")

    lightning_projection_mhz = [base + 195 for base in base_mhz]

    paper = "#111111"
    ink = "#e8e0cf"
    faded = "#aaa59b"
    rule = "#57544d"
    red = "#dc665b"
    blue = "#75a7c7"

    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "axes.facecolor": paper,
            "figure.facecolor": paper,
            "axes.edgecolor": rule,
            "axes.labelcolor": ink,
            "xtick.color": faded,
            "ytick.color": faded,
            "text.color": ink,
        }
    )

    fig, axis = plt.subplots(figsize=(14, 8), dpi=180)
    axis.plot(
        voltage_mv,
        base_mhz,
        color=faded,
        linewidth=1.8,
        linestyle=(0, (4, 4)),
        label="Decoded base frequency",
        zorder=1,
    )
    axis.plot(
        voltage_mv,
        effective_mhz,
        color=red,
        linewidth=2.6,
        marker="o",
        markersize=2.5,
        markeredgewidth=0,
        label="Astral 2001 W live STATUS (+45 MHz FactoryOC)",
        zorder=3,
    )
    axis.plot(
        voltage_mv,
        lightning_projection_mhz,
        color=blue,
        linewidth=2.0,
        linestyle=(0, (8, 4)),
        label="Lightning 2500 W conditional projection (+195 MHz FactoryOC)",
        zorder=2,
    )

    axis.set_xlim(430, 1260)
    axis.set_ylim(0, 3150)
    axis.set_xlabel("Effective voltage (mV)", labelpad=12)
    axis.set_ylabel("XBAR frequency (MHz)", labelpad=12)
    axis.grid(True, color=rule, linewidth=0.65, alpha=0.55)
    axis.set_axisbelow(True)
    axis.legend(
        loc="lower right",
        frameon=True,
        facecolor=paper,
        edgecolor=rule,
        labelcolor=ink,
        fontsize=9.5,
    )
    axis.set_title(
        "GB202 XBAR voltage/frequency bank",
        loc="left",
        fontsize=23,
        fontweight="bold",
        pad=24,
    )
    fig.text(
        0.125,
        0.91,
        "Astral 2001 W XOC · R610.57.04 · 127 live STATUS points",
        color=faded,
        fontsize=11,
    )
    fig.text(
        0.125,
        0.025,
        "The Lightning line is a controlled +150 MHz FactoryOC projection from byte-identical curve inputs, not a live capture.",
        color=faded,
        fontsize=9.5,
    )
    fig.tight_layout(rect=(0.04, 0.06, 0.98, 0.90))
    fig.savefig(OUTPUT, facecolor=paper)
    plt.close(fig)


if __name__ == "__main__":
    main()
