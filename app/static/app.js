"use strict";

/* ---------- справочник документов и полей ---------- */
const DOC_TYPES = {
  passport: {
    title: "Паспорт РФ",
    fields: {
      surname: "Фамилия", firstname: "Имя", middlename: "Отчество", sex: "Пол",
      dateOfBirth: "Дата рождения", birthCity: "Место рождения",
      passport_num: "Серия и номер", issued_by: "Кем выдан",
      issued_date: "Дата выдачи", issued_code: "Код подразделения",
    },
  },
  snils: {
    title: "СНИЛС",
    fields: {
      snils: "Номер СНИЛС", fio: "ФИО", date_of_birth: "Дата рождения",
      location: "Место рождения", sex: "Пол", reg_date: "Дата регистрации",
    },
  },
  attestat: {
    title: "Аттестат",
    fields: {
      lvl: "Уровень образования", fio: "ФИО", number: "Номер",
      school_name: "Образовательная организация", grad_year: "Год окончания",
      issue_date: "Дата выдачи", gerb: "Герб",
    },
  },
  diplom: {
    title: "Диплом",
    fields: {
      lvl: "Уровень образования", fio: "ФИО", series_numbers: "Серия и номер",
      reg_num: "Регистрационный номер", spec_name: "Специальность",
      university_name: "Образовательная организация", issue_date: "Дата выдачи",
      gerb: "Герб", stamp: "Печать",
    },
  },
  "attestat/diplom": { title: "Аттестат / диплом", fields: {} },
  prilozhenie: { title: "Приложение к диплому", fields: {} },
};

const ZONE_COLORS = [
  "#2f5bea", "#e8590c", "#0ca678", "#c2255c", "#7048e8", "#1098ad",
  "#f08c00", "#5c940d", "#d6336c", "#4263eb", "#ae3ec9", "#099268",
];
const DOC_COLORS = ["#2f5bea", "#e8590c", "#0ca678", "#c2255c", "#7048e8"];
const STAGES = [
  { key: "classify", label: "Классификация", color: "#2f5bea" },
  { key: "resolve", label: "Resolver", color: "#7048e8" },
  { key: "detect", label: "Детекция полей", color: "#0ca678" },
  { key: "ocr", label: "OCR", color: "#e8590c" },
  { key: "other", label: "Прочее", color: "#adb5bd" },
];

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const docTitle = (t) => DOC_TYPES[t]?.title ?? t;
const fieldLabel = (t, f) => DOC_TYPES[t]?.fields?.[f] ?? f;

const state = {
  file: null,
  ready: false,
  data: null,      // ответ /api/recognize
  edits: {},       // "doc:zone" -> текст, исправленный оператором
  activeDoc: 0,
  outMode: "json",
  settings: null,  // параметры последнего запуска
};

/* ---------- утилиты ---------- */
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 1800);
}

async function copyText(text, msg = "Скопировано") {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    toast("Не удалось скопировать");
  }
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}

function confClass(c) {
  return c >= 0.8 ? "hi" : c >= 0.5 ? "mid" : "lo";
}

/* ---------- статус сервера ---------- */
async function pollStatus() {
  const el = $("#status");
  const text = el.querySelector(".status-text");
  try {
    const r = await fetch("/api/status");
    const s = await r.json();
    if (s.error) {
      el.className = "status error";
      text.textContent = "Ошибка загрузки моделей";
      el.title = s.error;
      return;
    }
    if (s.ready) {
      state.ready = true;
      el.className = "status ready";
      text.textContent = `Модели готовы · ${String(s.device).toUpperCase()}`;
      el.title = `docreader-ocr ${s.package_version ?? ""} · классы: ${s.classes.join(", ")}`;
      $("#footVersion").textContent = s.package_version ? `v${s.package_version}` : "";
      updateRunButton();
      return;
    }
    el.className = "status";
    text.textContent = "Загрузка моделей…";
  } catch {
    el.className = "status error";
    text.textContent = "Сервер недоступен";
  }
  setTimeout(pollStatus, 1500);
}

/* ---------- выбор файла ---------- */
function setFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    toast("Нужен файл изображения");
    return;
  }
  state.file = file;
  const img = $("#dzPreview");
  if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(file);
  img.hidden = false;
  $("#dzEmpty").hidden = true;
  updateRunButton();
}

function updateRunButton() {
  const btn = $("#runBtn");
  const hint = $("#runHint");
  btn.disabled = !(state.file && state.ready);
  hint.textContent = !state.ready
    ? "Ждём загрузки моделей…"
    : state.file ? `${state.file.name || "изображение"} · ${(state.file.size / 1024 / 1024).toFixed(2)} МБ` : "Выберите изображение";
}

function initInputs() {
  const dz = $("#dropzone");
  const input = $("#fileInput");
  input.addEventListener("change", () => input.files[0] && setFile(input.files[0]));
  dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => e.dataTransfer.files[0] && setFile(e.dataTransfer.files[0]));
  document.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
    if (item) {
      setFile(item.getAsFile());
      toast("Изображение вставлено");
    }
  });

  for (const id of ["clsConf", "detConf"]) {
    const r = $("#" + id);
    const o = $("#" + id + "Out");
    r.addEventListener("input", () => (o.textContent = Number(r.value).toFixed(2)));
  }
  $("#runBtn").addEventListener("click", run);
  $("#copyInstall").addEventListener("click", () => copyText("pip install docreader-ocr", "Команда скопирована"));
}

async function loadSamples() {
  try {
    const list = await (await fetch("/api/samples")).json();
    if (!list.length) return;
    const box = $("#sampleList");
    for (const s of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.title = s.name;
      b.innerHTML = `<img src="${esc(s.url)}" alt="${esc(s.name)}" loading="lazy">`;
      b.addEventListener("click", async () => {
        const blob = await (await fetch(s.url)).blob();
        setFile(new File([blob], s.url.split("/").pop(), { type: blob.type }));
      });
      box.appendChild(b);
    }
    $("#samples").hidden = false;
  } catch { /* примеры необязательны */ }
}

/* ---------- запуск распознавания ---------- */
async function run() {
  if (!state.file) return;
  const settings = {
    classifier_conf: Number($("#clsConf").value),
    detector_conf: Number($("#detConf").value),
    deskew: $("#deskew").checked,
  };
  const fd = new FormData();
  fd.append("file", state.file);
  fd.append("classifier_conf", settings.classifier_conf);
  fd.append("detector_conf", settings.detector_conf);
  fd.append("deskew", settings.deskew);

  $("#placeholder").hidden = true;
  $("#output").hidden = true;
  $("#error").hidden = true;
  $("#loading").hidden = false;
  $("#runBtn").disabled = true;
  const t0 = performance.now();
  const timer = setInterval(() => ($("#elapsed").textContent = ((performance.now() - t0) / 1000).toFixed(1)), 100);
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const r = await fetch("/api/recognize", { method: "POST", body: fd });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.detail || `Ошибка сервера (${r.status})`);
    state.data = body;
    state.edits = {};
    state.activeDoc = 0;
    state.settings = settings;
    render();
  } catch (err) {
    $("#error").textContent = err.message || String(err);
    $("#error").hidden = false;
  } finally {
    clearInterval(timer);
    $("#loading").hidden = true;
    updateRunButton();
  }
}

/* ---------- отрисовка ---------- */
function render() {
  const d = state.data;
  $("#output").hidden = false;
  renderTimeline(d);

  const n = d.documents.length;
  $("#foundCount").textContent = n
    ? `Найдено документов: ${n}`
    : "Документы не найдены";
  renderFigure($("#sourceFigure"), d.source.image, d.source.width, d.source.height,
    d.documents.map((doc, i) => ({
      points: doc.polygon,
      color: DOC_COLORS[i % DOC_COLORS.length],
      label: `${docTitle(doc.doc_type)} ${(doc.doc_confidence * 100).toFixed(0)}%`,
      key: i,
    })),
    (key) => selectDoc(key),
  );

  const tabs = $("#docTabs");
  tabs.innerHTML = "";
  if (n > 1) {
    d.documents.forEach((doc, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `${i + 1}. ${docTitle(doc.doc_type)}`;
      b.addEventListener("click", () => selectDoc(i));
      tabs.appendChild(b);
    });
  }
  selectDoc(0);
  renderOutput();
}

function renderTimeline(d) {
  const t = { ...d.timings };
  const known = STAGES.slice(0, 4).reduce((s, st) => s + (t[st.key] || 0), 0);
  t.other = Math.max(0, d.total_seconds - known);
  const stages = STAGES.filter((s) => t[s.key] > 0.0005);
  const total = d.total_seconds || 1;
  const ocrCalls = d.calls.ocr ? ` · ${plural(d.calls.ocr, "вызов", "вызова", "вызовов")} OCR` : "";
  $("#timeline").innerHTML = `
    <div class="tl-top">
      <b>Обработано за ${d.total_seconds.toFixed(2)} с</b>
      <span class="muted">${esc(String(d.device).toUpperCase())}${ocrCalls}</span>
    </div>
    <div class="tl-bar">${stages.map((s) => `<i style="width:${(t[s.key] / total) * 100}%;background:${s.color}" title="${s.label}: ${t[s.key].toFixed(3)} с"></i>`).join("")}</div>
    <div class="tl-legend">${stages.map((s) => `<span><i style="background:${s.color}"></i>${s.label} <em>${t[s.key].toFixed(2)} с</em></span>`).join("")}</div>`;
}

/**
 * Рисует картинку и многоугольники в одном SVG — координаты совпадают без пересчёта.
 * shapes: [{points, color, label, key}]
 */
function renderFigure(container, src, w, h, shapes, onClick) {
  const fs = Math.max(12, Math.round(Math.max(w, h) / 55));
  const svgNS = "http://www.w3.org/2000/svg";
  let html = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="${svgNS}"><image href="${src}" width="${w}" height="${h}"/>`;
  for (const s of shapes) {
    if (!s.points?.length) continue;
    const pts = s.points.map((p) => p.join(",")).join(" ");
    html += `<polygon data-key="${s.key}" points="${pts}" fill="${s.color}" stroke="${s.color}"><title>${esc(s.label)}</title></polygon>`;
  }
  // подписи поверх всех фигур
  for (const s of shapes) {
    if (!s.points?.length || !s.label) continue;
    const minY = Math.min(...s.points.map((p) => p[1]));
    const top = s.points.find((p) => p[1] === minY);
    const x = Math.max(0, Math.min(top[0], w - 10));
    const y = Math.max(fs + 4, minY - 4);
    const tw = s.label.length * fs * 0.58 + 10;
    const bx = Math.min(x, Math.max(0, w - tw));
    html += `<rect class="label-bg" x="${bx}" y="${y - fs - 2}" width="${tw}" height="${fs + 8}" rx="4" fill="${s.color}"/>`;
    html += `<text class="poly-label" x="${bx + 5}" y="${y + 1}" fill="#fff" style="font-size:${fs}px">${esc(s.label)}</text>`;
  }
  html += "</svg>";
  container.innerHTML = html;
  if (onClick) {
    container.querySelectorAll("polygon").forEach((p) =>
      p.addEventListener("click", () => onClick(Number(p.dataset.key))));
  }
}

function sortedZones(doc) {
  const order = Object.keys(DOC_TYPES[doc.doc_type]?.fields ?? {});
  return doc.zones
    .map((z, i) => ({ ...z, idx: i }))
    .sort((a, b) => {
      const ia = order.indexOf(a.name), ib = order.indexOf(b.name);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
}

function selectDoc(i) {
  state.activeDoc = i;
  document.querySelectorAll("#docTabs button").forEach((b, j) => b.classList.toggle("active", j === i));
  document.querySelectorAll("#sourceFigure polygon").forEach((p) => p.classList.toggle("hot", Number(p.dataset.key) === i));
  $("#sourceFigure").classList.toggle("dim", state.data.documents.length > 1);
  renderDoc(i);
}

function renderDoc(i) {
  const view = $("#docView");
  const doc = state.data.documents[i];
  if (!doc) {
    view.innerHTML = `<div class="panel fields-empty">На изображении не найдено поддерживаемых документов.
      Попробуйте фото крупнее, с лучшим освещением, или уменьшите порог классификатора в параметрах.</div>`;
    return;
  }
  const zones = sortedZones(doc);
  const colorOf = new Map(zones.map((z, k) => [z.idx, ZONE_COLORS[k % ZONE_COLORS.length]]));
  const meta = doc.resolve_meta || {};
  const resolveNote = meta.resolver_ocr_text !== undefined
    ? `<p class="resolve-note">Resolver: поле «уровень образования» распознано как «${esc(meta.resolver_ocr_text)}», совпадение ${Number(meta.resolver_fuzzy_score ?? 0).toFixed(0)}%</p>`
    : "";
  const needCheck = zones.filter((z) => !z.ocr_skipped && z.confidence < 0.6).length;

  view.innerHTML = `
    <div class="panel doc-card">
      <div class="doc-head">
        <h3>${esc(docTitle(doc.doc_type))}</h3>
        <span class="badge">${esc(doc.doc_type)}</span>
        <span class="badge ok">уверенность ${(doc.doc_confidence * 100).toFixed(1)}%</span>
        <span class="badge">${plural(zones.length, "поле", "поля", "полей")}</span>
        ${resolveNote}
      </div>
      <div class="doc-body">
        <div class="figure" id="docFigure"></div>
        <div class="fields">
          ${zones.length ? zones.map((z) => zoneRow(doc, i, z, colorOf.get(z.idx))).join("") : `<div class="fields-empty">Для этого типа документа поля не извлекаются.</div>`}
          ${zones.length ? `<div class="fields-foot">Текст полей можно исправить: так оператор верифицирует результат перед сохранением. Правки сразу попадают в JSON ниже.${needCheck ? ` Полей с низкой уверенностью: ${needCheck}.` : ""}</div>` : ""}
        </div>
      </div>
    </div>`;

  if (doc.crop) {
    const img = new Image();
    img.onload = () => {
      renderFigure($("#docFigure"), doc.crop, img.naturalWidth, img.naturalHeight,
        zones.map((z) => ({ points: z.polygon, color: colorOf.get(z.idx), label: z.name, key: z.idx })),
        (key) => {
          const input = view.querySelector(`.frow[data-key="${key}"] input`);
          input?.focus();
          input?.closest(".frow").scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
      bindHover(view);
    };
    img.src = doc.crop;
  }

  view.querySelectorAll(".frow input").forEach((inp) => {
    inp.addEventListener("input", () => {
      const k = `${i}:${inp.dataset.idx}`;
      const orig = doc.zones[inp.dataset.idx].text;
      if (inp.value === orig) delete state.edits[k];
      else state.edits[k] = inp.value;
      inp.classList.toggle("edited", inp.value !== orig);
      renderOutput();
    });
  });
}

function zoneRow(doc, docIdx, z, color) {
  const text = state.edits[`${docIdx}:${z.idx}`] ?? z.text;
  const edited = text !== z.text;
  const conf = z.ocr_skipped
    ? `<span class="conf hi" title="уверенность детектора">det ${(z.confidence * 100).toFixed(0)}%</span>`
    : `<span class="conf ${confClass(z.confidence)}" title="уверенность OCR">${(z.confidence * 100).toFixed(0)}%</span>`;
  const check = !z.ocr_skipped && z.confidence < 0.6 ? `<span class="check">проверить</span>` : "";
  const body = z.ocr_skipped
    ? `<div class="note">Графический элемент — текст не распознаётся (skip_ocr_zones)</div>`
    : `<input type="text" value="${esc(text)}" data-idx="${z.idx}" class="${edited ? "edited" : ""}" placeholder="(пусто)" aria-label="${esc(fieldLabel(doc.doc_type, z.name))}">`;
  return `
    <div class="frow" data-key="${z.idx}">
      <i class="sw" style="background:${color}"></i>
      <div>
        <div class="frow-top">
          <span class="frow-name">${esc(fieldLabel(doc.doc_type, z.name))}<code>${esc(z.name)}</code>${check}</span>
          ${conf}
        </div>
        ${body}
        ${z.crop ? `<img class="crop" src="${z.crop}" alt="кроп поля ${esc(z.name)}" loading="lazy">` : ""}
      </div>
    </div>`;
}

function bindHover(view) {
  const fig = view.querySelector("#docFigure");
  const set = (key, on) => {
    fig.querySelectorAll(`polygon[data-key="${key}"]`).forEach((p) => p.classList.toggle("hot", on));
    view.querySelector(`.frow[data-key="${key}"]`)?.classList.toggle("hot", on);
    fig.classList.toggle("dim", on);
  };
  view.querySelectorAll(".frow").forEach((row) => {
    row.addEventListener("mouseenter", () => set(row.dataset.key, true));
    row.addEventListener("mouseleave", () => set(row.dataset.key, false));
    row.addEventListener("focusin", () => set(row.dataset.key, true));
    row.addEventListener("focusout", () => set(row.dataset.key, false));
  });
  fig.querySelectorAll("polygon").forEach((p) => {
    p.addEventListener("mouseenter", () => set(p.dataset.key, true));
    p.addEventListener("mouseleave", () => set(p.dataset.key, false));
  });
}

/* ---------- вывод JSON / Python ---------- */
function buildJson() {
  // Та же структура, что и PageResult.to_dict(), но с учётом правок оператора
  const docs = state.data.documents.map((doc, i) => {
    const zones = doc.zones.map((z, j) => ({
      name: z.name,
      text: state.edits[`${i}:${j}`] ?? z.text,
      confidence: z.confidence,
    }));
    const document = {
      doc_type: doc.doc_type,
      doc_confidence: doc.doc_confidence,
      zones,
      fields: Object.fromEntries(zones.map((z) => [z.name, z.text])),
    };
    if (Object.keys(doc.resolve_meta || {}).length) document.resolve_meta = doc.resolve_meta;
    return { document };
  });
  return { documents: docs, total: docs.length };
}

function buildPython() {
  const s = state.settings;
  const name = state.file?.name || "photo.jpg";
  return `from docreader import DocReader, PipelineConfig

config = PipelineConfig(
    classifier_confidence=${s.classifier_conf},
    detector_confidence=${s.detector_conf},
    enable_deskew=${s.deskew ? "True" : "False"},
)

reader = DocReader(config)
result = reader.process(${JSON.stringify(name)})

for doc in result.documents:
    print(doc.doc_type, f"{doc.doc_confidence:.2f}")
    for name, text in doc.fields.items():
        print(f"  {name:>16}: {text}")`;
}

function renderOutput() {
  const edited = Object.keys(state.edits).length;
  $("#codeOut").textContent = state.outMode === "json"
    ? JSON.stringify(buildJson(), null, 2)
    : buildPython();
  $("#downloadOut").textContent = edited ? `Скачать JSON (правок: ${edited})` : "Скачать JSON";
}

function initOutput() {
  document.querySelectorAll(".seg button").forEach((b) =>
    b.addEventListener("click", () => {
      state.outMode = b.dataset.out;
      document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("active", x === b));
      renderOutput();
    }));
  $("#copyOut").addEventListener("click", () => copyText($("#codeOut").textContent));
  $("#downloadOut").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(buildJson(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.file?.name?.replace(/\.[^.]+$/, "") || "result") + ".docreader.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

/* ---------- статические блоки ---------- */
function renderMetrics() {
  const rows = [
    ["Аттестат", 78.0, 50.0],
    ["СНИЛС", 64.4, 62.1],
    ["Диплом", 48.6, 0.0],
    ["Паспорт", 28.2, 6.7],
  ];
  $("#docBars").innerHTML = rows.map(([name, fa, fda]) => `
    <div class="bar-row">
      <span>${name}</span>
      <div class="bar-pair">
        <div class="bar"><i class="a" style="width:${fa * 0.85}%"></i><em>${fa.toFixed(1)}%</em></div>
        <div class="bar"><i class="b" style="width:${fda * 0.85}%"></i><em>${fda.toFixed(1)}%</em></div>
      </div>
    </div>`).join("");
}

function renderDocsGrid() {
  $("#docsGrid").innerHTML = ["passport", "snils", "attestat", "diplom"].map((t) => `
    <div class="doc-type">
      <h4>${DOC_TYPES[t].title}</h4>
      <span class="badge">${t}</span>
      <ul>${Object.entries(DOC_TYPES[t].fields).map(([k, v]) => `<li><span>${v}</span><code>${k}</code></li>`).join("")}</ul>
    </div>`).join("");
}

/* ---------- старт ---------- */
initInputs();
initOutput();
renderMetrics();
renderDocsGrid();
loadSamples();
pollStatus();
