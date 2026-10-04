/**
 * The guided tour: `http://127.0.0.1:4310/?tour=1`.
 *
 * It is a demonstration. Every beat below either narrates what is
 * already on screen or drives the real pipeline: it feeds the demo conversations
 * into the stream, cuts the stream, restores it, clicks the product's own
 * buttons. Nothing on screen is drawn by the tour except its own caption bar,
 * the two title cards, and the ring around whatever it is pointing at.
 *
 * The two replay controls -- play a conversation, cut
 * the network -- go through `/api/tour/*`, which the server refuses unless it
 * was started with MMD_TOUR=1, so outside a demonstration the tour has nothing to
 * play, which is correct: in daily use you wait for someone to say something.
 *
 * Pacing. Each beat has a default duration, and the recorder overrides all of
 * them at once by setting `window.__MMD_TIMING` to an array of milliseconds
 * measured from the narration audio. The beat runs its action, then holds the
 * remainder, so a fast machine and a slow one draw the same frames.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface TourControls {
  setTab: (tab: 'drift' | 'heard' | 'agent' | 'sources') => void;
  setSelected: (id: string | null) => void;
  refresh: () => Promise<void> | void;
}

interface Beat {
  phase: string;
  /** Shown on screen and in the subtitles. Read aloud as written unless `spoken` says otherwise. */
  caption: string;
  /**
   * What the narrator says when the caption is not how it is pronounced: a
   * clock time is written "09:02" and said "nine oh two". Same words otherwise.
   */
  spoken?: string;
  ms: number;
  /** A CSS selector to ring, once the beat's action has settled. */
  focus?: string;
  /** A full-bleed title card instead of the product. */
  card?: { title: string; lines: string[] };
  run?: (t: Runtime) => Promise<void>;
}

interface Runtime extends TourControls {
  /** Starts playback and returns; Bee streams for as long as it takes. */
  play(conversationId: string, speedMs: number): void;
  network(up: boolean): Promise<void>;
  click(selector: string): Promise<void>;
  waitFor(selector: string, timeoutMs?: number): Promise<Element | null>;
  sleep(ms: number): Promise<void>;
}

const RETRY = '[data-drift-key="checkout-worker.retry.max_attempts"]';

const BEATS: Beat[] = [
  {
    phase: 'THE PROBLEM',
    caption: "Mental Model Drift catches an engineer's stale assumptions before they shape the next decision. Here's a checkout example.",
    ms: 7000,
    card: { title: 'Your code changed.', lines: ["Your understanding didn't."] },
  },
  {
    phase: '01 / THE ASSUMPTION',
    caption: 'A checkout alert fires. The engineer remembers three retries, and decides it is probably fine.',
    ms: 6500,
    focus: '.feed',
    run: async (t) => { t.play('10743', 650); },
  },
  {
    phase: '02 / THE MISMATCH',
    caption: 'The app checks the claim. The verified retry limit is one.',
    ms: 4000,
    focus: `${RETRY} .values`,
    run: async (t) => { await t.waitFor(RETRY, 20000); await t.refresh(); },
  },
  {
    phase: '03 / WHAT CHANGED',
    caption: "Three was right until August 23. Then retries were reduced after a duplicate-charge incident. The engineer's memory never caught up.",
    spoken: "Three was right until August twenty-third. Then retries were reduced after a duplicate-charge incident. The engineer's memory never caught up.",
    ms: 9500,
    focus: `${RETRY} .why`,
  },
  {
    phase: '04 / WHY BEE MATTERS',
    caption: 'Bee history gives the missing context: five conversations, four before the change. This was a mental model, not a random slip.',
    ms: 8500,
    focus: `${RETRY} .recurrence`,
  },
  {
    phase: '05 / THE EVIDENCE',
    caption: 'Open the evidence. The value comes from a registered source, never from a model guessing what is true.',
    ms: 6500,
    focus: '.drawer .evidence-summary',
    run: async (t) => {
      await t.click(`${RETRY} [data-tour="evidence"]`);
      await t.waitFor('.drawer .evidence-summary', 8000);
    },
  },
  {
    phase: '06 / THE EXPLANATION',
    caption: 'The timeline explains the mismatch: when the system changed, and when the old understanding was repeated.',
    ms: 6500,
    focus: '.drawer .timeline',
    run: async (t) => {
      await t.waitFor('.drawer .timeline', 10000);
      document.querySelector('.drawer .timeline')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await t.sleep(650);
    },
  },
  {
    phase: '07 / CLOSE THE LOOP',
    caption: 'Confirm the sentence was yours, then save the correction where your Bee assistant can use it next.',
    ms: 6000,
    focus: `${RETRY} .notice`,
    run: async (t) => {
      t.setSelected(null);
      await t.sleep(350);
      await t.click(`${RETRY} [data-tour="confirm"]`);
      await t.sleep(650);
      await t.click(`${RETRY} [data-tour="update"]`);
      await t.waitFor(`${RETRY} .notice.ok`, 8000);
    },
  },
  {
    phase: '08 / KEEP THE CONTEXT',
    caption: 'A dropped connection should not lose the context. On reconnect, the missed conversation is recovered and checked.',
    ms: 7000,
    focus: '.feed',
    run: async (t) => {
      await t.network(false);
      await t.sleep(500);
      t.play('10744', 350);
      await t.sleep(2800);
      await t.network(true);
      await t.waitFor('.feed li[data-kind="reconciled"]', 20000);
      await t.refresh();
    },
  },
  {
    phase: '09 / KNOW WHEN TO STAY QUIET',
    caption: 'It also knows when to stay quiet: 115 example utterances, just 17 checkable claims. The other 98 produce no interruption.',
    spoken: 'It also knows when to stay quiet: one hundred and fifteen example utterances, just seventeen checkable claims. The other ninety-eight produce no interruption.',
    ms: 10000,
    focus: '.coverage',
    run: async (t) => { t.setTab('heard'); await t.waitFor('.coverage-bar', 25000); },
  },
  {
    phase: '10 / PROTECT THE NEXT DECISION',
    caption: 'A coding agent can check the same assumption before it acts. It gets the evidence, and tells the human what changed.',
    ms: 7100,
    focus: '.agent-answer',
    run: async (t) => {
      t.setTab('agent');
      await t.waitFor('.agent-input', 10000);
      await t.click('[data-tour="agent-run"]');
      await t.waitFor('.agent-answer', 20000);
    },
  },
  {
    phase: 'THE RESULT',
    caption: 'Mental Model Drift keeps engineers and their assistants in sync with the systems they build, so their next decision starts from verified context.',
    ms: 8500,
    card: { title: 'Mental Model Drift', lines: ['Your next decision starts from verified context.', 'github.com/Marc-Dvci/Mental-Model-Drift'] },
  },
];

declare global {
  interface Window {
    __MMD_TIMING?: number[];
    MentalModelDriftTour?: {
      beats: number;
      budgets: number[];
      completedBeats: number;
      timings: { beat: number; startsAtMs: number; actionMs: number; endsAtMs: number; budgetMs: number }[];
      error?: string;
      /** The narration, word for word, so the recorder can synthesise it. */
      captions: string[];
      /** The on-screen captions, for the subtitle file. */
      subtitles: string[];
      start: () => Promise<void>;
      running: boolean;
    };
  }
}

export function Tour({ controls }: { controls: TourControls }) {
  const [index, setIndex] = useState(-1);
  const [focusBox, setFocusBox] = useState<DOMRect | null>(null);
  /** Where the ring last was, so it can fade out in place rather than vanish. */
  const lastBox = useRef<DOMRect | null>(null);
  const started = useRef(false);
  const ctrl = useRef(controls);
  ctrl.current = controls;

  const start = useCallback(async () => {
    if (started.current) return;
    started.current = true;
    const timing = window.__MMD_TIMING;
    const startedAt = Date.now();
    if (window.MentalModelDriftTour) window.MentalModelDriftTour.running = true;
    for (let i = 0; i < BEATS.length; i++) {
      const beat = BEATS[i]!;
      const budget = timing?.[i] ?? beat.ms;
      const openedAt = Date.now();
      setIndex(i);
      // A beat with a target keeps the previous ring, and its dimming, in place
      // until the new target is measured, so the ring glides rather than the
      // page flashing to full brightness in between. A beat without one lets
      // the ring fade out.
      if (!beat.focus) setFocusBox(null);
      try {
        await beat.run?.(runtime(ctrl.current));
      } catch (err) {
        if (window.MentalModelDriftTour) {
          window.MentalModelDriftTour.error = `Beat ${i}: ${String(err)}`;
          window.MentalModelDriftTour.running = false;
        }
        throw err;
      }
      if (beat.focus) {
        // Ring nothing the viewer cannot see: bring the target on screen first,
        // above the caption bar, and only then measure it.
        document.querySelector(beat.focus)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await sleep(650);
        setFocusBox(rectOf(beat.focus));
      }
      const actionMs = Date.now() - openedAt;
      const remaining = budget - actionMs;
      if (remaining > 0) await sleep(remaining);
      if (window.MentalModelDriftTour) {
        window.MentalModelDriftTour.completedBeats = i + 1;
        window.MentalModelDriftTour.timings.push({
          beat: i + 1, startsAtMs: openedAt - startedAt, actionMs,
          endsAtMs: Date.now() - startedAt, budgetMs: budget,
        });
      }
    }
    if (window.MentalModelDriftTour) window.MentalModelDriftTour.running = false;
    // The closing card stays up: the tour ends on it rather than dropping back
    // to the dashboard under the recording's fade-out.
  }, []);

  useEffect(() => {
    window.MentalModelDriftTour = {
      beats: BEATS.length,
      budgets: BEATS.map((b) => b.ms),
      completedBeats: 0,
      timings: [],
      captions: BEATS.map((b) => b.spoken ?? b.caption),
      subtitles: BEATS.map((b) => b.caption),
      start,
      running: false,
    };
    // Autostart unless the recorder wants to inject its own pacing first.
    if (!new URLSearchParams(location.search).has('manual')) void start();
  }, [start]);

  // The ring follows its target while the page scrolls or the layout settles.
  useEffect(() => {
    if (index < 0) return;
    const selector = BEATS[index]?.focus;
    if (!selector) return;
    const tick = () => setFocusBox(rectOf(selector));
    const timer = setInterval(tick, 120);
    return () => clearInterval(timer);
  }, [index]);

  const beat = index >= 0 ? BEATS[index] : undefined;
  if (!beat) return null;
  if (focusBox) lastBox.current = focusBox;
  const ringBox = focusBox ?? lastBox.current;

  return (
    <>
      {beat.card && (
        <div className="tour-card">
          <span className="mark tour-mark" aria-hidden="true" />
          <p className="tour-identity">Mental Model Drift &middot; Bee</p>
          <h1>{beat.card.title}</h1>
          {beat.card.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      {ringBox && (
        <div
          className={`tour-ring ${focusBox && !beat.card ? '' : 'hidden'}`}
          style={{
            top: ringBox.top - 8,
            left: ringBox.left - 8,
            width: ringBox.width + 16,
            height: ringBox.height + 16,
          }}
        />
      )}
      <div className="tour-cursor" aria-hidden="true" style={{ display: beat.card ? 'none' : undefined }}>
        <svg viewBox="0 0 20 26"><path d="M2 1L2 21L7 16L11 25L15 23L11 15L18 14Z" fill="#244d3e" stroke="white" strokeWidth="1.7" /></svg>
      </div>
      <div className={`tour-caption ${beat.card ? 'on-card' : ''}`}>
        <div className="tour-phase"><span>{beat.phase}</span><span>Example workflow &middot; non-private data</span></div>
        <div className="tour-progress">
          {BEATS.map((_, i) => (
            <span key={i} className={i <= index ? 'on' : ''} />
          ))}
        </div>
        <p>{beat.caption}</p>
      </div>
    </>
  );
}

// ------------------------------------------------------------------- runtime

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The caption bar owns the bottom ~150px of the window, so a ring is clipped to
 * the space above it rather than being drawn underneath the words.
 */
const CAPTION_RESERVE = 150;

function rectOf(selector: string): DOMRect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return null;
  const top = Math.max(box.top, 8);
  const bottom = Math.min(box.bottom, window.innerHeight - CAPTION_RESERVE);
  if (bottom - top < 10) return null;
  return new DOMRect(box.left, top, box.width, bottom - top);
}

function runtime(controls: TourControls): Runtime {
  const post = async (path: string, body: unknown) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  };
  const waitFor: Runtime['waitFor'] = async (selector, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const el = document.querySelector(selector);
      if (el) return el;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${selector}`);
      await sleep(150);
    }
  };
  return {
    ...controls,
    sleep,
    waitFor,
    // Not awaited: the play endpoint holds the request open for the whole playback,
    // and a beat's budget is the length of its narration, not of the audio it
    // is describing.
    play: (conversationId, speedMs) => {
      void post('/api/tour/play', { conversationId, speedMs }).catch((err: Error) => {
        if (window.MentalModelDriftTour) window.MentalModelDriftTour.error = `Playback failed: ${String(err)}`;
        console.error('tour playback failed', err);
      });
    },
    network: (up) => post('/api/tour/network', { up }),
    click: async (selector) => {
      const el = (await waitFor(selector, 8000)) as HTMLElement | null;
      if (!el) throw new Error(`nothing to click at ${selector}`);
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(450);
      const box = el.getBoundingClientRect();
      const cursor = document.querySelector<HTMLElement>('.tour-cursor');
      if (cursor) {
        cursor.style.transform = `translate(${box.left + box.width / 2}px, ${box.top + box.height / 2}px)`;
        cursor.classList.add('active');
        cursor.classList.remove('click');
        await sleep(370);
        cursor.classList.add('click');
      }
      el.click();
      await sleep(250);
    },
  };
}
