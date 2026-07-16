#!/usr/bin/env node
/**
 * FMP · Nano Banana MCP — versão REMOTA (HTTP)
 * ---------------------------------------------------------------------------
 * Mesma ferramenta `gerar_fundo` do servidor local, porém exposta por HTTP
 * (transporte Streamable HTTP do MCP, com sessão) para rodar num contêiner
 * (EasyPanel) e ficar acessível a vários usuários do Claude via URL + token.
 *
 * Diferenças em relação à versão stdio local:
 *   - Transporte HTTP em /mcp (POST inicializa/chama, GET faz o stream, DELETE encerra).
 *   - Sessão por cliente (header mcp-session-id) — handshake MCP padrão.
 *   - Autenticação por token (header Authorization: Bearer <ACCESS_TOKEN>).
 *   - A ferramenta devolve a IMAGEM inline (base64) E uma URL pública em
 *     /files/<arquivo>.png (o cliente escolhe o que usar).
 *
 * REGRA DE OURO (inalterada): gera SOMENTE o fundo. Nunca logo, texto ou marca.
 *
 * Variáveis de ambiente:
 *   GEMINI_API_KEY   (obrigatória)  chave do Google AI Studio
 *   ACCESS_TOKEN     (recomendada)  token que os clientes enviam para usar
 *   PUBLIC_BASE_URL  (recomendada)  ex.: https://nano.seudominio.com
 *   PORT             (opcional)     porta HTTP (default 8080)
 *   GEMINI_MODEL     (opcional)     default: gemini-2.5-flash-image
 *   FMP_BG_OUT_DIR   (opcional)     pasta de saída dos PNGs (default: ./fundos-gerados)
 * ---------------------------------------------------------------------------
 */

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

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-image";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
const PORT = Number(process.env.PORT || 8080);
const OUT_DIR = process.env.FMP_BG_OUT_DIR
  ? path.resolve(SCRIPT_DIR, process.env.FMP_BG_OUT_DIR)
  : path.resolve(SCRIPT_DIR, "fundos-gerados");

/* ---------------- Presets de formato (iguais ao servidor local) ------------- */
const FORMATOS = {
  capa_1280x720: { w: 1280, h: 720, ar: "16:9" },
  card_1280x720: { w: 1280, h: 720, ar: "16:9" },
  home_1200x400: { w: 1200, h: 400, ar: "16:9" },
};

const MODOS = {
  escuro:
    "Cinematic editorial photograph, deep near-black background (#0D0B0C), dramatic low-key lighting, " +
    "moody and sophisticated, subtle warm rim light, refined and prestigious atmosphere, shallow depth of field, " +
    "fine photographic grain. Keep the LEFT side quiet, darker and uncluttered as negative space.",
  creme:
    "Bright airy editorial photograph, warm cream/off-white ambience (#EFEEEA), soft natural daylight, " +
    "welcoming, human and optimistic, gentle contrast, clean and modern. " +
    "Keep the LEFT side calm and softly lit as negative space.",
  neutro:
    "Clean editorial photograph, balanced neutral tones, soft natural light, modern and professional, " +
    "shallow depth of field. Keep the LEFT side calm as negative space.",
};

const BRAND_SAFE =
  "ABSOLUTELY NO text, NO words, NO letters, NO numbers, NO captions, NO watermark, " +
  "NO logo, NO signage, NO UI, NO brand marks of any kind anywhere in the image. " +
  "Photographic background only, suitable to be placed BEHIND a separate branded overlay. " +
  "Leave generous empty/quiet negative space so a title can be overlaid on top. " +
  "No people looking at the camera, no busy foreground clutter.";

/* ---------------- Chamada ao Gemini (igual ao servidor local) --------------- */
async function gerarImagemGemini(prompt, aspectRatio) {
  if (!API_KEY) {
    throw new Error(
      "GEMINI_API_KEY não configurada no servidor. Defina-a nas variáveis de ambiente do EasyPanel."
    );
  }
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio } },
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detalhe = await resp.text().catch(() => "");
    throw new Error(`Gemini respondeu ${resp.status}: ${detalhe.slice(0, 500)}`);
  }
  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p.inlineData?.data);
  if (!imgPart) {
    const motivo = data?.candidates?.[0]?.finishReason || "sem imagem na resposta";
    throw new Error(`Nenhuma imagem retornada (${motivo}). Ajuste o prompt e tente de novo.`);
  }
  return Buffer.from(imgPart.inlineData.data, "base64");
}

/* ---------------- Fábrica do servidor MCP (uma instância por sessão) --------- */
function construirServidorMcp(baseUrl) {
  const server = new McpServer({ name: "fmp-nano-banana", version: "2.0.0" });

  server.tool(
    "gerar_fundo",
    "Gera uma IMAGEM DE FUNDO (bg) on-brand para uma arte do LXP da FMP usando o " +
      "Gemini 2.5 Flash Image (nano banana). Gera SOMENTE o fundo fotográfico — nunca " +
      "logo, texto ou marca (esses são compostos por cima pelo template). Devolve a " +
      "imagem PNG (inline) e uma URL pública para baixá-la.",
    {
      prompt: z
        .string()
        .describe(
          "Descrição da cena/fundo (em inglês funciona melhor). NÃO inclua pedidos de texto/logo."
        ),
      modo: z.enum(["escuro", "creme", "neutro"]).default("escuro")
        .describe("Modo visual: 'escuro' (prestígio), 'creme' (acolhedor), 'neutro' (fallback)."),
      formato: z.enum(["capa_1280x720", "card_1280x720", "home_1200x400"]).default("capa_1280x720")
        .describe("Preset de dimensão do LXP."),
      nome_arquivo: z.string().describe("Nome do arquivo de saída sem extensão. Ex.: 'eixo01-capa-bg'."),
      eixo: z.string().optional().describe("Eixo/contexto para registro (opcional)."),
    },
    async ({ prompt, modo, formato, nome_arquivo, eixo }) => {
      try {
        const fmt = FORMATOS[formato];
        const estilo = MODOS[modo] || MODOS.neutro;
        const promptFinal = [
          prompt.trim(),
          estilo,
          BRAND_SAFE,
          `Composition target: a ${fmt.w}x${fmt.h} background.`,
        ].join(" ");

        const bruta = await gerarImagemGemini(promptFinal, fmt.ar);
        const png = await sharp(bruta)
          .resize(fmt.w, fmt.h, { fit: "cover", position: "attention" })
          .png()
          .toBuffer();

        await fs.mkdir(OUT_DIR, { recursive: true });
        const base = nome_arquivo.replace(/[^a-zA-Z0-9._-]/g, "-");
        const arquivo = `${base}-${randomUUID().slice(0, 6)}.png`;
        await fs.writeFile(path.join(OUT_DIR, arquivo), png);

        const publicUrl = `${baseUrl}/files/${arquivo}`;
        return {
          content: [
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
            {
              type: "text",
              text:
                `Fundo gerado com sucesso.\n` +
                `URL: ${publicUrl}\n` +
                `Formato: ${formato} (${fmt.w}x${fmt.h}) · Modo: ${modo}${eixo ? ` · ${eixo}` : ""}\n` +
                `Lembrete: este PNG é SÓ o fundo. Componha a marca por cima no template.`,
            },
          ],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Falha ao gerar fundo: ${err.message}` }] };
      }
    }
  );

  return server;
}

/* ---------------- App HTTP -------------------------------------------------- */
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "8mb" }));

// PNGs gerados acessíveis por URL (só o fundo, sem marca)
app.use("/files", express.static(OUT_DIR, { maxAge: "1h" }));

// Healthcheck para o EasyPanel
app.get("/health", (_req, res) => res.json({ ok: true, model: MODEL }));


function autorizado(req) {
  if (!ACCESS_TOKEN) return true;
  const h = req.get("authorization") || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  const alt = req.get("x-api-key") || "";
  const q = (req.query.token || req.query.key || "").toString();
  return bearer === ACCESS_TOKEN || alt === ACCESS_TOKEN || q === ACCESS_TOKEN;
}
function baseUrlDe(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
}

function naoAutorizado(res) {
  return res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Não autorizado: token inválido ou ausente." },
    id: null,
  });
}

// Sessões vivas, indexadas por mcp-session-id
const transports = {};

app.post("/mcp", async (req, res) => {
  if (!autorizado(req)) return naoAutorizado(res);
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => { transports[sid] = transport; },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      const server = construirServidorMcp(baseUrlDe(req));
      await server.connect(transport);
    } else {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Requisição sem sessão válida (falta initialize)." },
        id: null,
      });
    }
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] erro:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Erro interno." }, id: null });
    }
  }
});

// GET (stream SSE) e DELETE (encerrar sessão) reutilizam a sessão existente
async function requisicaoDeSessao(req, res) {
  if (!autorizado(req)) return naoAutorizado(res);
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send("Sessão inválida ou ausente.");
  }
  await transports[sessionId].handleRequest(req, res);
}
app.get("/mcp", requisicaoDeSessao);
app.delete("/mcp", requisicaoDeSessao);

app.listen(PORT, () => {
  console.log(`[fmp-nano-banana] HTTP na porta ${PORT} · modelo=${MODEL}`);
  console.log(`[fmp-nano-banana] saída=${OUT_DIR}`);
  if (!ACCESS_TOKEN) console.warn("[fmp-nano-banana] AVISO: ACCESS_TOKEN não definido — servidor ABERTO.");
  if (!API_KEY) console.warn("[fmp-nano-banana] AVISO: GEMINI_API_KEY não definida — geração vai falhar.");
});
