# DM Brain Multi-User MVP

One hosted app for many businesses.

Each user gets:
- their own login
- one isolated workspace
- their own uploaded files
- their own reply language and tone settings
- encrypted AI and Manychat keys stored on the backend
- a unique Manychat webhook URL

## Run locally

1. Create `.env` from `.env.example`
2. Install packages:

```bash
npm install
```

3. Start the app:

```bash
npm run dev
```

4. Open:

```text
http://localhost:3000
```

## Deploy on Render

This project now includes [render.yaml](C:\Users\ANNMARIYA\Desktop\whatsinurdm\render.yaml) for a simple web service deploy.

1. Create a GitHub repository and push this project.
2. In Render, choose `New +` -> `Blueprint`.
3. Connect the GitHub repo.
4. Render will read `render.yaml` automatically.
5. Add real values for:
   - `VERIFY_TOKEN`
   - `PAGE_ACCESS_TOKEN`
   - `OPENAI_API_KEY`
6. Deploy.

After deploy, your app URL will look like:

```text
https://your-app-name.onrender.com
```

Your Manychat webhook URL will then be:

```text
https://your-app-name.onrender.com/api/manychat/webhook/<workspace-token>
```

Important limitation for free hosting:
- this app currently uses local SQLite and local uploads
- free hosting can be ephemeral or sleep when idle
- for real customers, move to Postgres and cloud file storage soon

## Current features

- registration and login
- SQLite database in `data/app.db`
- server-side sessions in `data/sessions.db`
- one workspace per user
- encrypted secret storage for OpenAI and Manychat keys
- document upload and parsing for PDF, XLSX, XLS, CSV, TXT, and JSON
- AI reply preview per workspace
- unique Manychat webhook per workspace

## Important routes

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/session`
- `GET /api/workspace`
- `POST /api/workspace/settings`
- `POST /api/workspace/secrets`
- `POST /api/workspace/documents/upload`
- `POST /api/workspace/replies/preview`
- `POST /api/manychat/webhook/:token`

## Secret handling

The frontend can submit secrets, but it never receives them back.
Only saved status is returned, such as whether an OpenAI key exists for that workspace.

## Manychat setup

Each logged-in workspace gets a webhook token.
Use the workspace-specific URL shown in the dashboard inside Manychat External Request.

Example request body:

```json
{
  "message": "What is your package price?"
}
```

Example response body:

```json
{
  "ok": true,
  "reply": "Thanks for your interest...",
  "intent": "pricing",
  "replyLanguage": "English",
  "sources": []
}
```

## What is still missing

- multiple team members per workspace
- billing and plans
- document delete/edit
- real Facebook and Instagram OAuth connection
- stronger role permissions
- production-grade audit logs
- cloud file storage
- managed Postgres for scale

## Recommended next step

Move from local SQLite and uploads to hosted Postgres and object storage once you begin onboarding real customers.
