// A shared simulated acoustic medium for headless session tests.
//
// Whatever one endpoint plays lands in the other's inbox after passing through
// the room model. The subtlety is when `listen` should return: a microphone
// records continuously for the whole window, so a listen must collect
// *everything* the peer transmits during its turn. Returning on the first packet
// splits a multi-burst turn across two windows, which broke the handshake
// because the receiver saw the announcement but never the channel sounding that
// followed it.
//
// The link is strictly half duplex and turn-based, so "the peer has stopped
// transmitting and started listening" is the exact handoff signal.

import { through } from './channel.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class Air {
  constructor(chanOpts, { fs = 48000, deadlockMs = 20000, dropRate = 0 } = {}) {
    this.chanOpts = chanOpts;
    this.fs = fs;
    this.deadlockMs = deadlockMs;
    this.dropRate = dropRate;
    this.a = { inbox: [], listening: false, sends: 0, samples: 0 };
    this.b = { inbox: [], listening: false, sends: 0, samples: 0 };
  }

  endpoint(which) {
    const me = which === 'a' ? this.a : this.b;
    const peer = which === 'a' ? this.b : this.a;
    const air = this;

    return {
      async send(samples) {
        me.sends++;
        me.samples += samples.length;
        if (air.dropRate > 0 && Math.random() < air.dropRate) {
          // burst annihilated in flight: someone talked over it
          await sleep(0);
          return;
        }
        const { samples: out } = through(samples, air.fs, {
          ...air.chanOpts, padStart: 1200, padEnd: 1200,
        });
        peer.inbox.push(out);
        await sleep(0);
      },

      async listen(seconds) {
        me.listening = true;
        const deadline = Date.now() + air.deadlockMs;
        let bothIdleSince = null;

        // Both endpoints being flagged as listening is the ordinary transient
        // during a handoff, not a deadlock: one side raises its flag a moment
        // before the other lowers it. Treating that instant as a deadlock made
        // every listen return empty and the handshake never completed. A real
        // deadlock is both sides idle *and* nothing in flight for a sustained
        // interval.
        while (Date.now() < deadline) {
          if (me.inbox.length > 0) {
            if (peer.listening) break;          // peer finished its turn
            bothIdleSince = null;
          } else if (peer.listening) {
            if (bothIdleSince === null) bothIdleSince = Date.now();
            else if (Date.now() - bothIdleSince > 200) break;
          } else {
            bothIdleSince = null;
          }
          await sleep(2);
        }
        me.listening = false;

        if (me.inbox.length === 0) return new Float64Array(Math.round(seconds * air.fs));
        const parts = me.inbox.splice(0, me.inbox.length);
        let total = 0;
        for (const p of parts) total += p.length;
        const out = new Float64Array(total);
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
      },
    };
  }

  get airtimeSec() { return (this.a.samples + this.b.samples) / this.fs; }
  get sends() { return this.a.sends + this.b.sends; }
}
