import { solar } from './solar.js';

export async function flare(canvas, motion, stats, fallback) {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
  if (!adapter) throw new Error('No WebGPU adapter');
  const timing = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: timing ? ['timestamp-query'] : [] });
  try {
    const hero = canvas.closest('.hero');
    const logo = hero.querySelector('.logo');
    const [source, noiseBytes] = await Promise.all([
      fetch(new URL('./flare.wgsl', import.meta.url)).then(r => r.text()),
      fetch(new URL('./blue-noise.bin', import.meta.url)).then(r => r.arrayBuffer()),
      logo.decode(), document.fonts.ready
    ]);
    const module = device.createShaderModule({ code: source });
    const info = await module.getCompilationInfo();
    if (info.messages.some(m => m.type === 'error')) throw new Error(info.messages.map(m => m.message).join('\n'));
    const context = canvas.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    const texture = (width, height, format = 'rgba8unorm') => device.createTexture({
      size: [width, height], format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST
    });
    const image = texture(logo.naturalWidth, logo.naturalHeight);
    device.queue.copyExternalImageToTexture({ source: logo }, { texture: image }, [logo.naturalWidth, logo.naturalHeight]);
    const noise = texture(128, 128, 'r8unorm');
    device.queue.writeTexture({ texture: noise }, noiseBytes, { bytesPerRow: 128 }, [128, 128]);
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ...[2, 3, 4].map(binding => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }))
    ] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const names = ['rim', 'blur', 'rays', 'composite'];
    const pipelines = Object.fromEntries(await Promise.all(names.map(async name => [name,
      await device.createRenderPipelineAsync({ layout: pipelineLayout,
        vertex: { module, entryPoint: 'vertex' }, fragment: { module, entryPoint: name, targets: [{ format: name === 'composite' ? format : 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' }
      })
    ])));
    const buffers = Array.from({ length: 5 }, () => device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    const system = await solar(device, image, sampler, hero, logo, format);
    const query = timing ? device.createQuerySet({ type: 'timestamp', count: 2 }) : null;
    const resolve = timing ? device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
    const readback = timing ? device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) : null;
    const audit = new URLSearchParams(location.search).has('fxperf');
    let pending = false;
    let textures = [];
    let passes = [];
    let size = [0, 0];
    let anchor = [0.5, 0.2, 0.1, 0.1];
    let heading = 300;
    let low = innerWidth < 600 || navigator.connection?.saveData;
    let seen = false;
    let dead = false;
    let dirty = true;
    let raf = 0;
    let next = 0;
    let last = 0;
    let time = 0;
    let slow = 0;
    let frames = 0;
    let healthStart = 0;
    let pointer = [0, 0, 0];
    let target = [0, 0, 0];
    const sample = (list, value) => { list.push(value); if (list.length > 180) list.shift(); };
    stats.backend = 'webgpu';
    stats.quality = low ? 'low' : 'high';
    stats.adapter = adapter.info.description || adapter.info.device;

    function cheaper(reason) {
      if (low || dead) return;
      low = true;
      stats.quality = 'low';
      stats.qualityReason = reason;
      resize(true);
    }

    function resize(force = false) {
      if (dead) return;
      const rect = hero.getBoundingClientRect();
      if (!force && size[0] === rect.width && size[1] === rect.height) return;
      size = [rect.width, rect.height];
      const dpr = Math.min(devicePixelRatio || 1, 1.5);
      const scale = Math.min(dpr, Math.sqrt((low ? 170000 : 360000) / (size[0] * size[1])));
      canvas.width = Math.max(1, Math.round(size[0] * scale));
      canvas.height = Math.max(1, Math.round(size[1] * scale));
      stats.width = canvas.width;
      stats.height = canvas.height;
      const l = logo.closest('.logow');
      const wrap = hero.querySelector('.wrap');
      anchor = [(wrap.offsetLeft + l.offsetLeft + l.offsetWidth / 2) / size[0], (wrap.offsetTop + l.offsetTop + l.offsetHeight / 2) / size[1], l.offsetWidth / size[0], l.offsetHeight / size[1]];
      heading = hero.querySelector('h1').getBoundingClientRect().top - rect.top;
      system.resize();
      textures.forEach(t => t.destroy());
      const w = Math.max(1, Math.round(canvas.width * (low ? 0.42 : 0.55)));
      const h = Math.max(1, Math.round(canvas.height * (low ? 0.42 : 0.55)));
      textures = [texture(w, h), texture(w, h), texture(w, h), texture(w, h)];
      const definitions = [
        ['rim', image, textures[0]], ['blur', textures[0], textures[1]],
        ['blur', textures[1], textures[2]], ['rays', textures[2], textures[3]], ['composite', textures[3], null]
      ];
      passes = definitions.map(([name, input, output], i) => ({ name, output,
        bind: device.createBindGroup({ layout, entries: [
          { binding: 0, resource: { buffer: buffers[i] } }, { binding: 1, resource: sampler },
          { binding: 2, resource: image.createView() }, { binding: 3, resource: input.createView() }, { binding: 4, resource: noise.createView() }
        ] })
      }));
      dirty = true;
      sync();
    }

    function draw() {
      const start = performance.now();
      const measure = timing && !pending && (audit || stats.frames % 30 === 0);
      const encoder = device.createCommandEncoder();
      passes.forEach((pass, i) => {
        const data = new Float32Array([
          ...size, time, 0, ...anchor,
          anchor[0] - (pointer[0] * 55 + 8) / size[0], anchor[1] - (pointer[1] * 48 + Math.sin(time * 0.3) * 7) / size[1], heading, pointer[2],
          i === 1 ? 1.5 : 0, i === 2 ? 1.5 : 0, low ? 16 : 32, 0
        ]);
        device.queue.writeBuffer(buffers[i], 0, data);
        const timestampWrites = measure && i === 0 ? { querySet: query, beginningOfPassWriteIndex: 0 } : undefined;
        const output = pass.output || context.getCurrentTexture();
        const render = encoder.beginRenderPass({ colorAttachments: [{
          view: output.createView(), loadOp: 'clear', storeOp: 'store',
          clearValue: pass.output ? [0, 0, 0, 1] : [19 / 255, 18 / 255, 16 / 255, 1]
        }], timestampWrites });
        render.setScissorRect(0, 0, output.width, Math.min(output.height, Math.ceil((heading + 65) / size[1] * output.height)));
        render.setPipeline(pipelines[pass.name]);
        render.setBindGroup(0, pass.bind);
        render.draw(3);
        render.end();
      });
      system.draw(encoder, time, pointer, measure ? { querySet: query, endOfPassWriteIndex: 1 } : undefined);
      if (measure) {
        encoder.resolveQuerySet(query, 0, 2, resolve, 0);
        encoder.copyBufferToBuffer(resolve, 0, readback, 0, 16);
      }
      device.queue.submit([encoder.finish()]);
      if (!hero.hasAttribute('data-solar')) device.queue.onSubmittedWorkDone().then(() => {
        if (!dead) hero.dataset.solar = '';
      }).catch(() => {});
      if (measure) {
        const warm = stats.frames > 12;
        pending = true;
        readback.mapAsync(GPUMapMode.READ).then(() => {
          const stamps = new BigUint64Array(readback.getMappedRange());
          const ms = Number(stamps[1] - stamps[0]) / 1e6;
          readback.unmap();
          pending = false;
          if (audit) sample(stats.gpu, ms);
          if (!warm || motion.matches) return;
          slow = ms > 3.2 ? slow + 1 : Math.max(0, slow - 1);
          if (slow >= 5) cheaper('gpu-time');
        }).catch(() => { pending = false; });
      }
      if (audit) sample(stats.cpu, performance.now() - start);
      stats.frames++;
      dirty = false;
      canvas.dataset.ready = '';
      hero.dataset.gpu = '';
    }

    function tick(now) {
      raf = 0;
      if (!seen || document.hidden || dead) return;
      if (motion.matches) {
        stats.mode = 'static';
        pointer = target = [0, 0, 0];
        time = 0;
        draw();
        stats.running = false;
        return;
      }
      if (now >= next || dirty) {
        const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
        next = Math.max(next + 1000 / 30, now);
        last = now;
        time += dt;
        pointer = pointer.map((v, i) => v + (target[i] - v) * (1 - Math.exp(-dt * 4)));
        draw();
        frames++;
        if (!healthStart) healthStart = now;
        if (now - healthStart > 4000) {
          if (frames / ((now - healthStart) / 1000) < 23) cheaper('frame-health');
          frames = 0;
          healthStart = now;
        }
      }
      if (!motion.matches) raf = requestAnimationFrame(tick);
      stats.running = !!raf;
    }

    function sync() {
      cancelAnimationFrame(raf);
      raf = 0;
      next = last = frames = healthStart = 0;
      stats.running = false;
      stats.mode = motion.matches ? 'static' : 'animated';
      if (!seen || document.hidden || dead) return;
      if (motion.matches) {
        if (dirty) draw();
        return;
      }
      raf = requestAnimationFrame(tick);
      stats.running = true;
    }

    const controller = new AbortController();
    const options = { signal: controller.signal, passive: true };
    const resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(hero);
    const observer = new IntersectionObserver(([entry]) => { seen = entry.isIntersecting; sync(); });
    observer.observe(hero);
    document.addEventListener('visibilitychange', sync, options);
    motion.addEventListener('change', () => {
      pointer = target = [0, 0, 0];
      time = 0;
      dirty = true;
      sync();
    }, options);
    hero.addEventListener('pointermove', event => {
      if (motion.matches || event.pointerType === 'touch') return;
      const r = hero.getBoundingClientRect();
      const dx = event.clientX - r.left - anchor[0] * size[0];
      const dy = event.clientY - r.top - anchor[1] * size[1];
      target = [Math.max(-1, Math.min(1, dx / 250)), Math.max(-1, Math.min(1, dy / 250)), Math.exp(-(dx * dx + dy * dy) / 160000)];
    }, options);
    hero.addEventListener('pointerleave', () => { target = [0, 0, 0]; }, options);
    navigator.getBattery?.().then(battery => {
      if (dead) return;
      const check = () => { if (!battery.charging && battery.level <= 0.3) cheaper('battery'); };
      battery.addEventListener('levelchange', check, options);
      battery.addEventListener('chargingchange', check, options);
      check();
    }).catch(() => {});

    function stop() {
      if (dead) return;
      dead = true;
      cancelAnimationFrame(raf);
      controller.abort();
      observer.disconnect();
      resizeObserver.disconnect();
      delete hero.dataset.gpu;
      system.dispose();
      delete canvas.dataset.ready;
      textures.forEach(t => t.destroy());
      buffers.forEach(b => b.destroy());
      image.destroy(); noise.destroy(); query?.destroy(); resolve?.destroy(); readback?.destroy();
      device.destroy();
      fallback();
    }
    device.lost.then(stop);
    device.addEventListener('uncapturederror', event => { event.preventDefault(); stop(); });
    resize();
  } catch (error) {
    device.destroy();
    throw error;
  }
}
