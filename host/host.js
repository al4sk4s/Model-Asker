// Native Messaging host: o navegador inicia este processo e conversa com ele
// pelo stdin/stdout (cada mensagem = 4 bytes de tamanho + JSON).
// Ele repassa a imagem ao Claude Code (`claude -p`), que usa o login da sua
// assinatura Pro/Max, e devolve a resposta em pedaços para a extensão.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
// Pasta vazia para o Claude Code rodar sem pegar CLAUDE.md de nenhum projeto.
const WORK_DIR = path.join(os.tmpdir(), "claude-asker");
const LOG_FILE = path.join(WORK_DIR, "host.log");

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
// Devolve [{ name: "session", used: 25, resets: "Oct 22, 4:50am" }, ...] ou null.
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
          resets: toPortuguese((m[3] ?? "").replace(/\s*\(.*\)\s*$/, "")),
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

// "Oct 22, 4:49am" -> "22 out, 04:49" (mantém o texto original se o formato for outro).
function toPortuguese(text) {
  const months = { Jan: "jan", Feb: "fev", Mar: "mar", Apr: "abr", May: "mai", Jun: "jun",
    Jul: "jul", Aug: "ago", Sep: "set", Oct: "out", Nov: "nov", Dec: "dez" };
  const m = text.match(/^(?:([A-Z][a-z]{2}) (\d+), )?(\d+)(?::(\d+))?(am|pm)$/);
  if (!m) return text;
  const hour = (Number(m[3]) % 12) + (m[5] === "pm" ? 12 : 0);
  const time = `${String(hour).padStart(2, "0")}:${m[4] ?? "00"}`;
  return m[1] ? `${m[2]} ${months[m[1]] ?? m[1]}, ${time}` : `hoje, ${time}`;
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
    "--name", "claude-asker",
    "--system-prompt", message.instructions,
    "--model", message.model,
    "--effort", message.effort,
  ];

  // Desliga chamadas auxiliares do Claude Code que também consomem do plano, e os
  // anexos automáticos de contexto que ele põe em cada mensagem (~25 tokens).
  const env = {
    ...subscriptionEnv(),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
  };
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
    finish({ type: "error", message: `Não consegui iniciar o Claude Code (${err.message}). Rode host/install.ps1 de novo.` });
  });

  child.on("exit", (code) => {
    if (gotResult) return;
    log(`claude saiu com código ${code}: ${stderrText}`);
    finish({ type: "error", message: stderrText.trim() || `O Claude Code encerrou com código ${code}.` });
  });

  function onEvent(event) {
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
          resets: win.resetsAt ? new Date(win.resetsAt * 1000).toLocaleString("pt-BR") : "",
        }));
    } else if (event.type === "result") {
      gotResult = true;
      if (event.is_error || event.subtype !== "success") {
        log(`erro do Claude Code: ${JSON.stringify(event)}`);
        finish({ type: "error", message: event.result || "O Claude Code retornou um erro." });
        return;
      }
      const u = event.usage ?? {};
      const note = event.stop_reason === "max_tokens" ? "Resposta cortada (limite de tamanho atingido)." : undefined;
      // Avisa na hora que a resposta acabou; o uso atualizado da conta vem logo depois.
      send({
        type: "done",
        note,
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
      fetchPlanUsage().then((windows) => finish({ type: "usage", windows: windows ?? limits }));
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
