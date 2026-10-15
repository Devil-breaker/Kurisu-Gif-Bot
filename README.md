# Kurisu Gif Bot

A high-performance Telegram bot that sends reaction GIFs (hug, kiss, pat, etc.) with custom captions and includes reverse image search for anime scenes/art. Built for free-tier hosting on Vercel (serverless) + Turso (libSQL).

## ✨ Features

- **Reaction Engine**: Commands like `/hug`, `/kiss`, `/pat` (as replies) send a random themed GIF with a caption like `Alice hugged Bob!`.
- **GIF Ingestion**: GIFs stored in a single private Telegram dump channel tagged with hashtags (`#hug #kiss`). Caption-free batch uploads via `/mode hug kiss` in PM; each upload is linked to every selected expression.
- **Reverse Image Search** (`/sauce`): Multi-provider lookup:
  - SauceNAO (anime art, requires free API key)
  - trace.moe (anime scene detection with title, episode, exact timestamps, AniList links)
  - Fallback links to Google Lens/Yandex for non-anime media
- **Dynamic Management**: Admins add/remove expressions (`/addexpression`, `/deleteexpression`, `/updatecaption`) without redeploying. Add admins by numeric ID or by replying to their message (`/addadmin`); remove them by numeric ID.
- **Lewd Mode (NSFW)**: Mark expressions as lewd (`/togglelewd`). Lewd commands stay hidden until a chat admin enables `/lewdmode on`. Never available in inline mode.
- **Per-Chat Controls**: Group admins can lock/disable specific commands (`/lock`, `/unlock`, `/locks`) and toggle bluetext mode (`/bluetextmode`) to auto-delete invoking commands and stop spam.
- **@username Targeting**: `/kiss @nero` works without replying — the bot sends the GIF with the caption mentioning the user.
- **Quality & Safety**: Comprehensive error handling, Telegram HTML escaping, and an automated test suite.
- **Free-Tier Only**: Runs on Vercel Hobby + Turso free plan. No paid services required.

## 🛠️ Setup

### Prerequisites
- Node.js ≥20
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- (Optional) SauceNAO API key (free at [saucenao.com](https://saucenao.com/account.php))
- (Optional) Turso account for production DB (local file SQLite works for dev)

### 1. Clone & Install
```bash
git clone <repo-url>
cd Kurisu-Gif-Bot
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env` and fill in:
```env
BOT_TOKEN=your_botfather_token_here
ADMIN_IDS=123456789,987654321   # comma-separated numeric user IDs

# Optional
DUMP_CHANNEL_ID=-1001234567890   # private channel ID (starts with -100)
WEBHOOK_SECRET=your_random_string_here
SAUCENAO_API_KEY=your_saucenao_key
TURSO_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your_turso_token
CHANNEL_EXPRESSION_MAP='[{"channel_id":-100111,"expression":"hug"}]'
```

### 3. Initialize Database
```bash
# Local dev (creates ./data/bot.db)
npm run db:migrate
# Seed default expressions (hug, kiss, pat, etc.)
npm run seed
```

## 🚀 Development

```bash
# Start bot in long-polling mode (uses .env)
npm run dev

# Run test suite
npm test

# Type-check
npm run typecheck

# Production build
npm run build
```

## ☁️ Deploy to Vercel with Turso

This project runs as a Vercel Node.js Function at `/webhook` and connects directly to Turso using `@libsql/client`. It does not use a local SQLite file in production. The database schema and default expressions must be migrated and seeded in Turso before the bot receives updates.

### 1. Create the production Turso database

Create a database in Turso, then copy its database URL and create a database auth token. With the Turso CLI, the commands are:

```text
turso auth login
turso db create kurisu-gif-bot
turso db show kurisu-gif-bot --url
turso db tokens create kurisu-gif-bot
```

Keep the URL and token private. The token is a secret with write access to the database.

### 2. Create and configure the Vercel project

In Vercel, choose **Add New → Project** and import `Devil-breaker/Kurisu-Gif-Bot`. Keep the project root at the repository root. Vercel detects the Node.js API function in `api/webhook.ts`; the existing `vercel.json` maps Telegram's `/webhook` URL to it and gives it up to 300 seconds.

Add these variables under **Project Settings → Environment Variables**, selecting **Production**:

| Variable | Required | Purpose |
| --- | --- | --- |
| `BOT_TOKEN` | Yes | Telegram token from BotFather |
| `ADMIN_IDS` | Yes | Comma-separated numeric bot admin IDs |
| `BOT_OWNER_ID` | No | Owner's numeric Telegram ID |
| `WEBHOOK_SECRET` | Yes | Random secret used to authenticate Telegram webhook requests |
| `TURSO_URL` | Yes | URL copied from `turso db show ... --url` |
| `TURSO_AUTH_TOKEN` | Yes | Token created for this Turso database |
| `DUMP_CHANNEL_ID` | If using channel uploads | Private dump channel ID; add the bot as a channel admin |
| `SAUCENAO_API_KEY` | No | Enables SauceNAO reverse search |
| `CHANNEL_EXPRESSION_MAP` | No | JSON mapping for additional dump channels |

For Preview deployments, use a separate test bot and Turso database. Reusing the production bot token can cause a preview deployment to compete with production for Telegram's single webhook URL.

### 3. Migrate and seed Turso once

The webhook does not run migrations automatically. Before first use, run the existing migration and seed commands with the production database credentials. In PowerShell, enter the values when prompted so the database token is not saved in shell history, then run:

```powershell
$env:TURSO_URL = Read-Host 'Turso database URL'
$secureToken = Read-Host 'Turso auth token' -AsSecureString
$env:TURSO_AUTH_TOKEN = [System.Net.NetworkCredential]::new('', $secureToken).Password
npm run db:migrate
npm run seed
Remove-Item Env:TURSO_URL
Remove-Item Env:TURSO_AUTH_TOKEN
Remove-Variable secureToken
```

Run these commands from the project root. They target the Turso database URL entered above, not the local SQLite file. The webhook intentionally does not migrate the schema automatically.

### 4. Deploy and register the Telegram webhook

Deploy from Vercel after saving the environment variables. Once the deployment is ready, copy its production domain and register `https://<production-domain>/webhook` as the bot's Telegram webhook. Set Telegram's webhook `secret_token` to the same value as `WEBHOOK_SECRET`; Telegram will send it in the header that `api/webhook.ts` checks. Confirm the result with Telegram's `getWebhookInfo` method and check Vercel Function logs if an update fails.

When the GitHub repository is connected to Vercel, pushes to its configured production branch deploy automatically. The Hobby plan's maximum function duration is 300 seconds, so unusually long reverse searches or admin batch operations can time out; regular GIF commands should return well within that limit.

## 💡 Usage

### Core Commands (reply to a user's message)
```
/hug       → Alice hugged Bob! 🤗
/kiss      → Alice kissed Bob! 💋
/pat       → Alice patted Bob! 🫶
/slap      → Alice slapped Bob! ✋
```
*(20+ expressions seeded by default – see `/listexpressions`)*

Or target by username without replying:
```
/kiss @nero → Alice kissed @nero! 💋
```

### Lewd Commands (NSFW)
Expressions flagged with `/togglelewd` only work when lewd mode is enabled in that chat. Media tagged `#lewd` is excluded from safe-mode picks:
```
/lewdmode yes|no|on|off|enable|disable   – toggle lewd mode (chat admin or bot admin in groups; anyone in PM)
/togglelewd <name>                       – bot admin: mark an expression as lewd/safe
```
- With lewd mode **off**, lewd commands refuse with a hint to enable `/lewdmode`.
- Lewd media is also excluded from random picks for safe expressions.
- **Inline mode is disabled entirely** — the bot refuses inline queries.

### Per-Chat Controls (group admins/owners)
```
/lock <cmd>       – disable a command in this chat (e.g. /lock slap)
/unlock <cmd>     – re-enable a locked command
/locks            – list locked commands
/bluetextmode on|off – when off, the bot deletes the invoking /command message after
                       sending the GIF (anti-"bluetext" spam)
```

### Utility Commands
```
/listexpressions  – list all available expressions (safe + lewd sections)
/stats            – usage GIF count per expression
/sauce            – reverse search on a replied GIF/video (anime scene/art)
```

### Admin Commands
```
/addexpression <name> [aliases...]   – add a new expression
/deleteexpression <name>             – delete an expression
/updatecaption <name> <template>     – edit caption template (use {from}/{to}/{action})
/addadmin <user_id>                  – promote a user to admin (or reply to their message)
/rmadmin <id>                        – remove an admin by numeric ID
/admins                              – list current admins
/linepack <LINE URL> [static|animated] – download the LINE pack ZIP privately
/linepackcreate <LINE URL> [emoji] [--recreate] | [pack name] – create named Telegram sticker/custom-emoji pack(s)
/mode <expr> [expr ...]              – tag caption-free GIF uploads with one or more expressions
/updatecaption <expr> <template>      – customize the reply caption for an expression command
/remove [N|all]                       – remove mistaken GIF uploads from the current batch
/rescan                              – re-index old dump-channel posts by forwarding them to the bot
/rescan relink                       – point database records to the surviving channel posts
/togglelewd <name>                   – mark an expression as lewd/safe
```

`/linepack` downloads the source ZIP; `/linepackcreate` is a separate choice that creates static Telegram pack(s) for the admin who runs it. Add `| Your Pack Name` to set Telegram’s visible pack title, for example `/linepackcreate https://store.line.me/stickershop/product/27642/en 🎉 | Spy Family Reactions`. Telegram accepts up to 50 stickers in each initial create call, then the bot automatically adds the rest in batches; regular packs hold up to 120 stickers and custom emoji packs up to 200. Larger LINE packs are split into numbered Telegram packs and created automatically in the same command. The progress message updates with a bar and the completion message lists each pack title and link. PNG alpha is retained when images are resized and padded. If Telegram reports an existing pack as complete but its link says it cannot be found, add `--recreate` before `|` (for example, `/linepackcreate <LINE URL> --recreate | My Pack`). This deletes the existing bot-created set before rebuilding it; do not use it to resume an incomplete pack. The Vercel webhook processes at most four images simultaneously and uses up to 270 seconds of the Hobby 300-second function window. If a pack exceeds one request’s time limit, rerun the command to resume from Telegram’s saved progress. Animated packs remain available through the ZIP command; no persistent Vercel file storage or paid service is used.

### GIF Ingestion (Admin Only)
1. Set one or more expressions: `/mode hug kiss` (in private chat with bot; `/mode hug` still works)
2. Upload GIFs/videos directly to the bot (private chat)
   - Bot stores each upload and tags it with all active expressions
   - Add `#lewd` in the caption to mark the media as lewd
   - To remove a mistaken upload before ending the batch, send `/remove` to list uploads, then `/remove N` for the numbered entry (or `/remove all`)
3. Customize the text shown when a reaction command sends a GIF with `/updatecaption <expression> <template>`. Templates support `{from}`, `{to}`, and `{action}`; for example, `/updatecaption smile {from} smiles.` The `/hug` and `/kiss` commands use their own templates even when the GIF is tagged for both.
4. Or upload to the dump channel (set `DUMP_CHANNEL_ID`):
   - Post GIF/video with caption `#hug` or `#hug #kiss` (multi-tag)
   - Add `#lewd` to mark the media as lewd
   - Bot extracts hashtags and links media to matching expressions
5. After a local database reset, run `/rescan` in a private chat and forward the existing dump-channel posts to the bot. Forward the original batch first, then any reuploaded batch. This restores media records, channel message IDs, and hashtag tags without reposting. Matching duplicate posts are queued so `/remove` can review them or `/remove all` can delete just those copies. If you deleted the indexed copy and kept another, run `/rescan relink` and forward only the posts you are keeping to update database references. The Bot API cannot scan channel history automatically.

### Reverse Image Search (`/sauce`)
Reply to any GIF, video, or image with `/sauce` to get:
- **trace.moe**: Anime scene title, episode, similarity %, timestamp, AniList link
- **SauceNAO**: Artwork title, author, similarity % (if API key configured)
- **Fallback**: Google Lens and Yandex search links

Results are cached by `file_unique_id` for 24h to protect free API quotas.

## 🧪 Testing

```bash
# Unit + integration tests
npm test

# Watch mode
npm run test:watch
```

Test coverage includes:
- Database queries (expressions, media, admins, search cache)
- Caption formatting & MarkdownV2 escaping
- FFmpeg frame extraction logic
- Config parsing & validation
- Bot command handlers

## 📦 Project Structure

```
src/
├── bot.ts          – grammY bot setup, middleware, command handlers
├── config.ts       – Zod schema + dotenv loader
├── dev.ts          – local entrypoint (npm run dev)
├── types/          – TypeScript interfaces
├── services/
│   ├── caption.ts  – escapeMdV2, formatCaption, formatTimestamp
│   ├── ffmpeg.ts   – bounded FFmpeg frame sampling
│   ├── saucenao.ts – SauceNAO API client
│   └── tracemoe.ts – trace.moe API client
├── db/
│   ├── client.ts   – libSQL singleton (Turso or file:)
│   ├── queries.ts  – all SQL queries (typed)
│   ├── migrate.ts  – run schema.sql
│   └── seed.ts     – insert 20 default expressions
└── api/
    └── webhook.ts  – Vercel serverless function
```

## ⚙️ How It Works

### Architecture
- **grammy** framework for Telegram Bot API
- **libSQL** (Turso) for durable SQLite (replaces in-memory for prod)
- **Database-backed state**: expressions, media, chat settings, and upload sessions live in SQLite locally or Turso
- **FFmpeg** via `ffmpeg-static` extracts full-res frames for accurate reverse search
- **Zod** validates env vars with preprocessing for empty-string → undefined

### Ingestion Flow
1. Admin sets `/mode hug kiss` (private chat; one or more expressions)
2. Admin uploads GIF → bot stores media and links it to both expressions
3. User sends `/hug` (reply to @Bob) → bot picks random GIF, sends with caption
   - `/hug` uses the `hug` caption template; `/kiss` uses the `kiss` template. Admins can customize each independently with `/updatecaption`.
4. Bot increments usage count for analytics

### Reverse Search Flow
1. User replies to media with `/sauce`
2. Bot checks cache by `file_unique_id` (24h TTL)
3. If miss: downloads file → extracts 3 frames (FFmpeg) → queries trace.moe + SauceNAO
4. Results formatted + cached, reply edited in-place

## 🔐 Security

- All user-provided data (names, captions) escaped for MarkdownV2
- Admin-only commands verified via `isAdmin()` DB check
- Webhook calls verified by `X-Telegram-Bot-Api-Secret-Token` header
- No secrets logged; errors return generic messages to users

## 📝 License

MIT – see [LICENSE](LICENSE) file.

---

**Enjoy spreading reactions!** Built with ❤️ on Vercel + Turso.
