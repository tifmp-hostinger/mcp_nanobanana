#!/usr/bin/env node
// Cowork Image MCP :: gerador de imagens generico (HTTP Streamable) + OAuth 2.1
// -----------------------------------------------------------------------------
// Servidor MCP remoto para gerar imagens de QUALQUER proporcao/uso (site, LP,
// social, thumbnails, fundos, etc.) usando o Gemini 2.5 Flash Image (nano banana).
// Compativel com Claude / Cowork como conector remoto (OAuth via UI propria).
// Devolve a imagem inline + uma URL publica em /files.
//
// Env: GEMINI_API_KEY (obrig.), PUBLIC_BASE_URL, AUTH_PASSWORD, OAUTH_DATA_DIR,
//      GEMINI_MODEL, PORT, IMAGES_OUT_DIR
// -----------------------------------------------------------------------------
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import sharp from "sharp";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installOAuth } from "./oauth.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-image";
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const OUT_DIR = process.env.IMAGES_OUT_DIR ? path.resolve(process.env.IMAGES_OUT_DIR) : path.resolve(SCRIPT_DIR, "imagens-geradas");

// Proporcoes que o modelo gera bem. Qualquer largura/altura e mapeada p/ a mais proxima.
const GEN_RATIOS = { "1:1":1, "3:2":1.5, "2:3":0.6667, "4:3":1.3333, "3:4":0.75, "16:9":1.7778, "9:16":0.5625, "4:5":0.8, "5:4":1.25, "21:9":2.3333, "9:21":0.4286 };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));
function nearestRatio(w, h) {
  const t = w / h; let best = "1:1", bd = Infinity;
  for (const [k, v] of Object.entries(GEN_RATIOS)) { const d = Math.abs(v - t); if (d < bd) { bd = d; best = k; } }
  return best;
}
function dimsFromRatio(ratio, longSide = 1280) {
  const [a, b] = ratio.split(":").map(Number);
  return a >= b ? { w: longSide, h: Math.round(longSide * b / a) } : { w: Math.round(longSide * a / b), h: longSide };
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return { r: 255, g: 255, b: 255, alpha: 1 };
  const n = parseInt(m[1], 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, alpha: 1 };
}
const NO_TEXT = "Do not render any text, letters, words, numbers, captions, watermark or logo in the image.";

async function gerarImagemGemini(prompt, aspectRatio) {
  if (!API_KEY) throw new Error("GEMINI_API_KEY nao configurada nas variaveis de ambiente.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio } } };
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!resp.ok) { const d = await resp.text().catch(() => ""); throw new Error(`Gemini respondeu ${resp.status}: ${d.slice(0, 400)}`); }
  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p) => p.inlineData?.data);
  if (!img) throw new Error(`Nenhuma imagem retornada (${data?.candidates?.[0]?.finishReason || "sem imagem"}).`);
  return Buffer.from(img.inlineData.data, "base64");
}

function construirServidorMcp(baseUrl) {
  const server = new McpServer({ name: "cowork-image", version: "1.0.0" });
  server.tool(
    "gerar_imagem",
    "Gera uma imagem a partir de um texto, em QUALQUER proporcao/dimensao, para qualquer uso (site/hero, landing page, post social, story, thumbnail, banner, fundo, etc.) usando o Gemini 2.5 Flash Image. Devolve a imagem inline e uma URL publica. Escolha a proporcao pelo uso (16:9 hero de site, 1:1 post, 9:16 story/reels, 4:5 feed, 21:9 banner largo) ou informe largura/altura exatas em px.",
    {
      prompt: z.string().describe("Descricao do que gerar (em ingles costuma render melhor). Ex.: 'a sleek product shot of a ceramic coffee mug on a marble table, soft daylight'."),
      proporcao: z.enum(["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "4:5", "5:4", "21:9", "9:21"]).default("1:1").describe("Proporcao da imagem. Ignorada se largura+altura forem informadas."),
      largura: z.number().int().optional().describe("Largura exata em px (64-4096). Se informar, informe tambem altura."),
      altura: z.number().int().optional().describe("Altura exata em px (64-4096)."),
      estilo: z.string().optional().describe("Estilo visual livre. Ex.: 'fotografico', 'ilustracao flat', '3d render', 'minimalista', 'aquarela'."),
      evitar_texto: z.boolean().default(false).describe("Se true, instrui o modelo a NAO colocar texto/logo (util p/ fundos e banners onde o texto entra depois)."),
      ajuste: z.enum(["cover", "contain", "fill"]).default("cover").describe("Como encaixar na dimensao final: cover (preenche+corta), contain (cabe inteira, com fundo), fill (estica)."),
      fundo: z.string().optional().describe("Cor de fundo hex (ex.: '#FFFFFF') quando ajuste=contain. Default: transparente."),
      formato: z.enum(["png", "jpeg", "webp"]).default("png").describe("Formato do arquivo de saida."),
      nome_arquivo: z.string().optional().describe("Nome do arquivo sem extensao (opcional)."),
    },
    async ({ prompt, proporcao, largura, altura, estilo, evitar_texto, ajuste, fundo, formato, nome_arquivo }) => {
      try {
        let W, H, genRatio;
        if (largura && altura) { W = clamp(largura, 64, 4096); H = clamp(altura, 64, 4096); genRatio = nearestRatio(W, H); }
        else { genRatio = proporcao || "1:1"; ({ w: W, h: H } = dimsFromRatio(genRatio)); }

        const partes = [prompt.trim()];
        if (estilo) partes.push(`Style: ${estilo}.`);
        if (evitar_texto) partes.push(NO_TEXT);
        const promptFinal = partes.join(" ");

        const bruta = await gerarImagemGemini(promptFinal, genRatio);
        let pipe = sharp(bruta);
        if (ajuste === "contain") pipe = pipe.resize(W, H, { fit: "contain", background: fundo ? hexToRgb(fundo) : { r: 0, g: 0, b: 0, alpha: 0 } });
        else if (ajuste === "fill") pipe = pipe.resize(W, H, { fit: "fill" });
        else pipe = pipe.resize(W, H, { fit: "cover", position: "attention" });

        let ext = "png", mime = "image/png";
        if (formato === "jpeg") { pipe = pipe.jpeg({ quality: 90 }); ext = "jpg"; mime = "image/jpeg"; }
        else if (formato === "webp") { pipe = pipe.webp({ quality: 90 }); ext = "webp"; mime = "image/webp"; }
        else pipe = pipe.png();
        const buf = await pipe.toBuffer();

        await fs.mkdir(OUT_DIR, { recursive: true });
        const base = (nome_arquivo || "imagem").replace(/[^a-zA-Z0-9._-]/g, "-");
        const arquivo = `${base}-${randomUUID().slice(0, 6)}.${ext}`;
        await fs.writeFile(path.join(OUT_DIR, arquivo), buf);
        const publicUrl = `${baseUrl}/files/${arquivo}`;

        return {
          content: [
            { type: "image", data: buf.toString("base64"), mimeType: mime },
            { type: "text", text: `Imagem gerada.\nURL: ${publicUrl}\nDimensao: ${W}x${H} (${formato}) - proporcao de geracao: ${genRatio} - ajuste: ${ajuste}` },
          ],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Falha ao gerar imagem: ${err.message}` }] };
      }
    }
  );
  return server;
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/files", express.static(OUT_DIR, { maxAge: "1h" }));
app.get("/health", (_req, res) => res.json({ ok: true, model: MODEL, service: "cowork-image" }));

const { requireAuth } = await installOAuth(app);
const baseUrlDe = (req) => PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
const transports = {};

app.post("/mcp", requireAuth, async (req, res) => {
  try {
    const sid = req.headers["mcp-session-id"];
    let transport;
    if (sid && transports[sid]) { transport = transports[sid]; }
    else if (!sid && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => { transports[id] = transport; } });
      transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
      const server = construirServidorMcp(baseUrlDe(req));
      await server.connect(transport);
    } else {
      return res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Sem sessao valida (falta initialize)." }, id: null });
    }
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] erro:", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Erro interno." }, id: null });
  }
});
async function reqSessao(req, res) {
  const sid = req.headers["mcp-session-id"];
  if (!sid || !transports[sid]) return res.status(400).send("Sessao invalida ou ausente.");
  await transports[sid].handleRequest(req, res);
}
app.get("/mcp", requireAuth, reqSessao);
app.delete("/mcp", requireAuth, reqSessao);

app.listen(PORT, () => {
  console.log(`[cowork-image] HTTP na porta ${PORT} - modelo=${MODEL}`);
  console.log(`[cowork-image] saida=${OUT_DIR} - base=${PUBLIC_BASE_URL || "(auto)"}`);
  if (!API_KEY) console.warn("[cowork-image] AVISO: GEMINI_API_KEY nao definida - geracao vai falhar.");
});
