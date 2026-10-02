struct Body { position: vec4f, orbit: vec4f, color: vec4f }
struct Params { view: vec4f, pointer: vec4f, bodies: array<Body, 6> }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var logo: texture_2d<f32>;
@group(0) @binding(2) var linear: sampler;
struct Vertex {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) index: u32,
}
fn clip(point: vec2f) -> vec4f { return vec4f(point / p.view.xy * vec2f(2.0, -2.0), 0.0, 1.0); }
fn corner(i: u32) -> vec2f {
  let points = array<vec2f, 6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
  return points[i];
}
fn hash(q: vec2f) -> vec3f {
  var h = fract(vec3f(q.xyx) * vec3f(0.1031,0.1030,0.0973));
  h += dot(h,h.yxz+33.33);
  return fract((h.xxy+h.yzz)*h.zyx);
}
@vertex fn skyVertex(@builtin(vertex_index) i: u32) -> Vertex {
  let q = corner(i);
  return Vertex(vec4f(q * vec2f(1,-1),0,1),q*p.view.xy*0.5,0u);
}
@fragment fn stars(v: Vertex) -> @location(0) vec4f {
  var light = vec3f(0);
  let margin = p.view.xy*0.5-abs(v.local);
  let fade = smoothstep(0.0,120.0,margin.x)*smoothstep(0.0,120.0,margin.y);
  for(var i=0u;i<3u;i++) {
    let depth = f32(i)+1.0;
    let cell = 32.0+depth*18.0;
    let point = (v.local+p.pointer.xy*depth*3.0+vec2f(91,47)*depth)/cell;
    let seed = hash(floor(point));
    let d = (fract(point)-(0.16+seed.xy*0.68))*cell;
    if (seed.z<0.40 || any(abs(d)>vec2f(6.0))) { continue; }
    let bright = smoothstep(0.90,1.0,seed.z);
    let size = 0.55+seed.y*0.38+bright*0.30;
    let core = exp(-dot(d,d)/(size*size));
    let cross = exp(-abs(d.x)*3.5-abs(d.y)*0.55)+exp(-abs(d.y)*3.5-abs(d.x)*0.55);
    let twinkle = 0.68+0.32*sin(p.view.w*(0.45+seed.x*1.1)+seed.y*6.283);
    let value = (core*0.50+cross*bright*0.16)*twinkle*step(0.40,seed.z);
    light += mix(vec3f(0.77,0.57,0.38),vec3f(0.66,0.77,0.88),smoothstep(-0.8,0.8,v.local.x/sqrt(dot(v.local,v.local)+57600.0)))*value;
  }
  return vec4f(light*fade,0.0);
}
@vertex fn bodyVertex(@builtin(vertex_index) i: u32, @builtin(instance_index) b: u32) -> Vertex {
  let body = p.bodies[b];
  let q = corner(i) * body.position.w * 2.5;
  return Vertex(clip(body.position.xy + q), q / body.position.w, b);
}
@vertex fn sunVertex(@builtin(vertex_index) i: u32) -> Vertex {
  let q = corner(i);
  return Vertex(clip(q * p.view.z * 0.5), q * 0.5 + 0.5, 0u);
}
@vertex fn orbitVertex(@builtin(vertex_index) i: u32, @builtin(instance_index) b: u32) -> Vertex {
  let body = p.bodies[b];
  let c = corner(i % 6u);
  let a = (f32(i / 6u) + (c.x + 1.0) * 0.5) / 128.0 * 6.2831853;
  let radius = body.orbit.x;
  let normal = normalize(vec2f(cos(a) * body.orbit.y, sin(a)));
  let q = vec2f(cos(a), sin(a) * body.orbit.y) * radius + normal * c.y * 0.8;
  let turn = body.orbit.zw;
  let point = vec2f(q.x * turn.x - q.y * turn.y, q.x * turn.y + q.y * turn.x);
  return Vertex(clip(point), vec2f(c.y, a), b);
}
@fragment fn orbit(v: Vertex) -> @location(0) vec4f {
  let rear = smoothstep(-0.2, 0.2, sin(v.local.y));
  let dashes = mix(0.3 + 0.7 * smoothstep(-0.4,0.2,sin(v.local.y * 42.0)), 1.0, rear);
  let coverage = (1.0 - smoothstep(0.1, 1.0, abs(v.local.x))) * (0.11 + rear * 0.09) * dashes;
  return vec4f(vec3f(0.49,0.43,0.34) * coverage, coverage);
}
fn planet(v: Vertex) -> vec4f {
  let body = p.bodies[v.index];
  let q = v.local;
  let radius = length(q);
  let aa = max(fwidth(radius), 0.015);
  let coverage = 1.0 - smoothstep(1.0-aa,1.0+aa,radius);
  let n = vec3f(q, sqrt(max(0.0,1.0-dot(q,q))));
  let light = normalize(vec3f(p.pointer.xy*38.0-body.position.xy, 125.0 - body.position.z));
  let day = smoothstep(-0.035,0.6,dot(n,light));
  let aim = 1.0 + p.pointer.w*0.35 + max(dot(normalize(body.position.xy+vec2f(0.01)),p.pointer.xy),0.0)*0.25;
  let grain = sin(q.x*9.0+sin(q.y*7.0))*sin(q.y*8.0+q.x*5.0);
  let bands = sin((q.y+q.x*0.2)*19.0)*0.5+0.5;
  let texture = select(0.9+grain*0.1,0.7+bands*0.3,body.color.w==1.0);
  var surface = body.color.rgb * texture * (0.095 + day*0.88*aim);
  surface += vec3f(1.0,0.62,0.28)*pow(max(dot(n,light),0.0),5.0)*0.16*aim;
  let rim = pow(1.0-max(n.z,0.0),4.0)*pow(max(dot(normalize(vec3f(q,0.15)),light),0.0),2.0);
  surface += mix(vec3f(0.72,0.43,0.19),vec3f(0.36,0.59,0.27),select(0.0,1.0,body.color.w==2.0))*rim*(0.45+p.pointer.w*0.25);
  var result = vec4f(surface*coverage,coverage);
  if (body.color.w==1.0) {
    let turn = vec2f(0.93,0.37);
    let r = vec2f(q.x*turn.x+q.y*turn.y,(-q.x*turn.y+q.y*turn.x)/0.32);
    let dist = length(r);
    let ring = smoothstep(1.32,1.45,dist)*(1.0-smoothstep(2.15,2.3,dist));
    let gap = 0.72+0.28*sin(dist*17.0);
    let shimmer = 0.65+0.15*sin(p.view.w*0.15+p.pointer.x);
    let a = ring*gap*0.46;
    let silver = vec3f(0.64,0.65,0.59)*shimmer;
    let visible = select(1.0-coverage,1.0,r.y>0.0);
    result = vec4f(silver*a*visible+result.rgb*(1.0-a*visible),a*visible+result.a*(1.0-a*visible));
  }
  return result;
}
@fragment fn back(v: Vertex) -> @location(0) vec4f {
  if (p.bodies[v.index].position.z >= 0.0) { discard; }
  return planet(v);
}
@fragment fn front(v: Vertex) -> @location(0) vec4f {
  if (p.bodies[v.index].position.z < 0.0) { discard; }
  return planet(v);
}
@fragment fn sun(v: Vertex) -> @location(0) vec4f {
  let t = 0.24 / p.view.z;
  let c = (textureSample(logo, linear, v.local + vec2f(t,t)) + textureSample(logo, linear, v.local - vec2f(t,t))
    + textureSample(logo, linear, v.local + vec2f(t,-t)) + textureSample(logo, linear, v.local + vec2f(-t,t))) * 0.25;
  return vec4f(c.rgb*c.a,c.a);
}
