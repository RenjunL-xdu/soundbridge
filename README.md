# Sonar Transfer

Send files between two devices using **sound alone**. No network, no Bluetooth, no pairing,
no accounts. A phone and a laptop in the same room can move a file between them with nothing
but a speaker and a microphone.

Runs entirely in the browser as a static page, so GitHub Pages is enough to host it.

---

## What this actually is

Data is carried on hundreds of simultaneous audio tones — the same idea a dial-up modem or
Wi-Fi uses — played through a speaker and decoded from a microphone. The two devices talk to
each other first: they measure the room, agree which frequencies work, and pick the quietest
band that is still fast enough for the file.

Four bands, from silent to fast:

| Band | Range | Sounds like | Typical speed |
|---|---|---|---|
| **Silent** | 17.5–20 kHz | Nothing, to essentially all adults | ~250 B/s |
| **Discreet** | 14–20 kHz | Nothing to most adults; children may hear it | ~750 B/s |
| **Audible** | 4–20 kHz | A soft hiss | ~2 kB/s |
| **Full** | 0.4–20 kHz | A dial-up modem | ~2.5 kB/s |

Speeds are measured against a simulated office at 1.5 m with realistic noise; close range and
a quiet room do considerably better.

## Honest limits

Read this part before expecting too much.

- **Bandwidth is the hard ceiling.** Usable audio spectrum is about 20 kHz, and only a sliver
  of it is inaudible. Shannon caps a 2.5 kHz channel near 10 kbps even at generous SNR. Better
  codes buy a factor, not an order of magnitude.
- **Small files are the sweet spot.** Keys, configs, URLs, contact cards, text and documents
  move in seconds. A 10 MB file is realistically tens of minutes on the fastest band. The app
  estimates the time before starting and tells you.
- **Compressible files go much faster** — gzip runs before transmission.
- **Bluetooth speakers and headsets will not work at all.** SBC, AAC and Opus discard exactly
  this part of the spectrum. Use built-in speakers and microphones.
- **"Inaudible" is statistical, not physical.** Plenty of children and teenagers hear 17.5–18 kHz
  clearly. Dogs and cats hear all of it.

## Getting started

Open the page on both devices, put them within about a metre with the speaker facing the
microphone, then press **Receive** on one and **Send** on the other.

Run the **device check** first on any new pair of devices. Speaker and microphone response
above 17 kHz varies enormously, and the check measures what yours can actually do.

Serving locally needs any static server (the microphone requires a secure context, which
`localhost` counts as):

```bash
python -m http.server 8000
```

## How it works

```
  file
   ├─ gzip
   ├─ split into chunks, each fountain-coded          fec/fountain.js
   ├─ packets → Reed-Solomon slots, interleaved       fec/reedsolomon.js
   ├─ bits → adaptive QAM across ~700 subcarriers     dsp/qam.js, dsp/ofdm.js
   ├─ OFDM symbols + pilots + cyclic prefix           dsp/ofdm.js
   ├─ chirp preamble prepended                        dsp/chirp.js
   └─ psychoacoustic shaping + peak control           dsp/psycho.js
                             ↓  speaker → room → microphone  ↓
   ├─ matched filter finds every preamble             dsp/chirp.js
   ├─ training symbols give H(f) and the noise floor  dsp/ofdm.js
   ├─ pilots track clock drift and phase              dsp/ofdm.js
   ├─ slots decoded independently; losses are fine    fec/reedsolomon.js
   └─ fountain decoder needs any K(1+ε) packets       fec/fountain.js
```

### Three decisions worth explaining

**Fountain coding, not retransmission.** The sender emits an endless stream of distinct
combinations of the source blocks; the receiver needs *any* sufficient number of them, not any
particular ones. Someone talking, a door slamming or a phone being nudged makes the transfer
slightly longer instead of breaking it, and no retransmission back-channel is needed. Measured
recovery holds up to **85% packet loss**.

**Clock drift is tracked, not feared.** Two devices have independent crystals, mismatched by up
to 50 ppm, which appears as a phase ramp across subcarriers. Pilots measure that ramp every
symbol and rotate it out. With that in place the silent band rides out 100 ppm at QPSK without
a single bit error; 16-QAM starts to degrade around 50 ppm.

*(An earlier version of these notes called drift the dominant impairment. That was mostly a
simulator artefact — sample-rate offset was modelled with linear interpolation, which is 5 dB
down at 19 kHz. Switching to windowed-sinc resampling recovered 13 dB. See
[docs/DESIGN.md](docs/DESIGN.md).)*

**The cyclic prefix must clear the first reflection.** The first strong echo in a normal room
arrives 3–5 ms after the direct path. A 2.7 ms prefix leaves an error floor that no amount of
transmit power fixes; nothing here goes below 5.3 ms.

### On your ears

Transmit power is shaped by the ear's own sensitivity curve, which peaks sharply around
3–4 kHz, pushing energy toward frequencies the ear treats as dull. Peaks are controlled by
clip-and-filter so the speaker never clips into a harsh buzz, every burst is ramped rather
than switched on, and the app defaults to the quietest band that meets your deadline. Keep
the volume moderate anyway.

## Tests

The whole signal path is verified against a simulated acoustic channel — room reverb derived
from real 19 kHz absorption, a realistic ambient-noise spectrum, speaker and microphone
response, and sample-clock drift. No audio hardware is involved, so it all runs in CI.

```bash
node test/rs.test.mjs        # Reed-Solomon: corrects 16 byte errors, fails cleanly beyond
node test/fountain.test.mjs  # fountain: recovery up to 85% packet loss
node test/burst.test.mjs     # modem: sounding, bit loading, burst round trip per band
node test/transfer.test.mjs  # full file transfers between two sessions (slow)
```

## Layout

```
index.html          send / receive
calibrate.html      device check — measures your speaker and microphone
src/dsp/            fft, chirp sync, QAM, OFDM, psychoacoustics, bit loading
src/fec/            CRC, Reed-Solomon, fountain code
src/proto/          band plans, packets, bursts, session state machines
src/audio/          Web Audio capture and playback
src/ui/             interface
test/               channel simulator and test suites
```

## Licence

MIT
