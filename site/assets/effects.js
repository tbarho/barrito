const motion = matchMedia('(prefers-reduced-motion: reduce)');
let canvas = document.querySelector('.fx-foil');
const hero = canvas?.closest('.hero');
const stats = { mode: 'fallback', frames: 0, running: false, cpu: [], gpu: [] };
window.__fx = { hero: stats };

const install = document.querySelector('.install');
install?.addEventListener('pointermove', (event) => {
  if (motion.matches || event.pointerType === 'touch') return;
  const rect = install.getBoundingClientRect();
  install.style.setProperty('--mx', `${event.clientX - rect.left}px`);
  install.style.setProperty('--my', `${event.clientY - rect.top}px`);
}, { passive: true });

const vertex = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Bake folded, triangular noise once; the live material only samples the normal map.
const crinkle = `
  varying vec2 vUv;
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  vec3 fold(vec2 p) {
    vec2 skew = vec2(p.x + p.y * 0.57735, p.y * 1.1547);
    vec2 cell = floor(skew), f = fract(skew);
    float a = hash(cell), b = hash(cell + vec2(1.0, 0.0));
    float c = hash(cell + vec2(0.0, 1.0)), d = hash(cell + 1.0);
    float lo = a + (b - a) * f.x + (c - a) * f.y;
    float hi = d + (c - d) * (1.0 - f.x) + (b - d) * (1.0 - f.y);
    float upper = step(1.0, f.x + f.y);
    float h = mix(lo, hi, upper) - 0.48;
    vec2 slope = mix(vec2(b - a, c - a), vec2(d - c, d - b), upper);
    slope = vec2(slope.x, slope.x * 0.57735 + slope.y * 1.1547);
    return vec3(slope * smoothstep(-0.015, 0.015, h) * 2.0 - slope, abs(h));
  }
  void main() {
    vec2 p = vUv * 14.0 + vec2(sin(vUv.y * 18.0), sin(vUv.x * 19.0)) * 0.35;
    mat2 turn = mat2(0.8, -0.6, 0.6, 0.8);
    vec3 broad = fold(p);
    vec3 medium = fold(turn * p * 2.13 + 5.7);
    vec3 fine = fold(p * 4.37 + 13.2);
    vec2 slope = broad.xy * 0.85 + transpose(turn) * medium.xy * 0.45 + fine.xy * 0.12;
    float h = broad.z * 0.6 + medium.z * 0.18 + fine.z * 0.03;
    vec3 normal = normalize(vec3(-slope * 2.6, 1.0));
    gl_FragColor = vec4(normal * 0.5 + 0.5, h);
  }
`;

const foil = `
  varying vec2 vUv;
  uniform sampler2D uFoil;
  uniform float uAspect;
  uniform float uTime;
  uniform vec2 uPointer;
  void main() {
    vec2 uv = vUv;
    vec2 p = vec2((uv.x - 0.5) * uAspect, uv.y);
    float side = abs(uv.x * 2.0 - 1.0);
    float edge = 0.16 + 0.48 * pow(side, 1.7) + (uv.x - 0.5) * 0.06;
    vec2 wrap = vec2(p.x * 0.9 + uv.y * 0.12, uv.y * 0.82);
    wrap += vec2(sin(uv.y * 4.0) * 0.035, sin(p.x * 3.0) * 0.025);
    wrap += uPointer * 0.006;
    vec4 foil = texture2D(uFoil, wrap + vec2(0.5, 0.13));
    edge += (foil.a - 0.22) * 0.085;
    float sheet = 1.0 - smoothstep(edge - 0.004, edge + 0.004, uv.y);
    vec3 n = normalize((foil.rgb * 2.0 - 1.0) + vec3(p.x * 0.3, 0.2, 0.2));
    float drift = sin(uTime * 0.18) * 0.12;
    vec3 silver = normalize(vec3(0.65 + uPointer.x * 0.18, 0.6 + drift, 0.85));
    vec3 ember = normalize(vec3(-0.8 + uPointer.x * 0.16, 0.25 + uPointer.y * 0.16, 0.7));
    float s = max(0.0, dot(n, silver));
    float e = max(0.0, dot(n, ember));
    float rim = exp(-abs(uv.y - edge + 0.005) * 160.0);
    vec3 metal = vec3(0.026, 0.027, 0.025);
    metal += vec3(0.58, 0.59, 0.56) * (pow(s, 20.0) * 0.36 + pow(s, 3.0) * 0.08);
    metal += vec3(1.0, 0.36, 0.055) * (pow(e, 18.0) * 0.22 + pow(e, 4.0) * 0.04) * (1.0 - uv.x * 0.75);
    metal += vec3(0.20, 0.18, 0.14) * rim * (0.35 + s * 0.65);
    vec3 bg = vec3(19.0, 18.0, 16.0) / 255.0;
    float bottom = smoothstep(0.0, 0.14, uv.y);
    float top = 1.0 - smoothstep(0.42, 0.9, uv.y);
    float quiet = 1.0 - 0.78 * exp(-pow((uv.x - 0.5) * 4.2, 2.0));
    vec3 color = bg + metal * sheet * bottom * top * quiet * 0.75;
    float glow = exp(-length(vec2((uv.x - 0.08) * 1.5, (uv.y - 0.4) * 2.4)) * 5.0);
    color += vec3(0.017, 0.006, 0.001) * glow;
    gl_FragColor = vec4(color, 1.0);
  }
`;

async function start() {
  if (!canvas || !hero) return;
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'low-power' });
  if (!gl) return;
  // One bundled, pinned external module; no transitive CDN scripts.
  const THREE = await import('https://cdn.jsdelivr.net/npm/three@0.186.1/+esm');
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false, alpha: false });
  const camera = new THREE.Camera();
  const scene = new THREE.Scene();
  const geometry = new THREE.PlaneGeometry(2, 2);
  const bake = new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: crinkle });
  const mesh = new THREE.Mesh(geometry, bake);
  scene.add(mesh);
  const texture = new THREE.WebGLRenderTarget(1024, 1024, {
    depthBuffer: false, stencilBuffer: false,
    wrapS: THREE.MirroredRepeatWrapping, wrapT: THREE.MirroredRepeatWrapping
  });
  renderer.setRenderTarget(texture);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  const pointer = new THREE.Vector2();
  const target = new THREE.Vector2();
  const uniforms = {
    uFoil: { value: texture.texture }, uAspect: { value: 1 },
    uTime: { value: 0 }, uPointer: { value: pointer }
  };
  const material = new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: foil, uniforms });
  mesh.material = material;

  const measuring = new URLSearchParams(location.search).has('fxperf');
  const timer = measuring && gl.getExtension('EXT_disjoint_timer_query_webgl2');
  let query = null;
  let raf = 0;
  let seen = false;
  let lost = false;
  let dirty = true;
  let last = 0;
  let next = 0;
  let width = 0;
  let height = 0;
  const sample = (list, value) => {
    list.push(value);
    if (list.length > 180) list.shift();
  };

  function draw() {
    const start = performance.now();
    if (query && gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) sample(stats.gpu, gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(query);
      query = null;
    }
    const measure = timer && !query;
    if (measure) {
      query = gl.createQuery();
      gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    }
    renderer.render(scene, camera);
    if (measure) gl.endQuery(timer.TIME_ELAPSED_EXT);
    if (measuring) sample(stats.cpu, performance.now() - start);
    stats.frames++;
    dirty = false;
    canvas.dataset.ready = '';
  }

  function tick(now) {
    raf = 0;
    if (!seen || document.hidden || lost) return;
    if (motion.matches) {
      stats.mode = 'static';
      pointer.set(0, 0);
      uniforms.uTime.value = 0;
      draw();
      stats.running = false;
      return;
    }
    if (now >= next || dirty) {
      const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
      next = Math.max(next + 1000 / 30, now);
      last = now;
      uniforms.uTime.value += dt;
      pointer.lerp(target, 1 - Math.exp(-dt * 3));
      draw();
    }
    if (!motion.matches) raf = requestAnimationFrame(tick);
    stats.running = !!raf;
  }

  function sync() {
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
    next = 0;
    stats.running = false;
    stats.mode = lost ? 'fallback' : motion.matches ? 'static' : 'animated';
    if (!seen || document.hidden || lost) return;
    if (motion.matches) {
      if (dirty) draw();
      return;
    }
    raf = requestAnimationFrame(tick);
    stats.running = true;
  }

  function resize() {
    const rect = hero.getBoundingClientRect();
    if (width === rect.width && height === rect.height) return;
    width = rect.width;
    height = rect.height;
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const scale = Math.min(dpr * 0.8, 1000 / width, Math.sqrt(460000 / (width * height)));
    renderer.setPixelRatio(scale);
    renderer.setSize(width, height, false);
    uniforms.uAspect.value = width / height;
    stats.width = canvas.width;
    stats.height = canvas.height;
    dirty = true;
    sync();
  }

  new ResizeObserver(resize).observe(hero);
  new IntersectionObserver(([entry]) => {
    seen = entry.isIntersecting;
    sync();
  }).observe(hero);
  document.addEventListener('visibilitychange', sync);
  motion.addEventListener('change', () => {
    pointer.set(0, 0);
    target.set(0, 0);
    uniforms.uTime.value = 0;
    dirty = true;
    sync();
  });
  hero.addEventListener('pointermove', (event) => {
    if (motion.matches || event.pointerType === 'touch') return;
    const rect = hero.getBoundingClientRect();
    target.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
  }, { passive: true });
  hero.addEventListener('pointerleave', () => target.set(0, 0));
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    lost = true;
    query = null;
    delete canvas.dataset.ready;
    sync();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    renderer.setRenderTarget(texture);
    mesh.material = bake;
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    mesh.material = material;
    lost = false;
    dirty = true;
    sync();
  });
  resize();
}

async function fallback() {
  stats.backend = 'webgl';
  const fresh = canvas.cloneNode(false);
  delete fresh.dataset.ready;
  canvas.replaceWith(fresh);
  canvas = fresh;
  try { await start(); } catch { stats.mode = 'fallback'; }
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
