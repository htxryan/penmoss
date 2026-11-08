/**
 * A deterministic synthetic vault for search benchmarks (T22): `count` notes
 * of pseudo-English, word frequencies following Zipf's law like real prose,
 * with titles, headings, tags and update times. Same seed, same vault.
 */
export interface SyntheticNote {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly headings: string;
  readonly tags: readonly string[];
  readonly updatedAt: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES =
  'ba be bi bo bu ka ke ki ko ku la le li lo lu ma me mi mo mu na ne ni no nu ra re ri ro ru sa se si so su ta te ti to tu va ve vi vo vu'.split(
    ' ',
  );

/** `size` distinct pseudo-words; the first ones are the most frequent. */
export function vocabulary(size: number, random: () => number): string[] {
  const words = new Set<string>();
  while (words.size < size) {
    const length = 1 + Math.floor(random() * 3) + (words.size > 200 ? 1 : 0);
    let word = '';
    for (let i = 0; i < length; i++) word += SYLLABLES[Math.floor(random() * SYLLABLES.length)];
    words.add(word);
  }
  return [...words];
}

/** A Zipf(s = 1) sampler over ranks 0..n-1. */
function zipf(n: number, random: () => number): () => number {
  const cumulative = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += 1 / (i + 1);
    cumulative[i] = total;
  }
  return () => {
    const target = random() * total;
    let low = 0;
    let high = n - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cumulative[mid]! < target) low = mid + 1;
      else high = mid;
    }
    return low;
  };
}

export function syntheticVault(count: number, seed = 22): SyntheticNote[] {
  const random = mulberry32(seed);
  const words = vocabulary(12_000, random);
  const pick = zipf(words.length, random);
  const sentence = (length: number) => Array.from({ length }, () => words[pick()]!).join(' ');
  const tags = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? `area/t${i}` : `t${i}`));
  const notes: SyntheticNote[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < count; i++) {
    const paragraphs = 2 + Math.floor(random() * 8);
    const lines: string[] = [];
    const headings: string[] = [];
    for (let p = 0; p < paragraphs; p++) {
      if (p > 0 && random() < 0.35) {
        const heading = sentence(2 + Math.floor(random() * 3));
        headings.push(heading);
        lines.push(heading);
      }
      lines.push(`${sentence(20 + Math.floor(random() * 50))}.`);
    }
    notes.push({
      id: `N${String(i).padStart(25, '0')}`,
      title: sentence(2 + Math.floor(random() * 4)),
      body: lines.join('\n'),
      headings: headings.join('\n'),
      tags: Array.from(
        new Set(
          Array.from(
            { length: Math.floor(random() * 3) },
            () => tags[Math.floor(random() * tags.length)]!,
          ),
        ),
      ).sort(),
      updatedAt: start + Math.floor(random() * 1000 * 86_400_000),
    });
  }
  return notes;
}
