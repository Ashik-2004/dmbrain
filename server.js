require("dotenv").config();

const express = require("express");
const session = require("express-session");
const SQLiteStoreFactory = require("connect-sqlite3");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const XLSX = require("xlsx");
const { open } = require("sqlite");
const sqlite3 = require("sqlite3");

const app = express();
const SQLiteStore = SQLiteStoreFactory(session);

const port = Number(process.env.PORT || 3000);
const verifyToken = process.env.VERIFY_TOKEN || "dev-verify-token";
const pageAccessToken = process.env.PAGE_ACCESS_TOKEN;
const platformOpenAiApiKey = process.env.OPENAI_API_KEY || "";
const defaultOpenAiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const appSecret = process.env.APP_SECRET || "local-dev-secret-change-me";

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const uploadsDir = path.join(rootDir, "uploads");
const dbPath = path.join(dataDir, "app.db");
const sessionsPath = path.join(dataDir, "sessions.db");

const defaultWorkspaceSettings = {
  businessName: "My Business",
  ownerName: "Owner",
  ownerLanguage: "English",
  replyLanguage: "English",
  tone: "Warm and professional",
  style: "Short and natural",
  humanLikeMode: true,
  emojiMode: false,
  handoffEnabled: true,
  brandVoiceNotes: "Reply like a friendly team member, not a bot.",
  fallbackReply:
    "Thanks for your message. I am checking the details and will help you shortly.",
  systemPrompt:
    "Answer only using the business information provided. If something is unclear, ask one short follow-up question instead of inventing facts.",
  aiProvider: "openai",
  aiModel: defaultOpenAiModel
};

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(publicDir, { recursive: true });

const dbPromise = initializeDatabase();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: appSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 14
    },
    store: new SQLiteStore({ db: path.basename(sessionsPath), dir: path.dirname(sessionsPath) })
  })
);
app.use(express.static(publicDir));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "-");
    cb(null, `${Date.now()}-${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

function createWebhookToken() {
  return crypto.randomBytes(18).toString("hex");
}

function deriveKey() {
  return crypto.createHash("sha256").update(appSecret).digest();
}

function encryptSecret(value) {
  if (!value) {
    return "";
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptSecret(value) {
  if (!value) {
    return "";
  }

  const [ivHex, tagHex, encryptedHex] = value.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveKey(),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function splitIntoChunks(text, maxLength = 450) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return [];
  }

  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    const candidate = `${current} ${sentence}`.trim();
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    if (sentence.length <= maxLength) {
      current = sentence;
      continue;
    }

    for (let index = 0; index < sentence.length; index += maxLength) {
      chunks.push(sentence.slice(index, index + maxLength));
    }
    current = "";
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function parseFile(filePath, originalName) {
  const extension = path.extname(originalName).toLowerCase();

  if (extension === ".pdf") {
    const buffer = await fsp.readFile(filePath);
    const parsed = await pdfParse(buffer);
    return parsed.text || "";
  }

  if (extension === ".xlsx" || extension === ".xls") {
    const workbook = XLSX.readFile(filePath);
    return workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      return XLSX.utils.sheet_to_csv(sheet);
    }).join("\n\n");
  }

  if ([".csv", ".txt", ".md", ".json"].includes(extension)) {
    return fsp.readFile(filePath, "utf8");
  }

  return "";
}

function detectIntent(message, defaultProfile = "business") {
  const text = String(message || "").toLowerCase();

  if (["price", "pricing", "cost", "rate", "package"].some((item) => text.includes(item))) {
    return "pricing";
  }

  if (["book", "booking", "appointment", "schedule", "time"].some((item) => text.includes(item))) {
    return "booking";
  }

  if (["collab", "collaboration", "campaign", "brand", "influencer"].some((item) => text.includes(item))) {
    return "collab";
  }

  if (["help", "support", "issue", "problem"].some((item) => text.includes(item))) {
    return "support";
  }

  return defaultProfile === "influencer" ? "collab" : "general";
}

function scoreChunk(message, chunk) {
  const terms = String(message || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2);
  const target = String(chunk || "").toLowerCase();

  return terms.reduce((score, term) => score + (target.includes(term) ? 1 : 0), 0);
}

function getRelevantContext(message, documents) {
  const ranked = [];

  for (const document of documents) {
    const chunks = Array.isArray(document.chunks) ? document.chunks : [];
    for (const chunk of chunks) {
      const score = scoreChunk(message, chunk);
      if (score > 0) {
        ranked.push({ fileName: document.originalName, score, text: chunk });
      }
    }
  }

  ranked.sort((left, right) => right.score - left.score);
  return ranked.slice(0, 4);
}

function buildFallbackReply(message, settings, relevantContext) {
  const intent = detectIntent(message);
  const leadIn = settings.replyLanguage ? `Reply language: ${settings.replyLanguage}. ` : "";

  if (intent === "pricing") {
    return `${leadIn}Thanks for your interest. Please tell me which service or package you want, and I will share the right pricing details.`;
  }

  if (intent === "booking") {
    return `${leadIn}Happy to help with booking. Please send your preferred date and time, and I will check availability.`;
  }

  if (intent === "collab") {
    return `${leadIn}Thanks for reaching out. Please share your brand name, campaign goal, timeline, deliverables, and budget so we can review it properly.`;
  }

  if (relevantContext.length > 0) {
    return `${leadIn}${settings.fallbackReply} I found information related to ${relevantContext[0].fileName} and can guide you from there.`;
  }

  return `${leadIn}${settings.fallbackReply}`;
}

async function generateOpenAiReply(message, settings, relevantContext, apiKey) {
  const contextText = relevantContext
    .map((item, index) => `Source ${index + 1} (${item.fileName}): ${item.text}`)
    .join("\n\n");

  const payload = {
    model: settings.aiModel || defaultOpenAiModel,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: [
              settings.systemPrompt,
              `Business name: ${settings.businessName}`,
              `Owner language: ${settings.ownerLanguage}`,
              `Reply language: ${settings.replyLanguage}`,
              `Tone: ${settings.tone}`,
              `Style: ${settings.style}`,
              `Human-like mode: ${settings.humanLikeMode ? "on" : "off"}`,
              `Emoji mode: ${settings.emojiMode ? "on" : "off"}`,
              `Brand voice notes: ${settings.brandVoiceNotes}`,
              "Keep replies concise, natural, and useful.",
              "Do not mention prompts, files, or internal tools.",
              contextText ? `Business context:\n${contextText}` : "No uploaded business context was found."
            ].join("\n")
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Customer message: ${message}`
          }
        ]
      }
    ]
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${errorText}`);
  }

  const json = await response.json();
  const text = json.output_text?.trim();

  if (!text) {
    throw new Error("OpenAI did not return output_text.");
  }

  return text;
}

async function initializeDatabase() {
  const db = await open({ filename: dbPath, driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      business_name TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      owner_language TEXT NOT NULL,
      reply_language TEXT NOT NULL,
      tone TEXT NOT NULL,
      style TEXT NOT NULL,
      human_like_mode INTEGER NOT NULL,
      emoji_mode INTEGER NOT NULL,
      handoff_enabled INTEGER NOT NULL,
      brand_voice_notes TEXT NOT NULL,
      fallback_reply TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      ai_provider TEXT NOT NULL,
      ai_model TEXT NOT NULL,
      webhook_token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS workspace_secrets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL UNIQUE,
      openai_api_key_encrypted TEXT DEFAULT '',
      manychat_api_key_encrypted TEXT DEFAULT '',
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      extracted_text TEXT NOT NULL,
      chunks_json TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );
  `);

  return db;
}

async function createWorkspaceForUser(db, userId, fullName) {
  const now = new Date().toISOString();

  const result = await db.run(
    `INSERT INTO workspaces (
      user_id, business_name, owner_name, owner_language, reply_language, tone, style,
      human_like_mode, emoji_mode, handoff_enabled, brand_voice_notes, fallback_reply,
      system_prompt, ai_provider, ai_model, webhook_token, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      defaultWorkspaceSettings.businessName,
      fullName || defaultWorkspaceSettings.ownerName,
      defaultWorkspaceSettings.ownerLanguage,
      defaultWorkspaceSettings.replyLanguage,
      defaultWorkspaceSettings.tone,
      defaultWorkspaceSettings.style,
      defaultWorkspaceSettings.humanLikeMode ? 1 : 0,
      defaultWorkspaceSettings.emojiMode ? 1 : 0,
      defaultWorkspaceSettings.handoffEnabled ? 1 : 0,
      defaultWorkspaceSettings.brandVoiceNotes,
      defaultWorkspaceSettings.fallbackReply,
      defaultWorkspaceSettings.systemPrompt,
      defaultWorkspaceSettings.aiProvider,
      defaultWorkspaceSettings.aiModel,
      createWebhookToken(),
      now,
      now
    ]
  );

  await db.run(
    `INSERT INTO workspace_secrets (workspace_id, openai_api_key_encrypted, manychat_api_key_encrypted, updated_at)
     VALUES (?, '', '', ?)`,
    [result.lastID, now]
  );

  return result.lastID;
}

async function getUserByEmail(db, email) {
  return db.get(`SELECT * FROM users WHERE email = ?`, [String(email || "").trim().toLowerCase()]);
}

async function getWorkspaceByUserId(db, userId) {
  return db.get(`SELECT * FROM workspaces WHERE user_id = ?`, [userId]);
}

async function getWorkspaceByToken(db, token) {
  return db.get(`SELECT * FROM workspaces WHERE webhook_token = ?`, [token]);
}

function mapWorkspace(row) {
  return {
    id: row.id,
    businessName: row.business_name,
    ownerName: row.owner_name,
    ownerLanguage: row.owner_language,
    replyLanguage: row.reply_language,
    tone: row.tone,
    style: row.style,
    humanLikeMode: Boolean(row.human_like_mode),
    emojiMode: Boolean(row.emoji_mode),
    handoffEnabled: Boolean(row.handoff_enabled),
    brandVoiceNotes: row.brand_voice_notes,
    fallbackReply: row.fallback_reply,
    systemPrompt: row.system_prompt,
    aiProvider: row.ai_provider,
    aiModel: row.ai_model,
    webhookToken: row.webhook_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getWorkspaceSecrets(db, workspaceId) {
  return db.get(`SELECT * FROM workspace_secrets WHERE workspace_id = ?`, [workspaceId]);
}

async function getWorkspaceDocuments(db, workspaceId) {
  const rows = await db.all(
    `SELECT id, original_name, stored_name, mime_type, size, extracted_text, chunks_json, uploaded_at
     FROM documents WHERE workspace_id = ? ORDER BY uploaded_at DESC`,
    [workspaceId]
  );

  return rows.map((row) => ({
    id: row.id,
    originalName: row.original_name,
    storedName: row.stored_name,
    mimeType: row.mime_type,
    size: row.size,
    extractedText: row.extracted_text,
    chunks: JSON.parse(row.chunks_json || "[]"),
    uploadedAt: row.uploaded_at
  }));
}

async function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ ok: false, error: "Authentication required." });
  }

  const db = await dbPromise;
  const user = await db.get(`SELECT id, email, full_name FROM users WHERE id = ?`, [req.session.userId]);

  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ ok: false, error: "Session expired." });
  }

  const workspace = await getWorkspaceByUserId(db, user.id);
  req.currentUser = user;
  req.currentWorkspace = workspace;
  req.db = db;
  next();
}

async function buildWorkspaceReply(db, workspace, message) {
  const settings = mapWorkspace(workspace);
  const documents = await getWorkspaceDocuments(db, workspace.id);
  const relevantContext = getRelevantContext(message, documents);
  const secrets = await getWorkspaceSecrets(db, workspace.id);
  const workspaceOpenAiKey = decryptSecret(secrets?.openai_api_key_encrypted || "");
  const apiKey = workspaceOpenAiKey || platformOpenAiApiKey;
  let reply = buildFallbackReply(message, settings, relevantContext);

  if (settings.aiProvider === "openai" && apiKey) {
    try {
      reply = await generateOpenAiReply(message, settings, relevantContext, apiKey);
    } catch (error) {
      console.error("AI reply failed, falling back to template:", error.message);
    }
  }

  return {
    intent: detectIntent(message),
    reply,
    settings,
    relevantContext: relevantContext.map((item) => ({ fileName: item.fileName, score: item.score }))
  };
}

app.post("/api/auth/register", async (req, res) => {
  const db = await dbPromise;
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const fullName = String(req.body?.fullName || "").trim();

  if (!email || !password || !fullName) {
    return res.status(400).json({ ok: false, error: "Name, email, and password are required." });
  }

  if (password.length < 6) {
    return res.status(400).json({ ok: false, error: "Password must be at least 6 characters." });
  }

  const existingUser = await getUserByEmail(db, email);
  if (existingUser) {
    return res.status(409).json({ ok: false, error: "Email already registered." });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date().toISOString();
  const result = await db.run(
    `INSERT INTO users (email, password_hash, full_name, created_at) VALUES (?, ?, ?, ?)`,
    [email, passwordHash, fullName, now]
  );

  await createWorkspaceForUser(db, result.lastID, fullName);
  req.session.userId = result.lastID;
  res.json({ ok: true });
});

app.post("/api/auth/login", async (req, res) => {
  const db = await dbPromise;
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const user = await getUserByEmail(db, email);

  if (!user) {
    return res.status(401).json({ ok: false, error: "Invalid email or password." });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ ok: false, error: "Invalid email or password." });
  }

  req.session.userId = user.id;
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/auth/session", requireAuth, async (req, res) => {
  const secrets = await getWorkspaceSecrets(req.db, req.currentWorkspace.id);
  res.json({
    ok: true,
    user: {
      id: req.currentUser.id,
      email: req.currentUser.email,
      fullName: req.currentUser.full_name
    },
    workspace: {
      ...mapWorkspace(req.currentWorkspace),
      hasOpenAiKey: Boolean(secrets?.openai_api_key_encrypted),
      hasManychatApiKey: Boolean(secrets?.manychat_api_key_encrypted)
    }
  });
});

app.get("/api/workspace", requireAuth, async (req, res) => {
  const documents = await getWorkspaceDocuments(req.db, req.currentWorkspace.id);
  const secrets = await getWorkspaceSecrets(req.db, req.currentWorkspace.id);

  res.json({
    ok: true,
    workspace: {
      ...mapWorkspace(req.currentWorkspace),
      hasOpenAiKey: Boolean(secrets?.openai_api_key_encrypted),
      hasManychatApiKey: Boolean(secrets?.manychat_api_key_encrypted)
    },
    documents: documents.map((document) => ({
      id: document.id,
      originalName: document.originalName,
      uploadedAt: document.uploadedAt,
      size: document.size,
      chunks: document.chunks.length
    }))
  });
});

app.post("/api/workspace/settings", requireAuth, async (req, res) => {
  const payload = req.body || {};
  const now = new Date().toISOString();

  await req.db.run(
    `UPDATE workspaces SET
      business_name = ?, owner_name = ?, owner_language = ?, reply_language = ?, tone = ?, style = ?,
      human_like_mode = ?, emoji_mode = ?, handoff_enabled = ?, brand_voice_notes = ?, fallback_reply = ?,
      system_prompt = ?, ai_provider = ?, ai_model = ?, updated_at = ?
     WHERE id = ?`,
    [
      payload.businessName || defaultWorkspaceSettings.businessName,
      payload.ownerName || defaultWorkspaceSettings.ownerName,
      payload.ownerLanguage || defaultWorkspaceSettings.ownerLanguage,
      payload.replyLanguage || defaultWorkspaceSettings.replyLanguage,
      payload.tone || defaultWorkspaceSettings.tone,
      payload.style || defaultWorkspaceSettings.style,
      normalizeBoolean(payload.humanLikeMode) ? 1 : 0,
      normalizeBoolean(payload.emojiMode) ? 1 : 0,
      normalizeBoolean(payload.handoffEnabled) ? 1 : 0,
      payload.brandVoiceNotes || defaultWorkspaceSettings.brandVoiceNotes,
      payload.fallbackReply || defaultWorkspaceSettings.fallbackReply,
      payload.systemPrompt || defaultWorkspaceSettings.systemPrompt,
      payload.aiProvider || defaultWorkspaceSettings.aiProvider,
      payload.aiModel || defaultWorkspaceSettings.aiModel,
      now,
      req.currentWorkspace.id
    ]
  );

  res.json({ ok: true });
});

app.post("/api/workspace/secrets", requireAuth, async (req, res) => {
  const openAiApiKey = String(req.body?.openAiApiKey || "").trim();
  const manychatApiKey = String(req.body?.manychatApiKey || "").trim();
  const now = new Date().toISOString();

  const current = await getWorkspaceSecrets(req.db, req.currentWorkspace.id);
  const nextOpenAi = openAiApiKey ? encryptSecret(openAiApiKey) : current?.openai_api_key_encrypted || "";
  const nextManychat = manychatApiKey ? encryptSecret(manychatApiKey) : current?.manychat_api_key_encrypted || "";

  await req.db.run(
    `UPDATE workspace_secrets SET openai_api_key_encrypted = ?, manychat_api_key_encrypted = ?, updated_at = ? WHERE workspace_id = ?`,
    [nextOpenAi, nextManychat, now, req.currentWorkspace.id]
  );

  res.json({ ok: true });
});

app.post("/api/workspace/documents/upload", requireAuth, upload.array("files", 10), async (req, res) => {
  const files = req.files || [];

  if (files.length === 0) {
    return res.status(400).json({ ok: false, error: "No files uploaded." });
  }

  const saved = [];

  for (const file of files) {
    try {
      const extractedText = await parseFile(file.path, file.originalname);
      const chunks = splitIntoChunks(extractedText);
      const uploadedAt = new Date().toISOString();
      const result = await req.db.run(
        `INSERT INTO documents (workspace_id, original_name, stored_name, mime_type, size, extracted_text, chunks_json, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.currentWorkspace.id,
          file.originalname,
          path.basename(file.path),
          file.mimetype,
          file.size,
          extractedText,
          JSON.stringify(chunks),
          uploadedAt
        ]
      );

      saved.push({ id: result.lastID, originalName: file.originalname, uploadedAt, chunks: chunks.length });
    } catch (error) {
      console.error(`Failed to process ${file.originalname}:`, error.message);
    }
  }

  res.json({ ok: true, documents: saved });
});

app.post("/api/workspace/replies/preview", requireAuth, async (req, res) => {
  const message = String(req.body?.message || "").trim();

  if (!message) {
    return res.status(400).json({ ok: false, error: "Message is required." });
  }

  const result = await buildWorkspaceReply(req.db, req.currentWorkspace, message);
  res.json({ ok: true, ...result });
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verifyToken) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/api/manychat/webhook/:token", async (req, res) => {
  const db = await dbPromise;
  const workspace = await getWorkspaceByToken(db, req.params.token);

  if (!workspace) {
    return res.status(404).json({ ok: false, error: "Workspace not found." });
  }

  const incomingMessage =
    req.body?.message ||
    req.body?.last_input_text ||
    req.body?.text ||
    req.body?.user_input ||
    "";

  if (!incomingMessage) {
    return res.status(400).json({ ok: false, error: "No incoming message found." });
  }

  const result = await buildWorkspaceReply(db, workspace, incomingMessage);
  res.json({
    ok: true,
    reply: result.reply,
    intent: result.intent,
    replyLanguage: result.settings.replyLanguage,
    sources: result.relevantContext
  });
});

app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object !== "instagram") {
    return res.sendStatus(404);
  }

  res.sendStatus(200);

  for (const entry of body.entry || []) {
    for (const messaging of entry.messaging || []) {
      const senderId = messaging.sender?.id;
      const text = messaging.message?.text;
      const isEcho = messaging.message?.is_echo;

      if (!senderId || !text || isEcho) {
        continue;
      }

      try {
        const db = await dbPromise;
        const workspace = await db.get(`SELECT * FROM workspaces ORDER BY id LIMIT 1`);
        if (!workspace) {
          continue;
        }

        const result = await buildWorkspaceReply(db, workspace, text);

        if (!pageAccessToken) {
          console.log("PAGE_ACCESS_TOKEN missing. Generated reply:", result.reply);
          continue;
        }

        await fetch(
          `https://graph.facebook.com/v23.0/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              recipient: { id: senderId },
              messaging_type: "RESPONSE",
              message: { text: result.reply }
            })
          }
        );
      } catch (error) {
        console.error("Failed to auto-reply:", error.message);
      }
    }
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
