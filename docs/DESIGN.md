# Design notes

Everything below was measured against the channel simulator in `test/`, not assumed. Where a
number appears, it came out of a run.

---

## 1. Choosing the spectrum

Three walls close in on the usable band:

- **Below ~17 kHz — people hear it.** Nominal hearing reaches 20 kHz, but that is a child's
  ear. Most adults over 25 lose everything above ~17 kHz; by 40 it is nearer 15 kHz. Children
  are the binding constraint, not adults.
- **Above ~20 kHz — the hardware removes it.** Consumer audio paths sample at 44.1 or 48 kHz
  and their anti-aliasing filters roll off well before Nyquist. Speaker and microphone response
  up there is unreliable across devices even when the sample rate allows it.
- **Below ~8 kHz — the world is loud.** Nearly all ambient energy lives here. This is the quiet
  gift of going ultrasonic: the 17.5–20 kHz band is remarkably empty in real rooms, so effective
  SNR is far better than a broadband noise measurement suggests.

The simulator models ambient noise with a room-like spectrum (falling ~18 dB/decade above
250 Hz, plus a further 20 dB above 10 kHz) rather than white noise. With a flat noise floor,
band selection would look pointless; with a realistic one, the silent band's advantage is real.

## 2. What was measured

### Chirp synchronisation is almost free robustness

A 40 ms linear sweep recovered by matched filter located the frame start in **every trial down
to −10 dB SNR**, with worst-case timing error of 9 samples (0.19 ms). Sweeping spreads the
energy so correlation gain, not raw amplitude, does the work. It is the highest-leverage
component in the system and also what lets a receiver join a transmission already in progress.

### Clock drift matters, but far less than first measured

Raw BER against crystal mismatch, office acoustics, noise 0.006, silent band:

| Modulation | 0 ppm | 20 ppm | 50 ppm | 100 ppm | 200 ppm |
|---|---|---|---|---|---|
| QPSK | 0 | 0 | 0 | 0 | 7.1e−3 |
| 16-QAM | 0 | 0 | 4.7e−3 | 1.3e−2 | 1.1e−1 |

**This corrects an earlier conclusion.** The first version of this document claimed clock drift
was *the* dominant impairment, on the strength of numbers that showed 8-PSK collapsing two
orders of magnitude at 50 ppm. That was largely an artefact of the simulator: it modelled
sample-rate offset with linear interpolation, whose response at 19 kHz against a 48 kHz rate
is down about 5 dB with substantial aliasing — landing precisely on the near-ultrasonic band.
A real ADC running slightly fast or slow performs an ideal resampling. Replacing the model with
windowed-sinc interpolation recovered **13 dB** at 20 ppm, and the silent band now rides out
100 ppm at QPSK without a single bit error.

Drift is still worth tracking: 16-QAM starts to degrade around 50 ppm, and pilot-derived
timing-slope correction in `demodulateSymbol` is what keeps the denser constellations usable.
It is simply not the wall it first appeared to be.

### Peak-to-average reduction was doing more harm than good

Clip-and-filter PAPR reduction is standard practice for OFDM and was enabled by default. It is
now off, because measurement did not support it:

| | value |
|---|---|
| Mean crest factor, unclipped | ~3.6 |
| Headroom gained by clipping to 4.0 | under 0.5 dB, inside run-to-run noise |
| Distortion injected when a symbol's natural crest exceeded the target | ~30% of signal RMS |
| Resulting ceiling on effective SNR | ~17 dB, regardless of channel |

Because crest averages 3.6, peak-normalising the burst already leaves adequate headroom, and
clipping only engages on the minority of symbols that happen to peak higher. Those symbols were
then badly distorted — on the pilots as well as the data, so the phase-tracking fit degraded
too. The failure mode was insidious: QPSK still decoded perfectly, so the link looked healthy,
while every 16-QAM carrier failed. The ceiling was invisible until effective SNR (from EVM) was
compared against the SNR the channel estimator was reporting; the two disagreed by 9 dB.

With clipping disabled, an ideal loopback gives **exactly zero** EVM, and reported and measured
SNR agree to within about 1 dB (20.9 dB against 21.9 dB on a real desk channel). That agreement
is the signal that the model and the demodulator are both honest.

### The cyclic prefix must clear the first reflection

Room impulse responses are derived from real 19 kHz behaviour: 0.8 dB/m air absorption,
spherical spreading, ~6 dB per surface bounce. High frequencies decay far faster than
broadband intuition suggests, so long echoes are weak — but the *first* one is not. It arrives
3–5 ms after the direct path. A 2.7 ms prefix produced an error floor no transmit power could
fix; 5.3 ms removed it. No band plan goes below that.

### The SNR gap has to be honest

Bit loading uses the classic gap approximation, `b = log2(1 + SNR/Γ)`. The textbook uncoded gap
is ~9.2 dB. An early value of 6.5 dB assumed Reed-Solomon would contribute ~5 dB of coding
gain; hard-decision RS gives 2–3 dB, and the rest must cover channel-estimation error from only
two training symbols, residual timing and phase error, and clipping. Measured end to end:

| Gap | bits/symbol | bursts decoded |
|---|---|---|
| 6.5 dB | 1884 | 0 / 6 |
| 8 dB | 1639 | 0 / 6 |
| **10 dB** | 1323 | **6 / 6** |
| 12 dB | 1023 | 6 / 6 |
| 18 dB | 429 | 6 / 6 |

Nothing below 10 dB decoded; everything at or above it decoded every time. The shipped value is
11 dB.

## 3. Structure

### Bursts carry independent slots

A burst is `[chirp preamble][guard][training ×2][data symbols][tail]`. The preamble sweeps only
the plan's own band, so a burst on the silent plan stays inaudible end to end. Two identical
training symbols give `H(f)` and the per-carrier noise floor in one operation, so channel
estimation and channel sounding are the same thing.

The payload is **not** one monolithic block. Each burst carries several independent
Reed-Solomon codewords ("slots"), each decoded separately. This matters more than it sounds: a
wideband burst holds ~14 codewords, and an all-or-nothing frame turns a 20% codeword failure
rate into a 96% burst failure rate. With independent slots, a lost slot is one lost fountain
packet and the transfer barely notices. Slots are still interleaved against each other so a
burst of consecutive channel errors is spread one byte per codeword.

### Fountain coding

`LT` codes with a robust soliton distribution, systematic so the first K symbols are the source
blocks themselves — a clean channel therefore decodes at exactly 1.000× overhead and the
fountain only earns its keep when packets actually go missing. Parameters `c=0.05, δ=0.01` were
chosen by sweeping reception overhead at K=384 across 0–50% loss; they give 1.30× at 25% loss
against 1.39× for the textbook values.

Measured recovery:

| Packet loss | Decoded | Mean overhead |
|---|---|---|
| 0% | 25/25 | 1.000× |
| 30% | 25/25 | 1.369× |
| 50% | 25/25 | 1.321× |
| 85% | 25/25 | 1.243× |

Files are split into chunks of at most 384 blocks. Peeling cost grows with K, a single fountain
over 10 MB would mean ~10k blocks and all-or-nothing progress, and chunking lets the receiver
acknowledge and retire finished chunks.

### Both ends must derive the same bit-loading table

This is the subtlest correctness requirement in the protocol. The receiver measures the
wideband channel, condenses it to 32 coarse SNR values, and reports them. The sender picks a
band and allocates bits **from that report**. The receiver then re-derives the identical table
from the numbers it sent and the gap the sender echoed back — it never measures independently.
If the two tables disagreed by a single carrier, the receiver would be unpacking a different
number of bits per subcarrier and would decode nothing at all.

### The handshake needed its own protection

The fountain code makes payload loss a non-event, and that produced a blind spot: the
handshake had no equivalent protection, so a transfer that could survive losing a quarter of
its *data* could still be killed by losing one *setup* burst. Three separate single points of
failure, all found by running a transfer with 25% of bursts destroyed in flight:

- **A lost sounding burst produced a confidently wrong answer.** The receiver, having nothing
  to measure, replied with a fabricated flat estimate. The sender built a plan on it, the plan
  turned out to carry zero bits, and the transfer aborted. Silence is strictly better than a
  fabricated measurement here: it makes the sender repeat the sounding, which is the recovery
  we want. The receiver now says nothing rather than something false.
- **The probe was mistakable for ordinary traffic.** The sounding swept upward across
  0.8–20 kHz, and every ordinary burst sweeps upward inside that range, so when the real
  sounding went missing the matched filter locked onto a control burst instead and estimated
  the channel at entirely the wrong offset — producing a measurement that looked valid and was
  meaningless. The sounding now sweeps *downward*. An up-chirp and a down-chirp over the same
  band are near-orthogonal; measured discrimination is a factor of roughly 750,000
  (correlation ratio 5.7e7 against its own reference, 22 against the opposite one). A
  plausibility check on the resulting SNR catches whatever slips through.
- **A report was treated as a usable report.** The sender retried only until *an* answer
  arrived, not until a *workable plan* existed. Retrying the whole handshake — announce, sound,
  report, allocate — and rejecting any plan without capacity closes it.
- **The plan and header were sent exactly once.** Losing that one burst left the receiver deaf
  while the sender streamed a payload it could not interpret. They now repeat until the
  receiver acknowledges. The subtlety is what counts as proof of receipt: a receiver still
  waiting for a plan keeps re-sending its channel report, so treating *any* reply as
  confirmation would stop the retransmissions exactly when they were needed. Only an
  acknowledgement, which a receiver can only produce once it has the header, is proof.

The general shape of the mistake: robustness had been designed into the part of the system
carrying the most bytes, and the parts carrying the fewest — the ones every subsequent byte
depends on — were left unprotected.

### Turn-taking

The link is half duplex. Control traffic — handshake, plan, acknowledgements — always rides the
Silent band with BPSK on every carrier, the slowest and most robust configuration, and is
inaudible. Only bulk payload moves to a faster and possibly audible band. Control bursts are
sized by whole codewords rather than by duration: BPSK on the narrow control band fits only
~197 bytes in 0.9 s, short of the 255 a single codeword needs.

## 4. Ear safety

- Transmit power is weighted by Terhardt's absolute threshold of hearing, pushing energy toward
  frequencies where the ear is dull and away from the 3–4 kHz sensitivity peak.
- Peaks are controlled per OFDM symbol by clip-and-filter, applied to the symbol body before
  the cyclic prefix is taken so the prefix stays an exact copy of the tail. Target crest 4.0 was
  measured as costing no usable in-band SNR, where 2.8 capped it at ~30 dB.
- Every burst is edge-tapered, and the ramp lands in a silent tail rather than inside a data
  symbol.
- The quietest band that meets the user's deadline always wins.

## 5. Known limits and things not done

- **Throughput is capped by physics.** Measured goodput, including coding overhead:

  | | Silent | Discreet | Audible | Full |
  |---|---|---|---|---|
  | Desk, 0.3 m, quiet | 297 B/s | 785 B/s | 2823 B/s | 3284 B/s |
  | Office, 1.5 m | 206 B/s | 639 B/s | 1627 B/s | 1701 B/s |
  | Living room, 3 m | 85 B/s | 403 B/s | 1041 B/s | 1099 B/s |
  | Hall, 5 m, noisy | 34 B/s | 226 B/s | 546 B/s | 574 B/s |

  That puts 10 MB at about an hour at close range on the full band and two hours across a desk.
  No amount of coding changes the order of magnitude — the band is 20 kHz wide and that is that.

- **Acknowledgement rounds are surprisingly expensive.** A control burst plus a listen costs
  ~3.8 s against 1.36 s for a data burst, because control always runs BPSK on the narrow silent
  band. Acknowledging every 8 bursts added ~35% overhead; large transfers now acknowledge every
  24. Moving acknowledgements onto the negotiated data band would recover most of the rest, at
  the cost of making the back-channel audible whenever the forward channel is.
- **No encryption yet.** Sound is a broadcast medium and anyone in the room can record it. The
  intended design is X25519 key agreement with a four-digit short-authentication-string shown
  on both screens, and AES-256-GCM payloads; the packet format reserves room for it but it is
  not implemented.
- **Bluetooth audio cannot work.** Codecs discard this spectrum entirely.
- **A rate-compatible inner code would help.** Reed-Solomon is hard-decision only; a soft-decision
  convolutional or LDPC inner code would buy several dB and allow denser constellations at the
  same reliability.
- **RaptorQ instead of plain LT** would cut fountain overhead from ~1.3× to ~1.02× under loss.
