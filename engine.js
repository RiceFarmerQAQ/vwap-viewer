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
    barMinutes: 1,
    riskPct: 1.0,
    commissionPS: 0.0005,
    entryMode: 'close',
    confirmBars: 1,
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
  function positions(bars, vwap, entryMode, confirmBars){
    const n=bars.c.length, held=new Array(n).fill(0);
    // raw side per bar
    const raw=new Array(n);
    for(let i=0;i<n;i++) raw[i]= bars.c[i]>vwap[i]?1: bars.c[i]<vwap[i]?-1:0;

    let cur=0, run=0, runSide=0;
    const desired=new Array(n).fill(0);
    for(let i=0;i<n;i++){
      const s=raw[i];
      if(entryMode==='confirm'){
        if(s!==0 && s===runSide){ run++; } else { runSide=s; run=(s!==0?1:0); }
        if(s!==0 && s!==cur && run>=confirmBars) cur=s;
        // if flat signal, hold current (trend hold)
      } else { // 'close'
        if(s!==0 && s!==cur) cur=s;
      }
      desired[i]=cur;
    }
    // execution: hold prior bar's desired (next-open fill), flat first & last bar
    for(let i=1;i<n;i++) held[i]=desired[i-1];
    held[0]=0; if(n>0) held[n-1]=0;
    return held;
  }

  // --- simulate one day, return {retNet:[], trades:[], roundtrips:[] } ---
  // equityRef: {v: currentEquity} threaded across days for $ P&L
  function simDay(day, p, equityRef){
    const bars=resample(day, p.barMinutes);
    const n=bars.c.length;
    if(n<2) return {bars, vwap:[], held:[], dayRet:0, roundtrips:[]};
    const vwap=vwapOf(bars);
    const held=positions(bars, vwap, p.entryMode, p.confirmBars);

    const eqStart=equityRef.v;
    let prev=0, openEq=null, openNum=0, num=0;
    const roundtrips=[];
    for(let i=0;i<n;i++){
      // returns scaled by riskPct (position size = fraction of equity)
      const r = i>0 ? held[i]*(bars.c[i]/bars.c[i-1]-1)*p.riskPct : 0;
      equityRef.v *= (1+r);
      const dh=held[i]-prev;
      if(dh!==0){
        const shares=Math.abs(dh)*(equityRef.v*p.riskPct/bars.c[i]);
        equityRef.v -= shares*p.commissionPS;
        if(prev!==0 && openEq!==null){
          roundtrips.push({num:openNum, pnl:equityRef.v-openEq});
        }
        if(held[i]!==0){ num++; openNum=num; openEq=equityRef.v; }
        else { openEq=null; }
      }
      prev=held[i];
    }
    return {bars, vwap, held, dayRet:equityRef.v/eqStart-1, roundtrips, eqStart, eqEnd:equityRef.v};
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
  // param: key name; values: array; onProgress(i,total) optional
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

  return { DEFAULTS, resample, vwapOf, positions, simDay, runBacktest, sweep };
})();
