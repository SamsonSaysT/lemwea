"use strict";
/* =====================================================================
   LEMONS. — a fresh-squeezed multi-source weather blend
   ===================================================================== */

/* ---------- tiny utils ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const avg = arr => { const v = arr.filter(x => typeof x === 'number' && isFinite(x)); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; };
const store = {
  get(k){ try { return JSON.parse(localStorage.getItem(k)); } catch(e){ return null; } },
  set(k,v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
};
function fetchJSON(url, opts={}, timeout=12000){
  const ctl = new AbortController();
  const t = setTimeout(()=>ctl.abort(), timeout);
  return fetch(url, {...opts, signal: ctl.signal})
    .then(r => { if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .finally(()=>clearTimeout(t));
}
const cToF = c => c*9/5+32;
const kmhToMph = k => k*0.621371;

/* ---------- state ---------- */
const state = {
  loc: store.get('lemons.loc'),          // {lat, lon, name, admin}
  unit: store.get('lemons.unit') || 'F', // 'F' | 'C'
  hourlyHours: store.get('lemons.hourlyHours') || 72,
  tz: undefined,
  sources: [],                            // normalized per-source data
  tab: 'current',
  radar: null
};

/* ---------- weather-code helpers (WMO) ---------- */
function codeLabel(c){
  if(c==null) return '—';
  if(c===0) return 'Clear';
  if(c===1) return 'Mostly clear';
  if(c===2) return 'Partly cloudy';
  if(c===3) return 'Overcast';
  if(c===45||c===48) return 'Fog';
  if(c>=51&&c<=57) return 'Drizzle';
  if((c>=61&&c<=67)||c===80||c===81) return 'Rain';
  if(c===82) return 'Heavy rain';
  if((c>=71&&c<=77)||c===85||c===86) return 'Snow';
  if(c>=95) return 'Thunderstorm';
  return 'Mixed';
}
function iconFor(c, size=24){
  const S = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
  const cloud = 'M7 17.5h9a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 6 8.7 3.9 3.9 0 0 0 7 17.5z';
  if(c===0||c===1) return `<svg ${S}><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M18.7 5.3L17 7M7 17l-1.7 1.7"/></svg>`;
  if(c===2) return `<svg ${S}><circle cx="8.5" cy="8" r="3.4"/><path d="M8.5 1.8v1.6M2.3 8h1.6M4.1 3.6l1.1 1.1M12.9 3.6l-1.1 1.1"/><path d="M10 20h7.5a3.4 3.4 0 0 0 .5-6.77A4.6 4.6 0 0 0 9.2 12 3.3 3.3 0 0 0 10 20z" fill="var(--pith)"/></svg>`;
  if(c===3) return `<svg ${S}><path d="${cloud}"/></svg>`;
  if(c===45||c===48) return `<svg ${S}><path d="M7 13.5h9a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 6 4.7 3.9 3.9 0 0 0 7 13.5z"/><path d="M5 17.5h13M7.5 20.8h9"/></svg>`;
  if(c>=51&&c<=57) return `<svg ${S}><path d="${cloud}"/><path d="M9 20.4v.1M13 20.4v.1M11 22.6v.1"/></svg>`;
  if((c>=71&&c<=77)||c===85||c===86) return `<svg ${S}><path d="${cloud}"/><path d="M9 20.2l.01.01M12 22l.01.01M15 20.2l.01.01M10.5 22.6l.01.01M13.5 22.6l.01.01" stroke-width="2.4"/></svg>`;
  if(c>=95) return `<svg ${S}><path d="${cloud}"/><path d="M12 19l-1.8 3h3L11.4 25" transform="translate(0,-1.2)"/></svg>`;
  if(c>=61) return `<svg ${S}><path d="${cloud}"/><path d="M8.5 20l-.8 2.2M12 20l-.8 2.2M15.5 20l-.8 2.2"/></svg>`;
  return `<svg ${S}><path d="${cloud}"/></svg>`;
}
function codeSeverity(c){
  if(c==null) return 99;
  if(c===0) return 0;
  if(c===1) return 1;
  if(c===2) return 2;
  if(c===3) return 3;
  if(c===45||c===48) return 4;
  if(c>=51&&c<=57) return 5;
  if(c>=61&&c<=67) return 6;
  if(c>=71&&c<=77) return 6.5;
  if(c===80||c===81) return 7;
  if(c===82) return 7.5;
  if(c===85||c===86) return 7.5;
  if(c>=95) return 8;
  return 9;
}
function modeCode(codes){
  return pickWeatherCode(codes);
}
function pickWeatherCode(codes, precipAvg=null){
  const v = codes.filter(c=>c!=null && isFinite(c)).map(Number);
  if(!v.length) return null;
  const count = {};
  v.forEach(c=>count[c]=(count[c]||0)+1);
  const wetTie = typeof precipAvg === 'number' && isFinite(precipAvg) && precipAvg >= 45;
  return +Object.entries(count).sort((a,b)=>{
    const ca = a[1], cb = b[1];
    if(cb !== ca) return cb - ca;
    const sa = codeSeverity(+a[0]), sb = codeSeverity(+b[0]);
    // Old code picked the biggest WMO number on ties, so one thunder vote could beat one sunny vote.
    // Now ties choose the calmer icon unless the blended precip chance is genuinely high.
    return wetTie ? sb - sa : sa - sb;
  })[0][0];
}
const localPartFmtCache = new Map();
function localDateHour(epochH){
  const tz = state.tz || 'UTC';
  let fmt = localPartFmtCache.get(tz);
  if(!fmt){
    fmt = new Intl.DateTimeFormat('en-US', {timeZone:tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23'});
    localPartFmtCache.set(tz, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(epochH*3600000)).map(p=>[p.type,p.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`, hour:+parts.hour};
}
function representativeDailyCode(date, fallbackRows=[]){
  const dayCodes = [], dayPrecip = [];
  okSources().forEach(s=>{
    if(!s.hourly) return;
    for(const [h,row] of s.hourly.entries()){
      const lp = localDateHour(h);
      // Use late morning through afternoon for the daily icon. Daily weather_code can mean
      // “worst thing possible that day,” which made sunny days show as thunder.
      if(lp.date === date && lp.hour >= 10 && lp.hour <= 18){
        if(row.code!=null) dayCodes.push(row.code);
        if(row.precip!=null) dayPrecip.push(row.precip);
      }
    }
  });
  if(dayCodes.length) return pickWeatherCode(dayCodes, avg(dayPrecip));
  return pickWeatherCode(fallbackRows.map(r=>r.code), avg(fallbackRows.map(r=>r.precip)));
}

/* =====================================================================
   SOURCES — each returns:
   { id, name, ok, current:{tempC,feelsC,humidity,windKmh,code},
     hourly: Map(epochHour -> {tempC, precip, code}),
     daily:  Map('YYYY-MM-DD' -> {hiC, loC, precip, code}) }
   ===================================================================== */
const epochHour = iso => Math.floor(Date.parse(iso)/3600000);

/* ---- 1. Open-Meteo multi-model (5 independent models, one call) ---- */
const OM_MODELS = [
  {key:'ecmwf_ifs025',        name:'ECMWF'},
  {key:'gfs_seamless',        name:'NOAA GFS'},
  {key:'icon_seamless',       name:'DWD ICON'},
  {key:'ukmo_seamless',       name:'UK Met Office'},
  {key:'meteofrance_seamless',name:'Météo-France'}
];
async function fetchOpenMeteo(lat, lon){
  const models = OM_MODELS.map(m=>m.key).join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,weather_code,wind_speed_10m`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code`
    + `&models=${models}&timezone=auto&forecast_days=16&wind_speed_unit=kmh`;
  const d = await fetchJSON(url);
  state.tz = d.timezone || state.tz;
  const times = d.hourly.time.map(epochHour);
  const nowH = Math.floor(Date.now()/3600000);
  const nowIdx = Math.max(0, times.findIndex(t=>t>=nowH));

  return OM_MODELS.map(m=>{
    const g = suf => (d.hourly[`${suf}_${m.key}`] || d.hourly[suf] || []);
    const gd = suf => (d.daily[`${suf}_${m.key}`] || d.daily[suf] || []);
    const temps = g('temperature_2m');
    if(!temps.some(v=>v!=null)) return {id:m.key, name:m.name, ok:false};
    const hourly = new Map();
    times.forEach((t,i)=>{
      if(temps[i]==null) return;
      hourly.set(t, { tempC:temps[i], precip:(g('precipitation_probability')[i] ?? null), code:(g('weather_code')[i] ?? null) });
    });
    const daily = new Map();
    (d.daily.time||[]).forEach((date,i)=>{
      const hi = gd('temperature_2m_max')[i], lo = gd('temperature_2m_min')[i];
      if(hi==null&&lo==null) return;
      daily.set(date, { hiC:hi, loC:lo, precip:(gd('precipitation_probability_max')[i] ?? null), code:(gd('weather_code')[i] ?? null) });
    });
    const cur = {
      tempC: temps[nowIdx], feelsC: g('apparent_temperature')[nowIdx] ?? null,
      humidity: g('relative_humidity_2m')[nowIdx] ?? null,
      windKmh: g('wind_speed_10m')[nowIdx] ?? null,
      code: g('weather_code')[nowIdx] ?? null,
      precip: g('precipitation_probability')[nowIdx] ?? null
    };
    return {id:m.key, name:m.name, ok:true, current:cur, hourly, daily};
  });
}

/* ---- 2. NWS / weather.gov (US only) ---- */
function nwsCode(txt=''){
  const s = txt.toLowerCase();
  if(s.includes('thunder')) return 95;
  if(s.includes('snow')||s.includes('flurr')||s.includes('blizzard')) return 71;
  if(s.includes('sleet')||s.includes('ice')||s.includes('freezing')) return 67;
  if(s.includes('drizzle')) return 53;
  if(s.includes('rain')||s.includes('shower')) return 61;
  if(s.includes('fog')||s.includes('haze')||s.includes('smoke')) return 45;
  if(s.includes('mostly cloudy')||s.includes('overcast')) return 3;
  if(s.includes('partly')||s.includes('mostly sunny')||s.includes('mostly clear')) return 2;
  if(s.includes('sunny')||s.includes('clear')||s.includes('fair')) return 0;
  if(s.includes('cloud')) return 3;
  return null;
}
async function fetchNWS(lat, lon){
  const base = {id:'nws', name:'NWS · weather.gov'};
  try{
    const pt = await fetchJSON(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
    const [hf, df] = await Promise.all([
      fetchJSON(pt.properties.forecastHourly),
      fetchJSON(pt.properties.forecast)
    ]);
    const hourly = new Map();
    (hf.properties.periods||[]).forEach(p=>{
      const tC = p.temperatureUnit==='F' ? (p.temperature-32)*5/9 : p.temperature;
      hourly.set(epochHour(p.startTime), { tempC:tC, precip:(p.probabilityOfPrecipitation?.value ?? null), code:nwsCode(p.shortForecast) });
    });
    const daily = new Map();
    (df.properties.periods||[]).forEach(p=>{
      const date = p.startTime.slice(0,10);
      const tC = p.temperatureUnit==='F' ? (p.temperature-32)*5/9 : p.temperature;
      const rec = daily.get(date) || {hiC:null, loC:null, precip:null, code:null};
      if(p.isDaytime){ rec.hiC = tC; rec.code = nwsCode(p.shortForecast); }
      else { rec.loC = tC; if(rec.code==null) rec.code = nwsCode(p.shortForecast); }
      const pp = p.probabilityOfPrecipitation?.value;
      if(pp!=null) rec.precip = Math.max(rec.precip ?? 0, pp);
      daily.set(date, rec);
    });
    const first = (hf.properties.periods||[])[0];
    const current = first ? {
      tempC: first.temperatureUnit==='F' ? (first.temperature-32)*5/9 : first.temperature,
      feelsC:null,
      humidity: first.relativeHumidity?.value ?? null,
      windKmh: (parseFloat(first.windSpeed)||0) * 1.60934 || null,
      code: nwsCode(first.shortForecast),
      precip: first.probabilityOfPrecipitation?.value ?? null
    } : null;
    return {...base, ok:true, current, hourly, daily};
  }catch(e){ return {...base, ok:false}; }
}

/* ---- 3. MET Norway ---- */
function metCode(sym=''){
  const s = sym.split('_')[0];
  const map = { clearsky:0, fair:1, partlycloudy:2, cloudy:3, fog:45,
    lightrain:61, rain:63, heavyrain:65, lightrainshowers:80, rainshowers:80, heavyrainshowers:82,
    lightsleet:67, sleet:67, heavysleet:67, lightsleetshowers:67, sleetshowers:67, heavysleetshowers:67,
    lightsnow:71, snow:73, heavysnow:75, lightsnowshowers:85, snowshowers:85, heavysnowshowers:86 };
  if(s.includes('thunder')) return 95;
  return map[s] ?? null;
}
async function fetchMetNo(lat, lon){
  const base = {id:'metno', name:'MET Norway'};
  try{
    const d = await fetchJSON(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
    const ts = d.properties.timeseries || [];
    const hourly = new Map();
    const byDate = {};
    const fmt = new Intl.DateTimeFormat('en-CA', {timeZone: state.tz || undefined, year:'numeric', month:'2-digit', day:'2-digit'});
    ts.forEach(row=>{
      const det = row.data?.instant?.details; if(!det) return;
      const code = metCode(row.data?.next_1_hours?.summary?.symbol_code || row.data?.next_6_hours?.summary?.symbol_code || '');
      hourly.set(epochHour(row.time), { tempC:det.air_temperature, precip:null, code });
      const date = fmt.format(new Date(row.time));
      (byDate[date] = byDate[date] || {temps:[], codes:[]}).temps.push(det.air_temperature);
      if(code!=null) byDate[date].codes.push(code);
    });
    const daily = new Map();
    Object.entries(byDate).forEach(([date,v])=>{
      if(v.temps.length < 4) return; // partial day at the edges
      daily.set(date, { hiC:Math.max(...v.temps), loC:Math.min(...v.temps), precip:null, code:modeCode(v.codes) });
    });
    const cur = ts[0]?.data?.instant?.details;
    const current = cur ? { tempC:cur.air_temperature, feelsC:null, humidity:cur.relative_humidity ?? null,
      windKmh: cur.wind_speed!=null ? cur.wind_speed*3.6 : null, code: metCode(ts[0].data?.next_1_hours?.summary?.symbol_code||''), precip:null } : null;
    return {...base, ok:true, current, hourly, daily};
  }catch(e){ return {...base, ok:false}; }
}

/* ---- 4. Bright Sky (DWD — Germany only) ---- */
function bsCode(cond=''){
  const map = {'clear-day':0,'clear-night':0,'partly-cloudy-day':2,'partly-cloudy-night':2,cloudy:3,fog:45,rain:61,sleet:67,snow:71,hail:77,thunderstorm:95,wind:3,dry:1};
  return map[cond] ?? null;
}
async function fetchBrightSky(lat, lon){
  const base = {id:'brightsky', name:'Bright Sky · DWD'};
  if(lat<47 || lat>55.2 || lon<5.5 || lon>15.5) return null; // outside Germany — skip quietly
  try{
    const today = new Date(), last = new Date(Date.now()+15*864e5);
    const iso = d => d.toISOString().slice(0,10);
    const d = await fetchJSON(`https://api.brightsky.dev/weather?lat=${lat}&lon=${lon}&date=${iso(today)}&last_date=${iso(last)}`);
    const hourly = new Map(); const byDate = {};
    (d.weather||[]).forEach(w=>{
      if(w.temperature==null) return;
      const code = bsCode(w.icon || w.condition);
      hourly.set(epochHour(w.timestamp), { tempC:w.temperature, precip:(w.precipitation_probability ?? null), code });
      const date = w.timestamp.slice(0,10);
      (byDate[date] = byDate[date] || {temps:[], codes:[], pp:[]}).temps.push(w.temperature);
      if(code!=null) byDate[date].codes.push(code);
      if(w.precipitation_probability!=null) byDate[date].pp.push(w.precipitation_probability);
    });
    const daily = new Map();
    Object.entries(byDate).forEach(([date,v])=>{
      if(v.temps.length<4) return;
      daily.set(date, { hiC:Math.max(...v.temps), loC:Math.min(...v.temps), precip: v.pp.length?Math.max(...v.pp):null, code:modeCode(v.codes) });
    });
    const nowH = Math.floor(Date.now()/3600000);
    const c = hourly.get(nowH) || hourly.get(nowH+1);
    const current = c ? {tempC:c.tempC, feelsC:null, humidity:null, windKmh:null, code:c.code, precip:c.precip} : null;
    return {...base, ok:true, current, hourly, daily};
  }catch(e){ return {...base, ok:false}; }
}

/* =====================================================================
   BLEND — squeeze all sources into one consensus
   ===================================================================== */
async function loadWeather(){
  renderLoading();
  const {lat, lon} = state.loc;
  const results = await Promise.allSettled([
    fetchOpenMeteo(lat, lon),
    fetchNWS(lat, lon),
    fetchMetNo(lat, lon),
    fetchBrightSky(lat, lon)
  ]);
  let sources = [];
  results.forEach(r=>{
    if(r.status!=='fulfilled' || r.value==null) return;
    Array.isArray(r.value) ? sources.push(...r.value) : sources.push(r.value);
  });
  state.sources = sources;
  state.updated = Date.now();
  if(!sources.some(s=>s.ok)){
    $('#app').innerHTML = `<div class="msg"><h2>The lemon came up dry.</h2>
      Couldn't reach any weather source — check the connection and <button class="linkish" onclick="loadWeather()">try again</button>.</div>`;
    return;
  }
  renderApp();
}
const okSources = () => state.sources.filter(s=>s.ok);

function consensusCurrent(){
  const s = okSources().filter(x=>x.current && x.current.tempC!=null);
  const temps = s.map(x=>x.current.tempC);
  return {
    tempC: avg(temps),
    feelsC: avg(s.map(x=>x.current.feelsC)),
    humidity: avg(s.map(x=>x.current.humidity)),
    windKmh: avg(s.map(x=>x.current.windKmh)),
    code: pickWeatherCode(s.map(x=>x.current.code), avg(s.map(x=>x.current.precip))),
    spreadC: temps.length>1 ? Math.max(...temps)-Math.min(...temps) : 0,
    count: s.length
  };
}
function consensusHourly(hours=24){
  const start = Math.floor(Date.now()/3600000);
  const out = [];
  for(let h=start; h<start+hours; h++){
    const rows = okSources().map(s=>s.hourly?.get(h)).filter(Boolean);
    if(!rows.length) continue;
    out.push({ epochH:h, tempC:avg(rows.map(r=>r.tempC)), precip:avg(rows.map(r=>r.precip)),
      code:pickWeatherCode(rows.map(r=>r.code), avg(rows.map(r=>r.precip))), count:rows.length });
  }
  return out;
}
function consensusDaily(days=16){
  const dates = new Set();
  okSources().forEach(s=> s.daily && [...s.daily.keys()].forEach(d=>dates.add(d)));
  const todayStr = new Intl.DateTimeFormat('en-CA',{timeZone:state.tz||undefined}).format(new Date());
  return [...dates].filter(d=>d>=todayStr).sort().slice(0,days).map(date=>{
    const rows = okSources().map(s=>s.daily?.get(date)).filter(Boolean);
    return { date, hiC:avg(rows.map(r=>r.hiC)), loC:avg(rows.map(r=>r.loC)),
      precip:avg(rows.map(r=>r.precip)), code:representativeDailyCode(date, rows), count:rows.length };
  }).filter(d=>d.hiC!=null||d.loC!=null);
}

/* =====================================================================
   RENDER
   ===================================================================== */
const T = c => c==null ? '—' : Math.round(state.unit==='F' ? cToF(c) : c);
const W = k => k==null ? '—' : Math.round(state.unit==='F' ? kmhToMph(k) : k);
const windUnit = () => state.unit==='F' ? 'mph' : 'km/h';
const degSpread = c => (state.unit==='F' ? c*9/5 : c);

function lemonSpinner(){
  return `<svg class="spin" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="42" fill="var(--zest)" stroke="var(--ink)" stroke-width="5"/>
    <circle cx="50" cy="50" r="29" fill="var(--pith)"/>
    <g stroke="var(--zest)" stroke-width="6" stroke-linecap="round">
      <path d="M50 27v46M27 50h46M34 34l32 32M66 34L34 66"/></g></svg>`;
}
function renderLoading(){
  $('#app').innerHTML = `<div class="msg">${lemonSpinner()}<h2>Squeezing the sources…</h2>ECMWF · GFS · ICON · UKMO · Météo-France · NWS · MET Norway · corrected icons</div>`;
}

function renderLocationScreen(){
  const insecure = !window.isSecureContext;
  $('#app').innerHTML = `
    <div class="locscreen">
      <h1>Where are you, Lemons?</h1>
      <p>Pick a spot and I'll blend every free forecast model I can reach into one juicy consensus.</p>
      <button class="btn" id="geobtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/></svg>
        Use my location</button>
      <div id="locerror" class="locerror" role="status">${insecure ? 'Location is blocked because this file is open locally/content://. Publish it to GitHub Pages HTTPS or run it on localhost.' : ''}</div>
      <span class="or">or search</span>
      <div class="searchbox">
        <input id="citysearch" type="search" placeholder="City, town, or ZIP…" autocomplete="off" aria-label="Search for a city, town, or ZIP code">
        <ul class="results" id="cityresults"></ul>
      </div>
      <p class="lochelp">Search now checks Open-Meteo/GeoNames first, then OpenStreetMap for smaller US towns and ZIPs. Try things like <b>Ferndale MI</b>, <b>Lakewood OH</b>, or <b>48220</b>.</p>
    </div>`;
  $('#geobtn').addEventListener('click', geolocate);
  const input = $('#citysearch');
  let deb;
  input.addEventListener('input', ()=>{ clearTimeout(deb); deb = setTimeout(()=>searchCity(input.value.trim()), 700); });
}
function setLocError(msg){ const el = $('#locerror'); if(el) el.textContent = msg || ''; }
async function geolocate(){
  const btn = $('#geobtn');
  if(!navigator.geolocation){ setLocError('This browser does not support location. Use search instead.'); return; }
  if(!window.isSecureContext){
    setLocError('Chrome blocks location on local/content:// files. Upload to GitHub Pages and open the https:// URL, or run a local localhost server.');
    if(btn) btn.textContent = 'Location needs HTTPS';
    return;
  }
  try{
    if(navigator.permissions){
      const p = await navigator.permissions.query({name:'geolocation'});
      if(p.state === 'denied'){
        setLocError('Location is denied for this browser/site. Tap the lock icon or site settings and allow Location, or use search.');
        if(btn) btn.textContent = 'Location denied — use search';
        return;
      }
    }
  }catch(e){}
  if(btn) btn.textContent = 'Locating…';
  setLocError('');
  navigator.geolocation.getCurrentPosition(async pos=>{
    const {latitude:lat, longitude:lon} = pos.coords;
    let name = 'My location', admin = '';
    try{
      const g = await fetchJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
      name = g.city || g.locality || g.localityInfo?.administrative?.[0]?.name || name;
      admin = g.principalSubdivision || g.countryName || '';
    }catch(e){
      try{
        const n = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1&accept-language=en`);
        name = n.address?.city || n.address?.town || n.address?.village || n.address?.hamlet || n.name || name;
        admin = n.address?.state || n.address?.country || '';
      }catch(_e){}
    }
    setLocation({lat, lon, name, admin});
  }, err=>{
    const insecure = !window.isSecureContext;
    const msg = insecure ? 'Location is blocked on local/content:// files. Use the GitHub Pages https:// link.'
      : err.code === 1 ? 'Location blocked. Allow Location in browser/site settings, or use search.'
      : err.code === 2 ? 'Your device could not find a position. Try Wi‑Fi/GPS or use search.'
      : 'Location timed out. Try again or use search.';
    setLocError(msg);
    if(btn) btn.textContent = 'Use my location';
  }, {enableHighAccuracy:true, timeout:15000, maximumAge:300000});
}
function normalizePlace(r, source){
  if(source === 'nominatim'){
    const a = r.address || {};
    const name = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || r.name || (r.display_name||'').split(',')[0];
    const admin = [a.state, a.country_code ? a.country_code.toUpperCase() : ''].filter(Boolean).join(', ');
    return {lat:+r.lat, lon:+r.lon, name, admin, source:'OpenStreetMap'};
  }
  return {lat:r.latitude, lon:r.longitude, name:r.name, admin:[r.admin1, r.admin2, r.country_code].filter(Boolean).join(', '), source:'Open-Meteo'};
}
function dedupePlaces(list){
  const seen = new Set(), out = [];
  for(const p of list){
    if(!p || !isFinite(p.lat) || !isFinite(p.lon) || !p.name) continue;
    const key = `${p.name.toLowerCase()}|${(p.admin||'').toLowerCase()}|${p.lat.toFixed(2)}|${p.lon.toFixed(2)}`;
    if(seen.has(key)) continue;
    seen.add(key); out.push(p);
  }
  return out.slice(0,40);
}
async function searchCity(q){
  const ul = $('#cityresults'); if(!ul) return;
  if(q.length<2){ ul.innerHTML=''; return; }
  ul.innerHTML = `<li><button disabled>Searching the map…</button></li>`;
  const enc = encodeURIComponent(q);
  const jobs = [
    fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${enc}&count=100&language=en&format=json`).then(d => (d.results||[]).map(r=>normalizePlace(r,'openmeteo'))),
    fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${enc}&count=100&language=en&format=json&countryCode=US`).then(d => (d.results||[]).map(r=>normalizePlace(r,'openmeteo')))
  ];
  if(q.length >= 3){
    jobs.push(fetchJSON(`https://nominatim.openstreetmap.org/search?q=${enc}&format=jsonv2&addressdetails=1&limit=25&countrycodes=us&accept-language=en`, {}, 10000).then(d => (d||[]).map(r=>normalizePlace(r,'nominatim'))));
  }
  try{
    const settled = await Promise.allSettled(jobs);
    const places = dedupePlaces(settled.flatMap(x => x.status === 'fulfilled' ? x.value : []));
    window.__lemonsPlaces = places;
    ul.innerHTML = places.map((r,i)=>
      `<li><button data-i="${i}">${esc(r.name)} <span class="cc">${esc(r.admin)} · ${esc(r.source)}</span></button></li>`).join('')
      || `<li><button disabled>No luck — try town + state or a ZIP code</button></li>`;
    ul.querySelectorAll('button[data-i]').forEach(b=>b.addEventListener('click', ()=>{
      const r = window.__lemonsPlaces[+b.dataset.i];
      setLocation({lat:r.lat, lon:r.lon, name:r.name, admin:r.admin});
    }));
  }catch(e){ ul.innerHTML = `<li><button disabled>Search failed — try again</button></li>`; }
}
function setLocation(loc){
  state.loc = loc; store.set('lemons.loc', loc);
  if(state.radar){ state.radar.destroy(); state.radar = null; }
  loadWeather();
}

function renderApp(){
  const cur = consensusCurrent();
  const daily = consensusDaily(16);
  const today = daily[0];
  const app = $('#app');
  app.innerHTML = `
    <div class="locrow">
      <div class="locname">${esc(state.loc.name)}${state.loc.admin?`<span class="sub">${esc(state.loc.admin)}</span>`:''}</div>
      <button class="linkish" id="changeloc">change location</button>
    </div>
    <nav class="tabs" role="tablist" aria-label="Forecast views">
      ${['current','hourly','daily','radar'].map(t=>
        `<button role="tab" data-tab="${t}" aria-selected="${state.tab===t}">${t[0].toUpperCase()+t.slice(1)}</button>`).join('')}
    </nav>
    <div class="swipehint" aria-hidden="true">swipe left / right to switch</div>
    <section id="view-current" class="panelview" role="tabpanel"></section>
    <section id="view-hourly" class="panelview" role="tabpanel"></section>
    <section id="view-daily" class="panelview" role="tabpanel"></section>
    <section id="view-radar" class="panelview" role="tabpanel">
      <div class="radarwrap">
        <div id="map" aria-label="Precipitation radar map"></div>
        <div class="radarui">
          <button class="playbtn" id="radarplay" aria-label="Play radar animation">
            <svg id="playicon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>
          </button>
          <input class="scrub" id="radarscrub" type="range" min="0" max="0" value="0" aria-label="Radar frame">
          <span class="frametime" id="radartime">—</span>
        </div>
        <p class="radarnote">Past two hours of precipitation plus a short nowcast. Tiles by RainViewer.</p>
        <p class="mapcredit">Basemap © OpenStreetMap/CARTO · radar © RainViewer</p>
      </div>
    </section>`;

  $('#changeloc').addEventListener('click', renderLocationScreen);
  app.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click', ()=>switchTab(b.dataset.tab)));
  initSwipeNav(app);

  renderCurrent(cur, today);
  renderHourly();
  renderDaily(daily);
  switchTab(state.tab);
}

function renderCurrent(cur, today){
  const chips = state.sources.map(s=>{
    if(s.ok===false) return `<span class="chip err">${esc(s.name)}</span>`;
    if(!s.current || s.current.tempC==null) return '';
    return `<span class="chip">${esc(s.name)} <span class="t">${T(s.current.tempC)}°</span></span>`;
  }).join('');
  const spread = degSpread(cur.spreadC||0);
  $('#view-current').innerHTML = `
    <div class="current">
      <div class="bigtemp">${T(cur.tempC)}<sup>°${state.unit}</sup></div>
      <div class="cond">${iconFor(cur.code,22)} ${codeLabel(cur.code)}</div>
      ${today?`<div class="hilo">H ${T(today.hiC)}° · L ${T(today.loC)}°</div>`:''}
      <div class="statrow">
        <div class="stat"><div class="k">Feels like</div><div class="v">${T(cur.feelsC ?? cur.tempC)}°</div></div>
        <div class="stat"><div class="k">Humidity</div><div class="v">${cur.humidity!=null?Math.round(cur.humidity):'—'}<small>%</small></div></div>
        <div class="stat"><div class="k">Wind</div><div class="v">${W(cur.windKmh)}<small> ${windUnit()}</small></div></div>
      </div>
    </div>
    <div class="opinions">
      <h3>Second opinions</h3>
      <p class="agree">${cur.count} sources squeezed · they agree within <b>${spread.toFixed(1)}°</b></p>
      <div class="chips">${chips}</div>
    </div>`;
}

function renderHourly(){
  const hours = consensusHourly(state.hourlyHours);
  const timeFmt = new Intl.DateTimeFormat('en-US', {hour:'numeric', timeZone: state.tz || undefined});
  const dowFmt = new Intl.DateTimeFormat('en-US', {weekday:'short', timeZone: state.tz || undefined});
  const dateFmt = new Intl.DateTimeFormat('en-US', {month:'numeric', day:'numeric', timeZone: state.tz || undefined});
  const counts = hours.map(h=>h.count);
  let lastDate = '';
  $('#view-hourly').innerHTML = `
    <div class="hourlyhead">
      <h2>${state.hourlyHours}-hour lemon table</h2>
      <div class="hrange" role="group" aria-label="Hourly forecast range">
        ${[24,48,72].map(n=>`<button data-hours="${n}" aria-pressed="${state.hourlyHours===n}">${n}h</button>`).join('')}
      </div>
    </div>
    <div class="hscroll">
      ${hours.map((h,i)=>{
        const d = new Date(h.epochH*3600000);
        const dateKey = dateFmt.format(d);
        const isNewDay = i>0 && dateKey !== lastDate;
        lastDate = dateKey;
        return `<div class="hcol${i===0?' now':''}${isNewDay?' newday':''}">
          <div class="dow">${i===0?'Now':esc(dowFmt.format(d))}</div>
          <div class="date">${esc(dateKey)}</div>
          <div class="h">${esc(timeFmt.format(d))}</div>
          ${iconFor(h.code,22)}
          <div class="t">${T(h.tempC)}°</div>
          <div class="p">${h.precip!=null&&h.precip>=5?Math.round(h.precip)+'%':''}</div>
        </div>`}).join('')}
    </div>
    <p class="blendnote">Each hour is the average of ${counts.length?Math.min(...counts):0}–${counts.length?Math.max(...counts):0} available models. Green % is chance of precipitation.</p>`;
  $('#view-hourly').querySelectorAll('[data-hours]').forEach(b=>b.addEventListener('click', ()=>{
    state.hourlyHours = +b.dataset.hours; store.set('lemons.hourlyHours', state.hourlyHours); renderHourly();
  }));
}

function renderDaily(daily){
  if(!daily.length){ $('#view-daily').innerHTML = `<div class="msg">No daily data came back.</div>`; return; }
  const allLo = Math.min(...daily.map(d=>d.loC ?? d.hiC));
  const allHi = Math.max(...daily.map(d=>d.hiC ?? d.loC));
  const span = Math.max(allHi-allLo, 1);
  const dayFmt = new Intl.DateTimeFormat('en-US', {weekday:'short'});
  const dateFmt = new Intl.DateTimeFormat('en-US', {month:'short', day:'numeric'});
  const todayStr = new Intl.DateTimeFormat('en-CA',{timeZone:state.tz||undefined}).format(new Date());
  $('#view-daily').innerHTML = `
    <div class="days">
      ${daily.map(d=>{
        const dt = new Date(d.date+'T12:00:00');
        const lo = d.loC ?? d.hiC, hi = d.hiC ?? d.loC;
        const left = ((lo-allLo)/span*100).toFixed(1), width = Math.max(((hi-lo)/span*100),4).toFixed(1);
        return `<div class="dayrow">
          <span class="d">${d.date===todayStr?'Today':esc(dayFmt.format(dt))}<span class="date">${esc(dateFmt.format(dt))}</span></span>
          ${iconFor(d.code,24)}
          <span class="p">${d.precip!=null&&d.precip>=5?Math.round(d.precip)+'%':''}</span>
          <span class="range"><span class="lo">${T(lo)}°</span>
            <span class="rangebar"><i style="left:${left}%;width:${width}%"></i></span>
            <span class="hi">${T(hi)}°</span></span>
        </div>`;}).join('')}
    </div>
    <p class="blendnote">Highs and lows averaged across every source with an opinion that day. Free no-key forecast data is shown out to 16 days.</p>`;
}

/* ---------- mobile swipe between sections ---------- */
function initSwipeNav(el){
  const tabs = ['current','hourly','daily','radar'];
  let startX=0, startY=0, startT=0, tracking=false;
  const ignore = target => !!target.closest('button,input,select,textarea,a,.hscroll,#map,.leaflet-container,.scrub');
  el.addEventListener('touchstart', e=>{
    if(e.touches.length !== 1 || ignore(e.target)) return;
    tracking = true;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startT = Date.now();
  }, {passive:true});
  el.addEventListener('touchend', e=>{
    if(!tracking || !e.changedTouches.length) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    const fastEnough = Date.now() - startT < 800;
    if(!fastEnough || Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy)*1.35) return;
    const i = tabs.indexOf(state.tab);
    const next = dx < 0 ? Math.min(i+1, tabs.length-1) : Math.max(i-1, 0);
    if(next !== i) switchTab(tabs[next]);
  }, {passive:true});
}

/* ---------- tabs ---------- */
function switchTab(tab){
  state.tab = tab;
  document.querySelectorAll('nav.tabs [data-tab]').forEach(b=>b.setAttribute('aria-selected', b.dataset.tab===tab));
  document.querySelectorAll('.panelview').forEach(p=>p.classList.remove('active'));
  const view = $('#view-'+tab); if(view) view.classList.add('active');
  if(tab==='radar') initRadar();
}

/* ---------- radar (Leaflet + RainViewer) ---------- */
function initRadar(){
  if(state.radar){ state.radar.map.invalidateSize(); return; }
  if(typeof L === 'undefined'){ $('#map').innerHTML = '<p class="msg">Map library failed to load.</p>'; return; }
  const map = L.map('map', {zoomControl:true, attributionControl:true}).setView([state.loc.lat, state.loc.lon], 7);
  setTimeout(()=>map.invalidateSize(), 80);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {maxZoom:12, subdomains:'abcd', attribution:'&copy; OpenStreetMap & CARTO'}).addTo(map);
  L.circleMarker([state.loc.lat, state.loc.lon], {radius:6, color:'#23241B', weight:2, fillColor:'#F4CE3E', fillOpacity:1}).addTo(map);

  const radar = state.radar = { map, frames:[], layers:{}, idx:0, playing:false, timer:null,
    destroy(){ clearInterval(this.timer); this.map.remove(); } };

  fetchJSON('https://api.rainviewer.com/public/weather-maps.json').then(d=>{
    radar.frames = [...(d.radar?.past||[]), ...(d.radar?.nowcast||[])];
    radar.host = d.host || 'https://tilecache.rainviewer.com';
    if(!radar.frames.length){ $('#radartime').textContent = 'no data'; return; }
    const scrub = $('#radarscrub');
    scrub.max = radar.frames.length-1;
    radar.idx = Math.max(0, (d.radar?.past||[]).length-1); // most recent observed frame
    scrub.value = radar.idx;
    showFrame(radar.idx);
    scrub.addEventListener('input', ()=>{ stopRadar(); showFrame(+scrub.value); });
    $('#radarplay').addEventListener('click', ()=> radar.playing ? stopRadar() : playRadar());
  }).catch(()=>{ $('#radartime').textContent = 'radar offline'; });

  function layerFor(i){
    const f = radar.frames[i];
    if(!radar.layers[f.path]){
      radar.layers[f.path] = L.tileLayer(`${radar.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {opacity:0, maxZoom:12, tileSize:256, crossOrigin:true, attribution:'Radar &copy; RainViewer'});
    }
    return radar.layers[f.path];
  }
  function showFrame(i){
    radar.idx = i;
    const active = layerFor(i);
    if(!radar.map.hasLayer(active)) active.addTo(radar.map);
    active.setOpacity(0.75);
    Object.values(radar.layers).forEach(l=>{ if(l!==active) l.setOpacity(0); });
    layerFor(Math.min(i+1, radar.frames.length-1)); // preload next
    $('#radarscrub').value = i;
    const t = new Date(radar.frames[i].time*1000);
    const isNowcast = radar.frames[i].time*1000 > Date.now();
    $('#radartime').textContent = (isNowcast?'+':'') + t.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
  }
  function playRadar(){
    radar.playing = true;
    $('#playicon').innerHTML = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
    $('#radarplay').setAttribute('aria-label','Pause radar animation');
    radar.timer = setInterval(()=> showFrame((radar.idx+1) % radar.frames.length), 600);
  }
  function stopRadar(){
    radar.playing = false; clearInterval(radar.timer);
    $('#playicon').innerHTML = '<path d="M7 4.5v15l13-7.5z"/>';
    $('#radarplay').setAttribute('aria-label','Play radar animation');
  }
}

/* ---------- unit toggle ---------- */
function setUnit(u){
  state.unit = u; store.set('lemons.unit', u);
  $('#unitF').setAttribute('aria-pressed', u==='F');
  $('#unitC').setAttribute('aria-pressed', u==='C');
  if(state.loc && okSources().length) renderApp();
}
$('#unitF').addEventListener('click', ()=>setUnit('F'));
$('#unitC').addEventListener('click', ()=>setUnit('C'));

/* ---------- intro ---------- */
(function intro(){
  const el = $('#intro');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reduced){ el.remove(); return; }
  const timers = [
    setTimeout(()=>el.classList.add('cut'), 700),
    setTimeout(()=>el.classList.add('open'), 1050),
    setTimeout(finish, 1950)
  ];
  el.addEventListener('click', finish, {once:false});
  function finish(){
    timers.forEach(clearTimeout);
    el.classList.add('open','done');
    setTimeout(()=>el.remove(), 300);
  }
})();

/* ---------- boot ---------- */
if(state.loc) loadWeather(); else renderLocationScreen();