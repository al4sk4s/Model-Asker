// Padrões gerados pelo build (defaults.js, carregado antes deste arquivo).
const DEFAULTS = globalThis.CLAUDE_ASKER_DEFAULTS;

// Campos salvos na hora em que mudam (sem precisar clicar em Salvar).
const LIVE_FIELDS = ["captureMode", "highlightColor", "headerColor"];

const PROVIDER_HELP = {
  subscription:
    "Usa o Claude Code instalado e logado neste PC; conta nos limites do seu plano. " +
    "Requer rodar host\\install.ps1 uma vez.",
  api: "Usa a API da Anthropic; cada pergunta é cobrada na sua conta do console.",
};

const fields = Object.keys(DEFAULTS);
const $ = (id) => document.getElementById(id);

function updateUi() {
  const isApi = $("provider").value === "api";
  $("apiKeyField").hidden = !isApi;
  $("apiWarn").hidden = !isApi;
  $("providerHelp").textContent = PROVIDER_HELP[$("provider").value];
  $("highlightField").hidden = $("captureMode").value !== "element";
}

chrome.storage.local.get(DEFAULTS).then((settings) => {
  for (const key of fields) $(key).value = settings[key];
  updateUi();
});

$("provider").addEventListener("change", updateUi);
$("captureMode").addEventListener("change", updateUi);

for (const key of LIVE_FIELDS) {
  $(key).addEventListener("input", () => chrome.storage.local.set({ [key]: $(key).value }));
}

// Mantém os campos em dia com mudanças feitas em outro lugar (painel, menu do ícone).
chrome.storage.onChanged.addListener((changes) => {
  for (const key of LIVE_FIELDS) {
    if (changes[key]) $(key).value = changes[key].newValue;
  }
  updateUi();
});

$("save").addEventListener("click", async () => {
  const settings = {};
  for (const key of fields) settings[key] = $(key).value.trim();
  await chrome.storage.local.set(settings);
  await chrome.storage.local.remove("instructions"); // campo da versão anterior

  const status = $("status");
  status.textContent = "Salvo!";
  setTimeout(() => (status.textContent = ""), 2000);
});
