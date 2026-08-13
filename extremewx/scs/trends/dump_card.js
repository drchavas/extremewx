const fs=require('fs'),zlib=require('zlib'),path=require('path'),{JSDOM}=require('jsdom');
const ROOT=process.argv[2], OUT=process.argv[3], HASH=process.argv[4]||'';
const html=fs.readFileSync(path.join(ROOT,'scstrend_state.html'),'utf8');
const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,
  url:'http://localhost/x.html'+(HASH?'#'+HASH:'')});
const w=dom.window;
w.fetch=async u=>{const p=path.join(ROOT,u);const b=fs.readFileSync(p);
  return{ok:true,status:200,json:async()=>JSON.parse(b.toString()),arrayBuffer:async()=>b};};
w.DecompressionStream=function(){};
w.Blob=class{constructor(p){this.parts=p} stream(){return this} pipeThrough(){return this}};
w.Response=class{constructor(x){this.x=x} async text(){return zlib.gunzipSync(Buffer.from(this.x.parts[0])).toString()}};
w.URL.createObjectURL=()=>'blob:x'; w.URL.revokeObjectURL=()=>{};
w.navigator.clipboard={writeText:async()=>{}};
w.topojson=require(path.join(process.env.NODE_PATH,'topojson-client'));
w.eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
setTimeout(()=>{ fs.writeFileSync(OUT,w.eval('svgMarkup()')); console.log('wrote',OUT); process.exit(0); },3200);
