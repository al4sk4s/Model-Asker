// Padrões gerados pelo build (defaults.js, carregado antes deste arquivo).
const DEFAULTS = globalThis.CLAUDE_ASKER_DEFAULTS;

const PROVIDER_HELP = {
  subscription:
    "Usa o Claude Code instalado e logado neste PC; conta nos limites do seu plano. " +
    "Requer rodar host\\install.ps1 uma vez.",
  api: "Usa a API da Anthropic; cada pergunta é cobrada na sua conta do console.",
};

// Medido com as mesmas questões: o Haiku raciocina mais que o Opus no esforço
// baixo, então gasta tokens parecidos — mas cada token dele pesa bem menos no limite.
const MODEL_HELP = {
  "claude-opus-5-5": "Recomendado. Acerta mais e, no esforço baixo/médio, raciocina pouco.",
  "claude-sonnet-5-5": "Mais rápido; o consumo de tokens é parecido com o do Opus, mas pesa menos no limite.",
  "claude-haiku-5-5":
    "Pesa bem menos no limite por token, mas raciocina mais (gasta tokens parecidos) e erra mais em questões difíceis.",
};

const fields = Object.keys(DEFAULTS);
const $ = (id) => document.getElementById(id);
const TEXT_FIELDS = new Set(["apiKey", "extra"]);

function updateUi() {
  const isApi = $("provider").value === "api";
  $("apiKeyField").hidden = !isApi;
  $("providerHelp").textContent = PROVIDER_HELP[$("provider").value];
  $("highlightField").hidden = $("captureMode").value !== "element";
  $("modelHelp").textContent = MODEL_HELP[$("model").value] ?? "";
}

let toastTimer = 0;
function showSaved() {
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 1200);
}

// Tudo é salvo na hora; campos de texto esperam a digitação parar.
const pending = {};
function save(key) {
  const value = $(key).value.trim();
  clearTimeout(pending[key]);
  pending[key] = setTimeout(
    async () => {
      await chrome.storage.local.set({ [key]: value });
      showSaved();
    },
    TEXT_FIELDS.has(key) ? 400 : 0,
  );
}

chrome.storage.local.get(DEFAULTS).then((settings) => {
  for (const key of fields) {
    $(key).value = settings[key];
    $(key).addEventListener("input", () => {
      updateUi();
      save(key);
    });
  }
  updateUi();
});

// Mantém os campos em dia com mudanças feitas em outro lugar (painel, menu do ícone).
chrome.storage.onChanged.addListener((changes) => {
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (fields.includes(key) && document.activeElement !== $(key)) $(key).value = newValue;
  }
  updateUi();
});

chrome.storage.local.remove("instructions"); // campo de uma versão antiga
