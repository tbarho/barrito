/* barrito canvas fx — dithered pixel field, fade, button dust, border glow. no deps. */
(function () {
var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
var BAYER = [0,32,8,40,2,34,10,42,48,16,56,24,50,18,58,26,12,44,4,36,14,46,6,38,60,28,52,20,62,30,54,22,3,35,11,43,1,33,9,41,51,19,59,27,49,17,57,25,15,47,7,39,13,45,5,37,63,31,55,23,61,29,53,21];

function rng(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function mixc(a, b, t) {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

/* 1 + 5. dithered pixel field: procedural scene, ordered-dither lit cells as particles */
function field(canvas, o) {
  var ctx = canvas.getContext('2d');
  var dpr = Math.min(devicePixelRatio || 1, 2);
  var W = 0, H = 0, buckets = [], drops = [], raf = 0, last = 0, seen = false;
  var px = -1e4, py = -1e4, acc = 0;
  var perf = { frames: 0, ms: 0, max: 0 };

  function size() {
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }

  function color(b, star, r) {
    var c, a;
    if (star) {
      c = r() < o.silver ? [186, 181, 168] : [242, 232, 213];
      a = 0.3 + r() * 0.55;
    } else {
      var t = Math.min(1, b / 0.8);
      c = mixc([90, 42, 6], [255, 150, 40], t * t);
      a = 0.3 + 0.6 * t;
    }
    c[0] &= 0xF0; c[1] &= 0xF0; c[2] &= 0xF0;
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (Math.round(a * 8) / 8) + ')';
  }

  function build() {
    var r = rng(o.seed), cols = Math.ceil(W / 2), rows = Math.ceil(H / 2), cx = cols / 2;
    var stars = {}, lit = [], i, x, y;
    for (i = 0; i < Math.round(cols * rows * o.stars); i++)
      stars[((r() * rows * 0.75) | 0) * cols + ((r() * cols) | 0)] = 0.3 + r() * 0.5;
    var colE = [], rowE = [];
    for (x = 0; x < cols; x++) { var gx = (x - cx) / (cols * 0.44); colE[x] = Math.exp(-gx * gx * 2.4); }
    for (y = 0; y < rows; y++) { var gy = (y / rows - 0.84) / 0.34; rowE[y] = 0.8 * Math.exp(-gy * gy * 2.4) + 0.16 * Math.max(0, y / rows - 0.6); }
    for (y = 0; y < rows; y++) {
      for (x = 0; x < cols; x++) {
        var s = stars[y * cols + x];
        var b = s || colE[x] * rowE[y];
        if (b * o.gate > (BAYER[(x & 7) + ((y & 7) << 3)] + 0.5) / 64) lit.push([x, y, b, s > 0]);
      }
    }
    var keep = Math.min(1, o.cap / lit.length), by = {};
    for (i = 0; i < lit.length; i++) {
      if (r() > keep) continue;
      var p = lit[i];
      var css = color(p[2], p[3], r);
      (by[css] || (by[css] = { css: css, pts: [] })).pts.push({ x: p[0] * 2, y: p[1] * 2, hx: p[0] * 2, hy: p[1] * 2, vx: 0, vy: 0 });
    }
    buckets = Object.keys(by).map(function (k) { return by[k]; });
  }

  function step(dt) {
    var lx = -1e4, ly = 0;
    if (px > -9999) {
      var rc = canvas.getBoundingClientRect();
      lx = px - rc.left; ly = py - rc.top;
      if (lx < -110 || ly < -110 || lx > W + 110 || ly > H + 110) lx = -1e4;
    }
    var damp = 1 - 5 * dt;
    for (var bi = 0; bi < buckets.length; bi++) {
      var pts = buckets[bi].pts;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        if (lx > -9999) {
          var dx = p.x - lx, dy = p.y - ly, d2 = dx * dx + dy * dy;
          if (d2 < 12100 && d2 > 0.01) {
            var d = Math.sqrt(d2), f = (1 - d / 110) * 2400 / d;
            p.vx += dx * f * dt; p.vy += dy * f * dt;
          }
        }
        p.vx += (p.hx - p.x) * 28 * dt;
        p.vy += (p.hy - p.y) * 28 * dt;
        p.vx *= damp; p.vy *= damp;
        p.x += p.vx * dt; p.y += p.vy * dt;
      }
    }
    if (o.rate) {
      acc += o.rate * dt;
      while (acc >= 1) { acc--; drops.push({ x: Math.random() * W, y: -4, vx: (Math.random() - 0.5) * 16, vy: 60 + Math.random() * 60, a: 0.9, st: 0, tx: 0, c: '' }); }
    }
    for (var j = drops.length - 1; j >= 0; j--) {
      var q = drops[j];
      if (!q.st) {
        q.x += q.vx * dt; q.y += q.vy * dt;
        if (q.y > H * 0.64) {
          q.st = 1;
          var side = q.x < W / 2 ? -1 : 1;
          q.tx = W / 2 + side * W * 0.18;
          q.c = side < 0 ? 'rgba(255,128,1,' : 'rgba(186,181,168,';
        }
      } else {
        q.vx += (q.tx - q.x) * 2.5 * dt;
        q.x += q.vx * dt; q.y += q.vy * dt;
        q.a -= 1.5 * dt;
      }
      if (q.a <= 0 || q.y > H) drops.splice(j, 1);
    }
    if (drops.length > 48) drops.splice(0, drops.length - 48);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (var bi = 0; bi < buckets.length; bi++) {
      var b = buckets[bi], pts = b.pts;
      ctx.fillStyle = b.css;
      for (var i = 0; i < pts.length; i++) ctx.fillRect(pts[i].x | 0, pts[i].y | 0, 2, 2);
    }
    for (var j = 0; j < drops.length; j++) {
      var q = drops[j];
      ctx.fillStyle = (q.st ? q.c : 'rgba(242,232,213,') + q.a.toFixed(2) + ')';
      ctx.fillRect(q.x | 0, q.y | 0, 2, 2);
    }
  }

  function blast(cx, cy) {
    buckets.forEach(function (b) {
      b.pts.forEach(function (p) {
        var dx = p.x - cx, dy = p.y - cy, d = Math.sqrt(dx * dx + dy * dy);
        if (d > 160 || d < 0.01) return;
        var f = (1 - d / 160) * 560 / d;
        p.vx += dx * f; p.vy += dy * f;
      });
    });
  }

  function tick(t) {
    raf = 0;
    var dt = Math.min((t - last) / 1000 || 0.016, 1 / 30);
    last = t;
    var t0 = performance.now();
    step(dt); draw();
    var ms = performance.now() - t0;
    perf.frames++;
    perf.ms = perf.ms ? perf.ms * 0.9 + ms * 0.1 : ms;
    if (ms > perf.max) perf.max = ms;
    if (seen && !document.hidden) raf = requestAnimationFrame(tick);
  }

  function wake() {
    if (raf || reduced || !seen || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  var rq = 0;
  function rebuild() {
    size(); build();
    if (reduced) draw();
  }
  if ('ResizeObserver' in window) new ResizeObserver(function () {
    if (rq) return;
    rq = requestAnimationFrame(function () { rq = 0; rebuild(); });
  }).observe(canvas);
  rebuild();

  if (reduced) return perf;

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) { seen = es[0].isIntersecting; wake(); }, { rootMargin: '40px' }).observe(canvas);
  } else { seen = true; }

  addEventListener('pointermove', function (e) { px = e.clientX; py = e.clientY; wake(); }, { passive: true });
  addEventListener('pointerdown', function (e) {
    var rc = canvas.getBoundingClientRect();
    var x = e.clientX - rc.left, y = e.clientY - rc.top;
    if (x < -20 || y < -20 || x > W + 20 || y > H + 20) return;
    blast(x, y);
  }, { passive: true });
  document.addEventListener('visibilitychange', wake);
  return perf;
}

/* 2. dithered fade overlay — per-pixel alpha noise over a bg gradient */
function fadeOverlay(canvas) {
  var ctx = canvas.getContext('2d');
  var dpr = Math.min(devicePixelRatio || 1, 2);
  function render() {
    var W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    var band = Math.min(260, Math.round(H * 0.45));
    var off = document.createElement('canvas');
    off.width = W; off.height = band;
    var octx = off.getContext('2d');
    var img = octx.createImageData(W, band), d = img.data, r = rng(7);
    for (var y = 0; y < band; y++) {
      var a = Math.pow(y / band, 1.35) * 255;
      for (var x = 0; x < W; x++) {
        var i = (y * W + x) * 4;
        d[i] = 19; d[i + 1] = 18; d[i + 2] = 16;
        d[i + 3] = Math.max(0, Math.min(255, a + ((r() * 8) | 0) - 4));
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, (H - band) * dpr, W * dpr, band * dpr);
    canvas.dataset.rendered = '1';
  }
  if ('ResizeObserver' in window) new ResizeObserver(render).observe(canvas);
  render();
}

/* 3. button dust — crumbs on click, rAF only while alive */
var DUST = ['#f2e8d5', '#e6d2ab', '#d8b98a', '#c8a25c'];
function dust(btn) {
  if (reduced) return;
  var c = document.createElement('canvas');
  c.className = 'fx-dust';
  c.setAttribute('aria-hidden', 'true');
  btn.appendChild(c);
  btn.style.position = 'relative';
  btn.style.zIndex = '0';
  var ctx = c.getContext('2d');
  var dpr = Math.min(devicePixelRatio || 1, 2), W = 0, H = 0, pts = [], raf = 0, last = 0;

  function size() {
    var rc = btn.getBoundingClientRect();
    W = Math.round(rc.width) + 52; H = Math.round(rc.height) + 52;
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function tick(t) {
    raf = 0;
    var dt = Math.min((t - last) / 1000 || 0.016, 1 / 30);
    last = t;
    var damp = 1 - 5 * dt;
    ctx.clearRect(0, 0, W, H);
    for (var i = pts.length - 1; i >= 0; i--) {
      var p = pts[i];
      p.l -= dt;
      if (p.l <= 0) { pts.splice(i, 1); continue; }
      p.vy += 300 * dt;
      p.vx *= damp; p.vy *= damp;
      p.x += p.vx * dt; p.y += p.vy * dt;
      var a = p.l / p.m;
      ctx.globalAlpha = a * a;
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x | 0, p.y | 0, p.s, p.s);
    }
    ctx.globalAlpha = 1;
    if (pts.length) raf = requestAnimationFrame(tick);
  }

  btn.addEventListener('click', function (e) {
    var rc = btn.getBoundingClientRect();
    var real = e && e.detail;
    var cx = (real ? e.clientX - rc.left : rc.width / 2) + 26;
    var cy = (real ? e.clientY - rc.top : rc.height / 2) + 26;
    for (var i = 0, n = 24 + Math.random() * 14; i < n; i++) {
      var a = Math.random() * Math.PI * 2, s = 50 + Math.random() * 170, m = 0.45 + Math.random() * 0.45;
      pts.push({ x: cx, y: cy, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, l: m, m: m, s: 2 + Math.random() * 2, c: DUST[Math.random() * 4 | 0] });
    }
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
  });

  if ('ResizeObserver' in window) new ResizeObserver(size).observe(btn);
  size();
}

/* 4. pointer-tracking border glow via --mx/--my */
function glow(el) {
  if (!el || !matchMedia('(hover: hover)').matches) return;
  el.addEventListener('pointermove', function (e) {
    var rc = el.getBoundingClientRect();
    el.style.setProperty('--mx', (e.clientX - rc.left) + 'px');
    el.style.setProperty('--my', (e.clientY - rc.top) + 'px');
  }, { passive: true });
}

function init() {
  var stats = {};
  var hero = document.querySelector('[data-fx="hero"]');
  if (hero) stats.hero = field(hero, { seed: 11, cap: 4200, stars: 0.0016, silver: 0.3, gate: 1.05, rate: 2.4 });
  var foot = document.querySelector('[data-fx="footer"]');
  if (foot && matchMedia('(min-width: 700px)').matches)
    stats.footer = field(foot, { seed: 77, cap: 1200, stars: 0.0022, silver: 0.6, gate: 1.15, rate: 0 });
  var f = document.querySelector('.fx-fade');
  if (f) fadeOverlay(f);
  document.querySelectorAll('.copy, .btn.primary').forEach(dust);
  glow(document.querySelector('.install'));
  try { window.__fx = stats; } catch (e) {}
}

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', init);
else init();
})();
