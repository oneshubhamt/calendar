export function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function seededInt(random, min, max) {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new RangeError("Invalid seeded integer bounds");
  return min + Math.floor(random() * (max - min + 1));
}

export function seededShuffle(values, random) {
  const out = [...values];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = seededInt(random, 0, index);
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}
