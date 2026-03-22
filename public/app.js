const authView = document.getElementById("auth-view");
const appView = document.getElementById("app-view");
const registerForm = document.getElementById("register-form");
const loginForm = document.getElementById("login-form");
const settingsForm = document.getElementById("settings-form");
const secretForm = document.getElementById("secret-form");
const uploadForm = document.getElementById("upload-form");
const previewForm = document.getElementById("preview-form");
const logoutBtn = document.getElementById("logout-btn");
const settingsStatus = document.getElementById("settings-status");
const secretStatus = document.getElementById("secret-status");
const uploadStatus = document.getElementById("upload-status");
const documentsNode = document.getElementById("documents");
const docCountNode = document.getElementById("doc-count");
const previewOutput = document.getElementById("preview-output");
const previewMeta = document.getElementById("preview-meta");
const workspaceName = document.getElementById("workspace-name");
const workspaceSubtitle = document.getElementById("workspace-subtitle");
const webhookUrlNode = document.getElementById("webhook-url");
const openaiState = document.getElementById("openai-state");
const manychatState = document.getElementById("manychat-state");
const toast = document.getElementById("toast");

let currentWorkspace = null;

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => {
    toast.classList.add("hidden");
  }, 2500);
}

function setFormValues(form, values) {
  for (const [key, value] of Object.entries(values)) {
    const field = form.elements[key];
    if (!field) continue;

    if (field.type === "checkbox") {
      field.checked = Boolean(value);
    } else {
      field.value = value ?? "";
    }
  }
}

function settingsPayload() {
  const formData = new FormData(settingsForm);
  return {
    businessName: formData.get("businessName"),
    ownerName: formData.get("ownerName"),
    ownerLanguage: formData.get("ownerLanguage"),
    replyLanguage: formData.get("replyLanguage"),
    tone: formData.get("tone"),
    style: formData.get("style"),
    aiProvider: formData.get("aiProvider"),
    aiModel: formData.get("aiModel"),
    brandVoiceNotes: formData.get("brandVoiceNotes"),
    fallbackReply: formData.get("fallbackReply"),
    systemPrompt: formData.get("systemPrompt"),
    humanLikeMode: settingsForm.elements.humanLikeMode.checked,
    emojiMode: settingsForm.elements.emojiMode.checked,
    handoffEnabled: settingsForm.elements.handoffEnabled.checked
  };
}

function renderDocuments(documents) {
  docCountNode.textContent = `${documents.length} file${documents.length === 1 ? "" : "s"}`;
  documentsNode.innerHTML = "";

  if (documents.length === 0) {
    documentsNode.innerHTML = '<div class="doc-item"><span class="muted">No files uploaded in this workspace yet.</span></div>';
    return;
  }

  for (const doc of documents) {
    const item = document.createElement("div");
    item.className = "doc-item";
    item.innerHTML = `
      <strong>${doc.originalName}</strong>
      <div class="muted">Uploaded: ${new Date(doc.uploadedAt).toLocaleString()}</div>
      <div class="muted">Chunks indexed: ${doc.chunks}</div>
    `;
    documentsNode.appendChild(item);
  }
}

function renderWorkspace(data) {
  currentWorkspace = data.workspace;
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  setFormValues(settingsForm, data.workspace);
  workspaceName.textContent = data.workspace.businessName;
  workspaceSubtitle.textContent = `${data.workspace.ownerName} | ${data.workspace.replyLanguage} replies`;
  webhookUrlNode.textContent = `${window.location.origin}/api/manychat/webhook/${data.workspace.webhookToken}`;
  openaiState.textContent = data.workspace.hasOpenAiKey
    ? "OpenAI key saved on backend"
    : "OpenAI key not saved yet";
  manychatState.textContent = data.workspace.hasManychatApiKey
    ? "Manychat key saved on backend"
    : "Manychat key not saved yet";
  renderDocuments(data.documents || []);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {})
    },
    ...options
  });

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : null;

  if (!response.ok) {
    throw new Error(data?.error || "Request failed.");
  }

  return data;
}

async function refreshWorkspace() {
  const data = await api("/api/workspace");
  renderWorkspace(data);
}

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const formData = new FormData(registerForm);
    await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        fullName: formData.get("fullName"),
        email: formData.get("email"),
        password: formData.get("password")
      })
    });
    registerForm.reset();
    await refreshWorkspace();
    showToast("Account created");
  } catch (error) {
    showToast(error.message);
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const formData = new FormData(loginForm);
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: formData.get("email"),
        password: formData.get("password")
      })
    });
    loginForm.reset();
    await refreshWorkspace();
    showToast("Logged in");
  } catch (error) {
    showToast(error.message);
  }
});

logoutBtn.addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
  appView.classList.add("hidden");
  authView.classList.remove("hidden");
  showToast("Logged out");
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  settingsStatus.textContent = "Saving...";
  try {
    await api("/api/workspace/settings", {
      method: "POST",
      body: JSON.stringify(settingsPayload())
    });
    settingsStatus.textContent = "Saved";
    await refreshWorkspace();
    showToast("Settings saved");
  } catch (error) {
    settingsStatus.textContent = "Error";
    showToast(error.message);
  }
});

secretForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  secretStatus.textContent = "Saving...";
  try {
    const formData = new FormData(secretForm);
    await api("/api/workspace/secrets", {
      method: "POST",
      body: JSON.stringify({
        openAiApiKey: formData.get("openAiApiKey"),
        manychatApiKey: formData.get("manychatApiKey")
      })
    });
    secretForm.reset();
    secretStatus.textContent = "Saved";
    await refreshWorkspace();
    showToast("Keys saved securely");
  } catch (error) {
    secretStatus.textContent = "Error";
    showToast(error.message);
  }
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  uploadStatus.textContent = "Uploading...";
  try {
    const formData = new FormData(uploadForm);
    await api("/api/workspace/documents/upload", {
      method: "POST",
      body: formData
    });
    uploadForm.reset();
    uploadStatus.textContent = "Uploaded";
    await refreshWorkspace();
    showToast("Files uploaded");
  } catch (error) {
    uploadStatus.textContent = "Error";
    showToast(error.message);
  }
});

previewForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  previewOutput.textContent = "Generating reply...";
  previewMeta.textContent = "";
  try {
    const formData = new FormData(previewForm);
    const data = await api("/api/workspace/replies/preview", {
      method: "POST",
      body: JSON.stringify({ message: formData.get("message") })
    });
    previewOutput.textContent = data.reply;
    const sources = (data.relevantContext || []).map((item) => item.fileName).join(", ");
    previewMeta.textContent = `Intent: ${data.intent}${sources ? ` | Sources: ${sources}` : ""}`;
  } catch (error) {
    previewOutput.textContent = error.message;
  }
});

(async function init() {
  try {
    const session = await api("/api/auth/session");
    renderWorkspace({ workspace: session.workspace, documents: [] });
    await refreshWorkspace();
  } catch (_error) {
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
  }
})();
