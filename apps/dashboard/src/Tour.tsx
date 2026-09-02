/**
 * The guided tour: `http://127.0.0.1:4310/?tour=1`.
 *
 * It is a demonstration, not a mock. Every beat below either narrates what is
 * already on screen or drives the real pipeline: it plays a recorded
 * conversation into Bee, cuts the stream, restores it, clicks the product's own
 * buttons. Nothing on screen is drawn by the tour except its own caption bar,
 * the two title cards, and the ring around whatever it is pointing at.
 *
 * The two controls that only the emulator can offer -- play a conversation, cut
 * the network -- go through `/api/tour/*`, which the server refuses unless it
 * was started with MMD_TOUR=1. Against a real Bee device the tour has nothing to
 * play, which is correct: with a device you wait for someone to say something.
 *
 * Pacing. Each beat has a default duration, and the recorder overrides all of
 * them at once by setting `window.__MMD_TIMING` to an array of milliseconds
 * measured from the narration audio. The beat runs its action, then holds the
 * remainder, so a fast machine and a slow one draw the same frames.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface TourControls {
  setTab: (tab: 'drift' | 'heard' | 'sources') => void;
  setSelected: (id: string | null) => void;
  refresh: () => Promise<void> | void;
}

interface Beat {
  /** Spoken word for word. The caption and the narration are the same string. */
  caption: string;
  ms: number;
  /** A CSS selector to ring, once the beat's action has settled. */
  focus?: string;
  /** A full-bleed title card instead of the product. */
  card?: { title: string; lines: string[] };
  run?: (t: Runtime) => Promise<void>;
}

interface Runtime extends TourControls {
  /** Starts playback and returns; the emulator streams for as long as it takes. */
  play(conversationId: string, speedMs: number): void;
  network(up: boolean): Promise<void>;
  click(selector: string): Promise<void>;
  waitFor(selector: string, timeoutMs?: number): Promise<Element | null>;
  sleep(ms: number): Promise<void>;
}

const RETRY = '[data-drift-key="checkout-worker.retry.max_attempts"]';

const BEATS: Beat[] = [
  {
    caption:
      'We monitor configuration drift, infrastructure drift and schema drift. This monitors the one system nobody instruments: the engineer’s understanding.',
    ms: 9600,
    card: {
      title: 'Mental Model Drift',
      lines: ['Your system changes every day.', 'Your mental model doesn’t.'],
    },
  },
  {
    caption:
      'Nine oh two. An engineer is looking at an alert on the checkout worker, and decides not to investigate it.',
    ms: 7600,
    focus: '.feed',
    run: async (t) => {
      t.play('10743', 1400);
    },
  },
  {
    caption:
      'Bee hears the whole conversation. Eight sentences, and half of them produce nothing at all: a question, an opinion, an observation with no value in it, and a belief the speaker has already marked as past.',
    ms: 12400,
    focus: '.feed',
    run: async (t) => {
      await t.waitFor('.feed li.feed-quiet', 14000);
    },
  },
  {
    caption:
      'One is a flat assertion about a property the registry knows how to check. Every word of it has to appear in what was actually said, and then the value is read from AWS AppConfig.',
    ms: 12600,
    focus: '.feed',
    run: async (t) => {
      await t.waitFor('.feed li.feed-drift', 20000);
      await t.refresh();
    },
  },
  {
    caption: 'Production says one, not three.',
    ms: 4600,
    focus: `${RETRY} .values`,
    run: async (t) => {
      await t.waitFor(RETRY, 20000);
    },
  },
  {
    caption:
      'The engineer was not misremembering. Three was correct until the twenty-third of August, when retries were cut to one after a duplicate-charge incident. The software changed. Nobody told them.',
    ms: 13600,
    focus: `${RETRY} .why`,
  },
  {
    caption:
      'Bee is what turns a slip into a mental model. The same sentence in five conversations since the fourteenth of July. Four of them were true when they were said. This one is not.',
    ms: 12200,
    focus: `${RETRY} .recurrence`,
  },
  {
    caption:
      'The evidence is a source, an address and a timestamp. No model is ever asked whether a statement is true. It is asked only which property the sentence is about.',
    ms: 12200,
    focus: '.drawer .evidence',
    run: async (t) => {
      await t.click(`${RETRY} [data-tour="evidence"]`);
      await t.waitFor('.drawer .evidence', 8000);
    },
  },
  {
    caption:
      'Underneath, the mental-model timeline: what the system was, when it changed, and every time this person said otherwise.',
    ms: 9600,
    focus: '.drawer .timeline',
    run: async (t) => {
      document.querySelector('.drawer .timeline')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await t.sleep(700);
    },
  },
  {
    caption:
      'One click writes the corrected value into Bee memory as a confirmed fact, which is where the wearer’s own assistant will read it next.',
    ms: 11600,
    focus: RETRY,
    run: async (t) => {
      t.setSelected(null);
      await t.sleep(500);
      await t.click(`${RETRY} [data-tour="confirm"]`);
      await t.sleep(900);
      await t.click(`${RETRY} [data-tour="update"]`);
      await t.waitFor(`${RETRY} .notice`, 8000);
    },
  },
  {
    caption:
      'Eleven forty. The stream drops. Bee documents realtime delivery as at most once, so the corridor conversation happening now is never replayed.',
    ms: 12400,
    focus: '.feed',
    run: async (t) => {
      await t.network(false);
      await t.sleep(1400);
      t.play('10744', 500);
    },
  },
  {
    caption:
      'On reconnect the cursor closes the gap, and the sentence nobody was listening to comes back: the stale number has just been handed to another team.',
    ms: 13600,
    focus: '.feed',
    run: async (t) => {
      await t.network(true);
      await t.waitFor('.feed li[data-kind="reconciled"]', 20000);
      await t.refresh();
    },
  },
  {
    caption:
      'And most of the time it says nothing. Across seven weeks and one hundred and fifteen utterances, seventeen were about something this registry can settle. The other ninety-eight produce nothing. Silence is the feature.',
    ms: 15600,
    focus: '.coverage',
    run: async (t) => {
      t.setTab('heard');
      await t.waitFor('.coverage-bar', 25000);
      await t.sleep(500);
    },
  },
  {
    caption: 'Observability tells you when your systems drift. This tells you when your understanding does.',
    ms: 8400,
    card: {
      title: 'Mental Model Drift',
      lines: ['Bee hears the claim.', 'Production settles it.', 'github.com/Marc-Dvci/Mental-Model-Drift'],
    },
  },
];

declare global {
  interface Window {
    __MMD_TIMING?: number[];
    MentalModelDriftTour?: {
      beats: number;
      /** The narration, word for word, so the recorder can synthesise it. */
      captions: string[];
      start: () => Promise<void>;
      running: boolean;
    };
  }
}

export function Tour({ controls }: { controls: TourControls }) {
  const [index, setIndex] = useState(-1);
  const [done, setDone] = useState(false);
  const [focusBox, setFocusBox] = useState<DOMRect | null>(null);
  const started = useRef(false);
  const ctrl = useRef(controls);
  ctrl.current = controls;

  const start = useCallback(async () => {
    if (started.current) return;
    started.current = true;
    const timing = window.__MMD_TIMING;
    for (let i = 0; i < BEATS.length; i++) {
      const beat = BEATS[i]!;
      const budget = timing?.[i] ?? beat.ms;
      const openedAt = Date.now();
      setIndex(i);
      setFocusBox(null);
      try {
        await beat.run?.(runtime(ctrl.current));
      } catch (err) {
        console.warn(`tour beat ${i} action failed`, err);
      }
      if (beat.focus) {
        // Ring nothing the viewer cannot see: bring the target on screen first,
        // above the caption bar, and only then measure it.
        document.querySelector(beat.focus)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await sleep(650);
        setFocusBox(rectOf(beat.focus));
      }
      const remaining = budget - (Date.now() - openedAt);
      if (remaining > 0) await sleep(remaining);
    }
    setIndex(-1);
    setDone(true);
  }, []);

  useEffect(() => {
    window.MentalModelDriftTour = { beats: BEATS.length, captions: BEATS.map((b) => b.caption), start, running: true };
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

  if (done) return null;
  const beat = index >= 0 ? BEATS[index] : undefined;
  if (!beat) return null;

  return (
    <>
      {beat.card && (
        <div className="tour-card">
          <span className="mark tour-mark" aria-hidden="true" />
          <h1>{beat.card.title}</h1>
          {beat.card.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      {!beat.card && focusBox && (
        <div
          className="tour-ring"
          style={{
            top: focusBox.top - 8,
            left: focusBox.left - 8,
            width: focusBox.width + 16,
            height: focusBox.height + 16,
          }}
        />
      )}
      <div className={`tour-caption ${beat.card ? 'on-card' : ''}`}>
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
      if (Date.now() > deadline) return null;
      await sleep(150);
    }
  };
  return {
    ...controls,
    sleep,
    waitFor,
    // Not awaited: the emulator holds the request open for the whole playback,
    // and a beat's budget is the length of its narration, not of the audio it
    // is describing.
    play: (conversationId, speedMs) => {
      void post('/api/tour/play', { conversationId, speedMs }).catch((err: Error) =>
        console.warn('tour playback failed', err),
      );
    },
    network: (up) => post('/api/tour/network', { up }),
    click: async (selector) => {
      const el = (await waitFor(selector, 8000)) as HTMLElement | null;
      if (!el) throw new Error(`nothing to click at ${selector}`);
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(450);
      el.click();
      await sleep(250);
    },
  };
}
