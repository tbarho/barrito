const worlds = [
  [112, 6.5, 0.3, 0.26, 0.22, 1, 0.34, 0.07],
  [153, 9, 2.75, -0.15, 0.32, 0.66, 0.2, 0.12],
  [202, 11, 5.1, 0.12, 0.31, 0.38, 0.51, 0.2],
  [251, 10, 3.65, -0.09, 0.29, 0.87, 0.8, 0.64],
  [294, 15, 0.4, 0.09, 0.27, 0.61, 0.67, 0.72],
  [338, 6, 2.4, -0.06, 0.25, 0.22, 0.16, 0.19]
];

export function system(width, time, pointer = [0, 0]) {
  const mobile = width < 600;
  const scale = mobile ? Math.min((width - 30) / 630, 0.6) : 1;
  return worlds.filter((_, i) => !mobile || [0, 2, 3, 4].includes(i)).map(([orbit, radius, phase, tilt, squash, ...color], i) => {
    const a = orbit * scale;
    const angle = phase + time * (Math.PI * 2 / 9) * (112 / orbit) ** 1.25;
    const eccentric = angle + 0.09 * Math.sin(angle);
    const turn = tilt + pointer[0] * 0.045;
    const q = squash + pointer[1] * 0.025;
    const x = a * Math.cos(eccentric), y = a * Math.sin(eccentric) * q;
    const z = Math.sin(eccentric) * a;
    const r = radius * (mobile ? 0.72 : 1) * (1 + z / 2400);
    return [x * Math.cos(turn) - y * Math.sin(turn), x * Math.sin(turn) + y * Math.cos(turn), z, r,
      a, q, Math.cos(turn), Math.sin(turn), ...color, orbit === 294 ? 1 : orbit === 202 ? 2 : 0];
  }).sort((a, b) => a[2] - b[2]);
}

export function viewport(hero, logo) {
  const wrap = hero.querySelector('.wrap'), box = logo.closest('.logow');
  const width = Math.min(hero.clientWidth, 780);
  const height = Math.min(290, box.offsetHeight + 108);
  const x = wrap.offsetLeft + box.offsetLeft + box.offsetWidth / 2;
  const y = wrap.offsetTop + box.offsetTop + box.offsetHeight / 2;
  const heading = hero.querySelector('h1');
  const limit = wrap.offsetTop + heading.offsetTop - (y - height / 2) - 10;
  return { width, height, left: x - width / 2, top: y - height / 2, logo: box.offsetWidth, limit, mobile: hero.clientWidth < 600 };
}

export function layer(hero) {
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-solar';
  canvas.setAttribute('aria-hidden', 'true');
  hero.prepend(canvas);
  return canvas;
}

export function place(canvas, rect) {
  Object.assign(canvas.style, { width: `${rect.width}px`, height: `${rect.height}px`, left: `${rect.left}px`, top: `${rect.top}px` });
}

export async function solar(device, image, sampler, hero, logo, format) {
  const source = await fetch(new URL('./solar.wgsl', import.meta.url)).then(r => r.text());
  const module = device.createShaderModule({ code: source });
  const info = await module.getCompilationInfo();
  if (info.messages.some(m => m.type === 'error')) throw new Error(info.messages.map(m => m.message).join('\n'));
  const layout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} }
  ] });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipelines = await Promise.all(['stars', 'orbit', 'back', 'sun', 'front'].map(name => device.createRenderPipelineAsync({
    layout: pipelineLayout,
    vertex: { module, entryPoint: name === 'stars' ? 'skyVertex' : name === 'orbit' ? 'orbitVertex' : name === 'sun' ? 'sunVertex' : 'bodyVertex' },
    fragment: { module, entryPoint: name, targets: [{ format, blend: {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
    } }] }, primitive: { topology: 'triangle-list' }
  })));
  const buffer = device.createBuffer({ size: 320, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bind = device.createBindGroup({ layout, entries: [
    { binding: 0, resource: { buffer } }, { binding: 1, resource: image.createView() }, { binding: 2, resource: sampler }
  ] });
  const canvas = layer(hero);
  const context = canvas.getContext('webgpu');
  context.configure({ device, format, alphaMode: 'premultiplied' });
  let rect;
  return {
    resize() {
      rect = viewport(hero, logo);
      place(canvas, rect);
      const dpr = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    },
    draw(encoder, time, pointer, timestampWrites) {
      const bodies = system(hero.clientWidth, time, pointer);
      const data = new Float32Array(80);
      data.set([rect.width, rect.height, rect.logo, time, ...pointer.slice(0, 2), rect.mobile ? 1 : 0, pointer[2] || 0]);
      bodies.forEach((body, i) => data.set(body, 8 + i * 12));
      device.queue.writeBuffer(buffer, 0, data);
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }], timestampWrites });
      pass.setScissorRect(0, 0, canvas.width, Math.max(1, Math.min(canvas.height, Math.floor(rect.limit / rect.height * canvas.height))));
      pass.setBindGroup(0, bind);
      pipelines.forEach((pipeline, i) => {
        pass.setPipeline(pipeline);
        pass.draw(i === 1 ? 128 * 6 : 6, i === 0 || i === 3 ? 1 : bodies.length);
      });
      pass.end();
    },
    dispose() { canvas.remove(); buffer.destroy(); delete hero.dataset.solar; }
  };
}
