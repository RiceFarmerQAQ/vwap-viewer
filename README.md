# VWAP Trend Trading — Trade Viewer

An interactive viewer for the VWAP Trend Trading strategy from Zarattini & Aziz
(2023), *"VWAP: The Holy Grail for Day Trading Systems"* (SSRN 4631351),
backtested on 1-minute QQQ and TQQQ data.

**Live site:** https://YOUR-USERNAME.github.io/vwap-viewer/

## What it shows

- **Chart view** — per-session 1-minute candles with the anchored VWAP line,
  long/short position shading, and labelled entry/exit markers for every trade.
  Drag to pan, `+` / `−` to zoom, `fit` for the whole day.
- **Calendar view** — a monthly P&L calendar. Each trading day shows its net
  dollar result and trade count, colour-scaled by size. Click a day to see its
  round-trip trades (side, entry→exit time, dollar P&L) and jump to it on the
  chart.

The strategy: go long when price is above the session-anchored VWAP, short when
below, reverse only on a candle that *closes* through VWAP, flat overnight.
Backtest window 2018-05-01 → 2023-09-28, $25,000 start, $0.0005/share commission.

## Files

```
index.html          the whole app (HTML + CSS + JS, no build step)
engine.js           client-side backtest engine for the Analysis view
data/
  index.json        which dates exist per symbol/year
  calendar.json     compact daily P&L summary for the calendar
  QQQ_YYYY.json      per-year bars, VWAP, positions, trades, round-trip P&L
  TQQQ_YYYY.json
.nojekyll           tells GitHub Pages to serve files as-is (do not remove)
```

## Views

- **Chart** — candles, VWAP, labelled trades; drag to pan, +/− to zoom.
- **Calendar** — monthly P&L grid; click a day for its round-trip trades.
- **Analysis** — vary a parameter (position size, timeframe, commission, entry
  rule) and sweep it across a range, re-running the full backtest in your
  browser to chart how a metric (return, Sharpe, drawdown…) responds. Uses
  equal-weight VWAP, so absolute figures differ slightly from the reference
  backtest — it's built for comparing settings, not matching the paper exactly.

## Regenerating the data

The JSON is produced from the raw 1-minute CSVs by `export_trades.py`
(kept in the parent project, not in this repo). The strategy logic there matches
the backtest in `vwap_backtest.py`.

## Notes

- Pure static site — no server, database, or build step. Any static host works.
- The data reflects the supplied dataset, which starts 2018-05-01 (the paper
  begins 2018-01-02); the first ~4 months are not included.
