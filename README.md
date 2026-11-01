# 💌 Slowmail privado

Cartas digitais lentas para duas pessoas (Carlos e Amiga). Cada carta enviada demora um tempo aleatório (padrão: 1 a 3 dias) para ser entregue.

## Stack
- **Backend:** Node.js + Express + SQLite embutido do Node (`node:sqlite`, exige Node 22.13+)
- **Frontend:** HTML + CSS + JS puro (sem build)
- **Auth:** senha simples por pessoa + token assinado (HMAC)

## Rodar localmente
```bash
npm install
cp .env.example .env     # edite as senhas e o SESSION_SECRET
npm start                # http://localhost:3000
```

**Testar rápido:** no `.env`, use `MIN_HOURS=0.02` e `MAX_HOURS=0.05` (entrega em 1–3 minutos).

## Banco de dados
```sql
CREATE TABLE letters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender      TEXT NOT NULL CHECK (sender   IN ('Carlos','Amiga')),
  receiver    TEXT NOT NULL CHECK (receiver IN ('Carlos','Amiga')),
  content     TEXT NOT NULL,
  sent_at     TEXT NOT NULL,            -- ISO 8601 UTC
  deliver_at  TEXT NOT NULL,            -- ISO 8601 UTC
  is_read     INTEGER NOT NULL DEFAULT 0
);
```
A tabela é criada automaticamente na primeira execução.

## API
| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/login` | `{user, password}` → token |
| GET | `/api/status` | estado da tela principal (`ready` / `transit` / `compose`), **sem `content`** |
| POST | `/api/letters` | `{content}` → calcula `deliver_at` aleatório |
| GET | `/api/letters/:id` | só devolve `content` se `deliver_at <= agora` (senão 403) |
| GET | `/api/chest` | histórico de cartas já entregues e abertas |

## Publicar (Render)
1. Suba o projeto para um repositório no GitHub.
2. No Render: **New → Web Service**, build `npm install`, start `npm start`.
3. Configure as variáveis: `PASSWORD_CARLOS`, `PASSWORD_AMIGA`, `SESSION_SECRET`, `NODE_ENV=production`.
4. **Importante:** o disco do plano gratuito é efêmero, então o SQLite seria apagado a cada deploy/reinício. Para não perder cartas, adicione um *Persistent Disk* (plano pago) e defina `DB_PATH=/data/slowmail.db`. Alternativas gratuitas: Fly.io com volume, ou trocar o SQLite por Supabase/Postgres (a tabela é a mesma).

## Segurança (nível "duas pessoas")
- Senhas e segredo ficam em variáveis de ambiente, nunca no front.
- O texto da carta nunca é consultado antes do prazo (o endpoint de status nem seleciona `content`).
- Limite de tentativas de login e conteúdo sempre renderizado como texto (sem XSS).
- Use HTTPS em produção (Render já fornece).
