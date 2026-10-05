/* Аэрокомпозит — общие скрипты */
(function () {
  "use strict";

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

  /* ---------- Мобильное меню ---------- */
  const menuBtn = $(".menu-toggle");
  const nav = $(".nav");
  if (menuBtn && nav) {
    menuBtn.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", String(open));
    });
    $$("a", nav).forEach(a => a.addEventListener("click", () => {
      nav.classList.remove("open");
      menuBtn.setAttribute("aria-expanded", "false");
    }));
  }

  /* ---------- Подсветка пункта меню для блока на экране ---------- */
  const anchors = nav ? $$('a[href^="#"]', nav) : [];
  if (anchors.length) {
    const blocks = anchors.map(a => document.getElementById(a.getAttribute("href").slice(1)));
    const mark = () => {
      const line = window.scrollY + window.innerHeight * 0.35;
      let idx = 0;
      blocks.forEach((b, i) => { if (b && b.getBoundingClientRect().top + window.scrollY <= line) idx = i; });
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) idx = anchors.length - 1;
      anchors.forEach((a, i) => { if (i === idx) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    };
    addEventListener("scroll", mark, { passive: true });
    addEventListener("resize", mark);
    mark();
  }

  /* ---------- Год в футере ---------- */
  $$("[data-year]").forEach(el => { el.textContent = new Date().getFullYear(); });

  /* ---------- Появление при прокрутке ---------- */
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function countUp(el) {
    const target = parseFloat(el.dataset.count);
    const decimals = (el.dataset.count.split(".")[1] || "").length;
    if (reduced) { el.textContent = target.toFixed(decimals).replace(".", ","); return; }
    const start = performance.now();
    const dur = 1400;
    (function tick(now) {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = (target * eased).toFixed(decimals).replace(".", ",");
      if (t < 1) requestAnimationFrame(tick);
    })(start);
  }

  const onVisible = (el) => {
    el.classList.add("in");
    $$("[data-count]", el).forEach(countUp);
    if (el.matches("[data-count]")) countUp(el);
    $$(".bar-fill[data-width]", el).forEach(b => { b.style.width = b.dataset.width + "%"; });
  };

  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) { onVisible(e.target); io.unobserve(e.target); }
      });
    }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });
    $$(".reveal").forEach(el => io.observe(el));
  } else {
    $$(".reveal").forEach(onVisible);
  }

  /* ---------- Сравнение материалов ---------- */
  const chart = $("#materials-chart");
  if (chart) {
    // Типичные значения для однонаправленных композитов (вдоль волокон) и металлических сплавов.
    const materials = [
      { name: "Углепластик", sub: "T300 / эпоксид, UD", composite: true, density: 1.58, strength: 1500, modulus: 135 },
      { name: "Органопластик", sub: "арамид / эпоксид, UD", composite: true, density: 1.38, strength: 1400, modulus: 76 },
      { name: "Стеклопластик", sub: "E-стекло / эпоксид, UD", composite: true, density: 2.0, strength: 1000, modulus: 40 },
      { name: "Алюминиевый сплав", sub: "Д16Т / 2024-T3", composite: false, density: 2.78, strength: 480, modulus: 73 },
      { name: "Титановый сплав", sub: "ВТ6 / Ti-6Al-4V", composite: false, density: 4.43, strength: 950, modulus: 114 },
      { name: "Сталь", sub: "30ХГСА, термоупрочн.", composite: false, density: 7.85, strength: 1100, modulus: 200 }
    ];

    const metrics = {
      // Удельная прочность как «разрывная длина»: σ / (ρ·g), σ в МПа, ρ в г/см³ → км.
      specStrength: { unit: "км", fmt: v => v.toFixed(0), get: m => (m.strength * 1e6) / (m.density * 1000 * 9.81) / 1000 },
      strength: { unit: "МПа", fmt: v => v.toFixed(0), get: m => m.strength },
      density: { unit: "г/см³", fmt: v => v.toFixed(2).replace(".", ","), get: m => m.density },
      modulus: { unit: "ГПа", fmt: v => v.toFixed(0), get: m => m.modulus }
    };

    const render = (key) => {
      const metric = metrics[key];
      const values = materials.map(metric.get);
      const max = Math.max(...values);
      chart.innerHTML = materials.map((m, i) => `
        <div class="chart-row${m.composite ? " is-composite" : ""}">
          <div class="bar-name">${m.name}<small>${m.sub}</small></div>
          <div class="bar-track"><div class="bar-fill" style="width:0"></div></div>
          <div class="bar-val">${metric.fmt(values[i])} <small style="color:var(--ink-3);font-weight:500">${metric.unit}</small></div>
        </div>`).join("");
      requestAnimationFrame(() => requestAnimationFrame(() => {
        $$(".bar-fill", chart).forEach((b, i) => { b.style.width = (values[i] / max * 100).toFixed(1) + "%"; });
      }));
    };

    const tabs = $$("[data-metric]");
    tabs.forEach(t => t.addEventListener("click", () => {
      tabs.forEach(x => x.setAttribute("aria-selected", String(x === t)));
      const desc = $("#metric-desc");
      if (desc) desc.textContent = t.dataset.desc || "";
      render(t.dataset.metric);
    }));
    render("specStrength");
  }

  /* ---------- Подсветка подменю технологий ---------- */
  const subLinks = $$(".subnav a");
  if (subLinks.length && "IntersectionObserver" in window) {
    const map = new Map(subLinks.map(a => [a.getAttribute("href").slice(1), a]));
    const so = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          subLinks.forEach(a => a.classList.remove("active"));
          const link = map.get(e.target.id);
          if (link) {
            link.classList.add("active");
            link.scrollIntoView({ block: "nearest", inline: "center", behavior: reduced ? "auto" : "smooth" });
          }
        }
      });
    }, { rootMargin: "-40% 0px -55% 0px" });
    map.forEach((_, id) => { const s = document.getElementById(id); if (s) so.observe(s); });
  }

  /* ---------- Фильтр профессий ---------- */
  const chips = $$(".chip[data-filter]");
  if (chips.length) {
    chips.forEach(c => c.addEventListener("click", () => {
      chips.forEach(x => x.setAttribute("aria-pressed", String(x === c)));
      const f = c.dataset.filter;
      $$(".job").forEach(j => { j.hidden = !(f === "all" || j.dataset.area === f); });
    }));
  }

  /* ---------- Форма ---------- */
  const form = $("#contact-form");
  if (form) {
    const rules = {
      name: v => v.trim().length >= 2 || "Укажите имя",
      email: v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) || "Проверьте адрес почты",
      topic: v => v !== "" || "Выберите тему",
      message: v => v.trim().length >= 10 || "Напишите хотя бы пару предложений"
    };

    const validate = (input) => {
      const rule = rules[input.name];
      if (!rule) return true;
      const res = rule(input.value);
      const field = input.closest(".field");
      field.classList.toggle("invalid", res !== true);
      input.setAttribute("aria-invalid", String(res !== true));
      $(".error", field).textContent = res === true ? "" : res;
      return res === true;
    };

    $$("input, select, textarea", form).forEach(el => {
      el.addEventListener("blur", () => validate(el));
      el.addEventListener("input", () => { if (el.closest(".field")?.classList.contains("invalid")) validate(el); });
    });

    // Предзаполнение темы из ссылки вида contacts.html?topic=career
    const params = new URLSearchParams(location.search);
    if (params.get("topic") && form.topic) form.topic.value = params.get("topic");

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fields = $$("input[name], select[name], textarea[name]", form).filter(el => rules[el.name]);
      const ok = fields.map(validate).every(Boolean);
      if (!ok) { fields.find(el => el.getAttribute("aria-invalid") === "true")?.focus(); return; }
      if (form.consent && !form.consent.checked) { form.consent.reportValidity(); return; }
      // Сервера нет: здесь можно подключить отправку (Formspree, свой API и т.п.).
      form.hidden = true;
      $("#form-success").classList.add("show");
      $("#form-success").focus();
    });
  }
})();
