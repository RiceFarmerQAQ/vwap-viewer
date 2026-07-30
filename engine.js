/* ============================================================================
   engine.js — client-side VWAP Trend Trading simulator for parameter analysis.

   Ports the Python backtest (vwap_backtest.py / export_trades.py) to JS so the
   browser can re-run the strategy on demand with different parameters.

   Data: the per-year JSON files already carry 1-minute bars (t,o,h,l,c and a
   volume proxy). We recompute VWAP ourselves so that timeframe changes are
   honoured (the stored vwap is 1-min only).

   PARAMETERS (all overridable per run):
     barMinutes   : 1 | 5 | 15 | 30      resample the 1-min bars to this size
     riskPct      : 0..1                  fraction of equity deployed per position
     commissionPS : $/share per side      trading cost
     entryMode    : 'close' | 'confirm'   'close' = reverse on any close through
                                          VWAP; 'confirm' = require N consecutive
                                          closes on the new side before reversing
     confirmBars  : integer >=1           bars of confirmation (entryMode=confirm)

   NB: the source day objects don't store volume, so we approximate VWAP weight
   with a constant (equal-weight typical price). This matches how the viewer's
   stored vwap behaves closely for display; for exact volume-weighting we'd need
   volume in the JSON (easy to add later). Documented so results are interpreted
   correctly.
   ============================================================================ */

const Engine = (() => {

  const DEFAULTS = {
    strategy: 'trend',      // 'trend' | 'meanrev'
    barMinutes: 1,
    riskPct: 1.0,
    commissionPS: 0.0005,
    entryMode: 'close',     // trend only: 'close' | 'confirm'
    confirmBars: 1,
    stopMult: 0,            // stop-loss in multiples of avg VWAP distance (0=off)
    tpMult: 0,              // take-profit in mult of avg dist (trend only; 0=off)
    entryMult: 2,           // mean-rev: fade when this far from VWAP (in avg dists)
    bandMode: 'sigma',      // mean-rev entry basis: 'sigma' (±kσ band) | 'avgdist'
    sigmaMult: 2,           // mean-rev: fade when price beyond ±this many σ
    trendFilter: false,     // mean-rev: skip trades when the day is trending
    trendMax: 0.6,          // allow mean-rev only when trendStrength <= this
    initialCapital: 25000,
  };

  // --- parse "HH:MM" -> minutes since midnight, for resampling buckets ---
  function tmin(t){ const [h,m]=t.split(':'); return (+h)*60+(+m); }

  // --- resample 1-min day bars into N-min bars ---
  // day: {t:[],o:[],h:[],l:[],c:[]}  -> {t,o,h,l,c} at barMinutes resolution
  function resample(day, barMinutes){
    if(barMinutes<=1) return {t:day.t,o:day.o,h:day.h,l:day.l,c:day.c};
    const t=[],o=[],h=[],l=[],c=[];
    let bo,bh,bl,bc,bt,bucket=-1;
    for(let i=0;i<day.c.length;i++){
      const mins=tmin(day.t[i]);
      const b=Math.floor(mins/barMinutes);
      if(b!==bucket){
        if(bucket!==-1){ t.push(bt);o.push(bo);h.push(bh);l.push(bl);c.push(bc); }
        bucket=b; bt=day.t[i]; bo=day.o[i]; bh=day.h[i]; bl=day.l[i]; bc=day.c[i];
      } else {
        bh=Math.max(bh,day.h[i]); bl=Math.min(bl,day.l[i]); bc=day.c[i];
      }
    }
    if(bucket!==-1){ t.push(bt);o.push(bo);h.push(bh);l.push(bl);c.push(bc); }
    return {t,o,h,l,c};
  }

  // --- anchored VWAP over the resampled day (equal-weight typical price) ---
  function vwapOf(bars){
    const n=bars.c.length, v=new Array(n);
    let cum=0;
    for(let i=0;i<n;i++){
      const tp=(bars.h[i]+bars.l[i]+bars.c[i])/3;
      cum+=tp;
      v[i]=cum/(i+1);
    }
    return v;
  }

  // --- desired position each bar, with optional confirmation ---
  // --- TREND desired position (long above VWAP / short below), with optional
  //     confirmation. Returns desired[] per bar (the intended stance). ---
  function trendDesired(bars, vwap, entryMode, confirmBars){
    const n=bars.c.length;
    const raw=new Array(n);
    for(let i=0;i<n;i++) raw[i]= bars.c[i]>vwap[i]?1: bars.c[i]<vwap[i]?-1:0;
    let cur=0, run=0, runSide=0;
    const desired=new Array(n).fill(0);
    for(let i=0;i<n;i++){
      const s=raw[i];
      if(entryMode==='confirm'){
        if(s!==0 && s===runSide){ run++; } else { runSide=s; run=(s!==0?1:0); }
        if(s!==0 && s!==cur && run>=confirmBars) cur=s;
      } else {
        if(s!==0 && s!==cur) cur=s;
      }
      desired[i]=cur;
    }
    return desired;
  }

  // --- running average absolute distance of price from VWAP, per bar.
  //     Used by mean-reversion to define "far from VWAP" in distance-multiples. ---
  function avgDist(bars, vwap){
    const n=bars.c.length, d=new Array(n); let cum=0;
    for(let i=0;i<n;i++){ cum+=Math.abs(bars.c[i]-vwap[i]); d[i]=cum/(i+1); }
    return d;
  }

  // --- running standard deviation of price's deviation from VWAP, per bar.
  //     This is the "VWAP band" width: dev_i = close_i - vwap_i, and we take the
  //     running std of dev. ±kσ bands sit at vwap ± k*std. ---
  function stdDist(bars, vwap){
    const n=bars.c.length, s=new Array(n);
    let sum=0, sumsq=0;
    for(let i=0;i<n;i++){
      const dev=bars.c[i]-vwap[i];
      sum+=dev; sumsq+=dev*dev;
      const m=sum/(i+1);
      const v=Math.max(0, sumsq/(i+1)-m*m);
      s[i]=Math.sqrt(v);
    }
    return s;
  }

  // --- trend-strength score for a day (0..1): fraction of bars price spends on
  //     the majority side of VWAP. ~0.5 = choppy/balanced, ->1 = strongly
  //     one-directional (trending). Mean-reversion is skipped when this exceeds
  //     the filter threshold. ---
  function dayTrendScore(bars, vwap){
    let above=0, below=0;
    for(let i=0;i<bars.c.length;i++){
      if(bars.c[i]>vwap[i]) above++; else if(bars.c[i]<vwap[i]) below++;
    }
    const tot=above+below||1;
    return Math.max(above,below)/tot;   // 0.5 balanced .. 1.0 one-sided
  }

  // --- running standard deviation of price's deviation from VWAP, per bar.
  //     This defines the VWAP band: price beyond ±kσ is "stretched". Computed
  //     cumulatively from session open (population sd of (close - vwap)). ---
  function bandSigma(bars, vwap){
    const n=bars.c.length, sig=new Array(n);
    let sum=0, sumsq=0;
    for(let i=0;i<n;i++){
      const dev=bars.c[i]-vwap[i];
      sum+=dev; sumsq+=dev*dev;
      const mean=sum/(i+1);
      const varc=Math.max(0, sumsq/(i+1)-mean*mean);
      sig[i]=Math.sqrt(varc);
    }
    return sig;
  }

  // --- trend-strength of the session so far, per bar, in [0,1].
  //     Measured as |fraction of bars above VWAP - 0.5| * 2 : 0 = perfectly
  //     balanced (choppy, good for mean-reversion), 1 = price stayed entirely
  //     on one side (strong trend, skip mean-reversion). ---
  function trendStrength(bars, vwap){
    const n=bars.c.length, ts=new Array(n); let above=0;
    for(let i=0;i<n;i++){
      if(bars.c[i]>vwap[i]) above++;
      const frac=above/(i+1);
      ts[i]=Math.abs(frac-0.5)*2;
    }
    return ts;
  }

  // ============================================================================
  // Unified per-day simulation. Handles BOTH strategies and SL/TP by walking the
  // bars and tracking an open position with an entry price. Because SL/TP need
  // intrabar fills, we check each bar's high/low against the stop and target.
  //
  //   strategy 'trend'  : long above VWAP / short below (existing behaviour).
  //                       exits by opposite VWAP cross or (optional) SL/TP.
  //   strategy 'meanrev': FADE price when it is entryMult × the running avg
  //                       distance away from VWAP (short when far above, long
  //                       when far below). Take-profit = price returns to VWAP.
  //                       Stop-loss = price stretches to stopMult × avg distance.
  //
  // SL/TP for trend are expressed as distance-multiples too (of avg VWAP dist),
  // measured from the entry price. Set stopMult/tpMult to 0 to disable.
  // After any exit the book goes flat and can re-enter on the next fresh signal
  // (mean-reversion) / next opposite cross (trend). Flat on first & last bar.
  // ============================================================================
  function simDay(day, params, equityRef){
    const p={...DEFAULTS, ...params};
    const bars=resample(day, p.barMinutes);
    const n=bars.c.length;
    if(n<2) return {bars, vwap:[], held:[], dayRet:0, roundtrips:[]};
    const vwap=vwapOf(bars);
    const dist=avgDist(bars, vwap);
    const strat=p.strategy||'trend';
    const needSigma = strat==='meanrev' || strat==='combined';
    const sig = needSigma ? bandSigma(bars, vwap) : null;
    const tstr = ((strat==='meanrev'||strat==='combined') && p.trendFilter) ? trendStrength(bars, vwap) : null;
    const held=new Array(n).fill(0);

    // precompute the trend stance if needed (trend + combined use it)
    const tdes = (strat==='trend'||strat==='combined')
                 ? trendDesired(bars, vwap, p.entryMode, p.confirmBars) : null;

    // combined-strategy regime state:
    //   regime 'trend'  -> trading the trend leg (default)
    //   regime 'meanrev'-> fading back to VWAP after a band rejection
    // 'armed' tracks that price has traded OUTSIDE a band and we're waiting for it
    // to rebound back inside (the trigger to flip into the mean-rev leg).
    let regime='trend', armedSide=0;   // armedSide: +1 armed above +kσ, -1 below -kσ

    const eqStart=equityRef.v;
    const roundtrips=[];
    let pos=0, entryPx=0, entryEq=0, openNum=0, num=0;

    // helper to apply a fill (entering/exiting) with commission
    function tradeTo(newPos, px, i){
      const dh=newPos-pos;
      if(dh===0) return;
      const shares=Math.abs(dh)*(equityRef.v*p.riskPct/px);
      equityRef.v -= shares*p.commissionPS;
      if(pos!==0){ // closing (or flipping through) an open position
        roundtrips.push({num:openNum, pnl:equityRef.v-entryEq, side:pos>0?'LONG':'SHORT'});
      }
      if(newPos!==0){ num++; openNum=num; entryPx=px; entryEq=equityRef.v; }
      pos=newPos;
    }

    for(let i=0;i<n;i++){
      held[i]=pos; // stance carried into this bar (set before any change below)
      if(i===0){ continue; }               // flat on first bar
      if(i===n-1){ if(pos!==0) tradeTo(0, bars.c[i], i); held[i]=0; break; }

      // mark-to-market this bar via close-to-close on the held position
      const r = pos*(bars.c[i]/bars.c[i-1]-1)*p.riskPct;
      equityRef.v *= (1+r);

      // effective strategy for THIS bar's exit/entry logic. For 'combined' it is
      // the current regime; otherwise the fixed strategy.
      const eff = strat==='combined' ? regime : strat;

      // ---- COMBINED regime transitions (evaluated before entries) ----
      if(strat==='combined'){
        const s = sig[i]>0 ? sig[i] : 1e-9;
        const upper = vwap[i] + p.sigmaMult*s;
        const lower = vwap[i] - p.sigmaMult*s;
        if(regime==='trend'){
          // arm when price trades outside a band
          if(bars.h[i] >= upper) armedSide=1;
          else if(bars.l[i] <= lower) armedSide=-1;
          // trigger: armed above and price rebounds back inside (+2σ rejection) ->
          // exit trend, switch to mean-rev SHORT. Mirror for the lower band.
          if(armedSide===1 && bars.c[i] < upper){
            if(pos!==0) tradeTo(0, bars.c[i], i);
            tradeTo(-1, bars.c[i], i);              // fade short toward VWAP
            regime='meanrev'; armedSide=0; held[i]=pos; continue;
          }
          if(armedSide===-1 && bars.c[i] > lower){
            if(pos!==0) tradeTo(0, bars.c[i], i);
            tradeTo(1, bars.c[i], i);               // fade long toward VWAP
            regime='meanrev'; armedSide=0; held[i]=pos; continue;
          }
        }
      }

      // ---- intrabar SL/TP check on the OPEN position ----
      if(pos!==0 && (p.stopMult>0 || p.tpMult>0 || eff==='meanrev')){
        const dref = dist[i]>0?dist[i]:1e-9;
        const stopPx = p.stopMult>0 ? p.stopMult*dref : Infinity;
        if(eff==='meanrev'){
          // TP = return to VWAP. SL = a new extreme against us (price pushes back
          // OUT past the band it rejected). For combined, the band level is the
          // natural stop; for pure meanrev, stopMult past entry.
          const hitTP = pos>0 ? bars.h[i]>=vwap[i] : bars.l[i]<=vwap[i];
          let slLevel;
          if(strat==='combined'){
            const s = sig[i]>0 ? sig[i] : 1e-9;
            // stop when price makes a new extreme beyond the band (stopMult scales
            // how far past the band before stopping; default = at the band)
            const extra = (p.stopMult>0?p.stopMult:1)*0; // band itself is the line
            slLevel = pos>0 ? (vwap[i]-p.sigmaMult*s) : (vwap[i]+p.sigmaMult*s);
          } else {
            slLevel = pos>0 ? entryPx - stopPx : entryPx + stopPx;
          }
          const hitSL = (strat==='combined' || p.stopMult>0) &&
                        (pos>0 ? bars.l[i]<=slLevel : bars.h[i]>=slLevel);
          if(hitSL){ tradeTo(0, slLevel, i);
            if(strat==='combined') regime='trend';
            held[i]=0; continue; }
          if(hitTP){ tradeTo(0, vwap[i], i);
            if(strat==='combined') regime='trend';   // back to trend at VWAP touch
            held[i]=0; continue; }
        } else { // trend SL/TP measured from entry price
          const tpPx = p.tpMult>0 ? p.tpMult*dref : Infinity;
          const slLevel = pos>0 ? entryPx-stopPx : entryPx+stopPx;
          const tpLevel = pos>0 ? entryPx+tpPx : entryPx-tpPx;
          const hitSL = p.stopMult>0 && (pos>0?bars.l[i]<=slLevel:bars.h[i]>=slLevel);
          const hitTP = p.tpMult>0 && (pos>0?bars.h[i]>=tpLevel:bars.l[i]<=tpLevel);
          if(hitSL){ tradeTo(0, slLevel, i); held[i]=0; continue; }
          if(hitTP){ tradeTo(0, tpLevel, i); held[i]=0; continue; }
        }
      }

      // ---- entry / reversal logic per effective strategy ----
      if(eff==='meanrev' && strat==='meanrev'){
        if(pos===0){
          const blocked = p.trendFilter && tstr && tstr[i] > p.trendMax;
          if(!blocked){
            const dev = bars.c[i]-vwap[i];
            let long=false, short=false;
            if(p.bandMode==='sigma'){
              const s = sig[i]>0 ? sig[i] : 1e-9;
              if(dev >=  p.sigmaMult*s) short=true;
              if(dev <= -p.sigmaMult*s) long=true;
            } else {
              const dref = dist[i]>0?dist[i]:1e-9;
              const stretch = dev/dref;
              if(stretch >=  p.entryMult) short=true;
              if(stretch <= -p.entryMult) long=true;
            }
            if(short) tradeTo(-1, bars.c[i], i);
            else if(long) tradeTo(1, bars.c[i], i);
          }
        }
      } else if(eff==='trend'){ // trend leg (pure trend, or combined in trend regime)
        if(strat==='combined'){
          // In combined mode the trend leg should ride toward the bands, not
          // churn on every micro-cross of VWAP. Only take a NEW trend position
          // when flat, or flip when price is clearly on the other side (beyond a
          // small buffer of the running band), so noise around VWAP doesn't thrash.
          const s = sig[i]>0 ? sig[i] : 1e-9;
          const buf = 0.25*p.sigmaMult*s;         // quarter-band dead-zone
          const want = bars.c[i] > vwap[i]+buf ? 1 : bars.c[i] < vwap[i]-buf ? -1 : pos;
          if(want!==pos) tradeTo(want, bars.c[i], i);
        } else {
          const want=tdes[i-1];
          if(want!==pos) tradeTo(want, bars.c[i], i);
        }
      }
      // (combined mean-rev leg has no separate entries; it was entered on the
      //  regime flip and exits via TP/SL above)
      held[i]=pos;
    }
    return {bars, vwap, dist, held, dayRet:equityRef.v/eqStart-1, roundtrips, eqStart, eqEnd:equityRef.v};
  }

  // --- run the whole backtest across a set of {date->day} maps ---
  // yearsData: array of day-objects in chronological order
  // returns headline metrics
  function runBacktest(daysArray, params){
    const p={...DEFAULTS, ...params};
    const eq={v:p.initialCapital};
    const dailyEq=[]; let nTrades=0, wins=0;
    const dailyRets=[];
    for(const day of daysArray){
      const r=simDay(day, p, eq);
      dailyEq.push(eq.v);
      dailyRets.push(r.dayRet);
      nTrades+=r.roundtrips.length;
      wins+=r.roundtrips.filter(t=>t.pnl>0).length;
    }
    // max drawdown on the daily-close equity curve (matches the Python backtest)
    let peak=-Infinity, maxDD=0;
    for(const e of dailyEq){ if(e>peak) peak=e; const dd=e/peak-1; if(dd<maxDD) maxDD=dd; }
    // stats
    const finalEq=eq.v;
    const totalRet=finalEq/p.initialCapital-1;
    const mean=dailyRets.reduce((a,b)=>a+b,0)/(dailyRets.length||1);
    const variance=dailyRets.reduce((a,b)=>a+(b-mean)**2,0)/(dailyRets.length||1);
    const sd=Math.sqrt(variance);
    const sharpe= sd>0 ? (mean/sd)*Math.sqrt(252) : 0;
    return {
      finalEq, totalRet, sharpe, maxDD,
      nTrades, winRate: nTrades? wins/nTrades : 0,
      dailyEq,
    };
  }

  // --- sweep one parameter across a range of values ---
  function sweep(daysArray, baseParams, param, values, onProgress){
    const out=[];
    for(let i=0;i<values.length;i++){
      const params={...baseParams, [param]:values[i]};
      const m=runBacktest(daysArray, params);
      out.push({value:values[i], ...m});
      if(onProgress) onProgress(i+1, values.length);
    }
    return out;
  }

  // --- grid search: try every combination of the given parameter ranges and
  //     return all results, so the caller can rank by any metric.
  //     grid = { paramName: [values...], ... }. onProgress(done,total) optional.
  function gridSearch(daysArray, baseParams, grid, onProgress){
    const keys=Object.keys(grid);
    // cartesian product of all value arrays
    let combos=[{}];
    for(const k of keys){
      const next=[];
      for(const c of combos) for(const v of grid[k]) next.push({...c,[k]:v});
      combos=next;
    }
    const out=[];
    for(let i=0;i<combos.length;i++){
      const params={...baseParams, ...combos[i]};
      const m=runBacktest(daysArray, params);
      out.push({params:combos[i], ...m});
      if(onProgress) onProgress(i+1, combos.length);
    }
    return out;
  }

  return { DEFAULTS, resample, vwapOf, trendDesired, avgDist, simDay,
           runBacktest, sweep, gridSearch };
})();

// allow use in Node for testing (ignored in browser)
if(typeof module!=='undefined' && module.exports) module.exports=Engine;