// Padrões e textos gerados/carregados antes deste arquivo (defaults.js, i18n.js).
const DEFAULTS = globalThis.MODEL_ASKER_DEFAULTS;
const I18N = globalThis.MODEL_ASKER_I18N;

const PROVIDER_HELP = { subscription: "providerHelpSub", api: "providerHelpApi" };
const MODEL_HELP = {
  "claude-opus-5-5": "modelHelpOpus",
  "claude-sonnet-5-5": "modelHelpSonnet",
  "claude-haiku-5-5": "modelHelpHaiku",
};

const fields = Object.keys(DEFAULTS);
const $ = (id) => document.getElementById(id);
const TEXT_FIELDS = new Set(["apiKey", "extra"]);
let lang = I18N.resolveLanguage(DEFAULTS.language);
const t = (key) => I18N.translate(lang, key);

// Opções do campo de idioma: automático + cada idioma no próprio nome.
function fillLanguageOptions() {
  const select = $("language");
  const value = select.value;
  select.replaceChildren(
    new Option(t("languageAuto"), "auto"),
    ...Object.entries(I18N.LANGUAGES).map(([code, name]) => new Option(name, code)),
  );
  select.value = value || "auto";
}

// Textos da página no idioma atual (elementos marcados com data-i18n*).
function applyTranslations() {
  document.documentElement.lang = I18N.LOCALES[lang];
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  fillLanguageOptions();
  updateUi();
}

function updateUi() {
  const isApi = $("provider").value === "api";
  $("apiKeyField").hidden = !isApi;
  $("providerHelp").textContent = t(PROVIDER_HELP[$("provider").value]);
  $("highlightField").hidden = $("captureMode").value !== "element";
  $("modelHelp").textContent = MODEL_HELP[$("model").value] ? t(MODEL_HELP[$("model").value]) : "";
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

fillLanguageOptions();
chrome.storage.local.get(DEFAULTS).then((settings) => {
  lang = I18N.resolveLanguage(settings.language);
  applyTranslations();
  for (const key of fields) {
    $(key).value = settings[key];
    $(key).addEventListener("input", () => {
      if (key === "language") {
        lang = I18N.resolveLanguage($(key).value);
        applyTranslations();
      }
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
  if (changes.language) {
    lang = I18N.resolveLanguage(changes.language.newValue);
    applyTranslations();
  }
  updateUi();
});

chrome.storage.local.remove("instructions"); // campo de uma versão antiga
