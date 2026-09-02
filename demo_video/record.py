"""Record the guided tour as an MP4.

Playwright opens the dashboard's own guided tour against a running stack, hands
it the per-beat durations measured from the narration, and records the window.
Nothing is added in post: every caption, every ring, both title cards and every
number on screen is drawn by the product, and the conversations really are
played into Bee, the stream really is cut, and the reconnect really does
recover the sentence that was missed.

    pnpm tour                     # terminal 1: emulator + server, tour armed
    python demo_video/narrate.py  # terminal 2: voice + timing.json
    python demo_video/record.py   #             this

Output: mmd-demo.mp4, 1600x900, H.264/AAC, about 2:20.
"""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
RAW = HERE / "_raw"
VIEWPORT = (1600, 900)
TAIL_SECONDS = 1.6
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4310/?tour=1&manual=1"


def run(command: list[str]) -> None:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"{command[0]} failed ({result.returncode}):\n{result.stderr[-4000:]}")


def record(durations: list[int], total_ms: int) -> pathlib.Path:
    if RAW.exists():
        shutil.rmtree(RAW)
    RAW.mkdir(parents=True)
    span_ms = total_ms + int(TAIL_SECONDS * 1000)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--force-color-profile=srgb"])
        context = browser.new_context(
            viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]},
            device_scale_factor=1,
            record_video_dir=str(RAW),
            record_video_size={"width": VIEWPORT[0], "height": VIEWPORT[1]},
        )
        page = context.new_page()
        page.on("pageerror", lambda e: print(f"  page error: {e}"))
        page.goto(URL, wait_until="networkidle", timeout=60_000)
        page.wait_for_function("() => window.MentalModelDriftTour?.beats")

        beats = page.evaluate("() => window.MentalModelDriftTour.beats")
        if beats != len(durations):
            raise RuntimeError(f"timing has {len(durations)} beats, the product plays {beats}")

        # Hand the product the narration's pacing, then start its own tour.
        # Fire and forget: start() resolves only when the tour ends, and
        # page.evaluate awaits a returned promise, which would put the timed
        # window over the end screen instead of over the playback.
        page.evaluate("(d) => { window.__MMD_TIMING = d; }", durations)
        page.evaluate("() => { window.MentalModelDriftTour.start(); }")
        page.wait_for_timeout(span_ms)

        video = page.video
        context.close()
        browser.close()
        assert video is not None
        return pathlib.Path(video.path())


def main() -> None:
    timing = json.loads((HERE / "timing.json").read_text(encoding="utf-8"))
    durations: list[int] = timing["durations"]
    total_ms: int = timing["totalMs"]
    narration = HERE / "narration.wav"
    if not narration.exists():
        raise SystemExit("run narrate.py first")

    print(f"recording {len(durations)} beats, {total_ms / 1000:.1f}s + {TAIL_SECONDS}s tail")
    raw = record(durations, total_ms)
    print(f"  raw video {raw.name}")

    out = HERE / "mmd-demo.mp4"
    seconds = total_ms / 1000 + TAIL_SECONDS
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(raw), "-i", str(narration),
        "-filter_complex",
        f"[0:v]fps=30,scale={VIEWPORT[0]}:{VIEWPORT[1]}:flags=lanczos,"
        f"fade=t=in:st=0:d=0.5,fade=t=out:st={seconds - 0.8:.2f}:d=0.8[v];"
        f"[1:a]afade=t=out:st={total_ms / 1000 - 0.6:.2f}:d=0.6[a]",
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k",
        "-t", f"{seconds:.2f}",
        "-movflags", "+faststart",
        str(out),
    ])
    size = out.stat().st_size / 1_000_000
    print(f"\n{out.name}  {seconds:.1f}s  {size:.1f} MB")
    if seconds > 178:
        print("WARNING: over 2:58.")


if __name__ == "__main__":
    main()
