# The demo, beat by beat

**2 minutes 15 seconds.** Every frame is the product. Nothing is added in post: the captions, the
two title cards and the ring around whatever is being pointed at are all drawn by the dashboard, and
the conversations really are played into Bee, the stream really is cut, and the reconnect really
does recover the sentence that was missed.

Reproduce it in three commands:

```bash
pnpm tour                     # terminal 1: emulator + server, guided tour armed
python demo_video/narrate.py  # terminal 2: Edge TTS -> narration.wav + timing.json
python demo_video/record.py   #             Playwright -> demo_video/mmd-demo.mp4
```

Or just watch it happen in a browser: `pnpm tour`, then open
<http://127.0.0.1:4310/?tour=1>.

---

## How the timing works

The narration is not written in the recorder. It is the tour's own captions, read out of the running
page (`window.MentalModelDriftTour.captions`), so **the words a viewer hears and the words burned
into the screen cannot drift apart**. `narrate.py` synthesises each beat separately, measures it with
`ffprobe`, and writes `timing.json`. `record.py` injects those durations as `window.__MMD_TIMING`,
and each beat runs its action and then *holds the remainder*, so a fast machine and a slow one draw
the same frames.

Every number spoken is on screen in the same shot. That is a rule, not an aspiration: an earlier cut
said "six of the eight sentences produce nothing" because the design document said so. The real
number is four, and the product had been saying four on screen the whole time.

---

## The beats

| # | at | what the product does | narration |
|---|---|---|---|
| 0 | 0:00 | title card | *We monitor configuration drift, infrastructure drift and schema drift. This monitors the one system nobody instruments: the engineer's understanding.* |
| 1 | 0:11 | plays conversation 10743 into Bee's realtime stream, one sentence at a time | *Nine oh two. An engineer is looking at an alert on the checkout worker, and decides not to investigate it.* |
| 2 | 0:17 | the live capture panel fills: every utterance, and every rejection with its reason | *Bee hears the whole conversation. Eight sentences, and half of them produce nothing at all: a question, an opinion, an observation with no value in it, and a belief the speaker has already marked as past.* |
| 3 | 0:31 | candidate → grounding → `reading aws_appconfig` → `DRIFTED` | *One is a flat assertion about a property the registry knows how to check. Every word of it has to appear in what was actually said, and then the value is read from AWS AppConfig.* |
| 4 | 0:42 | the card, ringed on the two values | *Production says one, not three.* |
| 5 | 0:45 | ringed on **Why you may remember 3** | *The engineer was not misremembering. Three was correct until the twenty-third of August, when retries were cut to one after a duplicate-charge incident. The software changed. Nobody told them.* |
| 6 | 0:57 | ringed on the recurrence line | *Bee is what turns a slip into a mental model. The same sentence in five conversations since the fourteenth of July. Four of them were true when they were said. This one is not.* |
| 7 | 1:08 | opens the evidence drawer | *The evidence is a source, an address and a timestamp. No model is ever asked whether a statement is true. It is asked only which property the sentence is about.* |
| 8 | 1:19 | scrolls to the mental-model timeline | *Underneath, the mental-model timeline: what the system was, when it changed, and every time this person said otherwise.* |
| 9 | 1:26 | clicks **Yes, that was my understanding**, then **Update my understanding**; the fact text written to Bee appears on the card | *One click writes the corrected value into Bee memory as a confirmed fact, which is where the wearer's own assistant will read it next.* |
| 10 | 1:34 | cuts the stream, then plays conversation 10744 into a Bee nobody is listening to | *Eleven forty. The stream drops. Bee documents realtime delivery as at most once, so the corridor conversation happening now is never replayed.* |
| 11 | 1:44 | restores the stream; cursor reconciliation recovers the corridor sentence and checks it | *On reconnect the cursor closes the gap, and the sentence nobody was listening to comes back: the stale number has just been handed to another team.* |
| 12 | 1:53 | switches to the **Heard** tab; the coverage survey renders | *And most of the time it says nothing. Across seven weeks and one hundred and fifteen utterances, seventeen were about something this registry can settle. The other ninety-eight produce nothing. Silence is the feature.* |
| 13 | 2:07 | switches to the **Agent** tab; the firewall panel | *And the person is not the only one who needs this. A coding agent is handed the same sentence, and cannot tell a fact from a memory.* |
| 14 | 2:16 | clicks **Check**; a real `POST /api/check` returns the same verdict, with the instruction | *It asks the same registry, over MCP or one command, and gets the same verdict — told to say what changed, rather than quietly correcting someone who was right until August.* |
| 15 | 2:29 | closing card | *Observability tells you when your systems drift. This tells you when your understanding does.* |

---

## Why these beats and not others

**It opens on a sentence somebody said, not on architecture.** The hook is a person deciding *not*
to investigate an alert, for a reason that was true in July.

**Beat 2 is the product's real claim.** A tool that reads your conversations has to earn its place
by staying quiet, and the four rejections — with their reasons visible — are the proof. Beat 12 is
the same argument at the scale of seven weeks.

**Beat 5 is the conceptual reveal.** Not "you are wrong" but "you were right, and then the software
moved and nobody told you". Everything else in the product is in service of being able to say that
sentence with a commit hash attached.

**Beats 13 and 14 are the second consumer, and they are last for a reason.** The whole product has
to be believable for a person before it is worth pointing at an agent. The panel is not a mockup: it
posts to `/api/check`, which runs the same registry, the same grounding gate and the same
comparator, and the count on screen reads *six* earlier conversations rather than five — because the
corridor sentence recovered in beat 11 has, by then, become part of the history. The demo learned
something during the demo.

**Beat 11 is the reliability claim, and it is the one that is easy to fake and hard to do.** The
stream is genuinely cut. The conversation genuinely happens with no subscriber attached. The
recovery is genuinely a cursor read. And what comes back is the worst possible sentence: *"Told them
the checkout worker retries three times, so a slow consumer is not the problem."* The stale belief
has now been handed to another team.

**There is no architecture diagram.** The beat sheet in the original brief had one; it was cut. In a
two-minute video the diagram costs twenty seconds and tells a judge less than watching the evidence
panel name a locator does.

---

## Recording notes

- 1600×900, 30 fps, H.264/AAC, ~11 MB. Subtitles are written from the same timing to
  `demo_video/mmd-demo.srt`, so they can be uploaded alongside the video with no edit pass.
- The tour drives the emulator through `/api/tour/*`, which the server refuses with 403 unless it
  was started with `MMD_TOUR=1`. Against a real Bee device the tour has nothing to play, which is
  correct: with a device you wait for somebody to say something.
- `record.py` deliberately does not `await` the tour's `start()`. `page.evaluate` awaits a returned
  promise, and `start()` resolves only when the tour ends, so returning it puts the recording window
  over the end screen instead of over the demonstration.
- If a beat looks wrong, run the tour in a visible browser first (`pnpm tour`, then
  `/?tour=1`) — everything the recorder sees, you can watch happen live.
