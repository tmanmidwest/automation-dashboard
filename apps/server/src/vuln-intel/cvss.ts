/**
 * CVSS v3.0 / v3.1 base score from a vector string (the FIRST spec's formula), for
 * advisories that ship a vector but no number. v2 / v4 vectors return null.
 */

const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<string, number> = { L: 0.77, H: 0.44 };
const PR_U: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_C: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

/** CVSS 3.1 "Roundup": smallest number with one decimal that is >= x, free of float error. */
function roundUp(x: number): number {
  const i = Math.round(x * 100_000);
  return i % 10_000 === 0 ? i / 100_000 : (Math.floor(i / 10_000) + 1) / 10;
}

export function cvss3BaseScore(vector: string): number | null {
  const m = /^CVSS:3\.[01]\/(.+)$/.exec(vector.trim());
  if (!m) return null;
  const v: Record<string, string> = {};
  for (const part of m[1].split('/')) {
    const [k, val] = part.split(':');
    if (k && val) v[k] = val;
  }
  const scope = v.S;
  const av = AV[v.AV], ac = AC[v.AC], ui = UI[v.UI];
  const pr = scope === 'C' ? PR_C[v.PR] : PR_U[v.PR];
  const c = CIA[v.C], i = CIA[v.I], a = CIA[v.A];
  if ([av, ac, ui, pr, c, i, a].some((x) => x === undefined) || (scope !== 'U' && scope !== 'C')) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = scope === 'U' ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  if (impact <= 0) return 0;
  const expl = 8.22 * av * ac * pr * ui;
  return scope === 'U' ? roundUp(Math.min(impact + expl, 10)) : roundUp(Math.min(1.08 * (impact + expl), 10));
}
