// AI Teacher: arithmetic that is computed, never trusted to a model.
// LCM / HCF worked steps in prime-factor notation, fresh practice pairs that
// never repeat an example the student already had, checks of any "LCM of a
// and b is c" claim in generated text, and spoken-number parsing.

function primeFactors(n) {
  const f = {};
  let x = n;
  for (let p = 2; p * p <= x; p += 1) while (x % p === 0) { f[p] = (f[p] || 0) + 1; x /= p; }
  if (x > 1) f[x] = (f[x] || 0) + 1;
  return f;
}

const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const pow = (p, e) => (e === 1 ? `${p}` : `${p}${String(e).split('').map((d) => SUP[d]).join('')}`);
const factorString = (f) => Object.keys(f).map(Number).sort((a, b) => a - b).map((p) => pow(p, f[p])).join(' × ');

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const hcf = (a, b) => gcd(a, b);
const lcm = (a, b) => (a / gcd(a, b)) * b;

// "12 = 2² × 3", "18 = 2 × 3²", "LCM = 2² × 3² = 36"
function steps(kind, a, b) {
  const fa = primeFactors(a); const fb = primeFactors(b);
  const primes = [...new Set([...Object.keys(fa), ...Object.keys(fb)].map(Number))].sort((x, y) => x - y);
  const pick = {};
  for (const p of primes) {
    const e = kind === 'lcm' ? Math.max(fa[p] || 0, fb[p] || 0) : Math.min(fa[p] || 0, fb[p] || 0);
    if (e > 0) pick[p] = e;
  }
  const value = kind === 'lcm' ? lcm(a, b) : hcf(a, b);
  const name = kind === 'lcm' ? 'LCM' : 'HCF';
  const last = Object.keys(pick).length ? `${name} = ${factorString(pick)} = ${value}` : `${name} = 1 (no common prime factor)`;
  return { lines: [`${a} = ${factorString(fa)}`, `${b} = ${factorString(fb)}`, last], value,
    rule: kind === 'lcm' ? 'Take every prime factor with its highest power.' : 'Take only the common prime factors with their lowest power.' };
}

// Fresh pair for a level (1 basic, 2 standard, 3 challenge) not in `seen` ("lcm:8,12").
function freshPair(kind, seen = new Set(), level = 2, rand = Math.random) {
  const ranges = { 1: [2, 12, 60], 2: [4, 30, 180], 3: [8, 60, 420] };
  const [lo, hi, maxV] = ranges[level] || ranges[2];
  const pairs = [];
  for (let a = lo; a <= hi; a += 1) {
    for (let b = a + 1; b <= hi; b += 1) {
      if (b % a === 0) continue; // trivial: the larger is already the answer
      const v = kind === 'lcm' ? lcm(a, b) : hcf(a, b);
      // LCM pairs share a factor, so the answer isn't just the product.
      if (kind === 'lcm' && (v > maxV || gcd(a, b) === 1)) continue;
      if (kind === 'hcf' && v === 1) continue;
      if (seen.has(`${kind}:${a},${b}`)) continue;
      pairs.push([a, b]);
    }
  }
  if (!pairs.length) return null;
  const [a, b] = pairs[Math.floor(rand() * pairs.length)];
  return { a, b, kind, exampleKey: `${kind}:${a},${b}`, answer: kind === 'lcm' ? lcm(a, b) : hcf(a, b) };
}

// Every "LCM/HCF of a and b is/= c" in a text, checked. Wrong ones are listed.
function wrongClaims(text) {
  const out = [];
  const re = /\b(LCM|HCF|GCD)\s*(?:\(|of\s+)\s*(\d{1,5})\s*(?:,|and)\s*(\d{1,5})\s*\)?\s*(?:is|=|will be|comes to)\s*(\d{1,6})/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const kind = m[1].toLowerCase() === 'lcm' ? 'lcm' : 'hcf';
    const [a, b, c] = [Number(m[2]), Number(m[3]), Number(m[4])];
    const right = kind === 'lcm' ? lcm(a, b) : hcf(a, b);
    if (right !== c) out.push({ claim: m[0], right });
  }
  return out;
}

// ── Spoken numbers ("thirty six", "36", "one hundred and twenty") ────────
const ONES = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const HI = { 'शून्य': 0, 'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पाँच': 5, 'पांच': 5, 'छह': 6, 'छः': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10, 'बारह': 12, 'बीस': 20, 'चौबीस': 24, 'तीस': 30, 'छत्तीस': 36 };

function parseSpokenNumber(text) {
  const t = String(text || '').toLowerCase().replace(/(\d),(\d{3})/g, '$1$2');
  const digits = t.match(/-?\d+(?:\.\d+)?/g);
  if (digits && digits.length) return Number(digits[digits.length - 1]);
  // Longest Hindi number word first ("चौबीस" contains "बीस").
  const hi = Object.keys(HI).sort((x, y) => y.length - x.length).find((w) => t.includes(w));
  let total = 0; let current = 0; let seen = false;
  for (const w of t.replace(/-/g, ' ').split(/[^a-z]+/)) {
    if (w in ONES) { current += ONES[w]; seen = true; } else if (w in TENS) { current += TENS[w]; seen = true; } else if (w === 'hundred') { current = (current || 1) * 100; seen = true; } else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; seen = true; }
  }
  if (seen) return total + current;
  return hi ? HI[hi] : null;
}

module.exports = { primeFactors, factorString, gcd, hcf, lcm, steps, freshPair, wrongClaims, parseSpokenNumber };
