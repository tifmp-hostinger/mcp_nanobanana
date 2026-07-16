# MCP nano banana — versão remota (HTTP) para EasyPanel

Servidor MCP da FMP que gera **imagens de fundo (bg)** do LXP com o **Gemini 2.5 Flash Image** (nano banana), agora exposto por **HTTP** para rodar num contêiner e ser usado por várias pessoas no Claude, via URL + token.

> **Regra de ouro (inalterada):** gera **só o fundo**. Nunca desenha logo, texto ou marca — esses entram por cima, no template, com os assets reais do design system.

A ferramenta continua sendo `gerar_fundo`. A diferença é que ela agora devolve a **imagem inline (PNG)** e uma **URL pública** (`/files/<arquivo>.png`), em vez de um caminho de disco local.

---

## 1. Como funciona (visão rápida)

```
Claude (você e outras pessoas)  ──HTTPS /mcp + token──▶  Contêiner no EasyPanel  ──▶  Gemini (nano banana)
                                                          devolve imagem inline + URL
```

- **Transporte:** Streamable HTTP em `POST /mcp` (stateless — uma sessão por requisição).
- **Autenticação:** header `Authorization: Bearer <ACCESS_TOKEN>`.
- **Saída:** imagem inline + `GET /files/<arquivo>.png`.
- **Healthcheck:** `GET /health`.

---

## 2. Subir no GitHub

Crie um repositório novo (ex.: `fmp-nano-banana-mcp`) e suba **apenas esta pasta** (`mcp-nano-banana-remote/`). Arquivos que entram no repo:

```
server.mjs
package.json
Dockerfile
.dockerignore
.env.example      ← exemplo, sem a chave real
README.md
```

⚠️ **Não** faça commit do `.env` real (com a chave). O `.gitignore`/`.dockerignore` já ignora `.env` e `fundos-gerados`.

Pelo terminal:

```bash
cd "mcp-nano-banana-remote"
git init
git add .
git commit -m "MCP nano banana remoto (HTTP)"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/fmp-nano-banana-mcp.git
git push -u origin main
```

---

## 3. Deploy no EasyPanel

1. **Create → App** e escolha **GitHub** como fonte; selecione o repositório e a branch `main`.
2. **Build:** selecione **Dockerfile** (o repo já traz um). Se o EasyPanel perguntar a porta, use **8080**.
3. **Environment** — adicione as variáveis (veja `.env.example`):
   - `GEMINI_API_KEY` = sua chave do Google AI Studio (com **billing ativo**).
   - `ACCESS_TOKEN` = um token secreto longo (gere algo aleatório).
   - `PUBLIC_BASE_URL` = a URL pública que o EasyPanel vai te dar (ex.: `https://nano.seudominio.com`). Preencha depois que o domínio existir e faça um redeploy.
   - (opcional) `GEMINI_MODEL`, `PORT`.
4. **Domains:** habilite um domínio (o EasyPanel provisiona HTTPS automaticamente). Anote a URL.
5. (Opcional, recomendado) **Volume persistente** montado em `/app/fundos-gerados` para os PNGs sobreviverem a redeploys.
6. **Deploy.** Quando subir, teste o healthcheck:
   ```bash
   curl https://SEU_DOMINIO/health
   # deve responder: {"ok":true,"model":"gemini-2.5-flash-image"}
   ```

---

## 4. Como cada pessoa conecta no Claude

No Claude (Configurações → Conectores → adicionar conector personalizado / MCP remoto):

- **URL:** `https://SEU_DOMINIO/mcp`
- **Autenticação / Header:** `Authorization: Bearer <ACCESS_TOKEN>`
  (informe o token que você definiu no EasyPanel; distribua só para quem autorizar.)

Depois de conectar, a ferramenta **`gerar_fundo`** aparece disponível na sessão, igual à versão local — só que agora rodando no servidor.

---

## 5. Teste rápido (linha de comando)

Listar as ferramentas (deve exigir o token):

```bash
curl -s https://SEU_DOMINIO/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer SEU_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Sem o token deve retornar **401 Não autorizado**.

---

## 6. Custos e segurança

- A geração de imagem do nano banana é **paga** (~US$0,04/imagem) e roda na **sua** chave — todo mundo com o token gasta o **seu** billing. Trate o `ACCESS_TOKEN` como senha e troque-o se vazar.
- Os PNGs em `/files` ficam **públicos** por URL (são só fundos, sem marca). Se quiser restringir, dá para colocar o `/files` atrás do mesmo token — me avise que eu ajusto.
- Rotacione a chave do Gemini periodicamente e monitore o uso no Google AI Studio.

---

## 7. Diferenças em relação ao servidor local (`../mcp-nano-banana`)

| | Local (stdio) | Remoto (HTTP) |
|---|---|---|
| Transporte | stdio | Streamable HTTP (`/mcp`) |
| Quem usa | só a sua máquina | qualquer pessoa com URL + token |
| Saída | caminho de arquivo no disco | imagem inline + URL pública |
| Auth | — | token Bearer |
| Deploy | roda local via `node` | contêiner Docker no EasyPanel |

O servidor local continua útil para uso individual. O remoto é para compartilhar com a equipe.
