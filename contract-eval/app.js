// Contract vs. Projection: what a free-agent deal pays for in fWAR against where the player projects.
// Ported from the approved reference (contract_calc.html); the model, chart and share image are its,
// with the site's Share image menu (/shared/share-image.js) and the Pitcher List Stats wordmark top right.
(function () {
const AGE=[20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40];
const CUR={
 sp:{L:[-1.49,-1.16,-.83,-.54,-.28,-.09,0,-.03,-.14,-.28,-.40,-.51,-.64,-.80,-1.01,-1.28,-1.59,-1.92,-2.24,-2.49,-2.72],
     lo:[-2.63,-1.34,-1.18,-.67,-.51,-.27,0,-.20,-.33,-.48,-.81,-.77,-.84,-1.14,-1.46,-1.63,-1.90,-2.59,-3.33,-3.10,-3.81],
     hi:[-1.22,-.50,-.59,-.23,-.21,.02,0,.12,.05,-.02,-.34,-.29,-.26,-.55,-.83,-1.06,-1.05,-1.60,-2.05,-1.78,-2.15],
     inj:[[30,.15],[35,.16],[37,.24],[38,.28],[40,.34]]},
 h:{L:[-1.02,-.77,-.53,-.32,-.16,-.05,0,-.02,-.12,-.33,-.65,-1.03,-1.43,-1.79,-2.16,-2.62,-3.19,-3.81,-4.39,-4.87,-5.27],
    lo:[-1.65,-1.31,-.69,-.52,-.35,-.24,0,-.14,-.37,-.53,-.65,-1.26,-1.68,-1.99,-2.41,-2.72,-3.56,-4.25,-4.89,-5.62,-5.78],
    hi:[-.38,-.53,-.26,-.18,0,-.01,0,.10,-.10,-.21,-.35,-.92,-1.24,-1.63,-2.02,-2.18,-2.88,-3.50,-4.04,-4.46,-4.46],
    inj:[[30,.10],[33,.13],[35,.18],[37,.22],[40,.26]]}};
const PA=2.47,PB=3.33,PC=3,I0=1.065,G=1.03,D=1/1.05,N=20000;
const $=id=>document.getElementById(id);
const interp=(x,pts)=>{if(x<=pts[0][0])return pts[0][1];for(let i=1;i<pts.length;i++)if(x<=pts[i][0]){const[a,b]=pts[i-1],[c,d]=pts[i];return b+(d-b)*(x-a)/(c-a)}return pts[pts.length-1][1]};
function at(arr,age){if(age<=20)return arr[0];if(age<=40)return arr[age-20];const s=arr[20]-arr[19];return arr[20]+s*(age-40)}
const price=w=>PA+PB*Math.min(Math.max(w,0),PC);
function rng(seed){let a=seed>>>0;return()=>{a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
let role='sp';
// playing-time retention (share of base-age playing time delivered k years later; 0 if out of the majors)
const RET={sp:{26:[.90,.85,.80,.71,.63,.52,.40,.37],28:[.85,.74,.68,.60,.50,.41,.32,.26],30:[.87,.74,.58,.55,.42,.35,.21,.17],32:[.76,.73,.55,.44,.30,.22,.17,.13],34:[.77,.59,.39,.24,.19,.12,.08,.05]},
 h:{26:[.97,.93,.88,.83,.80,.69,.61,.50],28:[.93,.88,.83,.71,.59,.50,.39,.30],30:[.93,.82,.70,.57,.45,.34,.23,.14],32:[.87,.72,.57,.43,.31,.20,.13,.09],34:[.80,.64,.46,.28,.20,.14,.06,.03]}};
function retRow(age){const T=RET[role],a=Math.min(34,Math.max(26,age));if(T[a])return T[a];const l=T[a-1],u=T[a+1];return l.map((v,i)=>(v+u[i])/2)}
function retention(age,k){if(k===0)return 1;const r=retRow(age);if(k<=8)return r[k-1];const g=r[6]>0?Math.min(1,r[7]/r[6]):.5;return r[7]*g**(k-8)}
const Phi=x=>{const t=1/(1+.2316419*Math.abs(x)),d=.3989423*Math.exp(-x*x/2),p=d*t*(.3193815+t*(-.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p};
function compute(age,yrs,aav,w1){
 const c=CUR[role],R=rng(12345),nrm=()=>{let u=0;while(!u)u=R();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*R())};
 const ages=[...Array(yrs)].map((_,t)=>age+t);
 const rate=ages.map(a=>w1+at(c.L,a)-at(c.L,age));                    // step 2: age the rate (fixed-win curve)
 const hw=a=>(at(c.hi,a)-at(c.lo,a))/2, csd=ages.map(a=>Math.sqrt(Math.max(hw(a)**2-hw(age)**2,0))/1.645);
 const ret=ages.map((_,k)=>retention(age,k));                           // step 3: playing-time retention
 let Sprev=1;const S=ret.map(r=>{Sprev=Math.min(Sprev,r**.7);return Sprev}), M=ret.map((r,k)=>S[k]>0?r/S[k]:0);
 const PINJ=.2,HN=(1-PINJ)+PINJ*.45,RHO=.4;
 const sims=ages.map(()=>new Float64Array(N)), disc=new Float64Array(N);
 for(let i=0;i<N;i++){const z=nrm(),e0=nrm();let walk=e0*.6,dw=0;
  const U=Phi(-RHO*e0+Math.sqrt(1-RHO*RHO)*nrm());                    // weaker-than-projected players leave sooner
  for(let t=0;t<yrs;t++){if(t>0)walk+=nrm()*.5;let w=0;
   if(U<S[t]){const share=(R()<PINJ?.1+.7*R():1)/HN*M[t];w=(rate[t]+z*csd[t]+walk)*share+nrm()*.8*Math.sqrt(Math.min(share,1));if(w<-.5)w=-.5}
   sims[t][i]=w;dw+=w*D**t}disc[i]=dw}
 const q=(arr,p)=>{const s=Float64Array.from(arr).sort();return s[Math.floor(p*(s.length-1))]};
 const rows=sims.map(s=>{let m=0;for(const v of s)m+=v;return{mean:m/N,p10:q(s,.1),p90:q(s,.9)}});
 const minS=t=>.8*1.025**t, idx=t=>I0*G**t;
 let pv=0,ann=0;for(let t=0;t<yrs;t++){pv+=aav*D**t;ann+=D**t}
 // contract-implied fWAR: the year-1 projection the market prices this deal at, aged the way the price curve was fit (-0.4/yr)
 const mk=(W,t)=>Math.max(W-.4*t,0);
 const val=W=>{let v=0;for(let t=0;t<yrs;t++)v+=(minS(t)+price(W)*idx(t)*mk(W,t))*D**t;return v};
 let lo=0,hi=40;if(val(0)>=pv){hi=0}else for(let k=0;k<60;k++){const m=(lo+hi)/2;(val(m)<pv?lo=m:hi=m)}
 const Wstar=hi, implied=ages.map((_,t)=>mk(Wstar,t));
 let needD=0;implied.forEach((w,t)=>needD+=w*D**t);
 let ok=0;for(let i=0;i<N;i++)if(disc[i]>=needD)ok++;
 const cs=ages.map(()=>new Float64Array(N));for(let i=0;i<N;i++){let a=0;for(let t=0;t<yrs;t++){a+=sims[t][i];cs[t][i]=a}}
 const cum=cs[yrs-1];
 const crows=cs.map(s=>{let m=0;for(const v of s)m+=v;return{mean:m/N,p10:q(s,.1),p90:q(s,.9)}});
 let ia=0;const cimplied=implied.map(w=>ia+=w);
 let fair=0;for(let t=0;t<yrs;t++)fair+=(minS(t)+price(w1)*idx(t)*Math.max(rows[t].mean,0))*D**t;
 // each season's $ value, in that season's dollars: the minimum plus the price per win at the year-1
 // projection the wins come from (his for the projection, the deal's for the contract line), the
 // pricing behind Fair AAV and Contract Needs; the cumulative view's running totals
 const worth=(W,ws)=>ws.map((w,t)=>minS(t)+price(W)*idx(t)*Math.max(w,0));
 const pD=worth(w1,rows.map(r=>r.mean)),iD=worth(Wstar,implied);let s1=0,s2=0;const cpD=pD.map(v=>s1+=v),ciD=iD.map(v=>s2+=v);
 const expected=rate.map((r,t)=>r*ret[t]);
 return{pD,iD,cpD,ciD,ages,rows,crows,cimplied,rate,ret,expected,implied,Wstar,need:implied.reduce((a,b)=>a+b,0),proj:rows.reduce((a,r)=>a+r.mean,0),c10:q(cum,.1),c90:q(cum,.9),odds:ok/N,fair:fair/ann,p1:price(Wstar)*idx(0)};
}
let view='season';const V=()=>view==='cum'?{rows:res.crows,implied:res.cimplied,pD:res.cpD,iD:res.ciD}:{rows:res.rows,implied:res.implied,pD:res.pD,iD:res.iD};
const money=v=>`<span class="d">$${v.toFixed(1)}M</span>`;
function yscale(vw){const top=Math.max(...vw.rows.map(r=>r.p90),...vw.implied)+0.05;const st=[1,2,5,10,20,50].find(x=>Math.ceil(top/x)<=8)||100;const hi=Math.max(4,Math.ceil(top/st)*st);return[0,hi,st]}
let res=null;const svg=$('chart'),fig=$('fig'),tip=$('tip');
function draw(){if(!res)return;const vw=V();const W=svg.clientWidth,H=svg.clientHeight;if(!W)return;
 const n=res.ages.length,small=W<520,ml=small?52:68,mr=10,mt=small?92:112,stag=n*(small?36:48)>(W-ml-mr),mb=small?(stag?56:34):(stag?72:40),iw=W-ml-mr,ih=H-mt-mb;
 const [ymin,ymax,step]=yscale(vw);
 const X=t=>ml+(n===1?iw/2:iw*(t+.5)/n),Y=v=>mt+ih*(1-(Math.max(v,ymin)-ymin)/(ymax-ymin));
 let h='';
 for(let v=ymin;v<=ymax;v+=step)h+=`<line x1="${ml}" x2="${W-mr}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v===0?'var(--center)':'var(--grid)'}"/><text x="${ml-8}" y="${Y(v)+5}" text-anchor="end" fill="${v<0?'var(--red)':'var(--nav)'}" font-size="${small?12:15}">${v<0?'−'+(-v):v}</text>`;
 const band=(a,b)=>{const xs=vw.rows.map((_,t)=>X(t));if(n===1){const x=xs[0];return`M${x-14},${Y(vw.rows[0][a])}H${x+14}V${Y(vw.rows[0][b])}H${x-14}Z`}return'M'+vw.rows.map((r,t)=>`${xs[t]},${Y(r[a])}`).join('L')+'L'+vw.rows.map((r,t)=>`${xs[t]},${Y(r[b])}`).reverse().join('L')+'Z'};
 {const bw=iw/n*2/3;   // the 10th-90th percentile: a bar for each season, two thirds of its slot
  vw.rows.forEach((r,t)=>{const y1=Y(r.p90),y0=Y(r.p10);h+=`<rect x="${X(t)-bw/2}" y="${y1}" width="${bw}" height="${Math.max(y0-y1,1)}" rx="${Math.min(4,bw/4)}" fill="var(--cyan)" fill-opacity=".24"/>`})}
 const line=(vals,col,w)=>`<path d="M${vals.map((v,t)=>`${X(t)},${Y(v)}`).join('L')}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`+vals.map((v,t)=>`<circle cx="${X(t)}" cy="${Y(v)}" r="${small?3:4}" fill="${col}" stroke="var(--card)" stroke-width="2"/>`).join('');
 h+=line(vw.implied,'var(--amber)',2.5)+line(vw.rows.map(r=>r.mean),'var(--cyan)',2.5);
 h+=`<line x1="${ml}" x2="${W-mr}" y1="${mt+ih}" y2="${mt+ih}" stroke="var(--muted)"/>`;
 const fs=small?12:15;
 res.ages.forEach((a,t)=>{const x=X(t),off=stag&&t%2?(small?30:44):0,y0=mt+ih+(small?18:24)+off;
  h+=`<line x1="${x}" x2="${x}" y1="${mt+ih}" y2="${mt+ih+5}" stroke="var(--muted)"/><text x="${x}" y="${y0}" text-anchor="middle" fill="var(--nav)" font-size="${fs}">${small?"'"+String(2027+t).slice(2):2027+t}</text>`;
  });
 const yl=view==='cum'?'Cumulative fWAR':'fWAR, per Year',yf=small?12:14;   // the y axis's label, along it
 h+=`<text transform="translate(${yf+2},${mt+ih/2}) rotate(-90)" text-anchor="middle" fill="var(--nav)" font-family="DM Sans" font-weight="600" font-size="${yf}">${yl}</text>`;
 // 4. the header pair: the fWAR values larger than their labels
 const hx1=ml+iw*.25,hx2=ml+iw*.75,hf=small?14:18,vf=small?22:28,cy=mt/2,l1=cy-(small?8:12),l2=cy+(small?20:26);
 h+=`<text x="${hx1}" y="${l1}" text-anchor="middle" fill="var(--ink)" font-family="DM Sans" font-weight="600" font-size="${hf}">Projected</text><text x="${hx1}" y="${l2}" text-anchor="middle" fill="var(--cyan)" font-weight="600" font-size="${vf}">${res.proj.toFixed(1)} fWAR</text>`;
 h+=`<text x="${hx2}" y="${l1}" text-anchor="middle" fill="var(--ink)" font-family="DM Sans" font-weight="600" font-size="${hf}">Contract Needs</text><text x="${hx2}" y="${l2}" text-anchor="middle" fill="var(--amber)" font-weight="600" font-size="${vf}">${res.need.toFixed(1)} fWAR</text>`;
 h+=`<line id="hov" x1="0" x2="0" y1="${mt}" y2="${mt+ih}" stroke="var(--nav)" stroke-dasharray="4 4" visibility="hidden"/><rect id="hit" x="${ml}" y="${mt}" width="${iw}" height="${ih}" fill="transparent"/>`;
 svg.innerHTML=h;
 const hit=$('hit'),hov=$('hov');
 const move=e=>{const r=svg.getBoundingClientRect(),px=(e.touches?e.touches[0].clientX:e.clientX)-r.left;const t=Math.max(0,Math.min(n-1,Math.round((px-ml)/iw*n-.5)));const x=X(t),rw=vw.rows[t];
  hov.setAttribute('x1',x);hov.setAttribute('x2',x);hov.setAttribute('visibility','visible');
  tip.innerHTML=view==='cum'?`<b>Through ${2027+t} - Age ${res.ages[t]}</b><div class="r"><span class="c">Projected</span><span>${rw.mean.toFixed(1)}${money(vw.pD[t])}</span></div><div class="r"><span>80% range</span><span>${rw.p10.toFixed(1)} – ${rw.p90.toFixed(1)}<span class="d"></span></span></div><div class="r"><span class="a">Contract-implied</span><span>${vw.implied[t].toFixed(1)}${money(vw.iD[t])}</span></div>`:`<b>${2027+t} - Age ${res.ages[t]}</b><div class="r"><span class="c">Projected</span><span>${rw.mean.toFixed(1)}${money(vw.pD[t])}</span></div><div class="r"><span>80% range</span><span>${rw.p10.toFixed(1)} – ${rw.p90.toFixed(1)}<span class="d"></span></span></div><div class="r"><span class="a">Contract-implied</span><span>${vw.implied[t].toFixed(1)}${money(vw.iD[t])}</span></div>`;
  tip.style.opacity=1;const tw=tip.offsetWidth;let lx=x+14+tw>W?x-14-tw:x+14;lx=Math.max(0,Math.min(lx,W-tw));tip.style.left=lx+'px';tip.style.top=(mt+8)+'px'};
 hit.addEventListener('mousemove',move);hit.addEventListener('touchstart',move,{passive:true});hit.addEventListener('touchmove',move,{passive:true});
 hit.addEventListener('mouseleave',()=>{tip.style.opacity=0;hov.setAttribute('visibility','hidden')});
}
const ro=new ResizeObserver(draw);ro.observe(fig);
function clamp(v,a,b,d){v=parseFloat(v);return isFinite(v)?Math.min(b,Math.max(a,v)):d}
const PLAYERS=new Set(window.CVP_PLAYERS||[]);
{const dl=$('players'),f=document.createDocumentFragment();PLAYERS.forEach(n=>{const o=document.createElement('option');o.value=n;f.appendChild(o)});dl.appendChild(f)}
function playerName(){const raw=$('pname').value.replace(/\s+/g,' ').trim().slice(0,40);
 const ok=!raw||PLAYERS.has(raw)||!window.CVPNameOK||window.CVPNameOK(raw);
 $('pname').setAttribute('aria-invalid',String(!ok));$('pname-msg').textContent=ok?'':'That name can\'t be shown';
 return ok?raw:''}
function run(){const age=Math.round(clamp($('age').value,20,40,30)),yrs=Math.round(clamp($('yrs').value,1,15,9)),aav=clamp($('aav').value,.8,80,50),w1=clamp($('w1').value,-1,10,5.6);
 res=compute(age,yrs,aav,w1);const name=playerName(),team=$('team').value;cur={age,yrs,aav,w1,name,team};
 $('sh-name').textContent=`${name||'Free Agent'} - ${team}`;
 const tot=aav*yrs;
 $('sh-title').textContent=`${yrs} Year${yrs>1?'s':''}, $${tot>=100?tot.toFixed(0):tot.toFixed(1)}M`;
 $('sh-sub').textContent=`${role==='sp'?'Starting Pitcher':'Hitter'}, Age ${res.ages[0]}${yrs>1?'–'+res.ages[res.ages.length-1]:''} | $${aav.toFixed(1)}M AAV`;
 const o=res.odds,k=$('k-odds');k.textContent=Math.round(o*100)+'%';k.className='n '+(o>.75?'g':o<.25?'rd':'');
 const f0=v=>{const r=Math.round(v);return r<0?'−'+(-r):String(r)};$('k-range').textContent=`${f0(res.c10)}–${f0(res.c90)}`;
 let ann=0;for(let t=0;t<yrs;t++)ann+=D**t;const sur=(res.fair-aav)*ann;$('k-surp').textContent=(sur>=0?'+':'−')+'$'+Math.abs(sur).toFixed(0)+'M';$('k-fair').textContent='$'+res.fair.toFixed(1)+'M';$('k-star').textContent=res.Wstar.toFixed(1);
 draw();try{localStorage.setItem('cvp',JSON.stringify({age,yrs,aav,w1,role,name:$('pname').value,team}))}catch(e){}}
function setRole(r){role=r;$('r-sp').setAttribute('aria-pressed',r==='sp');$('r-h').setAttribute('aria-pressed',r==='h');run()}
function setView(v){view=v;$('v-season').setAttribute('aria-pressed',v==='season');$('v-cum').setAttribute('aria-pressed',v==='cum');draw()}
$('v-season').addEventListener('click',()=>setView('season'));$('v-cum').addEventListener('click',()=>setView('cum'));
$('r-sp').addEventListener('click',()=>setRole('sp'));$('r-h').addEventListener('click',()=>setRole('h'));
$('preset').addEventListener('click',()=>{$('pname').value='Tarik Skubal';$('team').value='NYM';$('age').value=30;$('yrs').value=9;$('aav').value=50;$('w1').value=5.6;setRole('sp')});
let tmr;['pname','age','yrs','aav','w1'].forEach(id=>$(id).addEventListener('input',()=>{clearTimeout(tmr);tmr=setTimeout(run,120)}));
$('team').addEventListener('change',run);
try{const s=JSON.parse(localStorage.getItem('cvp')||'null');if(s){if(typeof s.name==='string')$('pname').value=s.name;if(s.team&&[...$('team').options].some(o=>o.value===s.team))$('team').value=s.team;$('age').value=s.age;$('yrs').value=s.yrs;$('aav').value=s.aav;$('w1').value=s.w1;role=s.role==='h'?'h':'sp';$('r-sp').setAttribute('aria-pressed',role==='sp');$('r-h').setAttribute('aria-pressed',role==='h')}}catch(e){}

// ---- Share Image: draw the card to a 1600x1600 PNG with the page's fonts ----
let cur={};
const LOGO='/pitcher-cards/PitcherList_Stats_watermark_with_logo.webp';
let logoP=null;const loadLogo=()=>logoP||(logoP=new Promise((ok,no)=>{const im=new Image();im.onload=()=>ok(im);im.onerror=no;im.src=LOGO}).catch(()=>null));
async function renderPNG(){
 const vw=V();await document.fonts.ready;const logo=await loadLogo();
 await Promise.all(['700 76px "DM Sans"','600 38px "DM Sans"','500 34px "Work Sans"','400 32px "Work Sans"'].map(f=>document.fonts.load(f).catch(()=>{})));
 const S=1600,P=72,cv=document.createElement('canvas');cv.width=cv.height=S;const g=cv.getContext('2d');
 const C={bg:'#292c42',cyan:'#55e8ff',cyanh:'#73efff',amber:'#ffc277',ink:'#f0f1f5',nav:'#cbd7fd',meta:'#c0c4d8',grid:'rgba(255,255,255,.06)',center:'rgba(255,255,255,.24)',muted:'rgba(196,205,236,.85)',kpib:'#40a8c0',div:'rgba(64,168,192,.4)',green:'#7edc9d',red:'#fb849c'};
 const DM=(w,px)=>`${w} ${px}px "DM Sans", system-ui, sans-serif`,WS=(w,px)=>`${w} ${px}px "Work Sans", system-ui, sans-serif`;
 const T=(t,x,y,font,col,al='left')=>{g.font=font;g.fillStyle=col;g.textAlign=al;g.fillText(t,x,y)};
 g.fillStyle=C.bg;g.fillRect(0,0,S,S);
 // the Pitcher List Stats wordmark top right, level with the title
 // xMiss's header at 1.6x (its 1000 layout units on this 1600 canvas): the wordmark 368 wide top right;
 // name - team (shrunk only to clear the wordmark), the deal, then position, ages and AAV
 const lw=368;if(logo)g.drawImage(logo,S-P-lw,74,lw,lw*logo.naturalHeight/logo.naturalWidth);
 {let ns=57.6;g.font=DM(700,ns);while(ns>40&&g.measureText($('sh-name').textContent).width>S-2*P-lw-40)g.font=DM(700,ns-=1);
  T($('sh-name').textContent,P,122,DM(700,ns),C.cyanh)}
 T($('sh-title').textContent,P,170,DM(700,36),C.ink);
 T($('sh-sub').textContent,P,211,DM(400,30),'#8d96b3');
 const n=res.ages.length,ml=P+100,mr=S-P,mt=470,mb=1210,iw=mr-ml,ih=mb-mt;
 g.save();g.translate(P+30,(mt+mb)/2);g.rotate(-Math.PI/2);T(view==='cum'?'Cumulative fWAR':'fWAR, per Year',0,0,DM(600,32),C.nav,'center');g.restore();
 const hx1=ml+iw*.25,hx2=ml+iw*.75;
 T('Projected',hx1,322,DM(600,38),C.ink,'center');T(res.proj.toFixed(1)+' fWAR',hx1,392,WS(600,56),C.cyan,'center');
 T('Contract Needs',hx2,322,DM(600,38),C.ink,'center');T(res.need.toFixed(1)+' fWAR',hx2,392,WS(600,56),C.amber,'center');
 const [ymin,ymax,step]=yscale(vw);
 const X=t=>ml+(n===1?iw/2:iw*(t+.5)/n),Y=v=>mt+ih*(1-(Math.max(v,ymin)-ymin)/(ymax-ymin));
 for(let v=ymin;v<=ymax;v+=step){g.strokeStyle=v===0?C.center:C.grid;g.lineWidth=2;g.beginPath();g.moveTo(ml,Y(v));g.lineTo(mr,Y(v));g.stroke();T(v<0?'−'+(-v):String(v),ml-18,Y(v)+11,WS(400,32),v<0?C.red:C.nav,'right')}
 const band=(a,b,op)=>{g.beginPath();if(n===1){const x=X(0);g.rect(x-30,Y(vw.rows[0][b]),60,Y(vw.rows[0][a])-Y(vw.rows[0][b]))}else{vw.rows.forEach((r,t)=>t?g.lineTo(X(t),Y(r[a])):g.moveTo(X(t),Y(r[a])));for(let t=n-1;t>=0;t--)g.lineTo(X(t),Y(vw.rows[t][b]));g.closePath()}g.fillStyle=`rgba(85,232,255,${op})`;g.fill()};
 {const bw=iw/n*2/3;g.fillStyle='rgba(85,232,255,.24)';   // the 10th-90th percentile: a bar for each season, two thirds of its slot
  vw.rows.forEach((r,t)=>{const y1=Y(r.p90),y0=Y(r.p10);g.beginPath();g.roundRect(X(t)-bw/2,y1,bw,Math.max(y0-y1,2),Math.min(8,bw/4));g.fill()})}
 const line=(vals,col)=>{g.strokeStyle=col;g.lineWidth=5;g.lineJoin='round';g.lineCap='round';g.beginPath();vals.forEach((v,t)=>t?g.lineTo(X(t),Y(v)):g.moveTo(X(t),Y(v)));g.stroke();
  vals.forEach((v,t)=>{g.beginPath();g.arc(X(t),Y(v),9,0,7);g.fillStyle=col;g.fill();g.lineWidth=4;g.strokeStyle=C.bg;g.stroke()})};
 line(vw.implied,C.amber);line(vw.rows.map(r=>r.mean),C.cyan);
 g.strokeStyle=C.muted;g.lineWidth=2;g.beginPath();g.moveTo(ml,mb);g.lineTo(mr,mb);g.stroke();
 const yr=n>10;res.ages.forEach((_,t)=>{g.beginPath();g.moveTo(X(t),mb);g.lineTo(X(t),mb+12);g.stroke();T(yr?"'"+String(2027+t).slice(2):String(2027+t),X(t),mb+52,WS(400,32),C.nav,'center')});
 // KPI strip
 const kx=P,kh=210,ky=S-P-kh,kw=S-2*P,cw=kw/5;
 g.strokeStyle=C.kpib;g.lineWidth=3;g.beginPath();g.roundRect(kx,ky,kw,kh,20);g.stroke();
 g.strokeStyle=C.div;for(let i=1;i<5;i++){g.beginPath();g.moveTo(kx+cw*i,ky);g.lineTo(kx+cw*i,ky+kh);g.stroke()}
 const o=res.odds,K=[['Chance of Positive Value',Math.round(o*100)+'%',o>.75?C.green:o<.25?C.red:C.ink,''],['Projected Range',$('k-range').textContent,C.cyan,'Total fWAR'],['Expected Surplus',$('k-surp').textContent,C.ink,'present value'],['Fair AAV',$('k-fair').textContent,C.ink,'at his projection'],['Priced As',$('k-star').textContent,C.ink,'fWAR in year 1']];
 K.forEach(([l,v,col,sub],i)=>{const cx=kx+cw*(i+.5);g.font=DM(600,30);const words=l.split(' ');let lines=[l];if(g.measureText(l).width>cw-24){const m=Math.ceil(words.length/2);lines=[words.slice(0,m).join(' '),words.slice(m).join(' ')]}
  lines.forEach((ln,j)=>T(ln,cx,ky+(lines.length>1?46:60)+j*34,DM(600,30),C.cyanh,'center'));T(v,cx,ky+(sub?140:150),DM(700,50),col,'center');if(sub)T(sub,cx,ky+184,WS(400,30),C.meta,'center')});
 return await new Promise(r=>cv.toBlob(r,'image/png'));
}
const slug=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
const fname=()=>`${slug(cur.name||'free_agent')}_${cur.team.toLowerCase()}-contract-${cur.yrs}yr-${String(cur.aav).replace('.','_')}m-${cur.w1}fwar${view==='cum'?'-cumulative':''}.png`;
ShareImage.image($('share'), () => renderPNG(), () => fname());
run();
})();
