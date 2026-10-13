"""The player pool of a draft: the calculator's table (table.js) joined to the outcome draws (R1).

    pool = Pool(table, league, risk={"h": bytes, "p": bytes})

The table gives each player's $ value, SGP above replacement, Yahoo eligibility, the slot calc.js
values him at, whether he is in the calculator's drafted pool, and his projected counts.  The risk
files (projections repository, src/valuation/risk_draws.py) give 50 stratified real draws of each
player's season counts.  A player without draws gets his projection as his only outcome.

Per player and draw the pool holds the league's *components* (league.COMPONENTS) with the
playing-time fill applied as calc.js applies it: what a player does not play, up to his role's target
(calc.js fillTargets), is filled with the role's replacement production per PA or IP.  The
replacement production is the PA- or IP-weighted mean of the projections of the players ranked a
tier (teams) either side of the role's drafted cutoff by $ value (calc.js fillSpecOf ranks by its
bare SGP; DESIGN.md section 5).
"""

import json
import struct

import numpy as np

from league import COMPONENTS

MAGIC = b"RSK1"
STAT_ALIAS = {"HD": "HLD", "TBF": "BF"}


def decode(buf):
    """(header, mlbam, {stat: [players, draws] float}) of a risk file; IP back in innings.
    A numpy-only port of src.valuation.risk_draws.decode."""
    buf = bytes(buf)
    if buf[:4] != MAGIC:
        raise ValueError("not a risk file")
    (h,) = struct.unpack("<I", buf[4:8])
    head = json.loads(buf[8 : 8 + h].decode("utf-8"))
    p, n, s = head["players"], head["draws"], len(head["stats"])
    o = 8 + h
    mlbam = np.frombuffer(buf, "<i4", p, o).astype(np.int64)
    arr = np.frombuffer(buf, "<u2", s * p * n, o + 4 * p).reshape(s, p, n).astype(float)
    x = {k: arr[i] / 3 if (k == "IP" and head.get("ip_in_outs")) else arr[i] for i, k in enumerate(head["stats"])}
    return head, mlbam, x


def role_of(side, pos, proj):
    """calc.js rolesOf: hitters C or H; pitchers SP (GS >= half of G) or RP, else by position."""
    tok = {t.strip().upper() for t in str(pos or "").replace("/", ",").split(",")}
    if side == "h":
        return "C" if "C" in tok else "H"
    g, gs = proj.get("G", 0.0), proj.get("GS", 0.0)
    if g > 0:
        return "SP" if gs >= 0.5 * g else "RP"
    return "SP" if "SP" in tok else "RP" if "RP" in tok else "P"


def primary(side, pos, role):
    """The position a player is shown under: his first Yahoo position (LF/CF/RF as OF), or SP / RP."""
    if side == "p":
        return role if role in ("SP", "RP") else "P"
    first = str(pos or "UT").replace("/", ",").split(",")[0].strip().upper()
    return "OF" if first in ("LF", "CF", "RF") else first if first in ("C", "1B", "2B", "3B", "SS", "OF") else "UT"


class Pool:
    """The players the draft can take, best $ value first (index 0 = the most valuable)."""

    def __init__(self, table, league, risk=None, keep=2.0, n_draws=None):
        self.lg = league
        comps = league.components
        self.comps = comps
        rows = [p for p in table["players"] if p.get("value") is not None and np.isfinite(p["value"])]
        for p in rows:
            p["proj"] = {STAT_ALIAS.get(k, k): float(v or 0.0) for k, v in p["proj"].items()}
            p["role"] = role_of(p["type"], p["pos"], p["proj"])
        fill = self._fill(rows, table.get("fillTargets") or {}, comps, league.teams)

        # keep: `keep` x the calculator's drafted count on each side, best $ first, plus enough
        # players at each slot type for every team to fill it twice
        kept = []
        for side in ("h", "p"):
            side_rows = sorted([p for p in rows if p["type"] == side], key=lambda p: -p["value"])
            n_keep = int(round(keep * max(1, sum(p["drafted"] for p in side_rows))))
            chosen = side_rows[:n_keep]
            caps = league.slots if side == "h" else league.pslots
            for t, c in caps.items():
                need = 2 * c * league.teams
                have = sum(t in league.signature(side, p["pos"]) for p in chosen)
                for p in side_rows[n_keep:]:
                    if have >= need:
                        break
                    if t in league.signature(side, p["pos"]) and p not in chosen:
                        chosen.append(p)
                        have += 1
            kept += [p for p in chosen if league.signature(side, p["pos"])]
        kept.sort(key=lambda p: -p["value"])
        self.rows = kept
        n = self.n = len(kept)
        self.side = np.array([p["type"] for p in kept])
        self.name = [p["name"] for p in kept]
        self.team = [p.get("team") or "" for p in kept]
        self.pos = [p["pos"] for p in kept]
        self.mlbam = np.array([p["mlbamid"] if p.get("mlbamid") is not None else -1 for p in kept], np.int64)
        self.value = np.array([p["value"] for p in kept], float)
        self.sgpar = np.array([p["sgpar"] if p.get("sgpar") is not None else np.nan for p in kept], float)
        self.drafted = np.array([bool(p["drafted"]) for p in kept])
        self.valued_at = [p.get("valuedAt") for p in kept]
        self.role = [p["role"] for p in kept]
        self.primary = [primary(p["type"], p["pos"], p["role"]) for p in kept]
        self.signature = [league.signature(p["type"], p["pos"]) for p in kept]
        self.adp = np.array([p.get("adp") if p.get("adp") is not None else np.nan for p in kept], float)

        # the projection's components and playing time, with the fill
        self.proj = np.array([[_comp(p["proj"], c, p["type"]) for c in comps] for p in kept], float)
        self.proj_pt = np.array([p["proj"].get("PA" if p["type"] == "h" else "IP", 0.0) for p in kept], float)
        none = (0.0, np.zeros(len(comps)))
        self.fill_target = np.array([fill[p["type"]].get(p["role"], none)[0] for p in kept], float)
        self.fill_rate = np.array([fill[p["type"]].get(p["role"], none)[1] for p in kept], float)  # [n, comps]
        self.proj_filled = self.proj + np.maximum(0.0, self.fill_target - self.proj_pt)[:, None] * self.fill_rate

        # the outcome draws: [n, draws, comps], filled; a player without draws repeats his projection
        heads, by_side = {}, {}
        for side in ("h", "p"):
            if risk and risk.get(side) is not None:
                head, mlbam, x = decode(risk[side])
                heads[side] = head
                by_side[side] = ({int(m): j for j, m in enumerate(mlbam)}, x)
        D = n_draws or max([h["draws"] for h in heads.values()] or [1])
        self.n_draws = D
        draws = np.repeat(self.proj[:, None, :], D, axis=1)
        pt = np.repeat(self.proj_pt[:, None], D, axis=1)
        self.has_draws = np.zeros(n, bool)
        for side, (ix, x) in by_side.items():
            stats = {STAT_ALIAS.get(k, k): v for k, v in x.items()}
            sel = [(i, ix[int(self.mlbam[i])]) for i in range(n) if self.side[i] == side and int(self.mlbam[i]) in ix]
            if not sel:
                continue
            ii = np.array([a for a, _ in sel])
            jj = np.array([b for _, b in sel])
            cols = np.linspace(0, stats[next(iter(stats))].shape[1] - 1, D).round().astype(int)
            sub = _Zero({k: v[jj][:, cols] for k, v in stats.items()})
            for c, comp in enumerate(comps):
                if COMPONENTS[comp][0] == side:
                    draws[ii, :, c] = COMPONENTS[comp][1](sub)
            pt[ii] = sub["PA" if side == "h" else "IP"]
            self.has_draws[ii] = True
        self.draws = draws + np.maximum(0.0, self.fill_target[:, None] - pt)[:, :, None] * self.fill_rate[:, None, :]
        self.draw_pt = pt
        self.headers = heads

    @staticmethod
    def _fill(rows, targets, comps, tier):
        """Per side and role: (target playing time, replacement components per unit)."""
        out = {}
        for side in ("h", "p"):
            unit = "PA" if side == "h" else "IP"
            side_rows = [p for p in rows if p["type"] == side]
            out[side] = {}
            for role in sorted({p["role"] for p in side_rows}):
                mine = sorted([p for p in side_rows if p["role"] == role and p["proj"].get(unit, 0) > 0], key=lambda p: -p["value"])
                drafted = [p for p in mine if p["drafted"]]
                cut = len(drafted)
                band = mine[max(0, cut - tier) : cut + tier] or mine[:1]
                vol = sum(p["proj"][unit] for p in band)
                rate = np.array([sum(_comp(p["proj"], c, side) for p in band) / vol if vol > 0 else 0.0 for c in comps])
                t = (targets.get(side) or {}).get(role)
                if t is None:
                    pts = sorted(p["proj"][unit] for p in (drafted or mine))
                    t = pts[min(len(pts) - 1, int(0.9 * (len(pts) - 1)))] if pts else 0.0
                out[side][role] = (float(t), rate)
        return out

    def by_name(self, text):
        """Pool indices whose name contains `text` (case-insensitive); an exact match wins."""
        t = text.strip().lower()
        hits = [i for i, nm in enumerate(self.name) if t in nm.lower()]
        exact = [i for i in hits if self.name[i].lower() == t]
        return exact or hits


def _comp(stats, comp, side):
    """One component of a stats dict (a missing stat counts 0); 0 for the other side's components."""
    c_side, f = COMPONENTS[comp]
    if c_side != side:
        return 0.0
    return float(f(_Zero(stats)))


class _Zero(dict):
    def __missing__(self, key):
        return 0.0
