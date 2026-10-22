// Native Messaging host: o navegador inicia este processo e conversa com ele
// pelo stdin/stdout (cada mensagem = 4 bytes de tamanho + JSON).
// Ele repassa a imagem ao Claude Code (`claude -p`), que usa o login da sua
// assinatura Pro/Max, e devolve a resposta em pedaços para a extensão.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
// Pasta vazia para o Claude Code rodar sem pegar CLAUDE.md de nenhum projeto.
const WORK_DIR = path.join(os.tmpdir(), "model-asker");
const LOG_FILE = path.join(WORK_DIR, "host.log");
// Log detalhado por pergunta, só quando a extensão dev pede (message.debug).
const DEBUG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "logs");

fs.mkdirSync(WORK_DIR, { recursive: true });

let child = null;
let input = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (input.length < 4 + length) break;
    const message = JSON.parse(input.subarray(4, 4 + length).toString("utf8"));
    input = input.subarray(4 + length);
    handle(message);
  }
});

// O navegador fechou a conexão (painel fechado, aba recarregada etc.).
process.stdin.on("end", () => {
  child?.kill();
  process.exit(0);
});

function send(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function log(text) {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${text}\n`);
}

function finish(message) {
  send(message);
  // Dá tempo do stdout ser escrito antes de sair.
  process.stdout.write("", () => process.exit(0));
}

// Sem isto, uma ANTHROPIC_API_KEY no ambiente faria o Claude Code cobrar da
// API em vez de usar a assinatura.
function subscriptionEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

// Uso real da conta, o mesmo do comando /usage do Claude Code (não gasta tokens).
// Devolve [{ name: "session", used: 25, resetsAt: <ms> }, ...] ou null.
function fetchPlanUsage() {
  return new Promise((resolve) => {
    const proc = spawn(
      CLAUDE_BIN,
      ["-p", "/usage", "--output-format", "json", "--safe-mode", "--no-session-persistence"],
      { cwd: WORK_DIR, env: subscriptionEnv(), windowsHide: true },
    );
    let out = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => (out += chunk));
    proc.on("error", () => resolve(null));
    proc.on("exit", () => {
      try {
        const text = JSON.parse(out).result ?? "";
        const windows = [...text.matchAll(/^Current (.+?): (\d+)% used(?: · resets (.+))?$/gm)].map((m) => ({
          name: m[1],
          used: Number(m[2]),
          resetsAt: parseReset((m[3] ?? "").replace(/\s*\(.*\)\s*$/, "")),
        }));
        if (!windows.length) log(`/usage sem dados reconhecíveis: ${text}`);
        resolve(windows.length ? windows : null);
      } catch (err) {
        log(`falha ao ler /usage: ${err.message} :: ${out}`);
        resolve(null);
      }
    });
  });
}

// ---------- Log de desenvolvimento ----------
// logs/requests.jsonl: tudo de cada pergunta (instruções, conteúdo, argumentos,
// eventos do Claude Code, uso, tempos). logs/resumo.txt: uma linha por pergunta.
// Imagens enviadas ficam em logs/<id>-imagem<N>.<ext>.
function startTrace(message, args, env) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const t0 = Date.now();
  const id = new Date(t0).toISOString().replace(/[:.]/g, "-");
  let firstTextAt = null;
  let textChunks = 0;
  let ended = false;
  const events = [];

  // Conteúdo como foi enviado; imagens viram arquivos (o base64 não cabe no log).
  const content = message.content.map((block, i) => {
    if (block.type !== "image") return { ...block, chars: block.text?.length };
    const ext = block.source.media_type.split("/")[1];
    const file = `${id}-imagem${i}.${ext}`;
    fs.writeFileSync(path.join(DEBUG_DIR, file), Buffer.from(block.source.data, "base64"));
    return { type: "image", media_type: block.source.media_type, file, base64Chars: block.source.data.length };
  });

  return {
    event(event) {
      const isText = event.type === "stream_event" && event.event?.delta?.type === "text_delta";
      if (isText) {
        textChunks++;
        firstTextAt ??= Date.now() - t0;
      } else {
        events.push({ ms: Date.now() - t0, ...event });
      }
    },
    end(extra) {
      if (ended) return;
      ended = true;
      const result = events.find((e) => e.type === "result");
      const entry = {
        id,
        time: new Date(t0).toISOString(),
        debug: message.debug, // modo, configurações, extração, uso antes (vem da extensão)
        request: {
          model: message.model,
          effort: message.effort,
          instructions: message.instructions,
          instructionsChars: message.instructions.length,
          content,
          args: args.map((a) => (a === message.instructions ? "<instructions>" : a)),
          envFlags: Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("CLAUDE_CODE_"))),
        },
        timing: { firstTextMs: firstTextAt, totalMs: Date.now() - t0, textChunks },
        result: result
          ? {
              text: result.result,
              stop_reason: result.stop_reason,
              // Custo a preço de lista calculado pelo Claude Code: a melhor medida
              // para comparar configurações (o % do /usage só muda de 1 em 1).
              total_cost_usd: result.total_cost_usd,
              usage: result.usage,
              modelUsage: result.modelUsage,
              duration_ms: result.duration_ms,
              duration_api_ms: result.duration_api_ms,
              num_turns: result.num_turns,
            }
          : null,
        events,
        ...extra,
      };
      fs.appendFileSync(path.join(DEBUG_DIR, "requests.jsonl"), JSON.stringify(entry) + "\n");
      fs.appendFileSync(path.join(DEBUG_DIR, "resumo.txt"), summaryLine(entry) + "\n");
    },
  };
}

function summaryLine(entry) {
  const u = entry.result?.usage ?? {};
  const d = entry.debug ?? {};
  const fresh = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const before = d.before ?? [];
  const usage = (entry.after ?? [])
    .map((w) => {
      const b = before.find((x) => x.name === w.name);
      return `${w.name === "session" ? "sessão" : "semana"} ${b ? `${b.used}→` : ""}${w.used}%`;
    })
    .join(", ");
  const extraction = d.extraction ?? {};
  const what =
    d.mode === "element"
      ? `texto ${extraction.chars} chars (bruto ${extraction.rawChars}, ${extraction.skipped} itens filtrados)`
      : `imagem ${extraction.final?.w}x${extraction.final?.h} ≈${extraction.imageTokens} tok (recorte ${extraction.crop?.w}x${extraction.crop?.h})`;
  return [
    entry.time.replace("T", " ").slice(0, 19),
    d.mode ?? "?",
    entry.result ? `custo $${(entry.result.total_cost_usd ?? 0).toFixed(5)}` : "",
    `${entry.request.model.replace("claude-", "")}/${entry.request.effort}`,
    `entrada ${fresh + (u.cache_read_input_tokens ?? 0)} (novos ${u.input_tokens ?? 0} + gravados ${u.cache_creation_input_tokens ?? 0} + cache ${u.cache_read_input_tokens ?? 0})`,
    `saída ${u.output_tokens ?? "?"} (raciocínio ${u.output_tokens_details?.thinking_tokens ?? "?"})`,
    what,
    usage,
    `${(entry.timing.totalMs / 1000).toFixed(1)}s`,
    entry.error ? `ERRO: ${entry.error}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

// Tipo do plano logado no Claude Code ("pro", "max"...), via `claude auth status`.
// Só esse campo é lido; nenhum dado da conta sai daqui.
function fetchPlanType() {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, ["auth", "status"], { cwd: WORK_DIR, env: subscriptionEnv(), windowsHide: true });
    let out = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => (out += chunk));
    proc.on("error", () => resolve(null));
    proc.on("exit", () => {
      try {
        resolve(JSON.parse(out).subscriptionType ?? null);
      } catch {
        resolve(null);
      }
    });
  });
}

// "Oct 22, 4:49am" (ou só "4:49am" = hoje), no fuso local -> data em milissegundos,
// para a extensão formatar no idioma escolhido. null se o formato for outro.
function parseReset(text) {
  const m = text.match(/^(?:([A-Z][a-z]{2}) (\d+), )?(\d+)(?::(\d+))?(am|pm)$/);
  if (!m) return null;
  const now = new Date();
  const month = m[1] ? "JanFebMarAprMayJunJulAugSepOctNovDec".indexOf(m[1]) / 3 : now.getMonth();
  const day = m[2] ? Number(m[2]) : now.getDate();
  const hour = (Number(m[3]) % 12) + (m[5] === "pm" ? 12 : 0);
  const date = new Date(now.getFullYear(), month, day, hour, Number(m[4] ?? 0));
  // Renovação em janeiro vista em dezembro: é do ano seguinte.
  if (date < now - 24 * 3600 * 1000) date.setFullYear(date.getFullYear() + 1);
  return date.getTime();
}

function handle(message) {
  if (message.type === "usage") {
    Promise.all([fetchPlanUsage(), fetchPlanType()]).then(([windows, plan]) => finish({ type: "usage", windows, plan }));
    return;
  }
  if (message.type !== "solve" || child) return;

  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools", "",
    "--safe-mode",
    "--no-session-persistence",
    // Sem nome, o Claude Code faz uma chamada extra ao Haiku (~1.200 tokens)
    // só para gerar um título para a sessão.
    "--name", "model-asker",
    "--system-prompt", message.instructions,
    "--model", message.model,
    "--effort", message.effort,
  ];

  // Desliga chamadas auxiliares do Claude Code que também consomem do plano, os
  // anexos automáticos de contexto que ele põe em cada mensagem (~25 tokens) e o
  // cache de prompt: cada pergunta é diferente e a parte fixa é pequena demais
  // para o cache, então nada era reaproveitado — e gravar no cache de 1 h custa
  // o dobro. Medido no Opus: $0.0068 -> $0.0036 por pergunta (-47%).
  const env = {
    ...subscriptionEnv(),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
    DISABLE_PROMPT_CACHING: "1",
  };
  const trace = message.debug ? startTrace(message, args, env) : null;
  child = spawn(CLAUDE_BIN, args, { cwd: WORK_DIR, env, windowsHide: true });

  let stdoutBuffer = "";
  let stderrText = "";
  let gotResult = false;
  let limits = null;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) onEvent(JSON.parse(line));
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderrText += chunk));

  child.on("error", (err) => {
    log(`falha ao iniciar ${CLAUDE_BIN}: ${err.message}`);
    trace?.end({ error: err.message });
    // Erros vão como códigos; a extensão traduz para o idioma escolhido.
    finish({ type: "error", code: "spawn", detail: err.message });
  });

  child.on("exit", (code) => {
    if (gotResult) return;
    log(`claude saiu com código ${code}: ${stderrText}`);
    trace?.end({ error: `código ${code}`, stderr: stderrText });
    finish({ type: "error", code: "exit", detail: stderrText.trim() || String(code) });
  });

  function onEvent(event) {
    trace?.event(event);
    if (event.type === "stream_event" && !event.parent_tool_use_id) {
      const delta = event.event?.delta;
      if (event.event.type === "content_block_delta" && delta?.type === "text_delta") {
        send({ type: "delta", text: delta.text });
      }
    } else if (event.type === "rate_limit_event") {
      // Reserva caso o /usage falhe: utilization vai de 0 a 1 em cada janela.
      const w = event.rate_limit_info?.unifiedWindows ?? {};
      limits = [
        ["session", w.five_hour],
        ["week (all models)", w.seven_day],
      ]
        .filter(([, win]) => win?.utilization != null)
        .map(([name, win]) => ({
          name,
          used: Math.round(win.utilization * 100),
          resetsAt: win.resetsAt ? win.resetsAt * 1000 : null,
        }));
    } else if (event.type === "result") {
      gotResult = true;
      if (event.is_error || event.subtype !== "success") {
        log(`erro do Claude Code: ${JSON.stringify(event)}`);
        trace?.end({ error: event.result });
        finish({ type: "error", code: "cli", detail: event.result || "" });
        return;
      }
      const u = event.usage ?? {};
      const truncated = event.stop_reason === "max_tokens";
      // Avisa na hora que a resposta acabou; o uso atualizado da conta vem logo depois.
      send({
        type: "done",
        truncated,
        usage: {
          input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          // Parte da entrada lida do cache: custa ~10% do normal.
          cached: u.cache_read_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          thinking: u.output_tokens_details?.thinking_tokens ?? 0,
          windows: limits,
          // Modelo(s) que realmente responderam (mais de um se houve fallback).
          models: Object.keys(event.modelUsage ?? {}),
        },
      });
      child.kill();
      fetchPlanUsage().then((windows) => {
        trace?.end({ after: windows ?? limits });
        finish({ type: "usage", windows: windows ?? limits });
      });
    }
  }

  child.stdin.end(
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: message.content, // blocos de imagem e/ou texto montados pela extensão
      },
    }) + "\n",
  );
}
