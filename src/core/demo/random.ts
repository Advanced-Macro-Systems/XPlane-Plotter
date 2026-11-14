// Seeded random numbers for the demo flight: the same seed gives the same log, byte for byte.

/** A uniform deviate in [0, 1). */
export type Rng = () => number

/**
 * Mixes a user seed and a stream number into a 32-bit state, so each noise source (turbulence, pilot, sensors, frame
 * timing) has its own independent sequence. Any finite number is a valid seed; its fractional part counts too.
 */
export function streamSeed(seed: number, stream: number): number {
  const whole = Math.floor(seed)
  let h = (whole >>> 0) ^ Math.imul((Math.floor(whole / 4294967296) >>> 0) ^ 0x632be5ab, 0x9e3779b9)
  h ^= Math.floor((seed - whole) * 4294967296) >>> 0
  h ^= Math.imul(stream + 1, 0x85ebca6b)
  // murmur3 finaliser: small changes of the seed scatter over the whole state
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/** mulberry32: a small, fast PRNG built from 32-bit integer operations only. */
export function createRng(state: number): Rng {
  let s = state >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let r = Math.imul(s ^ (s >>> 15), 1 | s)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/** Standard normal deviates (Box–Muller, both values of each pair used). */
export function createGaussian(rng: Rng): () => number {
  let spare = 0
  let hasSpare = false
  return () => {
    if (hasSpare) {
      hasSpare = false
      return spare
    }
    let u = rng()
    while (u < 1e-300) u = rng()
    const radius = Math.sqrt(-2 * Math.log(u))
    const angle = 2 * Math.PI * rng()
    spare = radius * Math.sin(angle)
    hasSpare = true
    return radius * Math.cos(angle)
  }
}

/**
 * First-order Gauss–Markov process: exponentially correlated noise with standard deviation `sigma` and correlation
 * time `tauS`. The discrete update is exact for any step, so the statistics do not depend on the sample rate.
 */
export function createMarkov(gauss: () => number, sigma: number, tauS: number): (dt: number) => number {
  let value = sigma * gauss()
  return (dt) => {
    const decay = Math.exp(-dt / tauS)
    value = decay * value + sigma * Math.sqrt(1 - decay * decay) * gauss()
    return value
  }
}
