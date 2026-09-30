/* Аэрокомпозит — реалистичный карбоновый фон на WebGL.
   Сверху страницы — плетёный карбон (саржа 2x2), книзу — кованый.
   Освещение анизотропное (модель Уорда) от точечного источника: блики «бегают» по нитям
   за курсором и при прокрутке. Без WebGL остаётся запасной SVG-фон из style.css. */
(function () {
  "use strict";

  const canvas = document.createElement("canvas");
  canvas.className = "carbon-bg";
  canvas.setAttribute("aria-hidden", "true");
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" });
  if (!gl) return;

  const vert = `
    attribute vec2 aPos;
    void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
  `;

  const frag = `
    precision highp float;

    uniform vec2  uRes;     // размер холста в физических пикселях
    uniform float uDpr;
    uniform float uScroll;  // прокрутка, CSS px
    uniform float uDocH;    // высота документа, CSS px
    uniform vec2  uLight;   // наклон источника света, -1..1

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    vec2 hash22(vec2 p) {
      float n = hash21(p);
      return vec2(n, hash21(p + n + 17.17));
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
                 mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
    }

    // Анизотропный блик (Уорд): узкий вдоль волокна, широкий поперёк.
    float aniso(vec3 N, vec3 T, vec3 H, float aT, float aB) {
      vec3 B = normalize(cross(N, T));
      T = normalize(cross(B, N));
      float ht = dot(H, T) / aT, hb = dot(H, B) / aB, hn = max(dot(H, N), 0.05);
      return exp(-(ht * ht + hb * hb) / (hn * hn));
    }

    // L и V — векторы на точечный источник света и на камеру для текущего пикселя
    vec3 shade(float albedo, vec3 N, vec3 T, float specK, float aT, float aB, vec3 L, vec3 V) {
      vec3 H = normalize(L + V);
      float diff = max(dot(N, L), 0.0);
      float spec = aniso(N, T, H, aT, aB);
      return vec3(albedo * (0.25 + 0.75 * diff)) + vec3(0.9, 0.92, 0.96) * spec * specK;
    }

    /* ---------- Плетёный карбон, саржа 2x2 ---------- */
    vec3 twill(vec2 px, vec3 L, vec3 V) {
      float w = 8.0;                          // ширина жгута, CSS px
      vec2 p = px / w;
      vec2 c = floor(p);
      vec2 f = fract(p);
      float k = mod(c.x - c.y, 4.0);
      bool hor = k < 2.0;

      float across = hor ? f.y : f.x;
      float along  = hor ? (k + f.x) * 0.5 : ((3.0 - k) + f.y) * 0.5;   // позиция вдоль перекрытия из двух клеток

      float xa = across * 2.0 - 1.0;
      float lift = smoothstep(0.0, 0.12, along) * smoothstep(1.0, 0.88, along);  // жгут ныряет под соседний
      float nAcross = xa * 0.45;
      float nAlong = (along < 0.5 ? -1.0 : 1.0) * (1.0 - lift) * 0.5;

      vec3 N, T;
      if (hor) { N = normalize(vec3(nAlong, nAcross, 1.0)); T = vec3(1.0, 0.0, 0.0); }
      else     { N = normalize(vec3(nAcross, nAlong, 1.0)); T = vec3(0.0, 1.0, 0.0); }

      // филаменты внутри жгута
      float tow = hash21(c + (hor ? 0.0 : 31.0));
      float fil = vnoise(vec2(across * 40.0 + tow * 50.0, along * 3.0));
      fil = mix(fil, vnoise(vec2(across * 100.0 + tow * 20.0, along * 5.0)), 0.5);
      float strand = 0.8 + 0.4 * fil;

      vec3 col = shade(0.004 * strand, N, T, 0.2 * strand * (0.85 + 0.3 * tow), 0.075, 0.42, L, V);

      float gap = smoothstep(0.0, 0.04, across) * smoothstep(1.0, 0.96, across);
      col *= mix(0.4, 1.0, gap) * mix(0.55, 1.0, lift);
      return col;
    }

    /* ---------- Кованый карбон ---------- */
    // Один слой вытянутых чешуек с фиксированным углом. xyz — id ячейки и расстояние до края, w — «высота» чешуйки.
    vec4 shardLayer(vec2 px, float angle, vec2 offset) {
      float ca = cos(angle), sa = sin(angle);
      vec2 r = vec2(ca * px.x + sa * px.y, -sa * px.x + ca * px.y);
      vec2 cellSize = vec2(78.0, 20.0);
      vec2 p = r / cellSize + offset;
      vec2 ip = floor(p), fp = fract(p);
      float d1 = 1e8, d2 = 1e8;
      vec2 id = vec2(0.0);
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 g = vec2(float(x), float(y));
          vec2 dv = (g + hash22(ip + g) - fp) * cellSize;   // расстояние в пикселях — рёбра остаются прямыми
          float d = dot(dv, dv);
          if (d < d1) { d2 = d1; d1 = d; id = ip + g; }
          else if (d < d2) { d2 = d; }
        }
      }
      return vec4(id, sqrt(d2) - sqrt(d1), hash21(id + offset * 3.1));
    }

    // Возвращает цвет в rgb и порог появления чешуйки в a (для перехода от плетения).
    vec4 forged(vec2 px, vec3 L, vec3 V) {
      vec2 wp = px + (vec2(vnoise(px * 0.02), vnoise(px * 0.02 + 5.0)) - 0.5) * 10.0;  // лёгкая неровность рёбер

      // три слоя обрывков под разными углами; сверху оказывается слой с наибольшей «высотой»
      vec4 l0 = shardLayer(wp, 0.35, vec2(0.0, 0.0));
      vec4 l1 = shardLayer(wp, 2.25, vec2(13.7, 4.1));
      vec4 l2 = shardLayer(wp, 4.05, vec2(-7.3, 21.9));
      vec4 top = l0; float ang = 0.35; float layer = 0.0;
      if (l1.w > top.w) { top = l1; ang = 2.25; layer = 1.0; }
      if (l2.w > top.w) { top = l2; ang = 4.05; layer = 2.0; }

      vec2 id = top.xy + layer * 101.0;
      float r1 = hash21(id + 11.0), r2 = hash21(id + 23.0), r3 = hash21(id + 41.0);
      ang += (r1 - 0.5) * 0.7;                // волокна примерно вдоль обрывка
      vec2 dir = vec2(cos(ang), sin(ang));
      vec2 perp = vec2(-dir.y, dir.x);

      float acrossPx = dot(px, perp), alongPx = dot(px, dir);
      float fil = vnoise(vec2(acrossPx * 0.9, alongPx * 0.03) + id * 13.0);
      fil = mix(fil, vnoise(vec2(acrossPx * 2.2, alongPx * 0.06) + id * 7.0), 0.45);
      float bend = (vnoise(px * 0.015 + id * 5.0) - 0.5) * 0.45;
      vec3 T = vec3(cos(ang + bend), sin(ang + bend), 0.0);

      vec2 tilt = (hash22(id + 5.0) - 0.5) * 0.35;
      vec3 N = normalize(vec3(tilt, 1.0));

      float strand = 0.7 + 0.6 * fil;
      vec3 col = shade(0.004 * strand, N, T, (0.07 + 0.15 * r2) * strand, 0.07 + 0.08 * r3, 0.45, L, V);

      // тонкая смоляная граница по краю верхней чешуйки
      col *= mix(0.3, 1.0, smoothstep(0.0, 2.5, top.z));
      return vec4(col, 0.03 + 0.92 * hash21(id + 97.0));   // все пороги < 1, чтобы внизу страницы плетение не просвечивало
    }

    void main() {
      vec2 view = uRes / uDpr;                                   // размер экрана, CSS px
      vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
      vec2 px = vec2(frag.x, frag.y + uScroll);                  // координата на странице
      vec2 uv = gl_FragCoord.xy / uRes;

      // точечный источник над экраном и камера на конечном расстоянии
      float size = max(view.x, view.y);
      vec2 lightPos = view * (0.5 + uLight * 0.5);
      vec3 L = normalize(vec3(lightPos - frag, size * 0.55));
      vec3 V = normalize(vec3(view * 0.5 - frag, size * 1.1));

      float t = smoothstep(0.12, 0.88, px.y / max(uDocH, 1.0));
      vec3 col;
      if (t <= 0.0) {
        col = twill(px, L, V);
      } else {
        vec4 fg = forged(px, L, V);
        // чешуйки кованого карбона по одной «ложатся» поверх плетения
        float cover = smoothstep(fg.a - 0.03, fg.a + 0.03, t);
        if (cover >= 1.0) col = fg.rgb;
        else col = mix(twill(px, L, V), fg.rgb, cover);
      }

      // широкое мягкое отражение в прозрачном лаке
      float band = uv.x * 0.9 + (1.0 - uv.y) * 0.45 - 0.62 - uLight.x * 0.25;
      col += vec3(0.006, 0.0065, 0.0075) * exp(-band * band * 12.0);

      // виньетка, мягкое сжатие бликов, гамма и дизеринг против полос
      col *= 1.0 - 0.4 * dot(uv - 0.5, uv - 0.5);
      col = col / (1.0 + col * 0.8);
      col = pow(col, vec3(1.0 / 2.2));
      col += (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn("[carbon]", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, vert);
  const fs = compile(gl.FRAGMENT_SHADER, frag);
  if (!vs || !fs) return;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn("[carbon]", gl.getProgramInfoLog(prog)); return; }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = {};
  ["uRes", "uDpr", "uScroll", "uDocH", "uLight"].forEach(n => { u[n] = gl.getUniformLocation(prog, n); });

  document.body.prepend(canvas);
  document.documentElement.classList.add("webgl-carbon");

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const light = { x: -0.35, y: -0.55 };
  const target = { x: -0.35, y: -0.55 };
  let dpr = 1, frame = 0;

  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    request();
  };

  const draw = () => {
    frame = 0;
    // свет слегка «плывёт» при прокрутке, чтобы блики двигались и на телефонах без мыши
    const drift = reduced ? 0 : Math.sin(scrollY * 0.0012) * 0.25;
    light.x += (target.x + drift - light.x) * 0.12;
    light.y += (target.y - light.y) * 0.12;

    gl.uniform2f(u.uRes, canvas.width, canvas.height);
    gl.uniform1f(u.uDpr, dpr);
    gl.uniform1f(u.uScroll, scrollY);
    gl.uniform1f(u.uDocH, document.documentElement.scrollHeight);
    gl.uniform2f(u.uLight, light.x, light.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (Math.abs(target.x + drift - light.x) > 0.002 || Math.abs(target.y - light.y) > 0.002) request();
  };

  function request() { if (!frame) frame = requestAnimationFrame(draw); }

  addEventListener("resize", resize);
  addEventListener("scroll", request, { passive: true });
  if (!reduced) {
    addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      target.x = (e.clientX / innerWidth - 0.5) * 1.2;
      target.y = (e.clientY / innerHeight - 0.5) * 1.2;
      request();
    }, { passive: true });
  }
  if ("ResizeObserver" in window) new ResizeObserver(request).observe(document.body);
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); document.documentElement.classList.remove("webgl-carbon"); });

  resize();
})();
