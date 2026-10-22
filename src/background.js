// Service worker da extensão. Este arquivo é empacotado pelo esbuild
// (npm run build) em extension/background.js junto com o SDK da Anthropic.
import Anthropic from "@anthropic-ai/sdk";
import "../extension/i18n.js";

const I18N = globalThis.MODEL_ASKER_I18N;

// Padrões das configurações: vêm de config/defaults.json (+ config/dev.json no
// build dev), injetados pelo build.mjs.
//   provider: "subscription" (Claude Code / plano Pro) | "api"
//   captureMode: "print" (recorte vira imagem) | "element" (texto de uma área do HTML)
//   style: "direct" | "short" | "steps"
const DEFAULTS = __DEFAULTS__;

// Instruções curtas: o raciocínio acontece no pensamento interno do modelo
// (que garante a precisão); o texto visível fica só com o necessário. O idioma
// da resposta é acrescentado no fim, conforme a opção "Idioma".
const BASE_PROMPT =
  "Você recebe uma ou mais questões (imagem de tela ou texto extraído de uma página). Resolva " +
  "com cuidado e confira o resultado antes de responder. Sem introdução, sem repetir o enunciado " +
  "e sem comentários finais. Várias questões: uma linha por questão " +
  "(ex.: \"1) C\"). Conteúdo ilegível ou incompleto: diga isso em uma frase.";

const STYLE_PROMPTS = {
  direct:
    "Formato obrigatório: somente a resposta final, nada mais. Múltipla escolha: a letra e o " +
    "conteúdo da alternativa (ex.: b) 80 km/h). Cálculo: só o valor final. Dissertativa: uma frase. " +
    "Não mostre cálculos, fórmulas nem verificações.",
  short: "Primeira linha: a resposta final. Segunda linha: justificativa de no máximo uma frase.",
  steps: "Mostre só os passos essenciais, de forma enxuta, e termine com \"Resposta: ...\".",
};

const PROMPT = "Resolva.";
const NATIVE_HOST = "com.model_asker.host";

// Uma imagem custa cerca de (largura × altura) / 750 tokens. Limitar a ~0,8 MP
// (≤ ~1.070 tokens; lado maior ≤ 1568 px) mantém texto de tamanho normal legível
// sem pagar por pixels inúteis.
const MAX_SIDE = 1568;
const MAX_PIXELS = 800_000;
// Margem mantida em volta do conteúdo depois de aparar o fundo vazio (px).
const TRIM_PADDING = 8;
// Com zoom do Windows (125%, 150%, 200%) o print tem mais pixels do que a página
// mostra. Reduzimos em direção à resolução da página, mas nunca mais que 30%,
// para o texto continuar nítido.
const MIN_SHRINK = 0.7;
// Limite da API para imagem em base64 é 5 MB; acima disso trocamos PNG por JPEG.
const MAX_PNG_BYTES = 3.5 * 1024 * 1024;

// Uso da conta lido ao entrar no modo de seleção, por aba (promessa do host).
const usageSnapshots = new Map();

const MODE_LABELS = { print: "menuPrint", element: "menuArea" };

// Idioma escolhido nas opções ("auto" = o do navegador).
async function currentLanguage() {
  const { language } = await chrome.storage.local.get({ language: DEFAULTS.language });
  return I18N.resolveLanguage(language);
}

async function updateMenuTitles() {
  const lang = await currentLanguage();
  for (const [mode, key] of Object.entries(MODE_LABELS)) {
    chrome.contextMenus.update(mode, { title: I18N.translate(lang, key) });
  }
}

// Clique direito no ícone: alterna entre os modos de captura.
chrome.runtime.onInstalled.addListener(async () => {
  // Cores padrão das versões antigas (laranja/azul) passam para a paleta roxa;
  // cores escolhidas por você ficam como estão.
  const OLD_DEFAULTS = { headerColor: "#d97757", highlightColor: "#93c5fd" };
  const stored = await chrome.storage.local.get(Object.keys(OLD_DEFAULTS));
  const updates = {};
  for (const [key, old] of Object.entries(OLD_DEFAULTS)) {
    if (stored[key]?.toLowerCase() === old) updates[key] = DEFAULTS[key];
  }
  await chrome.storage.local.set(updates);

  const { captureMode } = await chrome.storage.local.get(DEFAULTS);
  const lang = await currentLanguage();
  chrome.contextMenus.removeAll(() => {
    for (const [mode, key] of Object.entries(MODE_LABELS)) {
      const title = I18N.translate(lang, key);
      chrome.contextMenus.create({ id: mode, title, type: "radio", contexts: ["action"], checked: mode === captureMode });
    }
  });
});

chrome.contextMenus.onClicked.addListener(({ menuItemId }) => {
  if (menuItemId in MODE_LABELS) chrome.storage.local.set({ captureMode: menuItemId });
});

// Mantém o menu certo quando o modo muda pela página de opções.
chrome.storage.onChanged.addListener((changes) => {
  const mode = changes.captureMode?.newValue;
  if (mode in MODE_LABELS) chrome.contextMenus.update(mode, { checked: true });
  if (changes.language) updateMenuTitles();
});

// 1) Clique no ícone (ou Alt+Shift+S): injeta o content script e liga o modo escolhido.
chrome.action.onClicked.addListener(async (tab) => {
  const { provider, apiKey, captureMode } = await chrome.storage.local.get(DEFAULTS);
  if (provider === "api" && !apiKey) {
    chrome.runtime.openOptionsPage();
    return;
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["defaults.js", "i18n.js", "content.js"] });
    if (captureMode === "element") {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["picker.css"] });
    }
    await chrome.tabs.sendMessage(tab.id, { type: "start-selection", mode: captureMode });
    // Foto do uso da conta ANTES da pergunta (enquanto você seleciona), para
    // depois mostrar quanto ela debitou.
    if (provider !== "api") usageSnapshots.set(tab.id, askHost({ type: "usage" }));
  } catch (err) {
    // Páginas como chrome://, a Web Store e o visualizador de PDF não aceitam scripts.
    console.warn("Model Asker: não foi possível usar esta página.", err);
    chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#c0392b" });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: "" }), 3000);
  }
});

// 2) O content script avisa o que o usuário escolheu: um retângulo (print) ou o
//    texto de uma área do HTML.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab) return;
  if (msg.type === "region-selected") {
    solve(sender.tab, async () => {
      const screenshot = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
      const image = await cropToBase64(screenshot, msg.rect, msg.viewportWidth);
      return {
        mode: "print",
        blocks: [{ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }],
        info: image.info,
      };
    });
  } else if (msg.type === "element-selected") {
    // Só o texto: as instruções já dizem que o conteúdo pode vir de uma página.
    solve(sender.tab, async () => ({ mode: "element", blocks: [{ type: "text", text: msg.text }], info: msg.stats }));
  }
});

// buildContent devolve { mode, blocks, info }: os blocos (imagem ou texto) com as
// questões e detalhes de como foram extraídos (usados no log da versão dev).
async function solve(tab, buildContent) {
  const send = (message) => chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  // Chamar uma API da extensão periodicamente impede o service worker de ser
  // encerrado por inatividade enquanto o Claude ainda está pensando.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  const lang = await currentLanguage();
  const t = (key, vars) => I18N.translate(lang, key, vars);

  try {
    // 3) Monta o conteúdo (print recortado ou texto da área) antes de mostrar o
    //    painel, para ele não sair no print.
    const { mode, blocks, info } = await buildContent();
    const content = [...blocks, { type: "text", text: PROMPT }];
    const settings = await chrome.storage.local.get(DEFAULTS);
    settings.instructions = [
      BASE_PROMPT,
      STYLE_PROMPTS[settings.style] ?? STYLE_PROMPTS.direct,
      t("answerLanguage"),
      settings.extra,
    ]
      .filter(Boolean)
      .join("\n");
    send({
      type: "answer-start",
      meta: { model: settings.model, effort: settings.effort, plan: settings.provider === "api" ? "API" : null },
    });

    // Só na versão dev: detalhes para o log (sem a chave de API).
    const debug = __DEV__
      ? {
          version: chrome.runtime.getManifest().version,
          mode,
          settings: { ...settings, apiKey: settings.apiKey ? "<definida>" : "", instructions: undefined },
          extraction: info,
        }
      : null;

    if (settings.provider === "api") {
      await solveWithApi(settings, content, send, debug, t);
    } else {
      // Uso da conta antes da pergunta: a foto tirada ao entrar no modo de seleção
      // (ou uma leitura agora, se ela se perdeu). Já aparece no painel.
      const before = usageSnapshots.get(tab.id) ?? askHost({ type: "usage" });
      usageSnapshots.delete(tab.id);
      before.catch(() => {});
      before.then((msg) => send({ type: "usage-update", windows: msg.windows, plan: msg.plan })).catch(() => {});
      if (debug) {
        // Normalmente já está pronta (foi lida enquanto você selecionava).
        const snapshot = await Promise.race([before.catch(() => null), new Promise((r) => setTimeout(r, 3000))]);
        debug.before = snapshot?.windows ?? null;
      }
      await solveWithSubscription(settings, content, send, before, debug, t);
    }
  } catch (err) {
    console.error("Model Asker:", err);
    send({ type: "answer-error", message: describeError(err, t) });
  } finally {
    clearInterval(keepAlive);
  }
}

// Modo assinatura: conversa com host/host.js, que roda o Claude Code logado no seu plano.
function solveWithSubscription(settings, content, send, before, debug, t) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    let finished = false;

    port.onMessage.addListener((msg) => {
      if (msg.type === "delta") {
        send({ type: "answer-delta", text: msg.text });
      } else if (msg.type === "done") {
        finished = true;
        send({ type: "answer-done", note: msg.truncated ? t("statusTruncated") : undefined, usage: msg.usage });
        resolve();
      } else if (msg.type === "usage") {
        // Uso real da conta lido logo após a resposta, comparado com o de antes.
        port.disconnect();
        const timeout = new Promise((r) => setTimeout(() => r(null), 10_000));
        Promise.race([before.catch(() => null), timeout]).then((snapshot) => {
          if (!msg.windows) return;
          send({ type: "usage-update", windows: msg.windows, before: snapshot?.windows, plan: snapshot?.plan, final: true });
        });
      } else if (msg.type === "error") {
        finished = true;
        port.disconnect();
        const errors = {
          spawn: () => t("errSpawn", { message: msg.detail }),
          exit: () => (/^\d+$/.test(msg.detail) ? t("errExit", { code: msg.detail }) : msg.detail),
          cli: () => msg.detail || t("errCli"),
        };
        reject(new Error((errors[msg.code] ?? errors.cli)()));
      }
    });

    port.onDisconnect.addListener(() => {
      if (finished) return;
      const reason = chrome.runtime.lastError?.message ?? "";
      reject(
        new Error(
          /not found|not exist/i.test(reason) ? t("errHostMissing") : t("errHostDropped", { reason }),
        ),
      );
    });

    port.postMessage({
      type: "solve",
      content,
      debug, // presente só na versão dev: o host grava tudo em logs/
      instructions: settings.instructions,
      model: settings.model,
      effort: settings.effort,
    });
  });
}

// Pedido simples ao host com uma única resposta (ex.: { type: "usage" }).
function askHost(request) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    port.onMessage.addListener((msg) => {
      port.disconnect();
      resolve(msg);
    });
    port.onDisconnect.addListener(() => reject(new Error(chrome.runtime.lastError?.message)));
    port.postMessage(request);
  });
}

// Modo chave de API: chama a API da Anthropic direto do navegador (cobrança por uso).
async function solveWithApi(settings, content, send, debug, t) {
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const params = {
    model: settings.model,
    max_tokens: 64000,
    system: settings.instructions,
    output_config: { effort: settings.effort },
    messages: [{ role: "user", content }],
  };
  // Se o modelo recusar por engano, a API tenta de novo com outro modelo
  // automaticamente. O Haiku não tem esse recurso.
  if (!settings.model.startsWith("claude-haiku")) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  const stream = client.beta.messages.stream(params);
  stream.on("streamEvent", (event) => {
    if (event.type === "content_block_start" && event.content_block.type === "fallback") {
      send({ type: "answer-reset" });
    }
  });
  stream.on("text", (text) => send({ type: "answer-delta", text }));

  const message = await stream.finalMessage();
  const u = message.usage;
  // No modo API não há host: o log da versão dev vai para o console do service worker.
  if (debug) console.log("[Model Asker dev]", { ...debug, instructions: settings.instructions, content, response: message });
  // A API cobra por uso; não existe porcentagem de cota como na assinatura.
  const usage = {
    input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    cached: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens,
    models: [message.model],
  };
  if (message.stop_reason === "refusal") {
    send({ type: "answer-error", message: t("errRefusal") });
  } else if (message.stop_reason === "max_tokens") {
    send({ type: "answer-done", note: t("statusTruncated"), usage });
  } else {
    send({ type: "answer-done", usage });
  }
}

async function cropToBase64(dataUrl, rect, viewportWidth) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const { width: bitmapWidth, height: bitmapHeight } = bitmap;

  // O print vem em pixels físicos; o retângulo está em pixels CSS.
  const scale = bitmap.width / viewportWidth;
  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.min(bitmap.width - sx, Math.round(rect.width * scale));
  const sh = Math.min(bitmap.height - sy, Math.round(rect.height * scale));

  // Recorte em resolução cheia, depois sem as margens de fundo vazio.
  const full = new OffscreenCanvas(sw, sh);
  const fullCtx = full.getContext("2d", { willReadFrequently: true });
  fullCtx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  const box = contentBox(fullCtx, sw, sh, Math.round(TRIM_PADDING * scale));

  const shrink = Math.min(
    1,
    Math.max(1 / scale, MIN_SHRINK),
    MAX_SIDE / Math.max(box.w, box.h),
    Math.sqrt(MAX_PIXELS / (box.w * box.h)),
  );
  const canvas = new OffscreenCanvas(Math.round(box.w * shrink), Math.round(box.h * shrink));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high"; // reamostragem suave: letras sem serrilhado
  ctx.drawImage(full, box.x, box.y, box.w, box.h, 0, 0, canvas.width, canvas.height);

  let blob = await canvas.convertToBlob({ type: "image/png" });
  if (blob.size > MAX_PNG_BYTES) {
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  }
  // Cada etapa do tratamento da imagem (usado no log da versão dev).
  const info = {
    screen: { w: bitmapWidth, h: bitmapHeight, scale: Number(scale.toFixed(3)) },
    crop: { w: sw, h: sh },
    trimmed: { w: box.w, h: box.h },
    final: { w: canvas.width, h: canvas.height, shrink: Number(shrink.toFixed(3)) },
    imageTokens: Math.round((canvas.width * canvas.height) / 750),
    bytes: blob.size,
  };
  return { mediaType: blob.type, data: toBase64(await blob.arrayBuffer()), info };
}

// Menor retângulo que contém tudo o que difere da cor de fundo (a do canto
// superior esquerdo), com uma margem. Fundo vazio custa tokens e não ajuda a ler.
function contentBox(ctx, width, height, padding) {
  const px = ctx.getImageData(0, 0, width, height).data;
  const [r0, g0, b0] = px;
  const differs = (i) => Math.max(Math.abs(px[i] - r0), Math.abs(px[i + 1] - g0), Math.abs(px[i + 2] - b0)) > 24;

  let top = height, bottom = -1, left = width, right = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (!differs(row + x * 4)) continue;
      if (y < top) top = y;
      bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (bottom < 0) return { x: 0, y: 0, w: width, h: height }; // só fundo: envia como está

  const x = Math.max(0, left - padding);
  const y = Math.max(0, top - padding);
  return { x, y, w: Math.min(width, right + padding + 1) - x, h: Math.min(height, bottom + padding + 1) - y };
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function describeError(err, t) {
  if (err instanceof Anthropic.AuthenticationError) return t("errInvalidKey");
  if (err instanceof Anthropic.PermissionDeniedError) return t("errPermission");
  if (err instanceof Anthropic.RateLimitError) return t("errRateLimit");
  if (err instanceof Anthropic.APIConnectionError) return t("errConnection");
  if (err instanceof Anthropic.APIError) return t("errApi", { status: err.status ?? "?", message: err.message });
  return err?.message ?? String(err);
}
