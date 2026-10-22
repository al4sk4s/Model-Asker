// Content script: roda dentro da página. Tem dois modos de captura —
// "print" (retângulo vira imagem) e "área" (escolhe um bloco do HTML e envia
// só o texto dele) — e o painel onde a resposta do Claude aparece.
// Pode ser injetado várias vezes na mesma aba; só registra tudo na primeira.
(() => {
  if (window.__modelAskerLoaded) return;
  window.__modelAskerLoaded = true;

  const Z_TOP = "2147483647";
  const MIN_SIZE = 8;
  // defaults.js (gerado pelo build) é injetado antes deste arquivo.
  const DEFAULT_HEADER_COLOR = globalThis.MODEL_ASKER_DEFAULTS.headerColor;
  const DEFAULT_HIGHLIGHT_COLOR = globalThis.MODEL_ASKER_DEFAULTS.highlightColor;
  // Classe no <html> que ativa o cursor de seleção (CSS em picker.css).
  const PICKING_CLASS = "model-asker-picking";
  // Eventos de mouse bloqueados durante a seleção, para o site não reagir ao clique.
  const BLOCKED_EVENTS = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "auxclick", "contextmenu"];

  // ---- Filtro de interface do modo área (conservador: na dúvida, mantém) ----
  const SKIP_ATTR = "data-model-asker-skip";
  const READING_ATTR = "data-model-asker-reading";
  // Botões só saem se o texto for um comando típico de navegação/plataforma.
  const UI_COMMAND =
    /^(pr[óo]xim[ao]( quest[ãa]o| p[áa]gina)?|anterior|voltar|avan[çc]ar|continuar|enviar( respostas?| prova)?|salvar|limpar( sele[çc][ãa]o| resposta)?|(des)?marcar( para revis[ãa]o)?|pular|finalizar( prova| tentativa)?|concluir|confirmar|cancelar|fechar|sair|menu|ajuda|next|previous|prev|back|submit|save|clear( selection)?|skip|finish|flag|review|close|siguiente|atr[áa]s|volver|guardar|borrar|omitir|terminar|finalizar intento|cerrar|[‹›«»<>←→]+)[\s.!:‹›«»<>←→]*$/i;
  const UI_BUTTONS = "button, [role=button], input[type=button], input[type=submit], input[type=reset]";
  // Blocos de interface pela função declarada (role) ou pelo nome (classe/id).
  const UI_BLOCKS =
    "nav, [role=navigation], [role=toolbar], [role=progressbar], [role=timer], [role=tablist], [role=menubar]";
  const UI_NAME = /(^|[-_\s])(timer|countdown|cronometro|progress|progresso|breadcrumbs?|pagination|paginacao|toolbar)([-_\s]|$)/i;
  // Nunca remover: opções de resposta ou o que as contenha.
  const ANSWER_LIKE =
    "input[type=radio], input[type=checkbox], label, [role=radio], [role=option], [role=checkbox], [role=menuitemradio], select";
  const ALTERNATIVE_TEXT = /^\(?[a-e1-9][).:\-–]\s/i;

  // Idioma da interface (i18n.js é injetado antes deste arquivo).
  const I18N = globalThis.MODEL_ASKER_I18N;
  let lang = I18N.resolveLanguage(globalThis.MODEL_ASKER_DEFAULTS.language);
  const t = (key, vars) => I18N.translate(lang, key, vars);
  const fmt = (n) => n.toLocaleString(I18N.LOCALES[lang]);
  chrome.storage.local.get({ language: "auto" }).then(({ language }) => setLanguage(language));

  let overlayHost = null;
  let picker = null;
  let panel = null;
  let pendingNotice = "";

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "start-selection":
        if (msg.mode === "element") startElementPicker();
        else startRegionSelection();
        break;
      case "answer-start":
        showPanel();
        setAnswer("");
        panel.answer.classList.remove("error");
        panel.finished = false;
        panel.tokens = null;
        panel.before = null;
        panel.meta = { ...panel.meta, ...msg.meta, plan: msg.meta?.plan ?? panel.meta?.plan ?? null };
        renderUsage();
        setStatus(t("statusAnalyzing"), true);
        break;
      case "usage-update":
        // A leitura do início não pode sobrescrever a feita após a resposta.
        if (panel && (msg.final || !panel.finished)) {
          panel.windows = msg.windows;
          if (msg.before) panel.before = msg.before;
          if (msg.plan) panel.meta = { ...panel.meta, plan: msg.plan };
          renderUsage();
        }
        break;
      case "answer-reset":
        setAnswer("");
        setStatus(t("statusRerouted"), true);
        break;
      case "answer-delta":
        if (!panel.text) setStatus(t("statusAnswering"), true);
        setAnswer(panel.text + msg.text);
        panel.answer.scrollTop = panel.answer.scrollHeight;
        break;
      case "answer-done":
        setStatus([msg.note || t("statusDone"), pendingNotice].filter(Boolean).join(" · "), false);
        panel.finished = true;
        if (msg.usage) {
          const { input, cached = 0, output, thinking = 0 } = msg.usage;
          panel.tokens = { input, cached, output, thinking };
          if (msg.usage.windows) panel.windows = msg.usage.windows;
          if (msg.usage.models?.length) panel.meta = { ...panel.meta, models: msg.usage.models };
        }
        renderUsage();
        break;
      case "answer-error":
        showError(msg.message);
        break;
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.headerColor && panel) applyHeaderColor(changes.headerColor.newValue);
    if (changes.highlightColor && picker) applyHighlightColor(changes.highlightColor.newValue);
    if (changes.language) setLanguage(changes.language.newValue);
  });

  // Troca o idioma na hora, inclusive com o painel aberto.
  function setLanguage(setting) {
    lang = I18N.resolveLanguage(setting);
    if (!panel) return;
    panel.copyButton.textContent = t("copy");
    panel.copyButton.title = t("copyTitle");
    panel.closeButton.title = t("close");
    panel.color.title = t("headerColorTitle");
    renderUsage();
  }

  function escapeHtml(text) {
    return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  function areaHint() {
    const kbd = (key) => `<kbd>${key}</kbd>`;
    // As marcas {up}, {down}... passam intactas pela tradução e viram teclas aqui.
    const marks = { up: "{up}", down: "{down}", enter: "{enter}", esc: "{esc}" };
    return escapeHtml(t("hintArea", marks))
      .replace("{up}", kbd("↑"))
      .replace("{down}", kbd("↓"))
      .replace("{enter}", kbd("Enter"))
      .replace("{esc}", kbd("Esc"));
  }

  // ---------- Modo print ----------

  function startRegionSelection() {
    if (overlayHost) return;
    pendingNotice = "";
    if (panel) panel.host.style.display = "none"; // não aparecer no print

    overlayHost = document.createElement("div");
    Object.assign(overlayHost.style, { position: "fixed", inset: "0", zIndex: Z_TOP });
    const root = overlayHost.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .layer { position: fixed; inset: 0; cursor: crosshair; background: rgba(0,0,0,.25); user-select: none; }
        .layer.dragging { background: transparent; }
        .box { position: fixed; display: none; border: 2px dashed #8b5cf6;
               box-shadow: 0 0 0 9999px rgba(0,0,0,.35); pointer-events: none; }
        .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
                background: #222; color: #fff; font: 13px system-ui, sans-serif;
                padding: 8px 14px; border-radius: 6px; pointer-events: none; }
      </style>
      <div class="layer"></div>
      <div class="box"></div>
      <div class="hint">${escapeHtml(t("hintPrint"))}</div>`;
    document.documentElement.appendChild(overlayHost);

    const layer = root.querySelector(".layer");
    const box = root.querySelector(".box");
    const hint = root.querySelector(".hint");
    let start = null;
    let rect = null;

    layer.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      layer.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY };
      layer.classList.add("dragging");
      hint.style.display = "none";
    });

    layer.addEventListener("pointermove", (e) => {
      if (!start) return;
      rect = {
        x: Math.min(start.x, e.clientX),
        y: Math.min(start.y, e.clientY),
        width: Math.abs(e.clientX - start.x),
        height: Math.abs(e.clientY - start.y),
      };
      Object.assign(box.style, {
        display: "block",
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    });

    layer.addEventListener("pointerup", async () => {
      const selected = rect;
      stopRegionSelection();
      if (!selected || selected.width < MIN_SIZE || selected.height < MIN_SIZE) return;

      // Espera o navegador redesenhar sem o overlay antes de tirar o print.
      await nextFrame();
      await nextFrame();
      chrome.runtime.sendMessage({
        type: "region-selected",
        rect: selected,
        viewportWidth: window.innerWidth,
      });
    });

    window.addEventListener("keydown", onRegionKey, true);
  }

  function onRegionKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      stopRegionSelection();
    }
  }

  function stopRegionSelection() {
    window.removeEventListener("keydown", onRegionKey, true);
    removeOverlay();
  }

  // ---------- Modo área (HTML) ----------

  function startElementPicker() {
    if (overlayHost) return;
    pendingNotice = "";
    if (panel) panel.host.style.display = "none"; // não atrapalhar a escolha

    overlayHost = document.createElement("div");
    Object.assign(overlayHost.style, { position: "fixed", inset: "0", zIndex: Z_TOP, pointerEvents: "none" });
    const root = overlayHost.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .box { --c: 196, 181, 253; position: fixed; display: none; box-sizing: border-box;
               background: rgba(var(--c), .16); border: 1.5px solid rgba(var(--c), .75); border-radius: 6px;
               box-shadow: 0 0 0 4px rgba(var(--c), .12);
               transition: left .08s ease, top .08s ease, width .08s ease, height .08s ease; }
        .tag { position: absolute; left: -1.5px; bottom: calc(100% + 6px); white-space: nowrap;
               background: rgba(255,255,255,.94); color: #3a3a3a; border: 1px solid rgba(var(--c), .6);
               font: 500 11px/1 "Segoe UI", system-ui, sans-serif; padding: 5px 9px; border-radius: 999px;
               box-shadow: 0 1px 6px rgba(0,0,0,.1); }
        .box.inside .tag { bottom: auto; top: 6px; left: 6px; }
        .hint { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); white-space: nowrap;
                background: rgba(255,255,255,.94); color: #3a3a3a; backdrop-filter: blur(6px);
                font: 13px "Segoe UI", system-ui, sans-serif; padding: 8px 16px; border-radius: 999px;
                box-shadow: 0 2px 14px rgba(0,0,0,.12); }
        kbd { font: inherit; font-size: 11px; background: #eef0f3; border-radius: 4px; padding: 1px 5px; }
        @media (prefers-color-scheme: dark) {
          .tag, .hint { background: rgba(27,26,35,.94); color: #ecebf2; }
          kbd { background: #3a3c41; }
        }
      </style>
      <div class="box"><span class="tag"></span></div>
      <div class="hint">${areaHint()}</div>`;
    document.documentElement.appendChild(overlayHost);

    picker = {
      box: root.querySelector(".box"),
      tag: root.querySelector(".tag"),
      base: null, // elemento sob o mouse
      level: 0, // quantos níveis acima do elemento sob o mouse
      measured: null, // último elemento cujo tamanho em tokens foi calculado
      frame: 0,
      done: false,
    };
    chrome.storage.local
      .get({ highlightColor: DEFAULT_HIGHLIGHT_COLOR })
      .then(({ highlightColor }) => applyHighlightColor(highlightColor));

    document.documentElement.classList.add(PICKING_CLASS);
    for (const type of BLOCKED_EVENTS) window.addEventListener(type, onPickerPointer, true);
    window.addEventListener("mousemove", onPickerMove, true);
    window.addEventListener("keydown", onPickerKey, true);
    window.addEventListener("scroll", schedulePickerDraw, true);
    window.addEventListener("resize", schedulePickerDraw);
  }

  function onPickerMove(e) {
    if (picker.done) return;
    let el = document.elementFromPoint(e.clientX, e.clientY);
    // Partes de uma linha (span, b, a...) sobem até o bloco que as contém.
    while (el && el.parentElement && getComputedStyle(el).display.startsWith("inline")) el = el.parentElement;
    if (!el || el === picker.base) return;
    picker.base = el;
    picker.level = 0;
    schedulePickerDraw();
  }

  function onPickerKey(e) {
    if (!["Escape", "ArrowUp", "ArrowDown", "Enter"].includes(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === "Escape") return stopElementPicker();
    if (!picker.base) return;
    if (e.key === "ArrowUp") {
      const parent = pickedElement().parentElement;
      if (parent && parent !== document.documentElement) picker.level++;
    } else if (e.key === "ArrowDown") {
      picker.level = Math.max(0, picker.level - 1);
    } else if (e.key === "Enter") {
      confirmPick();
      return stopElementPicker();
    }
    schedulePickerDraw();
  }

  function onPickerPointer(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === "pointerdown" && e.button === 0 && !picker.done && picker.base) {
      confirmPick();
      // Continua bloqueando até o "click" que vem depois, para o site não recebê-lo.
      setTimeout(stopElementPicker, 600);
    } else if (e.type === "click" && picker.done) {
      stopElementPicker();
    } else if (e.type === "contextmenu" && !picker.done) {
      stopElementPicker();
    }
  }

  function pickedElement() {
    let el = picker.base;
    for (let i = 0; i < picker.level && el.parentElement; i++) el = el.parentElement;
    return el;
  }

  function schedulePickerDraw() {
    if (!picker || picker.frame) return;
    picker.frame = requestAnimationFrame(() => {
      picker.frame = 0;
      drawPicker();
    });
  }

  function drawPicker() {
    if (!picker?.base || picker.done) return;
    const el = pickedElement();
    const r = el.getBoundingClientRect();
    Object.assign(picker.box.style, {
      display: "block",
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    // Perto do topo a etiqueta ficaria atrás da barra de dicas: vai para dentro da área.
    picker.box.classList.toggle("inside", r.top < 72);

    if (picker.measured !== el) {
      picker.measured = el;
      const tokens = estimateTokens(extractAreaText(el).text);
      picker.tag.textContent = `${describe(el)} · ${t("tagTokens", { n: fmt(tokens) })}`;
    }
  }

  function confirmPick() {
    const el = pickedElement();
    picker.done = true;
    removeOverlay();
    document.documentElement.classList.remove(PICKING_CLASS);

    const { text, skipped, rawChars, guard } = extractAreaText(el);
    if (!text) {
      showError(t("errNoText"));
      return;
    }
    const images = [...el.querySelectorAll("img, svg, canvas, video")].filter((node) => {
      const r = node.getBoundingClientRect();
      return r.width >= 48 && r.height >= 48;
    }).length;
    pendingNotice = [
      skipped && t("noticeSkipped", { n: skipped }),
      images && t("noticeImages", { n: images }),
    ]
      .filter(Boolean)
      .join(" · ");
    chrome.runtime.sendMessage({
      type: "element-selected",
      text,
      // Detalhes da extração (usados só no log da versão dev).
      stats: {
        element: describe(el),
        chars: text.length,
        rawChars,
        skipped,
        filterGuard: !!guard,
        images,
        estimatedTokens: estimateTokens(text),
      },
    });
  }

  function stopElementPicker() {
    if (!picker) return;
    for (const type of BLOCKED_EVENTS) window.removeEventListener(type, onPickerPointer, true);
    window.removeEventListener("mousemove", onPickerMove, true);
    window.removeEventListener("keydown", onPickerKey, true);
    window.removeEventListener("scroll", schedulePickerDraw, true);
    window.removeEventListener("resize", schedulePickerDraw);
    cancelAnimationFrame(picker.frame);
    document.documentElement.classList.remove(PICKING_CLASS);
    const wasCancelled = !picker.done;
    picker = null;
    if (wasCancelled) removeOverlay();
  }

  function applyHighlightColor(color) {
    if (!/^#[0-9a-f]{6}$/i.test(color ?? "")) color = DEFAULT_HIGHLIGHT_COLOR;
    const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)).join(", ");
    picker.box.style.setProperty("--c", rgb);
  }

  // Texto visível da área sem os itens de interface (botões "Próxima", cronômetro,
  // navegação...). Os itens são escondidos só durante a leitura do texto, que é
  // síncrona: a página não chega a ser redesenhada sem eles.
  function extractAreaText(el) {
    el.setAttribute(READING_ATTR, "");
    try {
      return readAreaText(el);
    } finally {
      el.removeAttribute(READING_ATTR);
    }
  }

  function readAreaText(el) {
    const full = cleanText(el.innerText);
    const noise = findUiNoise(el);
    if (!noise.length) return { text: full, skipped: 0, rawChars: full.length };

    for (const node of noise) node.setAttribute(SKIP_ATTR, "");
    const filtered = cleanText(el.innerText);
    for (const node of noise) node.removeAttribute(SKIP_ATTR);

    // Freio de segurança: se o filtro tirou mais da metade do texto, provavelmente
    // pegou conteúdo de verdade. Na dúvida, envia a área inteira.
    if (filtered.length < full.length * 0.5) return { text: full, skipped: 0, rawChars: full.length, guard: true };
    const topLevel = noise.filter((node) => !noise.some((other) => other !== node && other.contains(node)));
    return { text: filtered, skipped: topLevel.length, rawChars: full.length };
  }

  function findUiNoise(root) {
    const found = new Set();
    const consider = (el, isNoise) => {
      if (el !== root && !found.has(el) && isNoise(el) && !isAnswerLike(el)) found.add(el);
    };
    const isCommand = (button) => UI_COMMAND.test(commandText(button));
    for (const el of root.querySelectorAll(UI_BUTTONS)) {
      // Num grupo de botões em que algum não é comando (ex.: alternativas estilo
      // Kahoot), todos são conteúdo — mesmo uma alternativa chamada "Voltar".
      const group = el.parentElement ? [...el.parentElement.children].filter((sib) => sib.matches(UI_BUTTONS)) : [el];
      consider(el, () => group.every(isCommand));
    }
    for (const el of root.querySelectorAll(UI_BLOCKS)) consider(el, () => true);
    for (const el of root.querySelectorAll("[class], [id]")) {
      consider(el, () => UI_NAME.test(`${el.id} ${typeof el.className === "string" ? el.className : ""}`));
    }
    // Ícones de fonte viram palavras no texto (ex.: "arrow_forward").
    for (const el of root.querySelectorAll("[class*=material-icons], [class*=material-symbols], [aria-hidden=true]")) {
      consider(el, () => /material-(icons|symbols)/.test(el.className) || /^[a-z0-9]+(_[a-z0-9]+)+$/.test(el.textContent.trim()));
    }
    return [...found];
  }

  // Texto de um botão sem os nomes de ícones de fonte ("arrow_back Anterior" -> "Anterior").
  function commandText(button) {
    let text = button.innerText || button.value || "";
    for (const icon of button.querySelectorAll("[class*=material-icons], [class*=material-symbols]")) {
      text = text.replace(icon.textContent, " ");
    }
    return text.replace(/\b[a-z0-9]+(_[a-z0-9]+)+\b/g, " ").replace(/\s+/g, " ").trim();
  }

  // Opções de resposta (ou blocos que as contêm) nunca são filtradas.
  function isAnswerLike(el) {
    return el.matches(ANSWER_LIKE) || !!el.querySelector(ANSWER_LIKE) || ALTERNATIVE_TEXT.test((el.innerText || "").trim());
  }

  // Remove espaços repetidos e linhas vazias em excesso (cada uma custa tokens).
  function cleanText(text) {
    const lines = text
      .replace(/ /g, " ")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .filter((line) => !LMS_UI_LINE.test(line));
    const out = [];
    for (const line of collapseFormulas(lines)) {
      const prev = out[out.length - 1];
      // "a." sozinho seguido de linha vazia: o conteúdo da alternativa vem colado ao rótulo.
      if (line && prev !== undefined && /^[a-e][.)]$/i.test(prev)) {
        out[out.length - 1] = `${prev} ${line}`;
        continue;
      }
      if (!line && prev !== undefined && /^[a-e][.)]$/i.test(prev)) continue;
      // Cabeçalho "Questão N" repetido (o Moodle repete antes das alternativas).
      if (/^(questão|question|pregunta) \d+$/i.test(line) && out.slice(-8).includes(line)) continue;
      out.push(line);
    }
    return out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // Rótulos de plataformas de prova (Moodle etc.) que ocupam uma linha inteira, em
  // português, inglês e espanhol. Só a linha exata sai: não atinge enunciados nem alternativas.
  const LMS_UI_LINE = new RegExp(
    "^(" +
      [
        String.raw`resposta salva|ainda não respondida|não respondida|vale \d+([.,]\d+)? ponto\(s\)\.?|marcar questão|remover marcação|texto da questão|limpar minha escolha`,
        String.raw`answer saved|not yet answered|marked out of \d+([.,]\d+)?|flag question|remove flag|question text|clear my choice`,
        String.raw`respuesta guardada|sin responder aún|(se )?puntúa como \d+([.,]\d+)?( sobre \d+([.,]\d+)?)?|marcar pregunta|quitar marca|enunciado de la pregunta|quitar mi elección`,
      ].join("|") +
      ")$",
    "i",
  );

  // Fórmulas (MathJax e afins) aparecem duas vezes no texto: inteira numa linha e
  // quebrada em um símbolo por linha ("𝜋", ":", "3", "𝑥"...), mais pedaços de chave
  // (⎧ ⎩ ⎨). A versão quebrada é descartada quando repete o que veio logo antes;
  // se não repetir, vira uma linha só.
  function collapseFormulas(lines) {
    const flat = (s) => s.normalize("NFKC").replace(/[\s{}]/g, "").replace(/[.,;:]$/, "");
    // Pedaços de chave desenhados com caracteres não ajudam a ler: saem sempre.
    lines = lines.map((line) => line.replace(/[⎧⎨⎩⎪⎫⎬⎭]/g, ""));
    // Rótulos de alternativa ("a.", "b)") encerram um trecho quebrado em vez de entrar nele.
    const isShort = (line) => [...line].length <= 2 && !/^[a-e][.)]$/i.test(line);
    const out = [];
    for (let i = 0; i < lines.length; ) {
      let j = i;
      while (j < lines.length && isShort(lines[j]) && (lines[j] || isShort(lines[j + 1] ?? "x"))) j++;
      const run = lines.slice(i, j).filter(Boolean);
      if (run.length < 3) {
        out.push(lines[i]);
        i++;
        continue;
      }
      const joined = flat(run.join(""));
      const context = flat(out.slice(-6).join(""));
      if (joined && !context.includes(joined)) out.push(run.join("").normalize("NFKC"));
      i = j;
    }
    return out;
  }

  // Estimativa grosseira (~3,5 caracteres por token em português).
  function estimateTokens(text) {
    return Math.max(1, Math.round(text.length / 3.5));
  }

  function describe(el) {
    const name = el.tagName.toLowerCase();
    if (el.id) return `${name}#${el.id}`.slice(0, 32);
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
    return (cls ? `${name}.${cls}` : name).slice(0, 32);
  }

  // ---------- Comum ----------

  function removeOverlay() {
    overlayHost?.remove();
    overlayHost = null;
    if (panel && panel.text) panel.host.style.display = "";
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function showError(message) {
    showPanel();
    panel.finished = true;
    setStatus(t("statusError"), false);
    panel.answer.classList.add("error");
    setAnswer(message);
  }

  // ---------- Painel de resposta ----------

  function showPanel() {
    if (panel) {
      panel.host.style.display = "";
      return;
    }

    const host = document.createElement("div");
    Object.assign(host.style, { position: "fixed", top: "16px", right: "16px", zIndex: Z_TOP });
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        /* Impede que estilos herdados do site (cor, fonte, sombra) afetem o painel. */
        :host { all: initial; }
        .panel { --header-bg: #7c3aed; --header-fg: #fff;
                 --surface: #fff; --text: #16141d; --muted: #67637a; --answer-bg: #f5f3fb; --answer-text: #0e0c14;
                 --error-bg: #fdecea; --error-text: #b3261e; --shadow: rgba(0,0,0,.3);
                 width: 400px; max-width: calc(100vw - 32px); background: var(--surface); color: var(--text);
                 border-radius: 10px; box-shadow: 0 8px 30px var(--shadow);
                 font: 14px/1.5 "Segoe UI", system-ui, sans-serif; overflow: hidden; }
        /* Tema escuro acompanha o do navegador/sistema. */
        @media (prefers-color-scheme: dark) {
          .panel { --surface: #1b1a23; --text: #ecebf2; --muted: #a29eb0; --answer-bg: #262433;
                   --answer-text: #f4f4f4; --error-bg: #3b2120; --error-text: #ff8a80; --shadow: rgba(0,0,0,.6); }
        }
        .header { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
                  background: var(--header-bg); color: var(--header-fg); cursor: move; user-select: none; }
        .titles { flex: 1; min-width: 0; }
        .title { font-weight: 700; font-size: 14px; }
        .meta, .usage { font-size: 11px; opacity: .9; }
        .meta:empty, .usage:empty { display: none; }
        button { background: color-mix(in srgb, currentColor 18%, transparent); color: inherit;
                 border: 0; border-radius: 4px; padding: 4px 8px; font: inherit; font-size: 12px; cursor: pointer; }
        button:hover { background: color-mix(in srgb, currentColor 32%, transparent); }
        .color { width: 22px; height: 22px; padding: 0; border: 0; background: none; cursor: pointer; flex: none; }
        .color::-webkit-color-swatch-wrapper { padding: 0; }
        .color::-webkit-color-swatch { border: 2px solid currentColor; border-radius: 50%; }
        .status { padding: 6px 12px; font-size: 12px; color: var(--muted); }
        .status.busy::after { content: ""; display: inline-block; width: 10px; height: 10px;
                 margin-left: 6px; border: 2px solid var(--header-bg); border-right-color: transparent;
                 border-radius: 50%; vertical-align: -2px; animation: spin .8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .answer { margin: 0 12px 12px; padding: 12px 14px; max-height: 60vh; overflow: auto;
                  background: var(--answer-bg); border-left: 4px solid var(--header-bg); border-radius: 6px;
                  color: var(--answer-text); font-size: 16px; font-weight: 500; line-height: 1.55;
                  white-space: pre-wrap; word-wrap: break-word; }
        .answer strong { font-weight: 800; }
        .answer:empty { display: none; }
        .answer.error { color: var(--error-text); background: var(--error-bg); border-left-color: var(--error-text); }
      </style>
      <div class="panel">
        <div class="header">
          <div class="titles">
            <div class="title">Model Asker</div>
            <div class="meta"></div>
            <div class="usage"></div>
          </div>
          <input class="color" type="color">
          <button class="copy"></button>
          <button class="close">✕</button>
        </div>
        <div class="status"></div>
        <div class="answer"></div>
      </div>`;
    document.documentElement.appendChild(host);

    panel = {
      host,
      root: root.querySelector(".panel"),
      status: root.querySelector(".status"),
      answer: root.querySelector(".answer"),
      meta: null, // { model, models, effort, plan }
      metaLine: root.querySelector(".meta"),
      usage: root.querySelector(".usage"),
      color: root.querySelector(".color"),
      copyButton: root.querySelector(".copy"),
      closeButton: root.querySelector(".close"),
      text: "",
      tokens: null,
      windows: null, // uso da conta agora
      before: null, // uso da conta antes da pergunta
      finished: false,
    };
    setLanguage(lang);

    // A cor fica no storage: mudar aqui ou nas opções atualiza o painel e o seletor
    // na hora, em todas as abas.
    chrome.storage.local.get({ headerColor: DEFAULT_HEADER_COLOR }).then(({ headerColor }) => applyHeaderColor(headerColor));
    panel.color.addEventListener("input", () => {
      applyHeaderColor(panel.color.value);
      chrome.storage.local.set({ headerColor: panel.color.value });
    });

    const { copyButton } = panel;
    copyButton.addEventListener("click", async () => {
      await navigator.clipboard.writeText(panel.text);
      copyButton.textContent = t("copied");
      setTimeout(() => (copyButton.textContent = t("copy")), 1500);
    });
    panel.closeButton.addEventListener("click", () => {
      host.style.display = "none";
    });

    makeDraggable(host, root.querySelector(".header"));
  }

  function setStatus(text, busy) {
    panel.status.textContent = text;
    panel.status.classList.toggle("busy", busy);
  }

  // Mostra o texto tratando só **negrito**; tudo vira nós de texto (sem innerHTML).
  function setAnswer(text) {
    panel.text = text;
    const parts = text.split(/\*\*(.+?)\*\*/s);
    panel.answer.replaceChildren(
      ...parts.map((part, i) => {
        if (i % 2 === 0) return document.createTextNode(part);
        const strong = document.createElement("strong");
        strong.textContent = part;
        return strong;
      }),
    );
  }

  const EFFORT_KEYS = { low: "effortLow", medium: "effortMedium", high: "effortHigh", xhigh: "effortXhigh", max: "effortMax" };

  // "claude-opus-5-5" -> "Opus 5.5"
  function prettyModel(id) {
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id ?? "");
    if (!m) return id ?? "";
    return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  }

  // Linha 1: modelo · plano · esforço. Linha 2: tokens desta resposta e uso real
  // da conta (mesmos números do /usage do Claude), com quanto esta pergunta debitou.
  function renderUsage() {
    const meta = panel.meta ?? {};

    const models = (meta.models?.length ? meta.models : [meta.model]).filter(Boolean).map(prettyModel);
    const plan = meta.plan
      ? t("plan", { plan: meta.plan === "API" ? "API" : `${meta.plan[0].toUpperCase()}${meta.plan.slice(1)}` })
      : "";
    const effort = EFFORT_KEYS[meta.effort] ? t("effort", { level: t(EFFORT_KEYS[meta.effort]) }) : "";
    panel.metaLine.textContent = [models.join(" → "), plan, effort].filter(Boolean).join(" · ");
    panel.metaLine.title = models.length > 1 ? t("fallbackNote") : "";

    const items = [];
    const details = [];
    if (panel.tokens) {
      const { input, output, thinking } = panel.tokens;
      items.push(t("usageTokens", { n: fmt(input + output) }));
      details.push(
        t("usageDetail", { input: fmt(input), output: fmt(output) }) +
          (thinking ? t("usageThinking", { n: fmt(thinking) }) : ""),
        t("usageModelWeight"),
      );
    }
    const when = new Intl.DateTimeFormat(I18N.LOCALES[lang], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    for (const w of panel.windows ?? []) {
      const label = w.name === "session" ? t("session") : t("week");
      const prev = panel.before?.find((b) => b.name === w.name);
      // O Claude informa o uso em % inteiros: gastos menores que 1% aparecem como "<1%".
      // Uma queda significa que a janela renovou no meio; aí não há como medir.
      let debit = "";
      if (prev && panel.finished) {
        const diff = w.used - prev.used;
        if (diff > 0) debit = ` (+${diff}%)`;
        else if (diff === 0) debit = " (+<1%)";
      }
      items.push(t("usedShort", { label, n: w.used }) + debit);
      details.push(
        t("usedLong", { label, n: w.used }) +
          (prev ? t("usedBefore", { n: prev.used }) : "") +
          (w.resetsAt ? t("resets", { when: when.format(new Date(w.resetsAt)) }) : ""),
      );
    }
    if (panel.before && panel.finished) details.push(t("debitNote"));

    // Espaços não separáveis: a linha só quebra entre itens, nunca no meio de um.
    panel.usage.textContent = items.map((item) => item.replace(/ /g, " ").replace("+<", "+⁠<")).join(" · ");
    panel.usage.title = details.join("\n");
  }

  function applyHeaderColor(color) {
    if (!/^#[0-9a-f]{6}$/i.test(color ?? "")) color = DEFAULT_HEADER_COLOR;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    // Luminância percebida: fundo claro recebe texto escuro e vice-versa.
    const light = 0.299 * r + 0.587 * g + 0.114 * b > 160;
    panel.root.style.setProperty("--header-bg", color);
    panel.root.style.setProperty("--header-fg", light ? "#111" : "#fff");
    panel.color.value = color.toLowerCase();
  }

  function makeDraggable(host, handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, input")) return;
      handle.setPointerCapture(e.pointerId);
      const box = host.getBoundingClientRect();
      const offsetX = e.clientX - box.left;
      const offsetY = e.clientY - box.top;

      const move = (ev) => {
        Object.assign(host.style, {
          left: `${Math.max(0, ev.clientX - offsetX)}px`,
          top: `${Math.max(0, ev.clientY - offsetY)}px`,
          right: "auto",
        });
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }
})();
