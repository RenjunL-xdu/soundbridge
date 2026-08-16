// Iterative radix-2 FFT, in-place, on separate real/imag Float64Arrays.
// Kept dependency-free so the same file runs in the browser, in an AudioWorklet,
// and in the Node test harness.

/** @param {Float64Array} re @param {Float64Array} im */
export function fft(re, im, inverse = false) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error(`fft: length ${n} is not a power of two`);

  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + half], bi = im[i + k + half];
        const vr = br * cr - bi * ci;
        const vi = br * ci + bi * cr;
        re[i + k] = ar + vr; im[i + k] = ai + vi;
        re[i + k + half] = ar - vr; im[i + k + half] = ai - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

/**
 * Real-valued IFFT via Hermitian symmetry. Caller fills bins 1..N/2-1;
 * this mirrors them into N/2+1..N-1 so the time-domain result is real.
 */
export function irfft(re, im, out) {
  const n = re.length;
  for (let k = 1; k < n / 2; k++) {
    re[n - k] = re[k];
    im[n - k] = -im[k];
  }
  im[0] = 0;
  im[n / 2] = 0;
  fft(re, im, true);
  if (out) { for (let i = 0; i < n; i++) out[i] = re[i]; return out; }
  return re;
}

/** Fast cross-correlation of `sig` against `ref` via FFT. Returns correlation magnitude. */
export function xcorrMag(sig, ref, fftSize) {
  const n = fftSize;
  const sr = new Float64Array(n), si = new Float64Array(n);
  const rr = new Float64Array(n), ri = new Float64Array(n);
  for (let i = 0; i < Math.min(sig.length, n); i++) sr[i] = sig[i];
  for (let i = 0; i < Math.min(ref.length, n); i++) rr[i] = ref[i];
  fft(sr, si); fft(rr, ri);
  // multiply by conjugate of ref
  for (let i = 0; i < n; i++) {
    const a = sr[i], b = si[i], c = rr[i], d = -ri[i];
    sr[i] = a * c - b * d;
    si[i] = a * d + b * c;
  }
  fft(sr, si, true);
  const mag = new Float64Array(n);
  for (let i = 0; i < n; i++) mag[i] = Math.hypot(sr[i], si[i]);
  return mag;
}

export function nextPow2(x) {
  let p = 1;
  while (p < x) p <<= 1;
  return p;
}
