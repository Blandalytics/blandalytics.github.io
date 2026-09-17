"""The draft tool for a browser: the same Draft and Engine, driven by JSON instead of input().

draft_tool.py talks to a terminal.  This wraps the same objects for a page that runs Python in
the browser (Pyodide): a Session is built from a settings dict, each stop is described as a
dict, the simulations run in chunks so the page can draw early and sharpen, and picks arrive
as a pool index (a clicked option) or the same text commands the console takes.

    s = Session(cfg)              # cfg keys mirror draft_tool.py's flags
    s.begin_stop()                # -> stop info (mock mode: rivals have already picked)
    s.simulate(progress)          # progress(json) after every chunk; returns the final json
    s.take(index=i) / s.take(text="p kucherov")
    s.next_stop(), s.undo(), s.board(pos, n), s.rosters(), s.final()
"""
import json

import numpy as np
import pandas as pd

from draft_sim import calibrate, parse_args as base_args
from draft_tool import Draft, SLOT_ORDER, rank_options, resolve, resolve_names, roster_slots
from league import CATS, League, STATS, load_players, roto_points, team_totals
from pick_engine import CAT0, FIN, PTS, SKIP, VOR, WIN, Engine

DEFAULTS = dict(slot=1, teams=12, slots="C:2,LW:2,RW:2,D:4,UTIL:2,G:2", bench=0, sims=150, seed=960122,
                my_weight=0.6, w_lo=0.25, w_hi=0.75, per_pos=2, board=5, mock=True, dnd=[],
                sheet="sheet_live.csv", yahoo="merged_players.csv", calib_sims=200, chunk=15)


def players_json(sheet="sheet_live.csv", yahoo="merged_players.csv"):
    """The pool, for the page's player pickers."""
    p = load_players(sheet, yahoo)
    return json.dumps([{"i": int(i), "name": r.Player, "pos": r.Pos_Y, "nhl": str(r.Team),
                        "adp": None if pd.isna(r.ADP) else float(r.ADP)} for i, r in p.iterrows()])


class Session:
    def __init__(self, cfg, log=None):
        c = {**DEFAULTS, **{k: v for k, v in cfg.items() if v is not None}}
        self.cfg = c
        self.log_fn = log or (lambda *a: None)
        league = League(n_teams=int(c["teams"]), bench=int(c["bench"]),
                        slots={k: int(v) for k, v in (kv.split(":") for kv in c["slots"].split(","))})
        self.log_fn("loading players")
        players = load_players(c["sheet"], c["yahoo"])
        base = base_args(["--sheet", c["sheet"], "--teams", str(league.n_teams), "--slots", c["slots"],
                          "--bench", str(league.bench), "--calib-sims", str(int(c["calib_sims"]))])
        self.log_fn("calibrating (%d market leagues)" % base.calib_sims)
        cal = calibrate(players, players[STATS].to_numpy(float), league, base, np.random.default_rng(base.seed),
                        log=lambda *a: None)
        dnd_text = ", ".join(c["dnd"]) if isinstance(c["dnd"], (list, tuple)) else str(c["dnd"])
        dnd, self.unknown_dnd = resolve_names(players, dnd_text)
        self.eng = Engine(players, cal["coef"], cal["repl"], cal["assigned"], league,
                          float(c["w_lo"]), float(c["w_hi"]), dnd)
        self.rng = np.random.default_rng(int(c["seed"]))
        self.draft = Draft(self.eng, int(c["slot"]) - 1, self.rng, float(c["my_weight"]), int(c["per_pos"]), int(c["board"]))
        self.mock, self.sims, self.chunk = bool(c["mock"]), int(c["sims"]), int(c["chunk"])
        self.snaps, self.between, self.opts, self.result = [], [], [], None

    # ---- describing the draft ----------------------------------------------

    def player(self, i):
        p = self.eng.players
        return {"i": int(i), "name": p["Player"].iat[i], "pos": p["Pos_Y"].iat[i], "nhl": str(p["Team"].iat[i])}

    def pick_row(self, overall, rd, team, i):
        d = self.draft
        return {**self.player(i), "overall": int(overall), "round": int(rd), "pick": (overall - 1) % d.lg.n_teams + 1,
                "team": int(team) + 1, "you": team == d.user_team,
                "w": None if (not self.mock or team == d.user_team) else round(float(d.weights[team]), 2)}

    def roster_rows(self, team):
        d = self.draft
        slots = roster_slots(d, team)
        rows = [{**self.player(i), "slot": slots[i], "vorp": round(float(self.eng.vorp[i]), 2),
                 "value": round(float(self.eng.value[i]), 2)} for i in d.rosters[team]]
        rows.sort(key=lambda r: (SLOT_ORDER.index(r["slot"]), -r["value"]))
        return rows

    def stop_info(self):
        d = self.draft
        info = {"done": d.done(), "dnd": [self.player(int(i)) for i in np.flatnonzero(self.eng.dnd)],
                "unknown_dnd": self.unknown_dnd, "mock": self.mock, "sims": self.sims,
                "teams": d.lg.n_teams, "rounds": d.lg.roster_size, "user_team": d.user_team + 1,
                "weights": [None if t == d.user_team else round(float(w), 2) for t, w in enumerate(d.weights)],
                "roster": self.roster_rows(d.user_team), "between": [self.pick_row(*p) for p in self.between],
                "log": [self.pick_row(*p) for p in d.log], "options": []}
        if not d.done():
            rd, team, overall = d.on_clock()
            info.update({"round": rd, "team": team + 1, "overall": overall, "pick": (overall - 1) % d.lg.n_teams + 1,
                         "mine": team == d.user_team, "has_pick": d.user_team in d.remaining()})
        return info

    # ---- the flow ----------------------------------------------------------

    def begin_stop(self):
        """Arrive at a stop: rivals pick themselves in a mock draft, then the options are laid out."""
        d = self.draft
        while self.mock and not d.done() and d.on_clock()[1] != d.user_team:
            d.auto()
            self.between.append(d.log[-1])
        self.snaps.append(d.snapshot())
        self.result = None
        self.opts = d.candidates()[0] if not d.done() and d.user_team in d.remaining() else []
        info = self.stop_info()
        info["options"] = [{**self.player(i), "why": why} for i, why in self.opts]
        return json.dumps(info)

    def take(self, index=None, text=None):
        """A pick: a pool index (an option clicked) or a console command (`p name`, `#rank`, `1..n`)."""
        d = self.draft
        if d.done():
            return json.dumps({"ok": False, "message": "the draft is over"})
        _, team, _ = d.on_clock()
        mine = team == d.user_team
        i = index
        if i is None:
            t = (text or "").strip()
            cmd, _, arg = t.partition(" ")
            if cmd.isdigit() and 1 <= int(cmd) <= len(self.opts):
                i = self.opts[int(cmd) - 1][0]
            else:
                i, err = resolve(d, arg if cmd.lower() == "p" else t)
                if err:
                    return json.dumps({"ok": False, "message": err})
        i = int(i)
        if d.gone[i]:
            return json.dumps({"ok": False, "message": "%s is already gone" % self.player(i)["name"]})
        if mine and not d.legal_for(team, i):
            return json.dumps({"ok": False, "message": "%s is not a legal pick for your roster" % self.player(i)["name"]})
        d.take(i)
        if not mine:
            self.between.append(d.log[-1])
        elif self.mock:
            self.between = []
        return json.dumps({"ok": True, "pick": self.pick_row(*d.log[-1]), "mine": mine})

    def undo(self):
        if len(self.snaps) < 2:
            return json.dumps({"ok": False, "message": "nothing to undo"})
        self.snaps.pop()
        self.draft.restore(self.snaps.pop())
        self.between = []
        return json.dumps({"ok": True})

    def auto_pick(self):
        """Take the top option on screen (the console's --auto)."""
        if not self.opts:
            return json.dumps({"ok": False, "message": "no options to pick from"})
        return self.take(index=self.opts[0][0])

    # ---- pricing the options -----------------------------------------------

    def simulate(self, progress=None):
        """Price the options over --sims shared finishes, in chunks; `progress(json)` after each."""
        d, eng = self.draft, self.eng
        if not self.opts:
            return json.dumps(None)
        # the result array's columns follow this order for the whole run; tables() re-sorts a
        # copy for display, so the pairing of labels and data never drifts between chunks
        self.cand_opts = list(self.opts)
        cands = [i for i, _ in self.cand_opts] + [SKIP]
        snap = eng.make_snap(d)
        out = league = None
        done = 0
        while done < self.sims:
            k = min(self.chunk, self.sims - done)
            o, lg = eng.chunk(snap, cands, k, self.rng.spawn(1)[0])
            out = o if out is None else np.concatenate([out, o], axis=2)
            league = lg if league is None else np.concatenate([league, lg], axis=2)
            done += k
            self.result = self.tables(out, league, done)
            if progress is not None and done < self.sims:
                progress(json.dumps(self.result))
        return json.dumps(self.result)

    def tables(self, out, league, done):
        d, eng = self.draft, self.eng
        opts, res, base, measure = rank_options(d, self.cand_opts, out)
        self.opts = opts                              # numbered picks follow the ranked order
        ranked = res[measure]
        mean = ranked.mean(axis=1)
        p10, p90 = np.percentile(ranked, [10, 90], axis=1)
        top = ranked == ranked.max(axis=0)
        wins = (top / top.sum(axis=0)).sum(axis=1) / ranked.shape[1]
        rank = {i: k for k, i in enumerate(d.my_board(), start=1)}
        now = base[CAT0:].mean(axis=1)
        lift = res[CAT0:].mean(axis=2) - now[:, None]
        rows = []
        for k, (i, why) in enumerate(opts):
            a = eng.adp[i]
            rows.append({**self.player(i), "why": why, "rank": rank[i], "adp": None if a != a else round(float(a), 1),
                         "roto": round(float(res[PTS, k].mean()), 1), "vorp": round(float(res[VOR, k].mean()), 1),
                         "finish": round(float(res[FIN, k].mean()), 2), "win": round(float(res[WIN, k].mean()), 3),
                         "p10": round(float(p10[k]), 1), "p90": round(float(p90[k]), 1),
                         "gap": round(float(mean[k] - mean.max()), 1), "best": round(float(wins[k]), 3),
                         "lift": [round(float(v), 1) for v in lift[:, k]], "total": round(float(lift[:, k].sum()), 1)})
        lmean = np.nanmean(league, axis=2)
        ltot = lmean.sum(axis=1)
        standings = [{"team": int(t) + 1, "you": int(t) == d.user_team,
                      "w": None if (not self.mock or int(t) == d.user_team) else round(float(d.weights[t]), 2),
                      "cats": [round(float(v), 1) for v in lmean[t]], "total": round(float(ltot[t]), 1)}
                     for t in np.argsort(-ltot, kind="stable")]
        return {"sims": int(done), "of": self.sims, "measure": ["roto pts", "team vorp"][measure], "cats": CATS,
                "options": rows, "baseline": {"cats": [round(float(v), 1) for v in now], "total": round(float(now.sum()), 1)},
                "standings": standings}

    # ---- looking around ----------------------------------------------------

    def board(self, pos=None, n=15):
        d, eng = self.draft, self.eng
        rows = []
        for k, i in enumerate(d.my_board(pos or None)[: int(n)], start=1):
            a = eng.adp[i]
            rows.append({**self.player(i), "rank": k, "vor_rk": int(eng.rank_vor[i]), "adp_rk": int(eng.rank_adp[i]),
                         "adp": None if a != a else round(float(a), 1), "vorp": round(float(eng.vorp[i]), 2),
                         "value": round(float(eng.value[i]), 2)})
        return json.dumps(rows)

    def rosters(self):
        d = self.draft
        return json.dumps([{"team": t + 1, "you": t == d.user_team, "players": self.roster_rows(t)}
                           for t in range(d.lg.n_teams)])

    def final(self):
        d, eng, me = self.draft, self.eng, self.draft.user_team
        pts = roto_points(pd.DataFrame([team_totals(eng.stats, r) for r in d.starters]))
        rows = []
        for t in np.argsort(-pts["Total"].to_numpy(), kind="stable"):
            rows.append({"team": int(t) + 1, "you": int(t) == me,
                         "w": None if (not self.mock or int(t) == me) else round(float(d.weights[t]), 2),
                         "vorp": round(eng.team_vorp(d.starters[t], d.benches[t]), 1),
                         "cats": [round(float(pts[c].iat[t]), 1) for c in CATS], "total": round(float(pts["Total"].iat[t]), 1)})
        return json.dumps({"roster": self.roster_rows(me), "cats": CATS, "standings": rows,
                           "place": int((pts["Total"] > pts["Total"].iat[me]).sum()) + 1})
