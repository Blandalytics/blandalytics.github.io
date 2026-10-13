"""The MLB draft engine driven by JSON, for a page that runs Python in a web worker (Pyodide).

Port of nhl_draft web_api.py.  A Session is built from settings, the calculator's player table
(table.js) and the two risk files; each stop is described as a dict; the simulations run in chunks so
the page can draw early and sharpen.

    s = Session(cfg, table_json, risk_h_bytes, risk_p_bytes)
    s.begin_stop()             # -> stop info; in a mock draft the rivals act until the user's turn
    s.simulate(progress)       # progress(json) after every chunk; returns the final json
    snake:    s.take(index=i) / s.take(text="p judge")
    auction:  s.nominate(index=i) on the user's turn; s.bid(amount) settles the lot on the block
    either:   s.auto() (take the recommendation), s.record(...) (a real draft), s.undo(), s.board(),
              s.rosters(), s.final()

cfg keys (all optional): mode ("snake" | "auction"), slot (1-based seat), sims, seed, format
("roto" | "h2h"), weeks, playoff_teams, objective ("win" | "playoff" | "champ" | "points"), mock,
dnd (names), per_pos, board, keep (pool size per side, x the drafted count), sigma_market, sigma_team,
bench_share, outcomes (seasons per play-out), chunk, auto_below ($: lots worth less are bid on by value
without a stop).
"""

import json
import math
import warnings

import numpy as np

from draft import Draft
from engine import CAT0, CHAMP, FIN, GOT, HWINS, PAID, PLAYOFF, PTS, VAL, WIN, Engine
from league import SLOT_ORDER, League
from pool import Pool

DEFAULTS = dict(mode="snake", slot=1, sims=200, seed=20270401, format=None, weeks=None, playoff_teams=6, objective=None,
                mock=True, dnd=[], per_pos=1, board=6, keep=2.0, sigma_market=0.15, sigma_team=0.10, bench_share=0.25, outcomes=8,
                chunk=20, auto_below=0.0)  # fmt: skip
OBJECTIVE = {"win": WIN, "playoff": PLAYOFF, "champ": CHAMP, "points": PTS}


class Session:
    def __init__(self, cfg, table, risk_h=None, risk_p=None, log=None):
        c = {**DEFAULTS, **{k: v for k, v in (cfg or {}).items() if v is not None}}
        self.cfg = c
        self.log_fn = log or (lambda *a: None)
        table = json.loads(table) if isinstance(table, (str, bytes)) else table
        self.lg = League.from_settings(table["settings"], format=c["format"], weeks=c["weeks"], playoff_teams=int(c["playoff_teams"]))
        self.log_fn("reading the outcome draws")
        self.pool = Pool(table, self.lg, {"h": risk_h, "p": risk_p}, keep=float(c["keep"]))
        dnd = [i for nm in c["dnd"] for i in self.pool.by_name(nm)[:1]]
        self.objective = c["objective"] or ("playoff" if self.lg.format == "h2h" else "win")
        h2h = self.lg.format == "h2h" or self.objective in ("playoff", "champ")
        self.eng = Engine(self.pool, self.lg, float(c["sigma_market"]), float(c["sigma_team"]), float(c["bench_share"]),
                          h2h=h2h, dnd=dnd, outcomes=int(c["outcomes"]))  # fmt: skip
        self.rng = np.random.default_rng(int(c["seed"]))
        self.draft = Draft(self.eng, int(c["slot"]) - 1, self.rng, c["mode"], int(c["per_pos"]), int(c["board"]))
        self.mock, self.sims, self.chunk = bool(c["mock"]), int(c["sims"]), int(c["chunk"])
        self.snaps, self.between, self.opts, self.result, self.kind = [], [], [], None, None

    # ---- describing the draft ---------------------------------------------------------------------

    def player(self, i):
        p = self.pool
        return {"i": int(i), "name": p.name[i], "pos": p.pos[i], "mlb": p.team[i], "value": round(float(p.value[i]), 1)}

    def log_row(self, row):
        n, team, i, price = row
        return {**self.player(i), "n": n, "team": team + 1, "you": team == self.draft.user, "price": price}

    def roster_rows(self, team):
        d, eng = self.draft, self.eng
        starters = set(eng.lineup(d.rosters[team]))
        rows = []
        for i, price in zip(d.rosters[team], d.paid[team]):
            slot = self._slot_of(i, team) if i in starters else "BN"
            rows.append({**self.player(i), "slot": slot, "price": price})
        rows.sort(key=lambda r: (SLOT_ORDER.index(r["slot"]) if r["slot"] in SLOT_ORDER else 99, -r["value"]))
        return rows

    def _slot_of(self, i, team):
        """A starter's slot for display: his first eligible slot type still free, in lineup order."""
        d, eng = self.draft, self.eng
        caps = dict(self.lg.slot_caps)
        for j in eng.lineup(d.rosters[team]):
            sig = self.pool.signature[j]
            s = next((x for x in sig if caps.get(x, 0) > 0), sig[-1])
            caps[s] = caps.get(s, 0) - 1
            if j == i:
                return s
        return "BN"

    def stop_info(self):
        d = self.draft
        info = {"done": d.done(), "mode": d.mode, "kind": self.kind, "mock": self.mock, "sims": self.sims,
                "objective": self.objective, "format": self.lg.format, "teams": self.lg.teams, "user_team": d.user + 1,
                "budget": d.budget[d.user] if d.mode == "auction" else None,
                "max_bid": d.max_bid(d.user) if d.mode == "auction" else None,
                "roster": self.roster_rows(d.user), "between": [self.log_row(r) for r in self.between], "options": []}  # fmt: skip
        if not d.done() and d.mode == "snake":
            rd, team, overall = d.on_clock()
            info.update({"round": rd, "team": team + 1, "overall": overall, "mine": team == d.user})
        if d.mode == "auction" and d.lot is not None:
            j, nom = d.lot
            info.update({"lot": self.player(j), "nominator": nom + 1, "inflation": round(d.inflation(), 3)})
        return info

    # ---- the flow ---------------------------------------------------------------------------------

    def begin_stop(self):
        """Arrive at the user's next decision; in a mock draft the rivals act until then."""
        d = self.draft
        self.result = None
        if d.mode == "snake":
            while self.mock and not d.done() and d.on_clock()[1] != d.user:
                d.auto()
                self.between.append(d.log[-1])
            self.kind = None if d.done() else "pick"
            self.opts = d.candidates() if not d.done() and d.user in d.remaining() else []
        else:
            self.opts = []
            while not d.done():
                if d.lot is None:
                    if d.nominator() == d.user:
                        self.kind = "nominate"
                        self.opts = [(("pick", i), "board") for i in d.my_board() if d.legal_for(d.user, i)][: d.n_board]
                        break
                    if not self.mock:
                        self.kind = "enter"
                        break
                    d.auto_nominate()
                j = d.lot[0]
                if self.mock and (self.pool.value[j] < float(self.cfg["auto_below"]) or not d.legal_for(d.user, j)):
                    d.resolve(None)
                    self.between.append(d.log[-1])
                    continue
                self.kind = "bid"
                self.opts = d.bid_grid()
                break
            if d.done():
                self.kind = None
        self.snaps.append(d.snapshot())
        info = self.stop_info()
        info["options"] = [self.option_row(c, why) for c, why in self.opts]
        return json.dumps(info)

    def option_row(self, cand, why):
        row = {"kind": cand[0], "why": why}
        if cand[0] == "pick":
            row.update(self.player(cand[1]))
        elif cand[0] in ("bid", "buy"):
            row["amount"] = int(cand[1])
        return row

    def take(self, index=None, text=None):
        """Snake: a pick, a pool index or a name ("p name", or an option number)."""
        d = self.draft
        if d.mode != "snake" or d.done():
            return json.dumps({"ok": False, "message": "no pick to make"})
        i = self._resolve(index, text)
        if isinstance(i, str):
            return json.dumps({"ok": False, "message": i})
        _, team, _ = d.on_clock()
        if team == d.user and not d.legal_for(team, i):
            return json.dumps({"ok": False, "message": "%s is not a legal pick for your roster" % self.pool.name[i]})
        d.take(i)
        if team != d.user:
            self.between.append(d.log[-1])
        elif self.mock:
            self.between = []
        return json.dumps({"ok": True, "pick": self.log_row(d.log[-1])})

    def nominate(self, index=None, text=None):
        """Auction: the user's nomination."""
        d = self.draft
        if d.mode != "auction" or d.lot is not None or d.nominator() != d.user:
            return json.dumps({"ok": False, "message": "it is not your nomination"})
        i = self._resolve(index, text)
        if isinstance(i, str):
            return json.dumps({"ok": False, "message": i})
        if not d.legal_for(d.user, i):
            return json.dumps({"ok": False, "message": "%s does not fit your roster" % self.pool.name[i]})
        d.nominate(i)
        return json.dumps({"ok": True, "lot": self.player(i)})

    def bid(self, amount):
        """Auction: settle the lot on the block with the user's maximum bid (0: no bid)."""
        d = self.draft
        if d.mode != "auction" or d.lot is None:
            return json.dumps({"ok": False, "message": "nothing on the block"})
        win, price = d.resolve(int(amount))
        self.between = [] if win == d.user else self.between + [d.log[-1]]
        return json.dumps({"ok": True, "result": self.log_row(d.log[-1]), "mine": win == d.user})

    def record(self, index, team, price=None):
        """A real draft's result (snake: the pick on the clock; auction: the lot's winner and price)."""
        d = self.draft
        i = int(index)
        if d.gone[i]:
            return json.dumps({"ok": False, "message": "%s is already gone" % self.pool.name[i]})
        if d.mode == "auction" and d.lot is None:
            d.nominate(i)
        d.record(i, int(team) - 1, price)
        self.between.append(d.log[-1])
        return json.dumps({"ok": True, "result": self.log_row(d.log[-1])})

    def auto(self):
        """Take the recommendation: the best option once simulated, else the first one."""
        d = self.draft
        if not self.opts:
            return json.dumps({"ok": False, "message": "no options"})
        cand = self.result["best"]["cand"] if self.result else self.opts[0][0]
        if self.kind == "pick":
            return self.take(index=cand[1])
        if self.kind == "nominate":
            return self.nominate(index=cand[1])
        if self.kind == "bid":
            return self.bid(cand[1])
        return json.dumps({"ok": False, "message": "nothing to do"})

    def undo(self):
        if len(self.snaps) < 2:
            return json.dumps({"ok": False, "message": "nothing to undo"})
        self.snaps.pop()
        self.draft.restore(self.snaps.pop())
        self.between = []
        return json.dumps({"ok": True})

    def _resolve(self, index, text):
        if index is not None:
            i = int(index)
        else:
            t = (text or "").strip()
            cmd, _, arg = t.partition(" ")
            if cmd.isdigit() and 1 <= int(cmd) <= len(self.opts):
                c = self.opts[int(cmd) - 1][0]
                if c[0] != "pick":
                    return "option %s is not a player" % cmd
                return c[1]
            hits = [h for h in self.pool.by_name(arg if cmd.lower() == "p" else t) if not self.draft.gone[h]]
            if len(hits) != 1:
                return "%d available players match %r" % (len(hits), t)
            i = hits[0]
        if self.draft.gone[i]:
            return "%s is already gone" % self.pool.name[i]
        return i

    # ---- pricing the options ----------------------------------------------------------------------

    def candidates(self):
        """The candidates the engine prices at this stop, as (candidate, label, the option).  A
        nomination of player i is priced as the lot opening with i and the user bidding its value bid
        on him (Draft.user_value_bid): what the room does with him, and what the user's team becomes."""
        d = self.draft
        if self.kind == "nominate":
            return [(("bid", d.user_value_bid(c[1])), why, c) for c, why in self.opts]
        return [(c, why, c) for c, why in self.opts]

    def simulate(self, progress=None):
        """Price the options over `sims` shared worlds, in chunks; progress(json) after each chunk."""
        d, eng = self.draft, self.eng
        if not self.opts:
            return json.dumps(None)
        cands = self.candidates()
        snap = d.snap()
        base = next((k for k, (c, _, _) in enumerate(cands) if c[0] == "skip"), 0)
        out = league = None
        done, n = 0, self.sims
        while done < n:
            k = min(self.chunk, n - done)
            rng = self.rng.spawn(1)[0]
            if self.kind == "nominate":  # each nomination is its own lot: one play-out each, same worlds
                seed = int(rng.integers(1 << 62))
                parts = [eng.chunk(snap._replace(lot=(orig[1], d.user)), [c], k, np.random.default_rng(seed)) for c, _, orig in cands]
                o = np.concatenate([p[0] for p in parts], axis=1)
                lg = parts[base][1]
            else:
                o, lg = eng.chunk(snap, [c for c, _, _ in cands], k, rng, base)
            out = o if out is None else np.concatenate([out, o], axis=2)
            league = lg if league is None else np.concatenate([league, lg], axis=2)
            done += k
            self.result = self.tables(cands, out, league, base, done, n)
            if progress is not None and done < n:
                progress(json.dumps(self.public(self.result)))
        return json.dumps(self.public(self.result))

    @staticmethod
    def public(result):
        return {k: v for k, v in result.items() if k != "best"} | {"best_row": result["best"]["row"]}

    def tables(self, cands, out, league, base, done, of):
        """The options table: each candidate's measures (means over the shared worlds), its spread on
        roto points, and the best by the objective (ties to roto points, then to the cheaper bid)."""
        obj = OBJECTIVE[self.objective]
        with warnings.catch_warnings():  # a measure a mode does not have is all NaN
            warnings.simplefilter("ignore", RuntimeWarning)
            mean = np.nanmean(out, axis=2)
        p10, p90 = np.nanpercentile(out[PTS], [10, 90], axis=1)
        key = [(mean[obj, k], mean[PTS, k], -(c[1] if c[0] in ("bid", "buy") else 0)) for k, (c, _, _) in enumerate(cands)]
        if self.kind == "bid":  # the pass, then the forced buys by price; the recommendation is the break-even
            order = list(range(len(cands)))
        else:  # the skip baseline is shown last and never recommended (nhl_draft rank_options)
            order = sorted((k for k in range(len(cands)) if cands[k][0][0] != "skip"), key=lambda k: key[k], reverse=True)
            order += [k for k in range(len(cands)) if cands[k][0][0] == "skip"]
        ranked = out[obj]
        top = ranked == np.nanmax(ranked, axis=0)
        best_share = (top / np.maximum(1, top.sum(axis=0))).sum(axis=1) / ranked.shape[1]
        rows = []
        for k in order:
            c, why, orig = cands[k]
            r = self.option_row(orig, why)
            r.update({"roto": _r(mean[PTS, k], 1), "finish": _r(mean[FIN, k], 2), "win": _r(mean[WIN, k], 3),
                      "team_value": _r(mean[VAL, k], 1), "p10": _r(p10[k], 1), "p90": _r(p90[k], 1), "best": _r(best_share[k], 3),
                      "gap": _r(mean[obj, k] - mean[obj, order[0]], 3)})  # fmt: skip
            if self.lg.format == "h2h" or self.objective in ("playoff", "champ"):
                r.update({"playoff": _r(mean[PLAYOFF, k], 3), "champ": _r(mean[CHAMP, k], 3), "h2h_wins": _r(mean[HWINS, k], 1)})
            if c[0] in ("bid", "buy"):
                r.update({"got": _r(mean[GOT, k], 3), "paid": _r(np.nanmean(out[PAID, k]) if np.isfinite(out[PAID, k]).any() else math.nan, 1)})
            r["cats"] = [_r(v, 2) for v in mean[CAT0:, k]]
            rows.append(r)
        # the team's standing in the baseline world: M, S (O2, O3) and the winner's mean total H (O1)
        totals = np.nansum(league, axis=1)  # [teams, sims]
        me = self.draft.user
        lmean = np.nanmean(league, axis=2)
        standings = [{"team": int(t) + 1, "you": int(t) == me, "cats": [_r(v, 1) for v in lmean[t]], "total": _r(lmean[t].sum(), 1)}
                     for t in np.argsort(-lmean.sum(axis=1), kind="stable")]  # fmt: skip
        target = {"M": _r(totals[me].mean(), 2), "S": _r(totals[me].std(ddof=1) if totals.shape[1] > 1 else math.nan, 2),
                  "H": _r(totals.max(axis=0).mean(), 2)}  # fmt: skip
        res = {"sims": int(done), "of": int(of), "objective": self.objective, "cats": self.lg.cats, "kind": self.kind,
               "options": rows, "standings": standings, "target": target, "best": {"cand": cands[order[0]][2], "row": rows[0]}}  # fmt: skip
        if self.kind == "bid":
            be = self.break_even(cands, out, base, obj)
            res["break_even"] = {self.objective: be, "points": self.break_even(cands, out, base, PTS)}
            j = self.draft.lot[0]
            res["best"] = {"cand": ("bid", be["max_bid"]), "row": {**self.player(j), "kind": "bid", "amount": be["max_bid"],
                           "why": "break-even", "p_star": be["p_star"], "win": rows[0]["win"], "roto": rows[0]["roto"]}}  # fmt: skip
        return res

    def break_even(self, cands, out, base, m):
        """The maximum bid: the price at which buying the lot equals passing on it, on measure m.

        Each forced buy at price p is paired with the pass in every world (common random numbers); the
        mean gain over passing is fitted as a line in p (weighted by its standard error), and the line's
        root is the break-even price.  Bidding up to it buys the player whenever he costs less than he
        adds; the argmax of noisy candidates would favor the noisiest (the highest) bids.
        """
        p, y, se = [], [], []
        for k, (c, _, _) in enumerate(cands):
            if c[0] != "buy":
                continue
            d = out[m, k] - out[m, base]
            p.append(float(c[1]))
            y.append(float(np.mean(d)))
            se.append(float(np.std(d, ddof=1) / math.sqrt(len(d))) if len(d) > 1 else 1.0)
        mb, cap = self.lg.min_bid, self.draft.max_bid(self.draft.user)
        if not p:
            return {"max_bid": 0, "p_star": None, "prices": [], "gain": [], "se": []}
        p, y, se = np.array(p), np.array(y), np.array(se)
        intercept = slope = None
        if len(p) >= 2 and np.ptp(p) > 0:
            w = 1.0 / np.maximum(se, 1e-6 + 1e-3 * np.abs(y).max()) ** 2
            pm = (w * p).sum() / w.sum()
            ym = (w * y).sum() / w.sum()
            slope = float((w * (p - pm) * (y - ym)).sum() / (w * (p - pm) ** 2).sum())
            intercept = float(ym - slope * pm)
        if slope is not None and slope < 0:
            p_star = -intercept / slope
        else:  # no decline with price in these worlds: the dearest price that still gains
            p_star = float(p[y > 0].max()) if (y > 0).any() else 0.0
        max_bid = int(math.floor(min(cap, max(0.0, p_star))))
        return {"max_bid": max_bid if max_bid >= mb else 0, "p_star": _r(p_star, 1), "slope": None if slope is None else _r(slope, 5),
                "prices": [int(v) for v in p], "gain": [_r(v, 4) for v in y], "se": [_r(v, 4) for v in se]}  # fmt: skip

    # ---- looking around ---------------------------------------------------------------------------

    def board(self, pos=None, n=25):
        d = self.draft
        return json.dumps([{**self.player(i), "rank": k, "sgpar": _r(self.pool.sgpar[i], 2), "legal": d.legal_for(d.user, i)}
                           for k, i in enumerate(d.my_board(pos or None)[: int(n)], start=1)])  # fmt: skip

    def rosters(self):
        d = self.draft
        return json.dumps([{"team": t + 1, "you": t == d.user, "budget": d.budget[t] if d.mode == "auction" else None,
                            "players": self.roster_rows(t)} for t in range(self.lg.teams)])  # fmt: skip

    def final(self, n_sims=None):
        """The finished draft: every roster, and every team's odds over the outcome draws."""
        d, eng = self.draft, self.eng
        n = int(n_sims or max(200, self.sims))
        rows = []
        res = eng.season(d.rosters, n, np.random.default_rng(int(self.cfg["seed"]) + 7))  # [teams, measures, sims]
        for t in range(self.lg.teams):
            r = res[t]
            row = {"team": t + 1, "you": t == d.user, "roto": _r(np.mean(r[PTS]), 1), "finish": _r(np.mean(r[FIN]), 2),
                   "win": _r(np.mean(r[WIN]), 3), "team_value": _r(np.mean(r[VAL]), 1),
                   "spent": (self.lg.budget - d.budget[t]) if d.mode == "auction" else None}  # fmt: skip
            if self.lg.format == "h2h" or self.objective in ("playoff", "champ"):
                row.update({"playoff": _r(np.mean(r[PLAYOFF]), 3), "champ": _r(np.mean(r[CHAMP]), 3)})
            rows.append(row)
        rows.sort(key=lambda x: -x["roto"])
        return json.dumps({"roster": self.roster_rows(d.user), "standings": rows, "sims": n, "cats": self.lg.cats})


def _r(v, nd):
    v = float(v)
    return None if not math.isfinite(v) else round(v, nd)


def players_json(table, settings_over=None):
    """The pool for the page's player pickers (the whole table, before the engine trims it)."""
    table = json.loads(table) if isinstance(table, (str, bytes)) else table
    return json.dumps([{"i": k, "name": p["name"], "pos": p["pos"], "type": p["type"], "value": round(p["value"], 1)}
                       for k, p in enumerate(table["players"])])  # fmt: skip
