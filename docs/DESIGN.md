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

### Clock drift, not noise, is the dominant impairment

Raw BER at 25 dB SNR, office acoustics, sweeping only the crystal mismatch:

| Modulation | 0 ppm | 5 ppm | 20 ppm | 50 ppm | 100 ppm |
|---|---|---|---|---|---|
| DBPSK N=2048 CP=512 | 0 | 0 | 0 | 1.7e−4 | 4.1e−2 |
| DQPSK N=1024 CP=256 | 0 | 0 | 0 | 8.3e−4 | 5.2e−2 |
| D8PSK N=1024 CP=256 | 0 | 0 | 4.7e−4 | 4.4e−2 | 2.0e−1 |

Every scheme is perfect with matched clocks. Drift accumulates as a phase ramp across
subcarriers, and the denser the constellation the less margin there is to absorb it — D8PSK's
decision boundary is π/8 and drift eats nearly half of it. Hence pilot-derived timing-slope
correction in `demodulateSymbol`, without which nothing above QPSK is usable.

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

- **Throughput is capped by physics.** ~2.5 kB/s on the fastest band in an office. 10 MB is
  tens of minutes. No amount of coding changes the order of magnitude.
- **No encryption yet.** Sound is a broadcast medium and anyone in the room can record it. The
  intended design is X25519 key agreement with a four-digit short-authentication-string shown
  on both screens, and AES-256-GCM payloads; the packet format reserves room for it but it is
  not implemented.
- **Bluetooth audio cannot work.** Codecs discard this spectrum entirely.
- **A rate-compatible inner code would help.** Reed-Solomon is hard-decision only; a soft-decision
  convolutional or LDPC inner code would buy several dB and allow denser constellations at the
  same reliability.
- **RaptorQ instead of plain LT** would cut fountain overhead from ~1.3× to ~1.02× under loss.
