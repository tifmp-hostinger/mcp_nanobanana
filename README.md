# Cowork Image MCP — gerador de imagens generico (HTTP Streamable + OAuth 2.1)

Servidor MCP remoto para gerar imagens em **qualquer proporcao/uso** (site/hero, landing
page, post social, story, thumbnail, banner, fundo, etc.) com o **Gemini 2.5 Flash Image**.
Roda no **EasyPanel** e conecta no **Claude / Cowork** com **OAuth 2.1 integrado no
proprio projeto** (sem provedor externo).

Mesma base tecnica do projeto da LXP (HTTP Streamable + OAuth self-hosted), porem a
ferramenta e **generalista**: voce controla proporcao, dimensao, estilo, ajuste e formato.

## Ferramenta: `gerar_imagem`

| Parametro | Valores | Uso |
|---|---|---|
| `prompt` | texto (ingles rende melhor) | o que gerar |
| `proporcao` | 1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16, 4:5, 5:4, 21:9, 9:21 | forma da imagem |
| `largura` / `altura` | px (64-4096) | dimensao exata (ignora `proporcao`) |
| `estilo` | texto livre | ex.: fotografico, ilustracao flat, 3d, minimalista |
| `evitar_texto` | true/false | forca sem texto/logo (util p/ fundos) |
| `ajuste` | cover / contain / fill | como encaixar na dimensao final |
| `fundo` | hex (ex.: #FFFFFF) | cor de fundo quando `ajuste=contain` |
| `formato` | png / jpeg / webp | formato de saida |
| `nome_arquivo` | texto | nome do arquivo (opcional) |

Devolve a **imagem inline** + uma **URL publica** (`/files/...`).

### Guia rapido de proporcao por uso
- **16:9** hero de site / capa de video · **21:9** banner largo
- **1:1** post social · **4:5** feed vertical · **9:16** story / reels
- **3:2 / 2:3** landing page / cartaz · **4:3 / 3:4** cards
- ou informe `largura`+`altura` exatas (ex.: 1920x1080, 1080x1350).

## Deploy no EasyPanel

1. Suba esta pasta num repositorio GitHub.
2. EasyPanel → Create App → GitHub → build por **Dockerfile**, porta **8080**.
3. **Volume** persistente em `/app/oauth-data` (guarda a chave de assinatura).
4. **Environment** (veja `.env.example`): `GEMINI_API_KEY`, `PUBLIC_BASE_URL`,
   `AUTH_PASSWORD`, `OAUTH_DATA_DIR=/app/oauth-data`.
5. Deploy. Teste: `curl https://SEU_DOMINIO/health`.

## Conectar no Claude / Cowork

Conector personalizado → URL `https://SEU_DOMINIO/mcp` → autenticacao **OAuth**.
O Claude faz DCR + PKCE sozinho e abre a sua tela de senha (`AUTH_PASSWORD`).

## Seguranca
- `AUTH_PASSWORD` e o elo principal — use algo forte.
- Chave de assinatura (RS256) em `OAUTH_DATA_DIR` — mantenha o volume, nao commite.
- Codes single-use (60s), PKCE S256 obrigatorio. Geracao roda na SUA chave/billing.
