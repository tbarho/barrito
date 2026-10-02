// Flare / diffraction studies: Vercel Labs VGPU; see vgpu-LICENSE.txt.
struct Params {
  screen: vec4f,
  logo: vec4f,
  light: vec4f,
  state: vec4f,
}
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var linear: sampler;
@group(0) @binding(2) var image: texture_2d<f32>;
@group(0) @binding(3) var field: texture_2d<f32>;
@group(0) @binding(4) var noise: texture_2d<f32>;

struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@builtin(vertex_index) i: u32) -> Vertex {
  let pos = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return Vertex(vec4f(pos * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0), pos);
}
fn alpha(uv: vec2f) -> f32 {
  let coord = (uv - p.logo.xy) / p.logo.zw + 0.5;
  let inside = all(coord >= vec2f(0.0)) && all(coord <= vec2f(1.0));
  return select(0.0, textureSampleLevel(image, linear, coord, 0.0).a, inside);
}
@fragment fn rim(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = 1.5 / p.screen.xy;
  let a = alpha(uv);
  let x = alpha(uv + vec2f(t.x, 0.0)) - alpha(uv - vec2f(t.x, 0.0));
  let y = alpha(uv + vec2f(0.0, t.y)) - alpha(uv - vec2f(0.0, t.y));
  let ring = min(1.0, length(vec2f(x, y)));
  let normal = normalize(vec2f(x, y) + vec2f(0.0001));
  let direction = normalize((p.light.xy - uv) * p.screen.xy + vec2f(0.001));
  let facing = 0.45 + 0.55 * abs(dot(normal, direction));
  let out = ring * facing;
  return vec4f(out, out, out, a);
}
@fragment fn blur(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = p.state.xy / vec2f(textureDimensions(field));
  var c = textureSampleLevel(field, linear, uv, 0.0) * 0.227027;
  c += textureSampleLevel(field, linear, uv + t * 1.384615, 0.0) * 0.316216;
  c += textureSampleLevel(field, linear, uv - t * 1.384615, 0.0) * 0.316216;
  c += textureSampleLevel(field, linear, uv + t * 3.230769, 0.0) * 0.070270;
  c += textureSampleLevel(field, linear, uv - t * 3.230769, 0.0) * 0.070270;
  return c;
}
fn silver(d: vec2f) -> f32 {
  return smoothstep(-0.8,0.8,d.x/sqrt(dot(d,d)+57600.0));
}
@fragment fn rays(@location(0) uv: vec2f) -> @location(0) vec4f {
  let pixel = vec2u(uv * vec2f(textureDimensions(field)));
  let frame = u32(p.screen.z * 15.0);
  let jitter = textureLoad(noise, vec2i((pixel + vec2u(frame * 73u, frame * 23u)) & vec2u(127u)), 0).r;
  let steps = u32(p.state.z);
  let delta = (uv - p.light.xy) * 0.99 / f32(steps);
  var coord = uv - delta * jitter;
  let direction = normalize((uv-p.light.xy)*p.screen.xy+vec2f(0.01));
  let spread = vec2f(-direction.y,direction.x)*32.0/p.screen.xy;
  var sum = 0.0;
  var weight = 1.0;
  var total = 0.0;
  for (var i = 0u; i < steps; i++) {
    coord -= delta;
    let source = textureSampleLevel(field, linear, coord, 0.0).r*0.5
      + textureSampleLevel(field, linear, coord+spread, 0.0).r*0.25
      + textureSampleLevel(field, linear, coord-spread, 0.0).r*0.25;
    sum += source * weight;
    total += weight;
    weight *= 0.973;
  }
  let d = (uv - p.logo.xy) * p.screen.xy;
  let aim = (p.logo.xy-p.light.xy)*p.screen.xy/55.0;
  let facing = dot(normalize(d+vec2f(0.01)),aim);
  let span = vec2f(560.0,300.0)*(1.0+facing*0.28+p.light.w*0.12);
  let reach = exp(-dot(d/span,d/span));
  let signal = sum / total * 10.5 * clamp(1.0+facing*0.7,0.4,1.8);
  let tint = mix(vec3f(1.0, 0.34, 0.055), vec3f(0.64, 0.74, 0.79), silver(d));
  let glow = textureSampleLevel(field, linear, uv, 0.0).r;
  let atmosphere = exp(-dot(d / vec2f(235.0, 125.0), d / vec2f(235.0, 125.0))) * 0.028;
  let pulse = 1.0+p.light.w*(0.38+0.08*sin(p.screen.z*2.2));
  return vec4f(tint * (signal * 1.5 + glow * 0.85 + atmosphere) * reach * pulse, 1.0);
}
fn pearl(phase: f32) -> vec3f {
  return vec3f(0.55, 0.52, 0.64) + vec3f(0.43, 0.4, 0.34) * cos(6.2831853 * (phase + vec3f(0.05, 0.38, 0.63)));
}
fn wave(w: f32) -> vec3f {
  let r = (vec3f(w) - vec3f(0.610, 0.545, 0.460)) / vec3f(0.045, 0.038, 0.032);
  return exp(-0.5 * r * r);
}
fn hash(q: vec2f) -> f32 {
  var h = fract(vec3f(q.xyx)*0.1031);
  h += dot(h,h.yzx+33.33);
  return fract((h.x+h.y)*h.z);
}
fn cloud(q: vec2f) -> f32 {
  let cell = floor(q);
  let f = fract(q);
  let u = f*f*(3.0-2.0*f);
  return mix(mix(hash(cell),hash(cell+vec2f(1,0)),u.x),mix(hash(cell+vec2f(0,1)),hash(cell+vec2f(1,1)),u.x),u.y);
}
@fragment fn composite(@location(0) uv: vec2f) -> @location(0) vec4f {
  let px = uv * p.screen.xy;
  let d = (uv - p.logo.xy) * p.screen.xy;
  let copyMask = 1.0 - smoothstep(p.light.z - 100.0, p.light.z + 20.0, px.y);
  let edge = smoothstep(0.0,120.0,px.y)*smoothstep(0.0,120.0,min(px.x,p.screen.x-px.x));
  let texel = 1.0 / vec2f(textureDimensions(field));
  var scattered = textureSampleLevel(field, linear, uv, 0.0).rgb * 0.4;
  scattered += textureSampleLevel(field, linear, uv + texel * vec2f(1.2, 0.0), 0.0).rgb * 0.15;
  scattered += textureSampleLevel(field, linear, uv - texel * vec2f(1.2, 0.0), 0.0).rgb * 0.15;
  scattered += textureSampleLevel(field, linear, uv + texel * vec2f(0.0, 1.2), 0.0).rgb * 0.15;
  scattered += textureSampleLevel(field, linear, uv - texel * vec2f(0.0, 1.2), 0.0).rgb * 0.15;
  var glow = scattered * copyMask * edge * 0.7;
  let radius = length(d / vec2f(1.0, 0.43));
  let angle = atan2(d.y / 0.43, d.x);
  let bend = sin(angle * 3.0 + p.screen.z * 0.16) * 18.0;
  let sweep = exp(-pow((radius - 215.0 - bend) / 35.0, 2.0));
  let contours = pow(0.5 + 0.5 * sin(radius * 0.12 + sin(angle * 4.0) * 2.0), 6.0);
  let light = (p.light.xy - p.logo.xy) * p.screen.xy / 100.0;
  let phase = sin(angle) * 0.13 + radius * 0.0014 + dot(light, vec2f(0.3, -0.2));
  let path = abs(dot(normalize(d + vec2f(0.01)), light + vec2f(0.5, 0.4))) * 1.5;
  let diffraction = wave(path) + wave(path / 2.0) * 0.25;
  let sheen = (pearl(phase) * 0.65 + diffraction * 0.35) * sweep;
  glow += sheen * (0.085 + p.light.w * 0.25) * (0.2 + contours * 0.8) * copyMask * edge;
  let drift = vec2f(p.screen.z*0.012,-p.screen.z*0.007);
  let dust = cloud(d/vec2f(145.0,70.0)+drift+light*0.06);
  let wisps = cloud(d/vec2f(65.0,24.0)+vec2f(dust*1.7)+drift*0.7);
  let veil = pow(dust*0.6+wisps*0.4,3.0)*0.07*exp(-dot(d/vec2f(480,160),d/vec2f(480,160)));
  glow += mix(vec3f(0.9,0.29,0.06),vec3f(0.5,0.65,0.78),silver(d))*veil*copyMask*edge;
  let bg = vec3f(19.0, 18.0, 16.0) / 255.0;
  return vec4f(bg + (vec3f(1.0) - exp(-glow)), 1.0);
}
