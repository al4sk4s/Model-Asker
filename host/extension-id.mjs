// Calcula o ID da extensão a partir do campo "key" do manifest.json.
// (O ID é fixo graças a essa chave; o host só aceita conexões desse ID.)
import crypto from "node:crypto";
import fs from "node:fs";

const manifestUrl = new URL("../extension/manifest.json", import.meta.url);
const { key } = JSON.parse(fs.readFileSync(manifestUrl, "utf8"));
const hash = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest("hex");
const id = [...hash.slice(0, 32)].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("");
console.log(id);
