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
    effective_mhz = [int(row["effective_freq_mhz"]) for row in rows]
    base_mhz = [int(row["base_freq_mhz"]) for row in rows]
    offset_mhz = [int(row["freq_tuning_offset_khz"]) / 1000 for row in rows]

    if set(offset_mhz) != {45.0}:
        raise ValueError(f"expected a uniform +45 MHz offset, found {set(offset_mhz)}")
    if any(effective != base + 45 for base, effective in zip(base_mhz, effective_mhz)):
        raise ValueError("effective frequency is not base frequency + 45 MHz")

    panel = "#151719"
    plot = "#202327"
    ink = "#f0f2f3"
    faded = "#a5abb1"
    grid_major = "#5b6269"
    grid_minor = "#353a40"
    curve = "#d8dde1"
    selected = "#ff9d36"

    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "axes.facecolor": plot,
            "figure.facecolor": panel,
            "axes.edgecolor": grid_major,
            "axes.labelcolor": ink,
            "xtick.color": faded,
            "ytick.color": faded,
            "text.color": ink,
        }
    )

    fig, axis = plt.subplots(figsize=(16, 10), dpi=180)
    axis.plot(
        voltage_mv,
        effective_mhz,
        color=curve,
        linewidth=1.35,
        marker="s",
        markersize=4.8,
        markerfacecolor=plot,
        markeredgecolor=curve,
        markeredgewidth=0.85,
        zorder=3,
    )
    axis.scatter(
        [voltage_mv[-1]],
        [effective_mhz[-1]],
        s=72,
        marker="s",
        facecolor=selected,
        edgecolor=ink,
        linewidth=1.2,
        zorder=5,
    )

    axis.set_xlim(440, 1250)
    axis.set_ylim(0, 3050)
    axis.set_xlabel("VOLTAGE (mV)", labelpad=16, fontsize=11, fontweight="bold")
    axis.set_ylabel("XBAR FREQUENCY (MHz)", labelpad=16, fontsize=11, fontweight="bold")
    axis.set_xticks(range(450, 1251, 50))
    axis.set_xticks(range(450, 1251, 10), minor=True)
    axis.set_yticks(range(0, 3001, 250))
    axis.set_yticks(range(0, 3001, 50), minor=True)
    axis.grid(which="major", color=grid_major, linewidth=0.8, alpha=0.75)
    axis.grid(which="minor", color=grid_minor, linewidth=0.45, alpha=0.8)
    axis.set_axisbelow(True)
    axis.tick_params(which="major", length=6, width=0.9, labelsize=9)
    axis.tick_params(which="minor", length=3, width=0.5)

    fig.text(
        0.075,
        0.947,
        "XBAR VOLTAGE / FREQUENCY CURVE",
        color=ink,
        fontsize=22,
        fontweight="bold",
    )
    fig.text(
        0.075,
        0.918,
        "ASUS ASTRAL 2001 W XOC  ·  R610.57.04  ·  LIVE GSP STATUS  ·  127 DISCRETE POINTS",
        color=faded,
        fontsize=9.5,
    )
    fig.text(0.625, 0.947, "SELECTED POINT", color=faded, fontsize=8.5, fontweight="bold")
    fig.text(0.625, 0.916, "126", color=selected, fontsize=20, fontweight="bold")
    fig.text(0.710, 0.947, "VOLTAGE", color=faded, fontsize=8.5, fontweight="bold")
    fig.text(0.710, 0.916, "1240 mV", color=ink, fontsize=17, fontweight="bold")
    fig.text(0.810, 0.947, "FREQUENCY", color=faded, fontsize=8.5, fontweight="bold")
    fig.text(0.810, 0.916, "2812 MHz", color=ink, fontsize=17, fontweight="bold")
    fig.text(0.910, 0.947, "BASE / OFFSET", color=faded, fontsize=8.5, fontweight="bold")
    fig.text(0.910, 0.916, "2767 / +45", color=ink, fontsize=14, fontweight="bold")

    axis.annotate(
        "P126   1240 mV   2812 MHz",
        xy=(voltage_mv[-1], effective_mhz[-1]),
        xytext=(-210, 56),
        textcoords="offset points",
        color=ink,
        fontsize=9.5,
        fontweight="bold",
        bbox={"boxstyle": "square,pad=0.55", "facecolor": panel, "edgecolor": selected},
        arrowprops={"arrowstyle": "-", "color": selected, "linewidth": 1.2},
    )
    fig.text(
        0.075,
        0.025,
        "Each square is one STATUS record; lines connect adjacent records. Voltage is logical GSP STATUS data, not external VRM VOUT.",
        color=faded,
        fontsize=9.5,
    )
    fig.tight_layout(rect=(0.035, 0.055, 0.985, 0.89))
    fig.savefig(OUTPUT, facecolor=panel)
    plt.close(fig)


if __name__ == "__main__":
    main()
