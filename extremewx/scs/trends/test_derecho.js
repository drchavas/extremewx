/* Derecho event mode in scstrend.html. The things worth testing are the ones a
   screenshot would not catch: that the envelope encloses what it claims to, that
   the clock survives events running past UTC midnight, and that switching in and
   out of event mode leaves the time-series machinery intact. */
const fs=require('fs'), zlib=require('zlib'), path=require('path'), {JSDOM}=require('jsdom');
const ROOT=process.argv[2];
const html=fs.readFileSync(path.join(ROOT,'scstrend.html'),'utf8');
const errors=[];
const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,
                          url:'http://localhost/extremewx/scs/trends/scstrend.html'});
const w=dom.window;
w.fetch=async u=>{const p=path.join(ROOT,u);
  if(!fs.existsSync(p)) throw new Error('404 '+u);
  const b=fs.readFileSync(p);
  return{ok:true,status:200,json:async()=>JSON.parse(b.toString()),arrayBuffer:async()=>b};};
w.DecompressionStream=function(){};
w.Blob=class{constructor(p){this.parts=p} stream(){return this} pipeThrough(){return this}};
w.Response=class{constructor(x){this.x=x} async text(){return zlib.gunzipSync(Buffer.from(this.x.parts[0])).toString()}};
w.URL.createObjectURL=()=>'blob:x'; w.URL.revokeObjectURL=()=>{};
w.navigator.clipboard={writeText:async()=>{}};
w.topojson=require(path.join(process.env.NODE_PATH,'topojson-client'));

const maps=[];
const B={getSouth:()=>24,getNorth:()=>50,getWest:()=>-126,getEast:()=>-66,
         getCenter:()=>({lat:39,lng:-96}),pad(){return this}};
function mkMap(id){
  const h={};
  const m={id,_c:{lat:39.8,lng:-86.3},_z:6,_layers:[],_fit:0,_bounds:null,
    setView(c,z){this._c=Array.isArray(c)?{lat:c[0],lng:c[1]}:c;if(z!=null)this._z=z;
                 (h.move||[]).forEach(f=>f());return this},
    fitBounds(b){this._fit++;this._bounds=b;this._z=7;(h.move||[]).forEach(f=>f());return this},
    getCenter(){return this._c},getZoom(){return this._z},
    on(e,f){e.split(' ').forEach(x=>(h[x]=h[x]||[]).push(f))},
    removeLayer(l){this._layers=this._layers.filter(x=>x!==l)},
    addLayer(l){this._layers.push(l)},eachLayer(cb){this._layers.slice().forEach(cb)},
    invalidateSize(){},_h:h};
  maps.push(m);return m;
}
w.L={map:mkMap,
  tileLayer:()=>({addTo(m){m.addLayer(this);return this}}),
  layerGroup:()=>({_marks:[],_polys:[],addTo(m){m.addLayer(this);return this}}),
  circleMarker:(ll,o)=>({_ll:ll,_o:o,bindTooltip(f){this._tip=f;return this},
    on(){return this},addTo(g){g._marks.push(this);return this}}),
  polygon:(ll,o)=>({_ll:ll,_o:o,addTo(g){g._polys.push(this);return this}}),
  polyline:(ll,o)=>({_ll:ll,_o:o,_line:true,addTo(g){(g._lines=g._lines||[]).push(this);return this}}),
  DomEvent:{stop(){}},TileLayer:function(){},
  geoJSON:(d,o)=>{const ls=[];
    if(d&&d.features&&o&&o.onEachFeature)d.features.forEach(f=>{const l={feature:f,_h:{},
      _style:(typeof o.style==='function'?o.style(f):o.style),
      on(e,fn){this._h[e]=fn},bindTooltip(fn){this._tip=fn;return this},
      setStyle(){},getBounds:()=>B};
      ls.push(l);o.onEachFeature(f,l);});
    return{_data:d,_layers:ls,_restyled:0,addTo(m){m.addLayer(this);return this},
           getLayers(){return ls},setStyle(){this._restyled++},
           bringToFront(){},getBounds:()=>B};}};
w.L.TileLayer.prototype={};
w.addEventListener('error',e=>errors.push('window error: '+e.message));
process.on('unhandledRejection',e=>errors.push('unhandled rejection: '+(e&&e.message)));
w.eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);

const $=id=>w.document.getElementById(id);
const fire=(id,t)=>{const e=$(id);const h=e['on'+t];if(h)return h.call(e,{target:e});};
const say=(l,ok,x)=>console.log((ok?'  ok   ':'  FAIL ')+l+(x?'  — '+x:''));
const isCounty=l=>l._data&&l._data.features&&l._data.features.length>3000;
const grp=()=>maps[0]._layers.filter(l=>l._polys).pop();
const ptInRing=(x,y,ring)=>{let c=false;
  for(let i=0,n=ring.length;i<n;i++){const [x1,y1]=ring[i],[x2,y2]=ring[(i+1)%n];
    if(((y1>y)!==(y2>y))&&x<(x2-x1)*(y-y1)/(y2-y1)+x1)c=!c;}
  return c;};

(async()=>{
  await new Promise(r=>setTimeout(r,3200));
  const [A,Bm]=maps;

  console.log('\n--- entering event mode');
  say('Derecho is in the hazard menu',
      [...$('hazSel').options].some(o=>o.value==='derecho'),
      [...$('hazSel').options].map(o=>o.value).join(','));
  $('hazSel').value='derecho'; await $('hazSel').onchange({target:{value:'derecho'}});
  await new Promise(r=>setTimeout(r,900));
  say('trend column hidden',$('trendCol').style.display==='none');
  say('timeseries panels hidden',$('panels').style.display==='none');
  say('county fills removed',!A._layers.some(isCounty));
  say('menu relabelled Derecho',
      w.document.querySelector('label[for="ctySel"]').textContent==='Derecho',
      w.document.querySelector('label[for="ctySel"]').textContent);
  say('opens on the Corn Belt derecho',$('ctySel').value==='definitive-069',$('ctySel').value);
  say('and its readout is already drawn',/10 Aug 2020/.test($('foot').innerHTML));
  const stl=maps[0]._layers.filter(l=>l._data&&l._data.features&&l._data.features.length<200)[0];
  const stStyleOf=ab=>w.eval(`stStyle({properties:{STUSPS:'${ab}'}})`);
  say('state borders are white',stStyleOf('IA').color==='#fff',stStyleOf('IA').color);
  say('white even for the selected state',stStyleOf($('regSel').value||'IN').color==='#fff',
      'region="'+$('regSel').value+'"');
  say('borders do not hit-test over the reports',stStyleOf('IA').fill===false,
      'fill='+stStyleOf('IA').fill);
  say('state layers actually restyled, not just the function',stl&&stl._restyled>0,
      'setStyle calls: '+(stl&&stl._restyled));
  const opts=[...$('ctySel').options].slice(1);
  say('the 96 definitive swaths are listed',opts.length===96,opts.length+' swaths');
  say('newest first',/2025/.test(opts[0].textContent),opts[0].textContent);
  say('menu labels carry track length',/\d+ km/.test(opts[0].textContent));
  say('footer credits the SPC archive',/Squitieri, Wade and Jirak \(2026\)/.test($('foot').innerHTML));
  say('the window opens to the full archive',
      $('y0In').value==='1956'&&$('y1In').value==='2025',
      $('y0In').value+'-'+$('y1In').value);
  say('confidence menu defaults to definitive',
      $('tierWrap').style.display===''&&$('tierSel').value==='firm',$('tierSel').value);

  console.log('\n--- the 10 Aug 2020 Corn Belt derecho');
  $('ctySel').value='definitive-069'; fire('ctySel','change');
  await new Promise(r=>setTimeout(r,200));
  const g=grp();
  say('envelope drawn',g._polys.length>=1,g._polys.length+' rings');
  say('envelope is dashed and closed',!!g._polys[0]._o.dashArray&&g._polys[0]._ll.length>=4,
      g._polys[0]._ll.length+' vertices');
  /* The union of disks must hug the reports. A convex hull spanned 873,000 km2
     to reach two stray reports; anything near that is the hull coming back. */
  const ringArea=ll=>{let a=0;for(let i=0;i<ll.length;i++){const [y1,x1]=ll[i],[y2,x2]=ll[(i+1)%ll.length];
    a+=(x1*111*Math.cos(y1*Math.PI/180))*(y2*111)-(x2*111*Math.cos(y2*Math.PI/180))*(y1*111);}
    return Math.abs(a/2);};
  const area=g._polys.reduce((s,p)=>s+ringArea(p._ll),0);
  say('envelope hugs the reports, not a convex hull',area<600000,
      Math.round(area).toLocaleString()+' km2 (hull was ~873,000)');
  say('reports plotted',g._marks.length>400,g._marks.length+' markers');
  say("the archive's own track drawn",g._lines&&g._lines.length===1&&g._lines[0]._ll.length===2,
      (g._lines||[]).length+' polylines');
  say('map framed on the swath',A._fit>0&&Bm.getZoom()===A.getZoom(),'z'+A.getZoom());

  // the claim the envelope makes is that it encloses the qualifying reports
  const ev=w.eval("JSON.parse(JSON.stringify(curEvent()))");
  const min=w.eval("thrSpec().min"), tk=w.eval("thrSpec().key");

  const onEdge=(x,y,rg)=>rg.some((p,i)=>{const [x1,y1]=p,[x2,y2]=rg[(i+1)%rg.length];
    return Math.abs((x2-x1)*(y-y1)-(y2-y1)*(x-x1))<1e-9&&
      x>=Math.min(x1,x2)-1e-9&&x<=Math.max(x1,x2)+1e-9&&
      y>=Math.min(y1,y2)-1e-9&&y<=Math.max(y1,y2)+1e-9;});
  const qual=ev.reports.filter(r=>r.d&&r.kt>=min);
  const rings=ev.hull[tk];
  const out=qual.filter(r=>!rings.some(rg=>ptInRing(r.lo,r.la,rg)||
                            onEdge(r.lo,r.la,rg)||rg.some(p=>p[0]===r.lo&&p[1]===r.la)));
  say('every swath report is inside the envelope',out.length===0,
      out.length+' outside of '+qual.length);
  say('off-swath reports kept but greyed',ev.reports.some(r=>!r.d),
      ev.reports.filter(r=>!r.d).length+' greyed of '+ev.nall);
  /* The specific bug: a report 700 km downstream 4 minutes into a 13 h event. */
  const impossible=ev.reports.filter(r=>r.d&&r.la>44.5);
  say('the northern outliers are out of the swath',impossible.length===0,
      impossible.length+' swath reports north of 44.5N');
  /* The whole point of moving to the archive: reports are selected by the
     paper's published window, so none can fall outside it. */
  const late=ev.reports.filter(r=>r.t<0||r.t>ev.hours*60+60);
  say("no report falls outside the archive's window",late.length===0,
      late.length+' outside a '+ev.hours+' h window');

  console.log('\n--- the readout');
  const foot=$('foot').innerHTML;
  say("the archive's own start and stop shown",/13:16Z/.test(foot)&&/02:44Z/.test(foot),
      (foot.match(/\d\d:\d\dZ[^<]*/)||[''])[0].trim());
  say('crossing UTC midnight names the next day',/→ <\/b>?\s*\d\d:\d\dZ 11 Aug|→ 0\d:\d\dZ 11 Aug/.test(foot)
      ||/11 Aug/.test(foot), (foot.match(/→ [^<]*/)||[''])[0]);
  say('duration and track length given',/over <b>13 h<\/b>/.test(foot)&&/1,111 km/.test(foot),
      (foot.match(/[\d,]+ km<\/b> over <b>\d+ h/)||[''])[0]);
  say('tier named',/Definitive/.test(foot));
  say('peak gust given',/peak <b>126 kt<\/b>/.test(foot));
  say('archive is credited',/Squitieri, Wade and Jirak \(2026\)/.test(foot));
  say('gust colour bar shown',/gust, kt/.test($('cbClim').innerHTML));
  say('trend colour bar cleared',$('cbTrend').innerHTML==='');

  console.log('\n--- threshold changes the envelope');
  const areaOf=()=>{const ringArea=ll=>{let a=0;
    for(let i=0;i<ll.length;i++){const [y1,x1]=ll[i],[y2,x2]=ll[(i+1)%ll.length];
      a+=(x1*111*Math.cos(y1*Math.PI/180))*(y2*111)-(x2*111*Math.cos(y2*Math.PI/180))*(y1*111);}
    return Math.abs(a/2);};
    return grp()._polys.reduce((s,p)=>s+ringArea(p._ll),0);};
  const a0=areaOf();
  $('thrSel').value=2; fire('thrSel','change');
  await new Promise(r=>setTimeout(r,200));
  /* Fewer reports meet a stricter threshold, so the union legitimately comes
     apart into several pieces — a convex hull could never do that, which is
     rather the point. */
  say('envelope redrawn for >=74 kt',grp()._polys.length>=1,grp()._polys.length+' rings');
  say('a stricter threshold does not enlarge it',areaOf()<=a0,
      Math.round(a0).toLocaleString()+' -> '+Math.round(areaOf()).toLocaleString()+' km2');
  $('thrSel').value=0; fire('thrSel','change');

  console.log('\n--- the year window filters the list');
  $('y0In').value=2020; fire('y0In','change');
  await new Promise(r=>setTimeout(r,200));
  const yy=[...$('ctySel').options].slice(1).map(o=>+o.textContent.match(/(\d{4})/)[1]);
  say('only 2020+ swaths listed',yy.length>0&&yy.every(y=>y>=2020),
      yy.length+' swaths, earliest '+Math.min(...yy));
  $('y0In').value=1956; fire('y0In','change');

  console.log('\n--- confidence tiers');
  $('tierSel').value='all'; fire('tierSel','change');
  await new Promise(r=>setTimeout(r,200));
  say('all 184 swaths available',[...$('ctySel').options].slice(1).length===184,
      [...$('ctySel').options].slice(1).length+'');
  say('non-definitive tiers are labelled',
      [...$('ctySel').options].some(o=>/\[(Likely|Possible|Hybrid)\]/.test(o.textContent)),
      ([...$('ctySel').options].map(o=>o.textContent).find(x=>/\[/.test(x))||'').slice(0,52));
  $('tierSel').value='head'; fire('tierSel','change');
  await new Promise(r=>setTimeout(r,200));
  say('definitive+likely gives 144',[...$('ctySel').options].slice(1).length===144,
      [...$('ctySel').options].slice(1).length+'');
  say('narrowing kept a valid selection',$('ctySel').value!==''&&
      [...$('ctySel').options].some(o=>o.value===$('ctySel').value),$('ctySel').value);
  /* A pre-NEXRAD swath has to stay drawable even where the report record does
     not reach it -- that is the point of carrying the archive's own track. */
  $('tierSel').value='all'; fire('tierSel','change');
  // page-level `const HZ` is not reachable from outside the eval; only function
  // declarations are, so go through the accessor the page already exposes
  const ids=JSON.parse(w.eval(
    "JSON.stringify(eventsInWindow().filter(e=>!e.reports.length).map(e=>e.id))"));
  say('seven swaths have no reports, as expected',ids.length===7,ids.length+': '+ids.join(' '));
  $('ctySel').value=ids[0]; fire('ctySel','change');
  await new Promise(r=>setTimeout(r,200));
  const g2=grp();
  say('a reportless swath still draws its track',g2._lines&&g2._lines.length===1);
  say('and says why it is empty',/No wind reports are available/.test($('foot').innerHTML));
  say('the 1993 gap is named',/June and July 1993|stops at 2024/.test($('foot').innerHTML),
      ($('foot').innerHTML.match(/(June and July 1993|stops at 2024)/)||[''])[0]);
  $('tierSel').value='firm'; fire('tierSel','change');
  $('ctySel').value='definitive-069'; fire('ctySel','change');

  console.log('\n--- the county Derecho hazard');
  $('hazSel').value='derechoday'; await $('hazSel').onchange({target:{value:'derechoday'}});
  await new Promise(r=>setTimeout(r,900));
  say('it behaves as a county hazard, not an event',
      $('trendCol').style.display===''&&$('panels').style.display===''&&
      A._layers.some(isCounty));
  say('confidence menu hidden here',$('tierWrap').style.display==='none');
  say('record starts in 1996',$('y0In').min==='1996'&&$('y1In').max==='2024',
      $('y0In').min+'-'+$('y1In').max);
  say('both maps drawn',/linear-gradient/.test($('cbClim').innerHTML)&&
                        /linear-gradient/.test($('cbTrend').innerHTML));
  say('panels drawn',$('card').innerHTML.length>4000);
  /* A derecho is one coherent storm, so it is counted in events, not hazard days. */
  say('counted in events, not days',/events\/yr/.test($('cbClim').innerHTML)&&
      !/days\/yr/.test($('cbClim').innerHTML),
      ($('cbClim').innerHTML.match(/\w+\/yr/)||[''])[0]);
  say('map subtitle says events',/Mean annual derecho events per county/i.test($('climSub').textContent),
      $('climSub').textContent);
  say('annual panel says events',/Annual number of derecho events/i.test($('card').innerHTML));
  say('thunderstorm wind still says days', await (async()=>{
      $('hazSel').value='wind'; await $('hazSel').onchange({target:{value:'wind'}});
      await new Promise(r=>setTimeout(r,900));
      const ok=/days\/yr/.test($('cbClim').innerHTML);
      $('hazSel').value='derechoday'; await $('hazSel').onchange({target:{value:'derechoday'}});
      await new Promise(r=>setTimeout(r,900));
      return ok; })());
  /* The whole point: a county's value is derechos per year, a small number,
     where thunderstorm-wind days are many times larger. */
  const sumSeries=()=>w.eval("(function(){const s=seriesMonthYear();"+
    "return [...s.my].reduce((a,b)=>a+b,0);})()");
  // the page opens on Indiana, so this is the Indiana series, not the national one
  const ind=sumSeries();   // whole record, 1996-2024, not just the chosen window
  say('Indiana derecho days 1996-2024 are plausible',ind>5&&ind<40,
      ind+' days over 29 yr, '+(ind/29).toFixed(2)+'/yr');
  $('regSel').value=''; fire('regSel','change');
  await new Promise(r=>setTimeout(r,200));
  const natl=sumSeries();
  say('the national series is larger and plausible',natl>50&&natl<120&&natl>ind,
      natl+' days over 29 yr, '+(natl/29).toFixed(1)+'/yr nationally');
  say('it matches the 93 definitive swaths, minus shared dates',natl===90,natl+'');
  say('a state cannot exceed the nation',ind<natl);
  $('regSel').value='IN'; fire('regSel','change');
  say('climatology is small per county',
      w.eval("(function(){const m=countyMetrics();let mx=0;"+
             "for(let i=0;i<m.mean.length;i++)mx=Math.max(mx,m.mean[i]);return mx;})()")<1.5,
      'max '+w.eval("(function(){const m=countyMetrics();let mx=0;"+
             "for(let i=0;i<m.mean.length;i++)mx=Math.max(mx,m.mean[i]);return mx.toFixed(2);})()")+
      ' days/yr');

  console.log('\n--- leaving event mode restores the time series');
  $('hazSel').value='derecho'; await $('hazSel').onchange({target:{value:'derecho'}});
  await new Promise(r=>setTimeout(r,900));
  $('hazSel').value='hail'; await $('hazSel').onchange({target:{value:'hail'}});
  await new Promise(r=>setTimeout(r,900));
  say('the analysis period comes back, not 1995',
      $('y0In').value==='2000'&&$('y1In').value==='2024',
      $('y0In').value+'-'+$('y1In').value);
  say('trend column back',$('trendCol').style.display==='');
  say('panels back',$('panels').style.display===''&&$('card').innerHTML.length>4000);
  say('county fills back',A._layers.some(isCounty));
  /* The envelope and its reports must actually leave the map, not merely be
     covered by the choropleth drawn over them. */
  const leftovers=A._layers.filter(l=>l._polys||l._marks);
  say('derecho envelope removed from the map',
      !leftovers.some(l=>l._polys&&l._polys.length),
      leftovers.reduce((n,l)=>n+((l._polys||[]).length),0)+' polygons still attached');
  say('derecho reports removed too',
      !leftovers.some(l=>l._marks&&l._marks.length),
      leftovers.reduce((n,l)=>n+((l._marks||[]).length),0)+' markers still attached');
  say('both colour bars back',/linear-gradient/.test($('cbClim').innerHTML)&&
                              /linear-gradient/.test($('cbTrend').innerHTML));
  say('borders back to black hairlines',w.eval("stStyle({properties:{STUSPS:'IA'}})").color==='#000',
      w.eval("stStyle({properties:{STUSPS:'IA'}})").color);
  say('and hit-testing restored for county hover',
      w.eval("stStyle({properties:{STUSPS:'IA'}})").fill===true);

  console.log('\n--- a shared link reopens the same event');
  const d2=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,
    url:'http://localhost/scstrend.html#h=derecho&t=0&r=&c=definitive-074&p=1956-2025'});
  const w2=d2.window;
  Object.assign(w2,{fetch:w.fetch,DecompressionStream:w.DecompressionStream,Blob:w.Blob,
    Response:w.Response,topojson:w.topojson,L:w.L});
  w2.URL.createObjectURL=()=>'blob:x'; w2.URL.revokeObjectURL=()=>{};
  w2.navigator.clipboard={writeText:async()=>{}};
  w2.eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  await new Promise(r=>setTimeout(r,3200));
  say('link restores hazard and swath',
      w2.document.getElementById('hazSel').value==='derecho'&&
      w2.document.getElementById('ctySel').value==='definitive-074',
      w2.document.getElementById('hazSel').value+' / '+w2.document.getElementById('ctySel').value);
  say('and its readout',/12 May 2022/.test(w2.document.getElementById('foot').innerHTML));
  /* 12 May 2022 is TWO swaths in the archive; a date key would have collapsed
     them, so this is the assertion that the id key is load-bearing. */
  say('the second 12 May 2022 swath is distinct',
      w2.eval("eventsInWindow().filter(e=>e.start.startsWith('2022-05-12')).length")===2,
      w2.eval("eventsInWindow().filter(e=>e.start.startsWith('2022-05-12')).map(e=>e.id).join(' ')"));

  console.log('\n--- errors captured: '+errors.length);
  errors.forEach(e=>console.log('  '+e));
  process.exit(errors.length?1:0);
})().catch(e=>{console.error('HARNESS ERROR',e);process.exit(2);});
