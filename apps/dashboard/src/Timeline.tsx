/**
 * The mental-model timeline.
 *
 * Two series on one time axis, and the whole argument of the product is the gap
 * between them:
 *
 *   above   what the authoritative source said the value was, as a step line
 *   below   when the wearer said what, as marks
 *
 * The shaded band is the interval during which the belief was already wrong.
 * A mark inside it is not a mistake at the time it was made -- it is a mental
 * model that stopped tracking, which is a different and more interesting thing.
 */
import type { HistoricalChange, Timeline as TimelineData } from './api.ts';
import { fmt, shortDate } from './api.ts';

const W = 920;
const H = 250;
const PAD_L = 56;
const PAD_R = 24;
const SYSTEM_Y = 74;
const SPOKEN_Y = 178;

interface Segment {
  from: number;
  to: number;
  value: unknown;
}

export function Timeline({ data, driftAt }: { data: TimelineData; driftAt?: string }) {
  const changes = [...data.system].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const spoken = [...data.spoken].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const times = [
    ...changes.map((c) => Date.parse(c.at)),
    ...spoken.map((s) => Date.parse(s.at)),
    driftAt ? Date.parse(driftAt) : Date.now(),
  ].filter((t) => Number.isFinite(t));

  if (times.length === 0) {
    return <p className="muted">No history has been reconstructed for this property yet.</p>;
  }

  const now = Date.now();
  const rawMin = Math.min(...times);
  const rawMax = Math.max(...times, now);
  // A little air on both sides so the first and last marks are not on the frame.
  const span = Math.max(rawMax - rawMin, 86_400_000);
  const min = rawMin - span * 0.06;
  const max = rawMax + span * 0.06;
  const x = (t: number) => PAD_L + ((t - min) / (max - min)) * (W - PAD_L - PAD_R);

  const segments = buildSegments(changes, min, max);
  const lastChange = changes.at(-1);
  const driftFrom = lastChange ? Date.parse(lastChange.at) : null;

  return (
    <figure className="timeline">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Timeline of ${data.label}`}>
        <defs>
          <linearGradient id="staleBand" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--drift)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--drift)" stopOpacity="0.03" />
          </linearGradient>
        </defs>

        {driftFrom !== null && (
          <>
            <rect
              x={x(driftFrom)}
              y={38}
              width={Math.max(0, x(Math.max(now, driftAt ? Date.parse(driftAt) : now)) - x(driftFrom))}
              height={H - 78}
              fill="url(#staleBand)"
            />
            <line x1={x(driftFrom)} x2={x(driftFrom)} y1={38} y2={H - 40} className="tl-change-rule" />
          </>
        )}

        <text x={8} y={SYSTEM_Y - 22} className="tl-band-label">
          SOURCE
        </text>
        <text x={8} y={SPOKEN_Y + 26} className="tl-band-label">
          SPOKEN
        </text>

        {/* Step line: the authoritative value over time. */}
        {segments.map((seg, i) => (
          <g key={`seg-${i}`}>
            <line x1={x(seg.from)} x2={x(seg.to)} y1={SYSTEM_Y} y2={SYSTEM_Y} className="tl-system-line" />
            <text x={(x(seg.from) + x(seg.to)) / 2} y={SYSTEM_Y - 12} className="tl-system-value">
              {fmt(seg.value)}
            </text>
          </g>
        ))}
        {segments.slice(1).map((seg, i) => (
          <line key={`step-${i}`} x1={x(seg.from)} x2={x(seg.from)} y1={SYSTEM_Y} y2={SYSTEM_Y} className="tl-system-line" />
        ))}

        {changes.map((c) => (
          <g key={c.at + String(c.to)}>
            <circle cx={x(Date.parse(c.at))} cy={SYSTEM_Y} r={5} className="tl-change-dot" />
            <text x={x(Date.parse(c.at))} y={SYSTEM_Y + 22} className="tl-change-label" textAnchor="middle">
              {shortDate(c.at)}
            </text>
            {c.commitSha && (
              <text x={x(Date.parse(c.at))} y={SYSTEM_Y + 36} className="tl-change-sha" textAnchor="middle">
                {c.commitSha.slice(0, 7)}
              </text>
            )}
          </g>
        ))}

        {/* Marks: when the wearer stated a value. */}
        {spoken.map((s, i) => {
          const stale = driftFrom !== null && Date.parse(s.at) > driftFrom;
          return (
            <g key={`${s.conversationId}-${i}`}>
              <line
                x1={x(Date.parse(s.at))}
                x2={x(Date.parse(s.at))}
                y1={SPOKEN_Y - 14}
                y2={SPOKEN_Y}
                className={stale ? 'tl-spoken-stem stale' : 'tl-spoken-stem'}
              />
              <circle
                cx={x(Date.parse(s.at))}
                cy={SPOKEN_Y}
                r={6}
                className={stale ? 'tl-spoken-dot stale' : 'tl-spoken-dot'}
              >
                <title>{`${shortDate(s.at)} — “${s.excerpt}”`}</title>
              </circle>
              <text x={x(Date.parse(s.at))} y={SPOKEN_Y - 20} className="tl-spoken-value" textAnchor="middle">
                {fmt(s.value)}
              </text>
              <text x={x(Date.parse(s.at))} y={SPOKEN_Y + 20} className="tl-change-label" textAnchor="middle">
                {shortDate(s.at)}
              </text>
            </g>
          );
        })}

        <line x1={PAD_L} x2={W - PAD_R} y1={H - 34} y2={H - 34} className="tl-axis" />
        <text x={PAD_L} y={H - 18} className="tl-axis-label">
          {shortDate(new Date(min).toISOString())}
        </text>
        <text x={W - PAD_R} y={H - 18} className="tl-axis-label" textAnchor="end">
          now
        </text>
      </svg>

      <figcaption>
        {driftFrom !== null ? (
          <>
            The source stepped on <strong>{shortDate(new Date(driftFrom).toISOString())}</strong>. Marks in the shaded band
            were spoken after that.
          </>
        ) : (
          <>No change to the source value has been reconstructed, so nothing here is shaded.</>
        )}
      </figcaption>
    </figure>
  );
}

/**
 * Turn a list of transitions into contiguous value segments.
 *
 * `from` on the first change is the value that held before any recorded
 * transition, which is the only way to know what the value was when the wearer
 * originally learned it.
 */
function buildSegments(changes: HistoricalChange[], min: number, max: number): Segment[] {
  if (changes.length === 0) return [];
  const segments: Segment[] = [{ from: min, to: Date.parse(changes[0]!.at), value: changes[0]!.from }];
  for (let i = 0; i < changes.length; i++) {
    const start = Date.parse(changes[i]!.at);
    const end = i + 1 < changes.length ? Date.parse(changes[i + 1]!.at) : max;
    segments.push({ from: start, to: end, value: changes[i]!.to });
  }
  return segments;
}
