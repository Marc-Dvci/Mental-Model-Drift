"""Synthesise the demo narration, and measure it.

The narration is not written here. It is the guided tour's own captions, read
out of the running dashboard (``window.MentalModelDriftTour.captions``), so the
words a viewer hears and the words burned into the screen cannot drift apart.

Each beat is synthesised separately with Edge TTS, measured with ffprobe, and
padded to a whole number of milliseconds. ``timing.json`` carries the per-beat
durations; ``record.py`` injects them as ``window.__MMD_TIMING`` so the visuals
pace themselves to the voice.

    pnpm tour                    # terminal 1: the stack, with the tour armed
    python demo_video/narrate.py # terminal 2: voice + timing.json
    python demo_video/record.py  #             record + mux -> mmd-demo.mp4

Requires: edge-tts, playwright (chromium), ffmpeg/ffprobe on PATH.
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import subprocess
import sys

import edge_tts
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
SPEECH = HERE / "speech"
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4310/?tour=1&manual=1"

VOICE = "en-US-AndrewMultilingualNeural"
RATE = "+8%"
# Room to breathe after each sentence, and a longer beat after a title card.
GAP_MS = 700
CARD_GAP_MS = 1100
CARD_BEATS = {0}


def captions_from_product() -> list[str]:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(URL, wait_until="networkidle", timeout=60_000)
        page.wait_for_function("() => window.MentalModelDriftTour?.captions?.length")
        captions = page.evaluate("() => window.MentalModelDriftTour.captions")
        browser.close()
    return captions


def duration_ms(path: pathlib.Path) -> int:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nk=1:nw=1", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return int(round(float(out) * 1000))


async def synthesise(text: str, out: pathlib.Path) -> None:
    await edge_tts.Communicate(text, VOICE, rate=RATE).save(str(out))


def main() -> None:
    captions = captions_from_product()
    print(f"{len(captions)} beats read from the product")
    SPEECH.mkdir(exist_ok=True)
    for stale in SPEECH.glob("*"):
        stale.unlink()

    clips: list[pathlib.Path] = []
    durations: list[int] = []
    for i, caption in enumerate(captions):
        mp3 = SPEECH / f"beat{i:02d}.mp3"
        asyncio.run(synthesise(caption, mp3))
        wav = SPEECH / f"beat{i:02d}.wav"
        gap = CARD_GAP_MS if i in CARD_BEATS else GAP_MS
        # One 48k stereo WAV per beat, with its trailing pause baked in, so the
        # concatenation is sample-exact and every beat boundary is known.
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp3),
             "-af", f"apad=pad_dur={gap / 1000}", "-ar", "48000", "-ac", "2", str(wav)],
            check=True,
        )
        ms = duration_ms(wav)
        durations.append(ms)
        clips.append(wav)
        print(f"  beat {i:2d}  {ms / 1000:5.1f}s  {caption[:66]}")

    listing = SPEECH / "concat.txt"
    listing.write_text("".join(f"file '{c.as_posix()}'\n" for c in clips), encoding="utf-8")
    narration = HERE / "narration.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", str(listing), "-c", "copy", str(narration)],
        check=True,
    )

    total = sum(durations)
    (HERE / "timing.json").write_text(
        json.dumps({"voice": VOICE, "rate": RATE, "durations": durations,
                    "totalMs": total, "captions": captions}, indent=2),
        encoding="utf-8",
    )
    write_subtitles(captions, durations)
    print(f"\nnarration.wav  {total / 1000:.1f}s total  ({total / 60000:.2f} min)")
    if total > 175_000:
        print("WARNING: over 2:55. Trim a caption in apps/dashboard/src/Tour.tsx.")


def write_subtitles(captions: list[str], durations: list[int]) -> None:
    def stamp(ms: int) -> str:
        h, ms = divmod(ms, 3_600_000)
        m, ms = divmod(ms, 60_000)
        s, ms = divmod(ms, 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    lines, at = [], 0
    for i, (caption, ms) in enumerate(zip(captions, durations), start=1):
        lines.append(f"{i}\n{stamp(at)} --> {stamp(at + ms - 200)}\n{caption}\n")
        at += ms
    (HERE / "mmd-demo.srt").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
