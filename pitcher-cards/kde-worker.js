// The Season Cards page's date-range KDE regions (SeasonRange.regions), off the page's
// thread: a full season's take a second or more. Given {id, pitches, order}, answers
// {id, plots} (or {id, error}).
importScripts("card.js?v=32", "season-range.js?v=6");

self.onmessage = (ev) => {
  const { id, pitches, order } = ev.data;
  try {
    self.postMessage({ id, plots: SeasonRange.regions(pitches, order) });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
