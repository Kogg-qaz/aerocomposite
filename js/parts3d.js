/* Аэрокомпозит — интерактивные 3D-модели композитных агрегатов (Three.js).
   Геометрия строится кодом, без внешних файлов моделей.
   Скрипт обычный (не module), а Three.js подгружается динамическим import() через importmap в HTML —
   так страница работает и при открытии файла двойным щелчком (file://). */
(async function () {
  "use strict";

  const viewers = Array.from(document.querySelectorAll(".viewer[data-model]"));
  if (!viewers.length) return;

  const probe = document.createElement("canvas");
  if (!(probe.getContext("webgl2") || probe.getContext("webgl"))) {
    viewers.forEach(v => v.classList.add("viewer--unsupported"));
    return;
  }

  let THREE, OrbitControls, RoomEnvironment;
  try {
    THREE = await import("three");
    ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js"));
    ({ RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js"));
    viewers.forEach(v => { const art = v.closest(".hero-art"); if (art) art.classList.add("has-3d"); });
  } catch (e) {
    console.warn("[parts3d] не удалось загрузить Three.js", e);
    viewers.forEach(v => v.classList.add("viewer--unsupported"));
    return;
  }

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ================= Материалы ================= */

  // Текстура плетёного карбона (саржа 2x2), рисуется на canvas
  const carbonCanvas = (() => {
    const size = 512, n = 16, cell = size / n;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    g.fillStyle = "#050506";
    g.fillRect(0, 0, size, size);
    for (let r = 0; r < n; r++) {
      for (let q = 0; q < n; q++) {
        const hor = (((q - r) % 4) + 4) % 4 < 2;
        const x = q * cell, y = r * cell;
        const grad = hor ? g.createLinearGradient(x, y, x, y + cell) : g.createLinearGradient(x, y, x + cell, y);
        grad.addColorStop(0, "#0a0a0c");
        grad.addColorStop(0.3, "#1c1d21");
        grad.addColorStop(0.5, "#3c3e44");
        grad.addColorStop(0.7, "#1c1d21");
        grad.addColorStop(1, "#0a0a0c");
        g.fillStyle = grad;
        g.fillRect(x + 0.4, y + 0.4, cell - 0.8, cell - 0.8);
        // филаменты
        g.strokeStyle = "rgba(255,255,255,0.05)";
        g.lineWidth = 0.6;
        for (let i = 1; i < 6; i++) {
          const o = (i / 6) * cell;
          g.beginPath();
          if (hor) { g.moveTo(x, y + o); g.lineTo(x + cell, y + o); }
          else { g.moveTo(x + o, y); g.lineTo(x + o, y + cell); }
          g.stroke();
        }
      }
    }
    return c;
  })();

  const materialsFor = (renderer) => {
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    const carbon = (rx = 2, ry = 2) => {
      const tex = new THREE.CanvasTexture(carbonCanvas);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(rx, ry);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = maxAniso;
      return new THREE.MeshPhysicalMaterial({
        map: tex, bumpMap: tex, bumpScale: 0.35, color: 0xffffff, roughness: 0.3, metalness: 0.2,
        clearcoat: 1, clearcoatRoughness: 0.04, side: THREE.DoubleSide
      });
    };
    return {
      carbon,
      carbonDark: new THREE.MeshPhysicalMaterial({ color: 0x1a1b1f, roughness: 0.45, metalness: 0.15, clearcoat: 0.6, clearcoatRoughness: 0.2, side: THREE.DoubleSide }),
      titanium: new THREE.MeshStandardMaterial({ color: 0xb9bcc2, roughness: 0.28, metalness: 1, side: THREE.DoubleSide }),
      aluminium: new THREE.MeshStandardMaterial({ color: 0x9ea4ad, roughness: 0.35, metalness: 0.9, side: THREE.DoubleSide }),
      nomex: new THREE.MeshStandardMaterial({ color: 0xa47a2c, roughness: 0.75, metalness: 0, side: THREE.DoubleSide }),
      glass: new THREE.MeshPhysicalMaterial({
        color: 0xefe6c8, roughness: 0.25, metalness: 0, transparent: true, opacity: 0.38, depthWrite: false,
        clearcoat: 1, clearcoatRoughness: 0.05, side: THREE.DoubleSide
      }),
      fiberglass: new THREE.MeshPhysicalMaterial({ color: 0xe8e1cc, roughness: 0.42, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.12, side: THREE.DoubleSide }),
      fiberglassInner: new THREE.MeshStandardMaterial({ color: 0xb9b27f, roughness: 0.7, metalness: 0, side: THREE.DoubleSide }),
      strip: new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.35, metalness: 0.9 }),
      window: new THREE.MeshPhysicalMaterial({ color: 0x8fa3b8, roughness: 0.08, metalness: 0.6, emissive: 0x2a3a4c, clearcoat: 1, side: THREE.DoubleSide }),
      accent: new THREE.MeshStandardMaterial({ color: 0xff7a3d, roughness: 0.4, metalness: 0.2 })
    };
  };

  /* ================= Геометрические помощники ================= */

  // Поверхность, натянутая на набор сечений с одинаковым числом точек
  function loft(sections, closed) {
    const rows = sections.length, cols = sections[0].length;
    const pos = [], uv = [], idx = [];
    sections.forEach((sec, i) => sec.forEach((p, j) => {
      pos.push(p.x, p.y, p.z);
      uv.push(j / (cols - 1), i / (rows - 1));
    }));
    const segs = closed ? cols : cols - 1;
    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < segs; j++) {
        const j2 = (j + 1) % cols;
        const a = i * cols + j, b = i * cols + j2, c = (i + 1) * cols + j, d = (i + 1) * cols + j2;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // Полутолщина симметричного профиля NACA 00xx
  const naca = (x, t) => 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const cosSpace = (a, b, n) => Array.from({ length: n }, (_, i) => a + (b - a) * (1 - Math.cos(Math.PI * i / (n - 1))) / 2);
  const lerp = (a, b, t) => a + (b - a) * t;
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

  // Деталь, которая умеет «разъезжаться» в разобранный вид
  function part(mesh, offset) {
    mesh.userData.base = mesh.position.clone();
    mesh.userData.offset = offset || V3(0, 0, 0);
    return mesh;
  }

  /* ================= Модели ================= */

  const builders = {

    /* ----- Кессон крыла: обшивки со стрингерами, лонжероны, нервюры с облегчающими отверстиями ----- */
    wingbox(M) {
      const group = new THREE.Group();
      const L = 3.2, fFront = 0.15, fRear = 0.62, N = 22;
      const at = (s) => ({ c: lerp(1.35, 0.7, s), dz: 0.55 * s, dy: 0.12 * s, t: lerp(0.15, 0.11, s) });
      const pt = (s, f, sign) => { const a = at(s); return V3(s * L, a.dy + sign * a.c * naca(f, a.t), a.dz + f * a.c); };
      const spans = Array.from({ length: 12 }, (_, i) => i / 11);

      const skin = (sign) => loft(spans.map(s => cosSpace(fFront, fRear, N).map(f => pt(s, f, sign))), false);
      const upper = new THREE.Group(), lower = new THREE.Group();
      upper.add(new THREE.Mesh(skin(1), M.carbon(2, 5)));
      lower.add(new THREE.Mesh(skin(-1), M.carbon(2, 5)));

      // стрингеры: прямоугольное сечение вдоль размаха
      [0.24, 0.33, 0.42, 0.51].forEach(f => {
        [1, -1].forEach(sign => {
          const secs = spans.map(s => {
            const p = pt(s, f, sign), a = at(s), h = 0.035 * a.c / 1.35, w = 0.012;
            return [V3(p.x, p.y, p.z - w), V3(p.x, p.y - sign * h, p.z - w), V3(p.x, p.y - sign * h, p.z + w), V3(p.x, p.y, p.z + w)];
          });
          (sign > 0 ? upper : lower).add(new THREE.Mesh(loft(secs, true), M.carbonDark));
        });
      });
      group.add(part(upper, V3(0, 0.55, 0)), part(lower, V3(0, -0.55, 0)));

      // лонжероны
      const spar = (f) => loft(spans.map(s => [pt(s, f, 1), pt(s, f, -1)]), false);
      group.add(part(new THREE.Mesh(spar(fFront), M.carbon(1, 5)), V3(0, 0, -0.4)));
      group.add(part(new THREE.Mesh(spar(fRear), M.carbon(1, 5)), V3(0, 0, 0.4)));

      // нервюры с облегчающими отверстиями
      [0, 0.18, 0.36, 0.54, 0.72, 0.9].forEach(s => {
        const a = at(s);
        const shape = new THREE.Shape();
        const fs = cosSpace(fFront, fRear, 16);
        fs.forEach((f, i) => { const y = a.c * naca(f, a.t) * 0.97, z = f * a.c; i ? shape.lineTo(z, y) : shape.moveTo(z, y); });
        fs.slice().reverse().forEach(f => shape.lineTo(f * a.c, -a.c * naca(f, a.t) * 0.97));
        [0.3, 0.47].forEach(f => {
          const r = a.c * naca(f, a.t) * 0.5;
          const hole = new THREE.Path();
          hole.absarc(f * a.c, 0, r, 0, Math.PI * 2, true);
          shape.holes.push(hole);
        });
        const g = new THREE.ExtrudeGeometry(shape, { depth: 0.014, bevelEnabled: false, curveSegments: 20 });
        // (u, v, w) профиля → (x = размах, y = высота, z = хорда)
        g.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, s * L, 0, 1, 0, a.dy, 1, 0, 0, a.dz, 0, 0, 0, 1));
        g.computeVertexNormals();
        group.add(part(new THREE.Mesh(g, M.aluminium)));
      });
      return { group, explode: true, fit: 0.68 };
    },

    /* ----- Киль с рулём направления ----- */
    fin(M) {
      const group = new THREE.Group();
      const H = 2.1, hinge = 0.72, N = 26;
      const at = (s) => ({ c: lerp(1.7, 0.75, s), dx: 1.0 * s, t: 0.1 });
      const pt = (s, f, sign) => { const a = at(s); return V3(a.dx + f * a.c, s * H, sign * a.c * naca(f, a.t)); };
      const spans = Array.from({ length: 10 }, (_, i) => i / 9);

      const skin = (sign) => loft(spans.map(s => cosSpace(0, hinge - 0.01, N).map(f => pt(s, f, sign))), false);
      group.add(part(new THREE.Mesh(skin(1), M.carbon(2, 4)), V3(0, 0, 0.45)));
      group.add(part(new THREE.Mesh(skin(-1), M.carbon(2, 4)), V3(0, 0, -0.45)));

      [0.18, hinge - 0.01].forEach(f => group.add(part(new THREE.Mesh(loft(spans.map(s => [pt(s, f, 1), pt(s, f, -1)]), false), M.carbonDark))));
      [0.12, 0.35, 0.58, 0.8].forEach(s => {
        const a = at(s);
        const shape = new THREE.Shape();
        const fs = cosSpace(0.18, hinge - 0.01, 14);
        fs.forEach((f, i) => { const u = f * a.c, v = a.c * naca(f, a.t) * 0.95; i ? shape.lineTo(u, v) : shape.moveTo(u, v); });
        fs.slice().reverse().forEach(f => shape.lineTo(f * a.c, -a.c * naca(f, a.t) * 0.95));
        const g = new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: false });
        g.applyMatrix4(new THREE.Matrix4().set(1, 0, 0, a.dx, 0, 0, 1, s * H, 0, 1, 0, 0, 0, 0, 0, 1));
        g.computeVertexNormals();
        group.add(part(new THREE.Mesh(g, M.aluminium)));
      });

      // руль направления вращается вокруг наклонной оси шарниров
      const rudderGeo = loft(spans.map(s => {
        const pts = [];
        cosSpace(hinge + 0.01, 1, 12).forEach(f => pts.push(pt(s, f, 1)));
        cosSpace(1, hinge + 0.01, 12).forEach(f => pts.push(pt(s, f, -1)));
        return pts;
      }), true);
      const hingeRoot = V3(at(0).dx + hinge * at(0).c, 0, 0);
      const hingeTip = V3(at(1).dx + hinge * at(1).c, H, 0);
      rudderGeo.translate(-hingeRoot.x, -hingeRoot.y, -hingeRoot.z);
      const pivot = new THREE.Group();
      pivot.position.copy(hingeRoot);
      pivot.add(new THREE.Mesh(rudderGeo, M.carbon(1, 4)));
      pivot.userData.axis = hingeTip.clone().sub(hingeRoot).normalize();
      pivot.userData.animate = (t) => pivot.quaternion.setFromAxisAngle(pivot.userData.axis, Math.sin(t * 0.8) * 0.28);
      group.add(part(pivot, V3(0.5, 0, 0)));
      return { group, explode: true };
    },

    /* ----- Секция фюзеляжа: панели обшивки, шпангоуты, стрингеры, балки пола ----- */
    fuselage(M) {
      const group = new THREE.Group();
      const R = 1, len = 1.8;
      const a0 = Math.PI * 0.58, a1 = Math.PI * 2.08;    // вырез сверху-спереди, чтобы было видно силовой набор
      const panelEdges = [a0, a0 + (a1 - a0) / 3, a0 + 2 * (a1 - a0) / 3, a1];

      const panel = (b0, b1) => {
        const secs = [0, 1].map(k => Array.from({ length: 40 }, (_, j) => {
          const a = lerp(b0 + 0.004, b1 - 0.004, j / 39);
          return V3(-len / 2 + k * len, R * Math.cos(a), R * Math.sin(a));
        }));
        return loft(secs, false);
      };
      for (let i = 0; i < 3; i++) {
        const mid = (panelEdges[i] + panelEdges[i + 1]) / 2;
        const m = new THREE.Mesh(panel(panelEdges[i], panelEdges[i + 1]), M.carbon(3, 2));
        group.add(part(m, V3(0, Math.cos(mid) * 0.45, Math.sin(mid) * 0.45)));
      }

      // шпангоуты: дуговые кольца, выдавленные вдоль оси
      const frameShape = () => {
        const s = new THREE.Shape();
        s.absarc(0, 0, R - 0.005, a0, a1, false);
        s.absarc(0, 0, R - 0.1, a1, a0, true);
        return s;
      };
      for (let i = 0; i < 4; i++) {
        const g = new THREE.ExtrudeGeometry(frameShape(), { depth: 0.035, bevelEnabled: false, curveSegments: 64 });
        const x = -len / 2 + 0.12 + i * (len - 0.24) / 3;
        g.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, x, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
        g.computeVertexNormals();
        group.add(part(new THREE.Mesh(g, M.carbonDark)));
      }

      // стрингеры
      for (let i = 0; i < 18; i++) {
        const a = lerp(a0 + 0.08, a1 - 0.08, i / 17);
        const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.045, 0.018), M.carbonDark);
        m.position.set(0, (R - 0.03) * Math.cos(a), (R - 0.03) * Math.sin(a));
        m.rotation.x = a;
        group.add(part(m));
      }

      // пол: поперечные балки и сотовые панели
      const floorY = -0.32, halfW = Math.sqrt(R * R - floorY * floorY) - 0.08;
      for (let i = 0; i < 4; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.09, halfW * 2), M.aluminium);
        b.position.set(-len / 2 + 0.12 + i * (len - 0.24) / 3, floorY - 0.05, 0);
        group.add(part(b));
      }
      const floor = new THREE.Mesh(new THREE.BoxGeometry(len, 0.02, halfW * 2), M.nomex);
      floor.position.set(0, floorY + 0.01, 0);
      group.add(part(floor, V3(0, 0.25, 0)));

      group.rotation.y = 0.35;
      return { group, explode: true };
    },

    /* ----- Трёхслойная панель руля/закрылка: обшивки и сотовый заполнитель ----- */
    sandwich(M) {
      const group = new THREE.Group();
      const W = 2.4, D = 1.5, core = 0.16, r = 0.055;

      const bottom = new THREE.Mesh(new THREE.BoxGeometry(W, 0.02, D), M.carbon(3, 2));
      bottom.position.y = -core / 2 - 0.01;
      group.add(part(bottom, V3(0, -0.35, 0)));

      // верхняя обшивка закрывает только часть панели — видно соты
      const topW = W * 0.58;
      const top = new THREE.Mesh(new THREE.BoxGeometry(topW, 0.02, D), M.carbon(2, 2));
      top.position.set(-W / 2 + topW / 2, core / 2 + 0.01, 0);
      group.add(part(top, V3(0, 0.45, 0)));

      // клеевая плёнка по краю обшивки
      const film = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.022, D), M.accent);
      film.position.set(-W / 2 + topW, core / 2 + 0.01, 0);
      group.add(part(film, V3(0, 0.45, 0)));

      // соты: шестигранные ячейки из арамидной бумаги
      const cellGeo = new THREE.CylinderGeometry(r * 0.97, r * 0.97, core, 6, 1, true);
      const cols = Math.floor(W / (Math.sqrt(3) * r)) - 1, rows = Math.floor(D / (1.5 * r)) - 1;
      const cells = new THREE.InstancedMesh(cellGeo, M.nomex, cols * rows);
      const m4 = new THREE.Matrix4();
      let k = 0;
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
          const x = -W / 2 + Math.sqrt(3) * r * (j + 0.5 + (i % 2 ? 0.5 : 0));
          const z = -D / 2 + 1.5 * r * (i + 0.8);
          m4.makeTranslation(x, 0, z);
          cells.setMatrixAt(k++, m4);
        }
      }
      cells.count = k;
      group.add(part(cells));
      group.rotation.y = 0.35;
      return { group, explode: true, fit: 0.72 };
    },

    /* ----- Широкохордная лопатка вентилятора ----- */
    blade(M) {
      const group = new THREE.Group();
      const S = 2.2, N = 30;
      const at = (s) => ({ c: lerp(0.55, 1.05, Math.pow(s, 0.6)), tw: lerp(0.55, 0.0, s), t: lerp(0.1, 0.035, s), lean: 0.2 * s * s });
      const pt = (s, f, sign) => {
        const a = at(s);
        const u = (f - 0.35) * a.c;
        const v = sign * a.c * naca(f, a.t) + a.c * 0.06 * Math.sin(Math.PI * f);   // изогнутый профиль
        return V3(u * Math.cos(a.tw) - v * Math.sin(a.tw) + a.lean, s * S, u * Math.sin(a.tw) + v * Math.cos(a.tw));
      };
      const spans = Array.from({ length: 24 }, (_, i) => i / 23);
      const sec = (s, f0, f1, n, grow = 1) => {
        const pts = [];
        cosSpace(f1, f0, n).forEach(f => { const p = pt(s, f, 1); pts.push(p); });
        cosSpace(f0, f1, n).forEach(f => { const p = pt(s, f, -1); pts.push(p); });
        if (grow !== 1) {
          const c = pt(s, (f0 + f1) / 2, 0);
          pts.forEach(p => p.sub(c).multiplyScalar(grow).add(c));
        }
        return pts;
      };
      group.add(new THREE.Mesh(loft(spans.map(s => sec(s, 0.0, 1, N)), true), M.carbon(2, 5)));
      // титановая оковка передней кромки
      group.add(new THREE.Mesh(loft(spans.map(s => sec(s, 0.0, 0.07, 10, 1.04)), true), M.titanium));
      // хвостовик «ласточкин хвост»
      const root = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.26, 0.16), M.titanium);
      root.position.set(0, -0.14, 0);
      root.rotation.y = 0.9;
      group.add(root);

      group.position.y = -S / 2 + 0.1;
      // кладём лопатку горизонтально, широкой стороной к зрителю, и медленно покачиваем вокруг оси размаха
      const wrap = new THREE.Group();
      wrap.add(group);
      wrap.rotation.set(0.2, 0, -Math.PI / 2 + 0.2);
      wrap.userData.animate = (t) => { group.rotation.y = -0.6 + Math.sin(t * 0.35) * 0.9; };
      group.rotation.y = -0.6;
      return { group: wrap, explode: false, fit: 0.78 };
    },

    /* ----- Носовой обтекатель РЛС: трёхслойная стеклопластиковая оболочка в разрезе, антенна внутри ----- */
    radome(M) {
      const group = new THREE.Group();
      const L = 1.55, R = 0.9, T = 0.06, N = 48;
      // образующая: по оси y от шпангоута (0) к носку (L)
      const prof = (r0, l0) => Array.from({ length: N }, (_, i) => {
        const y = l0 * Math.sin((Math.PI / 2) * (i / (N - 1)));
        return new THREE.Vector2(Math.max(r0 * Math.pow(1 - Math.pow(y / l0, 2.2), 0.55), 0.002), y);
      });
      const phi0 = 0.3, phiLen = Math.PI * 2 - 1.55;     // вырез на четверть, обращённый к зрителю
      const outer = prof(R, L), inner = prof(R - T, L - T);
      const onLathe = (v, phi) => V3(v.x * Math.sin(phi), v.y, v.x * Math.cos(phi));

      const shell = new THREE.Group();
      shell.add(new THREE.Mesh(new THREE.LatheGeometry(outer, 96, phi0, phiLen), M.fiberglass));
      shell.add(new THREE.Mesh(new THREE.LatheGeometry(inner, 96, phi0, phiLen), M.fiberglassInner));
      // торцы разреза: обшивка — соты — обшивка
      [phi0, phi0 + phiLen].forEach(phi => {
        const band = (k0, k1, mat) => shell.add(new THREE.Mesh(loft(outer.map((o, i) => {
          const a = onLathe(o, phi), b = onLathe(inner[i], phi);
          return [a.clone().lerp(b, k0), a.clone().lerp(b, k1)];
        }), false), mat));
        band(0, 0.22, M.fiberglass);
        band(0.22, 0.78, M.nomex);
        band(0.78, 1, M.fiberglassInner);
      });
      // грозозащитные полосы по образующим
      for (let k = 0; k < 7; k++) {
        const phi = phi0 + 0.18 + (phiLen - 0.36) * k / 6;
        const pts = outer.slice(2, N - 3).map(o => onLathe(new THREE.Vector2(o.x + 0.006, o.y), phi));
        shell.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 0.009, 6), M.strip));
      }
      shell.rotation.z = -Math.PI / 2;                   // ось обтекателя → +x
      group.add(part(shell, V3(1.05, 0, 0)));

      // шпангоут крепления и гермоперегородка
      const ring = new THREE.Mesh(new THREE.TorusGeometry(R - 0.02, 0.04, 16, 96), M.aluminium);
      ring.rotation.y = Math.PI / 2;
      group.add(part(ring));
      const bulkhead = new THREE.Mesh(new THREE.CylinderGeometry(R - 0.05, R - 0.05, 0.03, 64), M.aluminium);
      bulkhead.rotation.z = Math.PI / 2;
      bulkhead.position.x = -0.03;
      group.add(part(bulkhead, V3(-0.35, 0, 0)));

      // АФАР: диск с решёткой излучателей на поворотном основании
      const antenna = new THREE.Group();
      const plateR = 0.5;
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(plateR, plateR, 0.05, 64), M.aluminium);
      plate.rotation.z = Math.PI / 2;
      antenna.add(plate);
      const tiles = [];
      for (let a = -plateR; a <= plateR; a += 0.06) {
        for (let b = -plateR; b <= plateR; b += 0.06) if (a * a + b * b < (plateR - 0.04) ** 2) tiles.push([a, b]);
      }
      const tileMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.012, 0.046, 0.046), M.carbonDark, tiles.length);
      const m4 = new THREE.Matrix4();
      tiles.forEach(([a, b], i) => tileMesh.setMatrixAt(i, m4.makeTranslation(0.03, a, b)));
      antenna.add(tileMesh);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.36, 24), M.titanium);
      mast.rotation.z = Math.PI / 2;
      mast.position.x = -0.2;
      antenna.add(mast);
      antenna.position.x = 0.4;
      antenna.userData.animate = (t) => { antenna.rotation.y = Math.sin(t * 0.9) * 0.4; antenna.rotation.z = Math.sin(t * 0.55) * 0.12; };
      const antennaMount = new THREE.Group();
      antennaMount.add(antenna);
      group.add(part(antennaMount, V3(0.15, 0, 0)));

      group.rotation.y = -0.5;
      return { group, explode: true, fit: 0.62, frameExploded: true };
    },

    /* ----- Самолёт целиком: из чего сделаны агрегаты (для главной страницы) ----- */
    airliner(M) {
      const group = new THREE.Group();
      const add = (obj, key, offset) => { obj.userData.pick = key; group.add(part(obj, offset)); return obj; };
      const R = 0.28, LF = 5.6, NOSE = 2.8;

      // --- фюзеляж: сечения вдоль оси, носок и хвостовой конус с подъёмом ---
      const fus = (s) => {
        if (s < 0.12) { const u = 1 - s / 0.12; return { r: R * Math.sqrt(Math.max(1 - Math.pow(u, 2.2), 0.0004)), cy: -0.2 * R * u * u }; }
        if (s > 0.7) { const u = (s - 0.7) / 0.3; return { r: R * (1 - 0.86 * Math.pow(u, 1.25)), cy: 0.6 * R * Math.pow(u, 1.5) }; }
        return { r: R, cy: 0 };
      };
      const fusSection = (s) => {
        const { r, cy } = fus(s), x = NOSE - s * LF;
        return Array.from({ length: 40 }, (_, j) => {
          const a = -Math.PI / 2 + (j / 40) * Math.PI * 2;
          return V3(x, cy + r * Math.sin(a), r * Math.cos(a));
        });
      };
      const fusPart = (s0, s1, rows, mat) => new THREE.Mesh(loft(Array.from({ length: rows }, (_, i) => fusSection(lerp(s0, s1, i / (rows - 1)))), true), mat);

      add(fusPart(0, 0.055, 14, M.fiberglass), "radome", V3(0.4, 0, 0));
      const fuselage = new THREE.Group();
      fuselage.add(fusPart(0.055, 0.93, 60, M.carbon(2, 7)));
      // иллюминаторы и окна кабины
      const wins = [];
      for (let x = 1.95; x > -1.2; x -= 0.085) wins.push(x);
      const winMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.034, 0.05, 0.012), M.window, wins.length * 2);
      const m4 = new THREE.Matrix4();
      wins.forEach((x, i) => [1, -1].forEach((sd, k) => winMesh.setMatrixAt(i * 2 + k, m4.makeTranslation(x, 0.08, sd * (Math.sqrt(R * R - 0.08 * 0.08) + 0.002)))));
      fuselage.add(winMesh);
      [1, -1].forEach(sd => {
        const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.055, 0.01), M.window);
        const s = 0.085, { r, cy } = fus(s);
        cockpit.position.set(NOSE - s * LF, cy + r * 0.55, sd * r * 0.8);
        cockpit.rotation.set(sd * 0.6, sd * -0.55, 0);
        fuselage.add(cockpit);
      });
      add(fuselage, "fuselage");
      const tailcone = add(fusPart(0.93, 1, 10, M.titanium), "tailcone", V3(-0.35, 0.05, 0));
      const apu = new THREE.Mesh(new THREE.CircleGeometry(fus(1).r, 32), M.window);
      apu.rotation.y = -Math.PI / 2;
      apu.position.set(NOSE - LF - 0.001, fus(1).cy, 0);
      tailcone.add(apu);

      // --- несущие поверхности: крыло, стабилизатор, киль ---
      // o: {root:[x,y,z], span, chord:[корень, конец], sweep, dihedral, t:[..], vertical, side}
      const surfPt = (o, eta, f, sign) => {
        const c = lerp(o.chord[0], o.chord[1], eta), tt = lerp(o.t[0], o.t[1], eta);
        const x = o.root[0] - eta * o.span * Math.tan(o.sweep) - f * c;
        const th = sign * c * naca(f, tt);
        return o.vertical
          ? V3(x, o.root[1] + eta * o.span, th)
          : V3(x, o.root[1] + eta * o.span * Math.tan(o.dihedral) + th, o.side * (o.root[2] + eta * o.span));
      };
      const surf = (o, f0, f1, mat, e0 = 0, e1 = 1) => {
        const n = 12, rows = 14;
        const secs = Array.from({ length: rows }, (_, i) => {
          const eta = lerp(e0, e1, i / (rows - 1)), pts = [];
          cosSpace(f1, f0, n).forEach(f => pts.push(surfPt(o, eta, f, 1)));
          cosSpace(f0, f1, n).forEach(f => pts.push(surfPt(o, eta, f, -1)));
          return o.side < 0 ? pts.reverse() : pts;
        });
        return new THREE.Mesh(loft(secs, true), mat);
      };

      [1, -1].forEach(side => {
        const wing = { root: [0.62, -0.15, 0.1], span: 2.75, chord: [1.5, 0.34], sweep: 0.56, dihedral: 0.1, t: [0.15, 0.1], side };
        add(surf(wing, 0, 0.13, M.aluminium), "slats", V3(0.22, 0, side * 0.42));
        add(surf(wing, 0.13, 0.7, M.carbon(3, 3)), "wingbox", V3(0, 0, side * 0.36));
        add(surf(wing, 0.7, 1, M.carbonDark, 0.04, 1), "flaps", V3(-0.24, 0, side * 0.38));

        // законцовка крыла, отогнутая вверх
        const tip = surfPt(wing, 1, 0, 0), wl = new THREE.Group();
        const wlo = { root: [tip.x - 0.02, tip.y, 0], span: 0.34, chord: [0.34, 0.12], sweep: 0.9, t: [0.1, 0.08], vertical: true };
        const wlm = surf(wlo, 0, 1, M.carbon(1, 1));
        wlm.geometry.translate(0, -tip.y, 0);
        wl.add(wlm);
        wl.position.set(0, tip.y, side * (tip.z + 0.004));
        wl.rotation.x = -side * 0.28;
        add(wl, "wingbox", V3(0, 0.12, side * 0.5));

        // двигатель: мотогондола, вентилятор, реактивное сопло
        const eta = 0.34, le = surfPt(wing, eta, 0, 0);
        const engine = new THREE.Group();
        const nac = [[0.168, 0.3], [0.163, 0.08], [0.172, 0.0], [0.2, 0.025], [0.214, 0.14], [0.212, 0.45], [0.19, 0.74], [0.15, 0.94], [0.132, 0.92], [0.13, 0.7]]
          .map(([r, y]) => new THREE.Vector2(r, y));
        engine.add(new THREE.Mesh(new THREE.LatheGeometry(nac, 64), M.carbon(3, 1)));
        const coreCowl = new THREE.Mesh(new THREE.LatheGeometry([[0.001, 0.12], [0.06, 0.18], [0.12, 0.6], [0.11, 0.95], [0.075, 1.08], [0.001, 1.22]].map(([r, y]) => new THREE.Vector2(r, y)), 48), M.titanium);
        engine.add(coreCowl);
        const fan = new THREE.Group();
        for (let k = 0; k < 18; k++) {
          const pivot = new THREE.Group(), blade = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.012, 0.05), M.carbonDark);
          blade.position.x = 0.1;
          blade.rotation.x = 0.7;
          pivot.rotation.y = (k / 18) * Math.PI * 2;
          pivot.add(blade);
          fan.add(pivot);
        }
        fan.position.y = 0.2;
        fan.userData.animate = (t) => { fan.rotation.y = t * 1.6 * side; };
        engine.add(fan);
        engine.rotation.z = Math.PI / 2;               // ось двигателя → вдоль фюзеляжа, воздухозаборник вперёд
        engine.position.set(le.x + 0.62, le.y - 0.33, le.z);
        add(engine, "nacelles", V3(0.2, -0.38, side * 0.36));

        const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.16, 0.045), M.titanium);
        pylon.position.set(le.x + 0.02, le.y - 0.16, le.z);
        pylon.rotation.z = 0.08;
        add(pylon, "pylons", V3(0.08, -0.2, side * 0.36));

        const stab = { root: [-2.02, 0.05, 0.04], span: 1.1, chord: [0.78, 0.3], sweep: 0.58, dihedral: 0.1, t: [0.11, 0.09], side };
        add(surf(stab, 0, 0.7, M.carbon(2, 2)), "tail", V3(-0.3, 0, side * 0.25));
        add(surf(stab, 0.7, 1, M.carbonDark, 0.05, 1), "controls", V3(-0.5, 0, side * 0.28));
      });

      const fin = { root: [-1.72, 0.17, 0], span: 1.08, chord: [1.02, 0.42], sweep: 0.66, t: [0.11, 0.09], vertical: true, side: 1 };
      add(surf(fin, 0, 0.68, M.carbon(2, 2)), "tail", V3(-0.3, 0.3, 0));
      add(surf(fin, 0.68, 1, M.carbonDark, 0.04, 0.96), "controls", V3(-0.5, 0.33, 0));

      // обтекатель центроплана
      const fairing = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), M.fiberglass);
      fairing.scale.set(1.35, 0.17, 0.29);
      fairing.position.set(0.02, -0.22, 0);
      add(fairing, "fairing", V3(0, -0.35, 0));

      group.rotation.y = 0.25;
      const info = {
        radome:   ["Обтекатель РЛС", "Стеклопластик", "Пропускает радиоволны локатора, углепластик их бы экранировал."],
        fuselage: ["Фюзеляж", "Углепластик", "Панели обшивки со стрингерами и шпангоуты. У A350 и Boeing 787 — более 50% массы планера."],
        wingbox:  ["Кессон крыла", "Углепластик", "Обшивки и лонжероны — главный силовой элемент, несёт подъёмную силу и топливо."],
        slats:    ["Предкрылки", "Алюминиевый сплав", "Передняя кромка принимает удары птиц, града и эрозию — здесь пока металл."],
        flaps:    ["Закрылки и элероны", "Углепластик + соты", "Трёхслойные панели: тонкие обшивки на сотовом заполнителе."],
        tail:     ["Киль и стабилизатор", "Углепластик", "Одни из первых силовых композитных агрегатов в гражданской авиации."],
        controls: ["Рули высоты и направления", "Углепластик + соты", "Лёгкие трёхслойные конструкции — меньше инерция, проще привод."],
        nacelles: ["Мотогондолы", "Углепластик", "Обтекатели и реверс; лопатки вентилятора — углепластик с титановой кромкой."],
        pylons:   ["Пилоны двигателей", "Титан", "Держат двигатель и работают рядом с горячими газами."],
        tailcone: ["Хвостовой конус", "Титан", "Внутри — вспомогательная силовая установка и её горячий выхлоп."],
        fairing:  ["Обтекатель центроплана", "Стеклопластик + соты", "Сложная форма при небольших нагрузках — идеально для формования."]
      };
      return { group, explode: true, fit: 0.58, frameExploded: true, info, autoRotateSpeed: 0.6, view: [0.55, 0.7, 1] };
    }
  };

  /* ================= Просмотрщик ================= */

  const active = new Set();

  function createViewer(el) {
    const canvas = el.querySelector("canvas");
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 5, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffe2d0, 0.5);
    rim.position.set(-4, 2, -3);
    scene.add(rim);

    const M = materialsFor(renderer);
    const { group, explode, fit = 0.8, frameExploded, info, autoRotateSpeed = 1.1, view = [0.62, 0.42, 0.66] } = builders[el.dataset.model](M);

    const parts = [];
    group.traverse(o => { if (o.userData && o.userData.offset) parts.push(o); });
    const setExplode = (e) => parts.forEach(p => p.position.copy(p.userData.base).addScaledVector(p.userData.offset, e));

    // центрируем модель и подбираем дистанцию камеры (при необходимости — с учётом разобранного вида)
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    if (frameExploded) {
      setExplode(1);
      group.updateMatrixWorld(true);
      box.union(new THREE.Box3().setFromObject(group));
      setExplode(0);
    }
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    const holder = new THREE.Group();
    group.position.sub(center);
    holder.add(group);
    scene.add(holder);

    const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 100);
    camera.layers.enable(1);
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(32 / 2)) * fit;
    camera.position.set(...new THREE.Vector3(...view).normalize().multiplyScalar(dist * 1.02).toArray());

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.autoRotate = !reduced;
    controls.autoRotateSpeed = autoRotateSpeed;
    controls.minPolarAngle = 0.2;
    controls.maxPolarAngle = Math.PI - 0.2;
    canvas.style.touchAction = "pan-y";   // вертикальный свайп прокручивает страницу, горизонтальный — вращает модель

    let idleTimer = 0;
    controls.addEventListener("start", () => {
      controls.autoRotate = false;
      clearTimeout(idleTimer);
      el.classList.add("viewer--touched");
    });
    controls.addEventListener("end", () => {
      clearTimeout(idleTimer);
      if (!reduced) idleTimer = setTimeout(() => { controls.autoRotate = true; }, 4000);
    });

    if (info) setupPicking(el, canvas, camera, group, info, controls);

    // разборка
    const animated = [];
    group.traverse(o => { if (o.userData && o.userData.animate) animated.push(o); });
    const state = { explode: 0, target: 0 };
    const btn = el.querySelector("[data-explode]");
    if (btn) {
      if (!explode) btn.hidden = true;
      btn.addEventListener("click", () => {
        state.target = state.target ? 0 : 1;
        btn.textContent = state.target ? "Собрать" : "Разобрать";
        btn.setAttribute("aria-pressed", String(!!state.target));
      });
    }

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(el);
    resize();

    const clock = new THREE.Clock();
    const tick = () => {
      const t = clock.getElapsedTime();
      state.explode += (state.target - state.explode) * 0.08;
      const e = state.explode * state.explode * (3 - 2 * state.explode);
      setExplode(e);
      if (!reduced) animated.forEach(o => o.userData.animate(t));
      controls.update();
      renderer.render(scene, camera);
    };

    el.classList.add("viewer--ready");
    return { tick };
  }

  // Подсветка агрегатов и подпись «что это и из чего» (модель самолёта на главной)
  function setupPicking(el, canvas, camera, group, info, controls) {
    const panel = el.querySelector("[data-part-info]");
    const chips = Array.from((el.closest("figure") || el).querySelectorAll("[data-part]"));
    const glow = new THREE.MeshBasicMaterial({
      color: 0xff7a3d, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide
    });
    const byKey = {};
    group.traverse(o => {
      if (!o.userData.pick) return;
      const key = o.userData.pick;
      (byKey[key] = byKey[key] || []);
      o.traverse(m => {
        if (!m.isMesh || m.isInstancedMesh || m.userData.glow) return;
        m.userData.key = key;
        const g = new THREE.Mesh(m.geometry, glow);
        g.userData.glow = true;
        g.layers.set(1);                               // не участвует в выборе лучом
        g.visible = false;
        m.add(g);
        byKey[key].push(g);
      });
    });

    let current = null, locked = null;
    const show = (key) => {
      if (key === current) return;
      if (current) byKey[current].forEach(g => { g.visible = false; });
      current = key;
      if (key) byKey[key].forEach(g => { g.visible = true; });
      chips.forEach(c => c.classList.toggle("is-active", c.dataset.part === key));
      canvas.style.cursor = key ? "pointer" : "";
      if (!panel) return;
      if (key) {
        const [title, mat, note] = info[key];
        panel.innerHTML = `<b>${title}</b><span class="part-mat">${mat}</span><span class="part-note">${note}</span>`;
        panel.classList.add("is-on");
      } else {
        panel.classList.remove("is-on");
      }
    };

    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    const hit = (ev) => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const h = ray.intersectObject(group, true).find(i => i.object.userData.key);
      return h ? h.object.userData.key : null;
    };

    let dragging = false, down = null;
    controls.addEventListener("start", () => { dragging = true; });
    controls.addEventListener("end", () => { dragging = false; });
    canvas.addEventListener("pointermove", (ev) => {
      if (ev.pointerType !== "mouse" || dragging || locked) return;
      show(hit(ev));
    });
    canvas.addEventListener("pointerleave", () => { if (!locked) show(null); });
    canvas.addEventListener("pointerdown", (ev) => { down = [ev.clientX, ev.clientY]; });
    canvas.addEventListener("pointerup", (ev) => {
      if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 6) return;
      const key = hit(ev);
      locked = key && key !== locked ? key : null;   // щелчок фиксирует подпись, повторный — снимает
      show(locked || (ev.pointerType === "mouse" ? key : null));
    });
    chips.forEach(c => {
      const key = c.dataset.part;
      c.addEventListener("mouseenter", () => { if (!locked) show(key); });
      c.addEventListener("mouseleave", () => { if (!locked) show(null); });
      c.addEventListener("focus", () => show(key));
      c.addEventListener("blur", () => { if (!locked) show(null); });
      c.addEventListener("click", () => {
        locked = locked === key ? null : key;
        show(locked);
        c.setAttribute("aria-pressed", String(locked === key));
        chips.forEach(o => { if (o !== c) o.setAttribute("aria-pressed", "false"); });
      });
    });
  }

  // Модели создаются, когда карточка приближается к экрану, и рисуются, только пока видны
  const instances = new Map();
  const io = new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      if (isIntersecting && !instances.has(target)) {
        try { instances.set(target, createViewer(target)); }
        catch (e) { console.warn("[parts3d]", e); target.classList.add("viewer--unsupported"); return; }
      }
      const inst = instances.get(target);
      if (!inst) return;
      if (isIntersecting) active.add(inst); else active.delete(inst);
    });
  }, { rootMargin: "150px 0px" });
  viewers.forEach(v => io.observe(v));

  (function loop() {
    active.forEach(v => v.tick());
    requestAnimationFrame(loop);
  })();
})();
