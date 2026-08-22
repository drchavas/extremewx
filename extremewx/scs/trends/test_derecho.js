/* The Derecho county climatology on scstrend.html (hazard key "derechoday"):
   definitive SPC swaths counted as events per county per year. Individual
   derecho swaths moved to scsevents.html and are covered by test_scsevents.js.
   Also pins the white-at-exact-zero shading, which matters most here because
   most of the map is a true zero. */
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

  console.log('\n--- the Derecho county hazard');
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
  /* White marks a true zero so the edge of the affected area is visible. It has
     to stay distinct from no-data, which is the land colour, and must not leak
     onto the diverging trend ramp where zero is mid-scale. */
  say('exact zero is pure white',w.eval("colorFor(0,{div:false,lo:0,hi:1})")==='#ffffff',
      w.eval("colorFor(0,{div:false,lo:0,hi:1})"));
  say('a small non-zero is not white',w.eval("colorFor(0.01,{div:false,lo:0,hi:1})")!=='#ffffff',
      w.eval("colorFor(0.01,{div:false,lo:0,hi:1})"));
  say('zero on the trend ramp is untouched',w.eval("colorFor(0,{div:true,lo:-1,hi:1})")!=='#ffffff');
  say('no-data is still null, not white',w.eval("colorFor(NaN,{div:false,lo:0,hi:1})")===null);
  say('the climo bar explains the white',/exactly 0/.test($('cbClim').innerHTML));
  say('the trend bar does not',!/exactly 0/.test($('cbTrend').innerHTML));
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


  console.log('\n--- errors captured: '+errors.length);
  errors.forEach(e=>console.log('  '+e));
  process.exit(errors.length?1:0);
})().catch(e=>{console.error('HARNESS ERROR',e);process.exit(2);});
