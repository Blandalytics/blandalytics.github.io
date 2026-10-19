// Team colors for the Game Sim's Who wins card (game.js). No imports, so tools/lineup_sims/test_game.mjs
// checks every pairing.
//
// Each club's primary and secondary color. On the page's dark card a color is lightened (hue and
// saturation kept) until it reads as text there, at 4.5:1. The away team takes its primary; the home
// team its primary unless that looks like the away team's (CIEDE2000 ΔE under MIN_DE: two navy clubs
// both lighten to a bright blue), then its secondary. MLB (the league-average lineup) takes the page's
// own color for its side, through the same lightening.

export const TEAM_HEX = {
  ATH: ["#003831", "#efb21e"], ATL: ["#ce1141", "#13274f"], AZ: ["#a71930", "#e3d4ad"], BAL: ["#df4601", "#000000"],
  BOS: ["#bd3039", "#0c2340"], CHC: ["#0e3386", "#cc3433"], CIN: ["#c6011f", "#000000"], CLE: ["#00385d", "#e50022"],
  COL: ["#33006f", "#c4ced4"], CWS: ["#27251f", "#c4ced4"], DET: ["#0c2340", "#fa4616"], HOU: ["#002d62", "#eb6e1f"],
  KC: ["#004687", "#bd9b60"], LAA: ["#ba0021", "#003263"], LAD: ["#005a9c", "#ef3e42"], MIA: ["#00a3e0", "#ef3340"],
  MIL: ["#12284b", "#ffc52f"], MIN: ["#002b5c", "#d31145"], NYM: ["#002d72", "#ff5910"], NYY: ["#003087", "#c4ced3"],
  PHI: ["#e81828", "#002d72"], PIT: ["#fdb827", "#27251f"], SD: ["#2f241d", "#ffc425"], SEA: ["#0c2c56", "#005c5c"],
  SF: ["#fd5a1e", "#27251f"], STL: ["#c41e3a", "#0c2340"], TB: ["#092c5c", "#8fbce6"], TEX: ["#003278", "#c0111f"],
  TOR: ["#134a8e", "#e8291c"], WSH: ["#ab0003", "#14225a"],
};
export const MIN_CONTRAST = 4.5, MIN_DE = 15;

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (h) => {
  const [r, g, b] = rgb(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const lab = (h) => {
  const [r, g, b] = rgb(h).map(lin);
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * b),
    z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};
// how different two colors look (CIEDE2000 ΔE; plain Lab distance overrates saturated blues and reds)
export function deltaE(c1, c2) {
  const [L1, a1, b1] = lab(c1), [L2, a2, b2] = lab(c2), rad = Math.PI / 180;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2, G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const A1 = (1 + G) * a1, A2 = (1 + G) * a2, C1 = Math.hypot(A1, b1), C2 = Math.hypot(A2, b2);
  const hue = (b, a) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1 = hue(b1, A1), h2 = hue(b2, A2);
  let dh = h2 - h1;
  if (C1 * C2 === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dL = L2 - L1, dC = C2 - C1, dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh / 2) * rad);
  const Lb = (L1 + L2) / 2, Cb2 = (C1 + C2) / 2;
  let hb = h1 + h2;
  if (C1 * C2 !== 0) hb = Math.abs(h1 - h2) > 180 ? (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2 : (h1 + h2) / 2;
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2), SC = 1 + 0.045 * Cb2, SH = 1 + 0.015 * Cb2 * T;
  const RT = -2 * Math.sqrt(Cb2 ** 7 / (Cb2 ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}
const toHsl = (h) => {
  const [r, g, b] = rgb(h).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(hue * 60 + 360) % 360, d / (1 - Math.abs(2 * l - 1)), l];
};
const fromHsl = (h, s, l) => {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const v = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + v.map((u) => Math.round((u + m) * 255).toString(16).padStart(2, "0")).join("");
};
// the color, lightened as little as reads at MIN_CONTRAST on `on`
export function readable(hex, on) {
  const [h, s, l0] = toHsl(hex);
  for (let l = l0; l < 1; l += 0.005) {
    const c = fromHsl(h, s, l);
    if (contrast(c, on) >= MIN_CONTRAST) return c;
  }
  return "#ffffff";
}

// The two sides' colors on `on`: [away, home]. teams: the two team abbreviations; fallback: the page's
// own [away, home] pair, for MLB and for a matchup no team colors tell apart.
export function teamColors(teams, on, fallback) {
  const page = fallback.map((h) => readable(h, on));
  const choices = teams.map((t, i) => (TEAM_HEX[t] ?? [fallback[i]]).map((h) => readable(h, on)));
  for (const a of choices[0]) {
    const h = choices[1].find((x) => deltaE(a, x) >= MIN_DE);
    if (h) return [a, h];
  }
  return page;
}
