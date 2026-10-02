import { layer, place, system, viewport } from './solar.js';

const motion = matchMedia('(prefers-reduced-motion: reduce)');
const canvas = document.querySelector('.fx-foil');
const hero = canvas?.closest('.hero');
const stats = { mode: 'fallback', frames: 0, running: false, cpu: [], gpu: [] };
window.__fx = { hero: stats };
const install = document.querySelector('.install');
install?.addEventListener('pointermove', event => {
  if (motion.matches || event.pointerType === 'touch') return;
  const rect = install.getBoundingClientRect();
  install.style.setProperty('--mx', `${event.clientX - rect.left}px`);
  install.style.setProperty('--my', `${event.clientY - rect.top}px`);
}, { passive: true });

async function fallback() {
  delete hero.dataset.solar;
  delete hero.dataset.gpu;
  delete canvas.dataset.ready;
  hero.querySelectorAll('.fx-solar').forEach(node => node.remove());
  stats.backend = 'css';
  stats.mode = 'fallback';
  stats.running = false;
  const surface = layer(hero);
  const gl = surface.getContext('webgl2', { alpha: true, antialias: false, powerPreference: 'low-power' });
  if (!gl) { surface.remove(); return; }
  try {
    const THREE = await import('https://cdn.jsdelivr.net/npm/three@0.186.1/+esm');
    const logo = hero.querySelector('.logo');
    await Promise.all([logo.decode(), document.fonts.ready]);
    const renderer = new THREE.WebGLRenderer({ canvas: surface, context: gl, alpha: true, antialias: false });
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-390,390,145,-145,1,2400);
    camera.position.z = 1000;
    const texture = new THREE.Texture(logo);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    const sun = new THREE.Mesh(new THREE.PlaneGeometry(1,1), new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.03 }));
    scene.add(sun, new THREE.AmbientLight(0xb4a48f,0.5));
    const light = new THREE.PointLight(0xffcf91, 75000, 0, 2);
    light.position.set(0,0,110);
    scene.add(light);
    const sphere = new THREE.SphereGeometry(1,24,16);
    const orbitGeometry = new THREE.BufferGeometry().setFromPoints(Array.from({length:160},(_,i)=>new THREE.Vector3(Math.cos(i/160*Math.PI*2),Math.sin(i/160*Math.PI*2),0)));
    const bodies = Array.from({length:6},()=>{
      const mesh = new THREE.Mesh(sphere,new THREE.MeshPhongMaterial({shininess:12}));
      const orbit = new THREE.LineLoop(orbitGeometry,new THREE.LineBasicMaterial({color:0x9d8f76,transparent:true,opacity:0.15}));
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.4,2.2,64),new THREE.MeshBasicMaterial({color:0xaaa99a,transparent:true,opacity:0.32,side:THREE.DoubleSide,depthWrite:false}));
      mesh.add(ring);ring.rotation.x=1.2;ring.rotation.z=0.35;
      scene.add(mesh,orbit);
      return {mesh,orbit,ring};
    });
    let rect,raf=0,last=0,next=0,time=0,seen=false,lost=false,dirty=true;
    let pointer=[0,0],target=[0,0];
    const audit = new URLSearchParams(location.search).has('fxperf');
    const timer = audit && gl.getExtension('EXT_disjoint_timer_query_webgl2');
    let query;
    const sample=(list,n)=>{list.push(n);if(list.length>180)list.shift();};
    function draw() {
      const start=performance.now();
      const worlds=system(hero.clientWidth,time,pointer);
      bodies.forEach(({mesh,orbit,ring},i)=>{
        mesh.visible=orbit.visible=i<worlds.length;
        if(!worlds[i])return;
        const [x,y,z,r,a,q,c,s,red,green,blue,kind]=worlds[i];
        mesh.position.set(x,-y,z);mesh.scale.setScalar(r);
        mesh.material.color.setRGB(red,green,blue,THREE.SRGBColorSpace);
        orbit.scale.set(a,a*q,1);orbit.rotation.z=-Math.atan2(s,c);orbit.position.z=-400;
        ring.visible=kind===1;
      });
      if(query&&gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)){
        if(!gl.getParameter(timer.GPU_DISJOINT_EXT))sample(stats.gpu,gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6);
        gl.deleteQuery(query);query=null;
      }
      const measure=timer&&!query;
      if(measure){query=gl.createQuery();gl.beginQuery(timer.TIME_ELAPSED_EXT,query);}
      renderer.setScissor(0,Math.max(0,rect.height-rect.limit),rect.width,Math.min(rect.height,rect.limit));
      renderer.setScissorTest(true);
      renderer.render(scene,camera);
      if(measure)gl.endQuery(timer.TIME_ELAPSED_EXT);
      if(audit)sample(stats.cpu,performance.now()-start);
      stats.frames++;dirty=false;hero.dataset.solar='';
      stats.backend='webgl';
    }
    function tick(now){
      raf=0;if(!seen||document.hidden||lost)return;
      if(motion.matches){time=0;pointer=[0,0];draw();stats.mode='static';stats.running=false;return;}
      if(now>=next||dirty){const dt=last?Math.min((now-last)/1000,.1):0;last=now;next=Math.max(next+1000/30,now);time+=dt;pointer=pointer.map((v,i)=>v+(target[i]-v)*(1-Math.exp(-dt*4)));draw();}
      raf=requestAnimationFrame(tick);stats.running=true;
    }
    function sync(){
      cancelAnimationFrame(raf);raf=last=next=0;stats.running=false;
      stats.mode=lost?'fallback':motion.matches?'static':'animated';
      if(!seen||document.hidden||lost)return;
      if(motion.matches){if(dirty)draw();return;}
      raf=requestAnimationFrame(tick);stats.running=true;
    }
    function resize(){
      rect=viewport(hero,logo);place(surface,rect);
      renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));renderer.setSize(rect.width,rect.height,false);
      camera.left=-rect.width/2;camera.right=rect.width/2;camera.top=rect.height/2;camera.bottom=-rect.height/2;camera.updateProjectionMatrix();
      sun.scale.set(rect.logo,rect.logo,1);stats.width=surface.width;stats.height=surface.height;dirty=true;sync();
    }
    new ResizeObserver(resize).observe(hero);
    new IntersectionObserver(([entry])=>{seen=entry.isIntersecting;sync();}).observe(hero);
    document.addEventListener('visibilitychange',sync);
    motion.addEventListener('change',()=>{time=0;pointer=target=[0,0];dirty=true;sync();});
    hero.addEventListener('pointermove',event=>{if(motion.matches||event.pointerType==='touch')return;const r=hero.getBoundingClientRect();target=[(event.clientX-r.left-r.width/2)/250,(event.clientY-r.top-rect.top-rect.height/2)/250].map(v=>Math.max(-1,Math.min(1,v)));},{passive:true});
    hero.addEventListener('pointerleave',()=>{target=[0,0];});
    surface.addEventListener('webglcontextlost',event=>{event.preventDefault();lost=true;query=null;delete hero.dataset.solar;sync();});
    surface.addEventListener('webglcontextrestored',()=>{lost=false;dirty=true;sync();});
    resize();
  } catch { surface.remove();delete hero.dataset.solar; }
}

async function init() {
  if (!canvas) return;
  try {
    if (!navigator.gpu) return fallback();
    const { flare } = await import('./flare.js');
    await flare(canvas, motion, stats, fallback);
  } catch { await fallback(); }
}
init();
