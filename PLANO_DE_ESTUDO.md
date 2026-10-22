# Plano de Estudo — Model Asker

Extensão de navegador (Chrome / Brave / Edge / Opera — todos baseados em Chromium) que:
1. ao clicar no ícone (ou `Alt+Shift+S`) entra em **modo print**;
2. o cursor vira uma mira e o usuário arrasta um **retângulo** sobre a página;
3. a área recortada vira uma imagem enviada ao **Claude**, que resolve a questão;
4. a resposta aparece num painel flutuante na própria página, em tempo real (streaming).

---

## Visão geral da arquitetura

```
 [Ícone / atalho]                                   (gesto do usuário => permissão activeTab)
        │
        ▼
 background.js (service worker)  ── injeta ──►  content.js (na página)
        ▲                                         - overlay com cursor de mira
        │  {rect, viewport}                       - desenha o retângulo
        │◄────────────────────────────────────────  - remove o overlay e avisa
        │
        ├─ chrome.tabs.captureVisibleTab()  → PNG da aba inteira
        ├─ OffscreenCanvas                  → recorta o retângulo
        ├─ @anthropic-ai/sdk (streaming)    → Claude Opus 5.5
        │
        └── trechos da resposta ─────────────►  content.js mostra no painel
```

---

## Módulo 1 — Fundamentos web (1–2 semanas, se ainda não domina)
- **JavaScript moderno**: `const/let`, arrow functions, módulos ES (`import/export`), `async/await`, Promises.
- **DOM**: `document.createElement`, eventos de mouse (`mousedown`, `mousemove`, `mouseup`), `getBoundingClientRect`, `clientX/clientY`.
- **CSS**: `position: fixed`, `z-index`, `cursor: crosshair`, `pointer-events`.
- **Canvas 2D**: `drawImage` com recorte (9 argumentos), `OffscreenCanvas`, `convertToBlob`.
- **Base64 e Blobs**: como transformar bytes de imagem em texto base64.
- Exercício: página HTML onde você arrasta um retângulo e ele fica desenhado na tela.

Referências: MDN Web Docs (developer.mozilla.org) — seções "Mouse events", "Canvas API", "OffscreenCanvas".

## Módulo 2 — Extensões Chromium / Manifest V3 (1 semana)
- `manifest.json`: `manifest_version: 3`, `action`, `background.service_worker`, `permissions`, `commands`, `options_page`.
- **Service worker** (background): não tem DOM, pode ser encerrado a qualquer momento — não guarde estado em variáveis globais por muito tempo.
- **Content scripts**: rodam dentro da página; injeção programática com `chrome.scripting.executeScript`.
- **Permissões**:
  - `activeTab` — acesso temporário à aba quando o usuário clica no ícone (evita pedir acesso a "todos os sites").
  - `scripting` — injetar o content script.
  - `storage` — salvar chave de API e preferências.
- **Mensagens** entre partes: `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage` / `onMessage`.
- **Captura de tela**: `chrome.tabs.captureVisibleTab` (só a parte visível da aba).
- Carregar sem publicar: `chrome://extensions` → "Modo do desenvolvedor" → "Carregar sem compactação".
- Depurar: "Inspecionar visualizações: service worker" e DevTools da página para o content script.

Referência: developer.chrome.com/docs/extensions (guias "Get started", "Service workers", "activeTab", "Message passing").

## Módulo 3 — UI de seleção (o "modo print") (3–5 dias)
- Overlay de tela inteira semitransparente com `cursor: crosshair`.
- Retângulo calculado a partir do ponto inicial e do ponto atual (`Math.min`, `Math.abs`).
- Técnica do "buraco": `box-shadow: 0 0 0 9999px rgba(0,0,0,.4)` escurece tudo menos a seleção.
- `Esc` cancela; seleções muito pequenas são ignoradas.
- **Shadow DOM** (`attachShadow`) para o CSS da extensão não brigar com o CSS do site.
- Remover o overlay **antes** de capturar (senão ele aparece na foto) — esperar 2 frames com `requestAnimationFrame`.

## Módulo 4 — Captura e recorte da imagem (2–3 dias)
- `captureVisibleTab` devolve uma data URL PNG em **pixels físicos**; o retângulo está em **pixels CSS**.
- Escala = `larguraDaImagem / window.innerWidth` (cobre `devicePixelRatio` e zoom).
- `createImageBitmap` + `OffscreenCanvas` funcionam dentro do service worker.
- Reduzir imagens enormes (lado maior ≤ 2000 px) para economizar tokens e respeitar limites da API.

## Módulo 5 — API do Claude (3–5 dias)
- Criar conta e chave em **console.anthropic.com** (a API é cobrada por uso — é diferente da assinatura do claude.ai).
- **Messages API** (`POST /v1/messages`) com conteúdo multimodal:
  ```js
  content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data } },
    { type: "text", text: "Resolva a questão da imagem." }
  ]
  ```
- SDK oficial `@anthropic-ai/sdk`; no navegador precisa de `dangerouslyAllowBrowser: true`.
- **Streaming** (`client.messages.stream`, evento `"text"`, `finalMessage()`) para mostrar a resposta enquanto é gerada.
- Modelo `claude-opus-5-5` com pensamento adaptativo (padrão) e `output_config.effort` para equilibrar custo × qualidade.
- Tratar `stop_reason === "refusal"` e usar `fallbacks: "default"` (beta) para reencaminhar recusas automaticamente.
- Tratar erros: chave inválida (401), limite de uso (429), sobrecarga (529/5xx).

Referência: docs.claude.com / platform.claude.com — "Vision", "Streaming", "Messages API".

## Módulo 5b — Usar a assinatura Pro/Max via Claude Code (2–3 dias)
- A assinatura do claude.ai não é uma API; o caminho oficial é o **Claude Code**, que loga com o seu plano.
- Modo sem interface: `claude -p --input-format stream-json --output-format stream-json --include-partial-messages`
  — recebe a imagem como bloco `image` no stdin e devolve a resposta em linhas JSON.
- **Native Messaging**: a extensão não pode executar programas; o navegador inicia um "host" registrado
  (`chrome.runtime.connectNative`), e os dois trocam mensagens pelo stdin/stdout (4 bytes de tamanho + JSON).
- No Windows o host é registrado em `HKCU\Software\Google\Chrome\NativeMessagingHosts\<nome>` (Edge e Brave têm chaves próprias).
- `allowed_origins` exige o ID da extensão; o campo `key` no `manifest.json` deixa o ID fixo.
- Processos filhos em Node: `child_process.spawn`, leitura de streams linha a linha.

Referência: developer.chrome.com/docs/extensions/develop/concepts/native-messaging e a documentação do Claude Code (modo headless).

## Módulo 6 — Empacotamento com npm + esbuild (1 dia)
- O SDK é um pacote npm; extensões não resolvem `import "pacote"` sozinhas.
- `esbuild --bundle` junta o SDK + seu código num único `background.js`.
- `npm run build` / `npm run watch`.

## Módulo 7 — Segurança e privacidade (contínuo)
- A chave fica em `chrome.storage.local` — **só no seu computador**. Nunca publique a extensão com uma chave embutida; para distribuir publicamente, o certo é um **backend próprio** que guarda a chave e repassa as chamadas.
- Nunca usar `innerHTML` com texto vindo do modelo ou da página (risco de XSS) — usar `textContent`.
- `activeTab` em vez de `<all_urls>`: a extensão só enxerga a aba quando você pede.
- Lembre que o recorte enviado sai do seu computador para a API — evite capturar dados sensíveis.

## Módulo 8 — Evoluções futuras (opcional)
- Renderizar Markdown/LaTeX da resposta (ex.: `marked` + `DOMPurify`, `KaTeX`).
- Histórico de perguntas; perguntas de acompanhamento ("explique melhor o passo 2").
- Capturar área maior que a tela (scroll + colar várias capturas).
- Firefox: usa `browser.*` e tem pequenas diferenças no MV3.
- Publicar na Chrome Web Store (com backend próprio).

---

## Roteiro de implementação (o que foi feito neste repositório)

| Etapa | Arquivo | O que faz |
|---|---|---|
| 1 | `extension/manifest.json` | Declara a extensão, permissões, atalho e página de opções |
| 2 | `extension/options.html` / `options.js` | Salva chave de API, modelo, esforço e instruções |
| 3 | `src/background.js` | Injeta o script, captura, recorta, chama o Claude com streaming |
| 4 | `extension/content.js` | Modo print (overlay + retângulo) e painel de resposta |
| 5 | `package.json` | `npm run build` empacota `src/background.js` → `extension/background.js` |
| 6 | `host/host.js` + `host/install.ps1` | Ponte Native Messaging → Claude Code (modo assinatura) |

Veja o `README.md` para instalar e usar.
