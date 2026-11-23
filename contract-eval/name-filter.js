// The free-text Player field's check against profanity and slurs. A name is folded (accents and
// case dropped, look-alike digits and symbols read as letters), then blocked if its letters, run
// together, contain a ROOTS entry or any of its words is a WORDS entry. The lists are rot13 so the
// page source does not spell them out; whole-word entries are the ones that occur inside real
// surnames. CVPNameOK(name) is true for a name the card may show.
(function () {
  const r13 = (s) => s.replace(/[a-z]/g, (c) => String.fromCharCode((c.charCodeAt(0) - 84) % 26 + 97));
  const ROOTS = ["shpx", "shx", "spx", "fuvg", "ovgpu", "phag", "avttre", "avttn", "snttbg", "sntbg", "ergneq", "juber", "fyhg", "chffl", "gjng", "wvmm", "pbpxfhpx", "zbgures", "nffubyr", "qhzonff", "wnpxnff", "qvpxurnq", "qvcfuvg", "ohyyfuvg", "ubefrfuvg", "puvaxvr", "enturnq", "gbjryurnq", "jrgonpx", "ornare", "genaal", "furznyr", "uvgyre", "xxx", "anmvf", "encvfg", "crqb", "zbyrfg", "cbea", "oybjwbo", "unaqwbo", "qvyqb", "cravf", "intvan", "grfgvpyr", "fpebghz", "pyvg", "obare", "tbqqnza", "qnzavg", "fcnfgvp", "zbatbybvq", "tbyyvjbt", "fnzob", "cvpxnavaal", "qnexvr"].map(r13);
  const WORDS = new Set(["nff", "nefr", "phz", "gvg", "gvgf", "snt", "sntf", "pbba", "pbbaf", "fcvp", "fcvpx", "puvax", "tbbx", "xvxr", "qlxr", "qlxrf", "ubzb", "qvpx", "qvpxf", "pbpx", "pbpxf", "cvff", "jnax", "arteb", "artebrf", "anmv", "encr", "encrq", "qntb", "jbc", "wnc", "wncf", "cnxv", "tlc", "tlcfl", "penc", "qnza", "uryy", "fynt", "fxnax", "ubr", "ubrf", "gubg", "xlf", "avt", "avtf", "frk", "nany", "nahf", "ohgg", "obbo", "obbof", "chgn", "chgb", "craqrwb", "zvreqn", "pnoeba", "znevpba", "wbgb", "puvatnqn", "iretn", "phyb", "ergneqf", "gneq", "gneqf", "pevccyr", "zvqtrg", "onfgneq", "onfgneqf"].map(r13));
  const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "i", "+": "t" };
  function fold(name) {
    return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[0134578@$!|+]/g, (c) => LEET[c] || c);
  }
  window.CVPNameOK = function (name) {
    const f = fold(name), words = f.split(/[^a-z]+/).filter(Boolean), run = words.join("");
    // a word spelled out a letter at a time ("f u c k", "f.u.c.k") is read as one word too
    const singles = f.split(/[^a-z]+/).filter((w) => w.length === 1).join("");
    return !ROOTS.some((w) => run.includes(w) || singles.includes(w)) && !words.some((w) => WORDS.has(w)) && !WORDS.has(singles);
  };
})();
