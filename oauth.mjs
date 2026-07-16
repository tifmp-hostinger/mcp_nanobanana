// oauth.mjs - Authorization Server OAuth 2.1 self-contido para o MCP.
// Tudo dentro do proprio projeto (sem provedor externo):
//   PRM, AS metadata, DCR, PKCE (S256), JWKS e validacao de Bearer.
// Login do humano: uma senha compartilhada (AUTH_PASSWORD), com UI integrada.
//
// Env:
//   PUBLIC_BASE_URL (obrigatoria)  ex.: https://host  -> vira o issuer
//   AUTH_PASSWORD   (obrigatoria)  senha para autorizar o consentimento
//   OAUTH_DATA_DIR  (recomendada)  pasta p/ persistir chave+clientes (use um VOLUME!)
//   TOKEN_TTL_SEC   (opcional)     validade do access token (default 3600)
import { SignJWT, jwtVerify, generateKeyPair, exportJWK, importJWK } from "jose";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const BASE = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const ISSUER = BASE;
const RESOURCE = BASE ? `${BASE}/mcp` : "";
const PASSWORD = process.env.AUTH_PASSWORD || "";
const TTL = Number(process.env.TOKEN_TTL_SEC || 3600);
const DATA_DIR = process.env.OAUTH_DATA_DIR ? path.resolve(process.env.OAUTH_DATA_DIR) : path.resolve(process.cwd(), "oauth-data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const KID = "fmp-1";

let privateKey = null, publicKey = null, publicJwk = null;
const clients = new Map();
const codes = new Map();
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest();

async function loadState() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    if (raw.privateJwk && raw.publicJwk) {
      privateKey = await importJWK(raw.privateJwk, "RS256");
      publicKey = await importJWK(raw.publicJwk, "RS256");
      publicJwk = raw.publicJwk;
    }
    for (const c of raw.clients || []) clients.set(c.client_id, c);
  } catch {}
  if (!privateKey) {
    const kp = await generateKeyPair("RS256", { extractable: true });
    privateKey = kp.privateKey; publicKey = kp.publicKey;
    publicJwk = await exportJWK(publicKey);
    publicJwk.kid = KID; publicJwk.alg = "RS256"; publicJwk.use = "sig";
    await persist();
  }
}
async function persist() {
  const privateJwk = await exportJWK(privateKey);
  await fs.writeFile(STATE_FILE, JSON.stringify({ privateJwk, publicJwk, clients: [...clients.values()] }));
}

function telaLogin(params, erro) {
  const hidden = Object.entries(params).map(([k, v]) => `<input type=hidden name="${k}" value="${(v || "").toString().replace(/"/g, "&quot;")}">`).join("");
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>FMP - Autorizar</title>
<body style="font-family:system-ui;background:#0D0B0C;color:#EFEEEA;display:grid;place-items:center;min-height:100vh;margin:0">
<form method=POST action="/authorize" style="background:#191818;padding:34px;border-radius:16px;width:330px;box-shadow:0 20px 60px rgba(0,0,0,.5)">
<div style="font-size:22px;font-weight:700;margin-bottom:4px">FMP <span style="color:#EE2A42">Nano Banana</span></div>
<p style="color:#BFBAA4;font-size:13.5px;line-height:1.5;margin:0 0 18px">Autorize o acesso do Claude ao gerador de fundos com IA.</p>
${erro ? `<p style="color:#EE2A42;font-size:13px;margin:0 0 12px">${erro}</p>` : ""}
${hidden}
<input name=password type=password placeholder="Senha de acesso" autofocus style="width:100%;padding:11px;border-radius:9px;border:1px solid #333;background:#0D0B0C;color:#fff;margin-bottom:14px;box-sizing:border-box">
<button style="width:100%;padding:11px;border:0;border-radius:999px;background:#EE2A42;color:#fff;font-weight:600;font-size:15px;cursor:pointer">Autorizar</button>
</form></body>`;
}
function challenge(req, res, invalido) {
  const prm = `${ISSUER}/.well-known/oauth-protected-resource`;
  res.set("WWW-Authenticate", `Bearer resource_metadata="${prm}"` + (invalido ? `, error="invalid_token"` : ""));
  return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Autenticacao OAuth necessaria." }, id: null });
}
async function emitirTokens(client_id, scope) {
  const now = Math.floor(Date.now() / 1000);
  const access = await new SignJWT({ scope, client_id }).setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER).setAudience(RESOURCE).setSubject("fmp").setIssuedAt(now).setExpirationTime(now + TTL).setJti(crypto.randomUUID()).sign(privateKey);
  const refresh = await new SignJWT({ scope, client_id, typ: "refresh" }).setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER).setAudience(`${ISSUER}/refresh`).setSubject("fmp").setIssuedAt(now).setExpirationTime(now + 60 * 60 * 24 * 30).sign(privateKey);
  return { access_token: access, token_type: "Bearer", expires_in: TTL, refresh_token: refresh, scope };
}

export async function installOAuth(app) {
  await loadState();
  if (!BASE) console.warn("[oauth] PUBLIC_BASE_URL nao definido.");
  if (!PASSWORD) console.warn("[oauth] AUTH_PASSWORD nao definido - ninguem consegue autorizar.");

  app.get("/.well-known/oauth-protected-resource", (req, res) =>
    res.json({ resource: RESOURCE, authorization_servers: [ISSUER], bearer_methods_supported: ["header"] }));
  const asMeta = (req, res) => res.json({
    issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
    registration_endpoint: `${ISSUER}/register`, jwks_uri: `${ISSUER}/.well-known/jwks.json`,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["mcp"],
  });
  app.get("/.well-known/oauth-authorization-server", asMeta);
  app.get("/.well-known/openid-configuration", asMeta);
  app.get("/.well-known/jwks.json", (req, res) => res.json({ keys: [publicJwk] }));

  app.post("/register", async (req, res) => {
    const b = req.body || {};
    const meta = {
      client_id: "c_" + crypto.randomBytes(16).toString("hex"),
      redirect_uris: Array.isArray(b.redirect_uris) ? b.redirect_uris : [],
      token_endpoint_auth_method: "none",
      grant_types: b.grant_types || ["authorization_code", "refresh_token"],
      response_types: b.response_types || ["code"], client_name: b.client_name || "MCP Client", scope: b.scope || "mcp",
    };
    clients.set(meta.client_id, meta); await persist(); res.status(201).json(meta);
  });

  app.get("/authorize", (req, res) => {
    const q = req.query; const client = clients.get(q.client_id);
    if (!client) return res.status(400).send("client_id desconhecido");
    if (!client.redirect_uris.includes(q.redirect_uri)) return res.status(400).send("redirect_uri invalido");
    if (q.code_challenge_method !== "S256" || !q.code_challenge) return res.status(400).send("PKCE S256 obrigatorio");
    res.type("html").send(telaLogin({ client_id: q.client_id, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, state: q.state || "", scope: q.scope || "mcp" }));
  });
  app.post("/authorize", (req, res) => {
    const b = req.body || {}; const client = clients.get(b.client_id);
    if (!client || !client.redirect_uris.includes(b.redirect_uri)) return res.status(400).send("cliente/redirect invalido");
    if (!PASSWORD || b.password !== PASSWORD) return res.type("html").status(401).send(telaLogin(b, "Senha incorreta."));
    const code = crypto.randomBytes(24).toString("hex");
    codes.set(code, { client_id: b.client_id, redirect_uri: b.redirect_uri, code_challenge: b.code_challenge, scope: b.scope || "mcp", expires: Date.now() + 60000 });
    const u = new URL(b.redirect_uri); u.searchParams.set("code", code); if (b.state) u.searchParams.set("state", b.state);
    res.redirect(u.toString());
  });
  app.post("/token", async (req, res) => {
    const b = req.body || {};
    try {
      if (b.grant_type === "authorization_code") {
        const rec = codes.get(b.code); codes.delete(b.code);
        if (!rec || rec.expires < Date.now()) return res.status(400).json({ error: "invalid_grant" });
        if (rec.client_id !== b.client_id || rec.redirect_uri !== b.redirect_uri) return res.status(400).json({ error: "invalid_grant" });
        if (b64url(sha256(b.code_verifier || "")) !== rec.code_challenge) return res.status(400).json({ error: "invalid_grant", error_description: "PKCE" });
        return res.json(await emitirTokens(rec.client_id, rec.scope));
      }
      if (b.grant_type === "refresh_token") {
        const { payload } = await jwtVerify(b.refresh_token, publicKey, { issuer: ISSUER, audience: `${ISSUER}/refresh` });
        return res.json(await emitirTokens(payload.client_id, payload.scope || "mcp"));
      }
      return res.status(400).json({ error: "unsupported_grant_type" });
    } catch { return res.status(400).json({ error: "invalid_grant" }); }
  });

  const requireAuth = async (req, res, next) => {
    try {
      const h = req.get("authorization") || "";
      if (!h.startsWith("Bearer ")) return challenge(req, res);
      const { payload } = await jwtVerify(h.slice(7).trim(), publicKey, { issuer: ISSUER, audience: RESOURCE });
      req.auth = payload; next();
    } catch { return challenge(req, res, true); }
  };
  return { requireAuth };
}
