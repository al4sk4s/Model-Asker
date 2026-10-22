# Model Asker

Extensão para **Chrome / Edge / Brave** (Windows) que resolve questões da tela com o **Claude**:
clique no ícone, selecione a questão e a resposta aparece num painel na própria página.

- **Modo print** — arraste um retângulo; o recorte vai como imagem (bom para figuras e fórmulas).
- **Modo área (HTML)** — clique num bloco da página; só o texto dele é enviado (bem mais barato).
- Usa a **sua assinatura Claude Pro/Max** através do Claude Code — sem chave de API — ou, se preferir, uma chave de API.
- Mostra no painel o modelo, o plano, o esforço, os tokens gastos e **quanto do seu limite cada pergunta debitou**.

---

## Tutorial: instalar e rodar

### 1. Pré-requisitos

| O quê | Para quê | Como |
|---|---|---|
| Windows 10/11 | o host local usa PowerShell e o registro do Windows | — |
| [Node.js](https://nodejs.org) 18+ | roda o host que conversa com o Claude Code | instalador do site |
| [Claude Code](https://claude.com/claude-code) | usa sua assinatura Pro/Max | siga o site; depois rode `claude` no terminal uma vez e faça login |
| Chrome, Edge ou Brave | a extensão | — |

> Vai usar só chave de API? O Claude Code e o passo 3 são opcionais.

### 2. Baixe a release

Na página [**Releases**](../../releases), baixe `model-asker-vX.Y.Z.zip` e extraia numa pasta fixa
(ex.: `C:\Ferramentas\model-asker`). Não apague a pasta depois — o navegador carrega a extensão de lá.

### 3. Instale o host (ponte com o Claude Code)

Abra o PowerShell **na pasta extraída** e rode:

```powershell
powershell -ExecutionPolicy Bypass -File host\install.ps1
```

Ele registra o host para Chrome, Edge e Brave **só para o seu usuário** (chave em `HKEY_CURRENT_USER`).
Para desfazer: `host\uninstall.ps1`. Se mover a pasta, rode o `install.ps1` de novo.

### 4. Carregue a extensão

1. Abra `chrome://extensions` (ou `edge://extensions`, `brave://extensions`).
2. Ative o **Modo do desenvolvedor**.
3. **Carregar sem compactação** → escolha a pasta `extension` (dentro da pasta extraída).
4. Feche e abra o navegador (para ele enxergar o host recém-instalado).

### 5. Use

1. Em qualquer página, clique no ícone da extensão ou pressione **Alt+Shift+S**.
2. Selecione a questão:
   - **Modo print:** arraste o retângulo.
   - **Modo área:** passe o mouse (o bloco fica destacado com uma estimativa de tokens) e clique.
     **↑** amplia para o bloco pai, **↓** volta, **Enter** confirma.
   - **Esc** cancela em qualquer modo.
3. A resposta aparece no painel (arraste pela barra, **Copiar**, **✕**).

Troque de modo clicando com o **botão direito no ícone**. As demais opções ficam em
*botão direito no ícone → Opções* — tudo é salvo automaticamente ao mudar.

---

## Configurações

| Opção | O que faz |
|---|---|
| Como acessar o Claude | **Assinatura** (via Claude Code, padrão) ou **chave de API** (cobrança por uso no console.anthropic.com) |
| Modo de captura | Print ou Área do HTML |
| Cor do destaque da área | só aparece no modo área; muda na hora |
| Modelo | Opus 5.5 (padrão), Sonnet 5.5 ou Haiku 5.5 |
| Esforço de raciocínio | mais esforço = mais cuidado, mais tokens. "Médio" é o equilíbrio; "Alto" para questões difíceis |
| Estilo da resposta | **Só a resposta** (padrão, menos tokens), resposta + justificativa curta, ou passos essenciais |
| Cor da barra de título | também pela bolinha na barra do painel; muda na hora |

## O que aparece no painel

```
Opus 5.5 · plano Pro · esforço médio
826 tokens · Sessão: 51% (+1%) · Semana: 30% (+<1%)
```

- **tokens**: o que esta pergunta gastou (entrada + resposta + raciocínio interno).
- **Sessão / Semana**: uso real da sua conta (o mesmo do comando `/usage` do Claude Code), lido logo após a resposta.
- **(+N%)**: quanto **esta pergunta** debitou — comparação com o uso medido quando você ativou a seleção.
  O Claude informa o uso em porcentagens inteiras, então gastos menores que 1% aparecem como `+<1%`.
- Passe o mouse sobre a linha para ver o detalhamento (entrada, saída, raciocínio) e quando cada limite renova.

O painel e a página de configurações seguem o **tema claro/escuro do navegador**.

## Economia de tokens

O que a ferramenta já faz sozinha:

- **Modo área** envia só texto (nenhum código HTML) — normalmente o mais barato, principalmente com várias
  questões de uma vez. Ignora itens de interface dentro da área (botões "Próxima"/"Enviar", cronômetro,
  barra de progresso, navegação, nomes de ícones), de forma conservadora: alternativas nunca são removidas,
  e se o filtro tirar mais da metade do texto a área vai inteira. O painel mostra quantos itens foram ignorados.
- **Fórmulas** (MathJax e afins) que a página repete quebradas em um símbolo por linha são enviadas uma vez só,
  e rótulos de plataformas como o Moodle ("Resposta salva", "Vale 1,00 ponto(s).", "Marcar questão"...) saem.
  Numa prova de Moodle com fórmulas: −58% de texto e −36% de custo, com as mesmas respostas.
- **Modo print** apara automaticamente as margens vazias do recorte, reduz a imagem em telas com zoom
  (até 30%, sem perder legibilidade) e limita o tamanho a ~0,8 MP.
- **Cache de prompt desligado**: cada pergunta é diferente e a parte fixa é pequena demais para o cache, então
  nada era reaproveitado — e o Claude Code gravava tudo no cache de 1 hora, que custa o **dobro**.
  Medido no Opus: de $0,0068 para $0,0036 por pergunta (**−47%**).
- O host desliga chamadas auxiliares do Claude Code (título de sessão, anexos de contexto) que gastariam tokens à toa.
- Ainda vão em toda pergunta ~550 tokens fixos do próprio Claude Code (identificação, seu e-mail da conta e
  informações do ambiente). Não há opção oficial para removê-los.

Escolhendo modelo e esforço (medido com as mesmas questões):

| Configuração | Raciocínio interno | Observação |
|---|---|---|
| Opus · baixo | 0–75 tokens | acertou tudo nos testes; ótimo custo-benefício |
| Opus · médio (padrão) | 8–111 tokens | um pouco mais de cuidado em questões difíceis |
| Haiku · baixo | 59–366 tokens | gasta tokens parecidos (raciocina mais), mas **cada token pesa bem menos no limite**; erra mais sem raciocínio |

O número de tokens sozinho engana: o que importa para o seu limite é o **(+N%)** — Haiku e Sonnet debitam
bem menos por token que o Opus.

## Privacidade

- O conteúdo selecionado é enviado à Anthropic (via Claude Code ou API) — evite capturar dados sensíveis.
- A chave de API (se usada) fica só no armazenamento local da extensão, no seu navegador.
- O host roda o Claude Code numa pasta temporária vazia, sem ferramentas, sem plugins e sem ler seus arquivos.
- Uso pessoal: não compartilhe sua assinatura com outras pessoas através da ferramenta.

## Limitações

- Só Windows (o host usa PowerShell/registro). A extensão em si funciona em qualquer Chromium.
- Não funciona em páginas internas (`chrome://`, Web Store, visualizador de PDF nativo) — o ícone mostra "!".
- Modo print captura só a parte visível da aba.
- Modo área: imagens/figuras não são enviadas (o painel avisa) e não seleciona dentro de iframes.

---

## Para desenvolvedores

```
src/background.js     service worker (empacotado com o SDK da Anthropic pelo esbuild)
extension/            arquivos estáticos da extensão (content script, opções, manifest)
host/                 host Native Messaging + instalador
config/defaults.json  padrões públicos das configurações
config/dev.json       SEUS padrões (ignorado pelo git) — copie de config/dev.example.json
build.mjs             gera dist/public, dist/dev e o zip de release
```

```bash
npm install
npm run build        # dist/public  — padrões neutros (o que é publicado)
npm run build:dev    # dist/dev     — padrões + config/dev.json; nome "Model Asker (dev)"
npm run watch:dev    # refaz o dev a cada alteração
npm run release      # release/model-asker-v<versão>.zip (build public + host)
```

Carregue `dist/dev` no navegador para desenvolver. A versão dev grava um **log de cada pergunta** (só no modo
assinatura) em `logs/`: `resumo.txt` (uma linha por pergunta: modo, modelo, tokens, custo, extração, uso
antes/depois, tempo) e `requests.jsonl` (instruções, conteúdo enviado, argumentos, eventos do Claude Code,
uso detalhado). As imagens enviadas ficam como arquivos ao lado. A versão public não grava nada. Nada pessoal entra no repositório:
`config/dev.json`, `dist/`, `release/` e os arquivos gerados pelo `install.ps1` estão no `.gitignore`.

O `manifest.json` tem um campo `key` que fixa o ID da extensão (`obkgoanblboakpomlknmomclngpaicnn`);
o host só aceita conexões desse ID.

O plano de estudo usado para construir o projeto está em [PLANO_DE_ESTUDO.md](PLANO_DE_ESTUDO.md).
