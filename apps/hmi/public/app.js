import {
  actionTarget,
  errorPresentation,
  executionPresentation,
  humanizeIdentifier,
  vehiclePresentation,
} from "/ui-model.js";

const apiBase = "/api";
const $ = (id) => document.getElementById(id);
const progressOrder = ["understanding", "checking", "executing", "completed"];
let sessionId = localStorage.getItem("driveguard.sessionId");
let pendingAction = null;
let sending = false;
let healthTimer;
let urgentReconnectAttempt = 0;

class ApiRequestError extends Error {
  constructor(code, message, status = 0, retryAfter = null) {
    super(`${code}: ${message}`);
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function headers() {
  const bearerToken = $("bearer-token").value.trim();
  if (bearerToken) {
    return { "content-type": "application/json", authorization: `Bearer ${bearerToken}` };
  }
  return {
    "content-type": "application/json",
    "x-driveguard-user-id": $("user-id").value.trim(),
    "x-driveguard-vehicle-id": $("vehicle-id").value.trim(),
  };
}

function vehicleId() {
  return $("vehicle-id").value.trim();
}

function sessionQuery() {
  return `?vehicleId=${encodeURIComponent(vehicleId())}`;
}

async function parseApiFailure(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  throw new ApiRequestError(
    payload?.error?.code || (response.status === 502 ? "BACKEND_UNAVAILABLE" : "ERROR"),
    payload?.error?.message || "Request failed",
    response.status,
    response.headers.get("retry-after"),
  );
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: { ...headers(), ...(options.headers || {}) },
    });
  } catch {
    throw new ApiRequestError("BACKEND_UNAVAILABLE", "Backend connection failed");
  }
  if (!response.ok) await parseApiFailure(response);
  const payload = await response.json();
  return { data: payload.data, response };
}

function setConnection(state, label) {
  $("connection-badge").className = `status-badge is-${state}`;
  $("connection-label").textContent = label;
}

function setReadiness(state, label) {
  $("readiness-badge").className = `status-badge is-${state}`;
  $("readiness-label").textContent = label;
}

function setSession(id, identityBoundary) {
  sessionId = id;
  localStorage.setItem("driveguard.sessionId", id);
  $("session-id").textContent = id;
  if (identityBoundary) {
    $("identity-boundary").textContent =
      identityBoundary === "JWT_VERIFIED_PRINCIPAL"
        ? "Verified production identity"
        : "Development identity";
  }
}

function clearSession() {
  sessionId = null;
  localStorage.removeItem("driveguard.sessionId");
  $("session-id").textContent = "No active session";
}

function resetConversation() {
  $("conversation").replaceChildren();
  const empty = document.createElement("div");
  empty.id = "conversation-empty";
  empty.className = "conversation-empty";
  empty.innerHTML =
    '<div class="assistant-avatar large" aria-hidden="true">DG</div><h2>Session ready</h2><p>Your requests use the real DriveGuard API, policy, confirmation, and execution path.</p>';
  $("conversation").append(empty);
}

function appendMessage(role, content = "", isError = false, timestamp = new Date()) {
  $("conversation-empty")?.remove();
  const row = document.createElement("div");
  row.className = `message-row ${role}`;
  const messageContent = document.createElement("div");
  messageContent.className = "message-content";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("strong");
  author.textContent = role === "user" ? "You" : "DriveGuard";
  const time = document.createElement("span");
  time.textContent = timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.append(author, time);
  const node = document.createElement("p");
  node.className = `message${isError ? " is-error" : ""}`;
  node.textContent = content;
  messageContent.append(meta, node);
  if (role === "assistant") {
    const avatar = document.createElement("span");
    avatar.className = "message-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = "DG";
    row.append(avatar, messageContent);
  } else {
    row.append(messageContent);
  }
  $("conversation").append(row);
  $("conversation").scrollTop = $("conversation").scrollHeight;
  return node;
}

function setProgress(stage, outcome = "running") {
  $("run-progress").hidden = false;
  const currentIndex = progressOrder.indexOf(stage);
  for (const item of $("run-progress").querySelectorAll(".progress-item")) {
    const itemIndex = progressOrder.indexOf(item.dataset.stage);
    item.className = "progress-item";
    if (outcome === "failed" && itemIndex === currentIndex) item.classList.add("failed");
    else if (itemIndex < currentIndex || (stage === "completed" && outcome === "success")) {
      item.classList.add("done");
    } else if (itemIndex === currentIndex) item.classList.add("active");
  }
  const completedLabel = $("run-progress").querySelector(
    '[data-stage="completed"] span:last-child',
  );
  completedLabel.textContent = outcome === "failed" ? "Failed / Replan required" : "Completed";
}

function showAlert(error, retry = true) {
  const code = error instanceof ApiRequestError ? error.code : "BACKEND_UNAVAILABLE";
  const presentation = errorPresentation(code);
  delete $("global-alert").dataset.healthAlert;
  $("global-alert").className = `alert is-${presentation.tone}`;
  $("alert-title").textContent = presentation.title;
  $("alert-message").textContent = presentation.message;
  $("alert-retry").hidden = !retry || !presentation.retryable;
  $("global-alert").hidden = false;
}

function hideAlert() {
  $("global-alert").hidden = true;
  delete $("global-alert").dataset.healthAlert;
}

function setExecution(label, kind, value) {
  if (kind === "failure") setProgress("completed", "failed");
  else if (label === "Executing") setProgress("executing");
  else if (kind === "success") setProgress("completed", "success");
  if (value !== undefined) renderReceipt(value);
}

function setConfirmationStatus(status) {
  const normalized = status.toLowerCase();
  $("confirmation-panel").dataset.status = normalized;
  $("confirmation-status").className = `state-chip ${normalized}`;
  $("confirmation-status").textContent = humanizeIdentifier(normalized);
  const terminal = ["completed", "failed", "rejected", "cancelled"].includes(normalized);
  $("confirm-action").hidden = terminal;
  $("reject-action").hidden = terminal;
}

function showAction(data) {
  pendingAction = data;
  $("confirmation-panel").hidden = false;
  $("action-risk").textContent = data.risk_level;
  $("action-tool").textContent = humanizeIdentifier(data.tool);
  $("action-target").textContent = actionTarget(data.parameters);
  $("action-summary").textContent = data.summary || "Policy requires explicit confirmation.";
  $("action-expiry").textContent = `Expires ${new Date(data.expires_at).toLocaleString()}`;
  $("confirm-action").hidden = false;
  $("reject-action").hidden = false;
  $("confirm-action").disabled = false;
  $("reject-action").disabled = false;
  setConfirmationStatus("pending");
  setProgress("checking");
}

function clearAction() {
  pendingAction = null;
  $("confirmation-panel").hidden = true;
}

function renderReceipt(execution) {
  const view = executionPresentation(execution);
  $("receipt-panel").hidden = false;
  $("receipt-status").className = `state-chip ${view.cssClass}`;
  $("receipt-status").textContent = view.label;
  const fields = [
    ["Execution", execution.executionId ?? "—"],
    ["Attempts", execution.attemptCount ?? execution.attempts?.length ?? "—"],
    ["Deduplicated", execution.deduplicated === true ? "Yes" : "No"],
  ];
  $("receipt-details").replaceChildren(
    ...fields.map(([label, value]) => {
      const item = document.createElement("div");
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      term.textContent = label;
      detail.textContent = String(value);
      item.append(term, detail);
      return item;
    }),
  );
  $("result").textContent = JSON.stringify(execution, null, 2);
}

function applyEvent(event, assistant) {
  const data = event.data || {};
  switch (event.event_type) {
    case "run.started":
      setProgress("understanding");
      break;
    case "assistant.delta":
      assistant.textContent += data.delta || "";
      break;
    case "tool.requested":
      setProgress("checking");
      break;
    case "policy.decision":
      setProgress(data.decision === "ALLOW" ? "checking" : "checking");
      break;
    case "confirmation.required":
      showAction(data);
      break;
    case "tool.completed":
      if (data.is_error) setExecution("Failed", "failure");
      else setProgress("checking");
      break;
    case "assistant.completed":
      if (!assistant.textContent) assistant.textContent = data.response || "Request completed.";
      if (data.status === "completed") setExecution("Completed", "success");
      break;
    case "run.failed":
      if (data.code === "POLICY_REPLAN_REQUIRED" || data.code === "REPLAN_REQUIRED") {
        setExecution("Replan required", "failure");
      } else if (data.code === "ACTION_EXPIRED") {
        setExecution("Expired", "failure");
      } else {
        setExecution("Failed", "failure");
      }
      showAlert(new ApiRequestError(data.code || "ERROR", "Run failed safely"));
      break;
    case "urgent.received":
    case "urgent.action_required":
    case "urgent.confirmation_required":
    case "urgent.resolved":
    case "urgent.failed":
      applyUrgentEvent(event);
      break;
  }
}

function addUrgentItem(label) {
  $("urgent-events").querySelector(".empty-state")?.remove();
  const item = document.createElement("li");
  item.textContent = label;
  $("urgent-events").prepend(item);
  while ($("urgent-events").children.length > 5) $("urgent-events").lastElementChild.remove();
}

function applyUrgentEvent(event) {
  const data = event.data || {};
  addUrgentItem(
    `${data.severity || "UNKNOWN"} · ${data.status || data.event_type || "RECEIVED"} — ${data.summary || "Validated vehicle event"}`,
  );
  if (event.event_type === "urgent.confirmation_required") showAction(data);
  if (event.event_type === "urgent.failed")
    showAlert(new ApiRequestError("POLICY_DENIED", "Urgent action blocked"));
}

async function readSse(response, assistant) {
  if (!response.ok) await parseApiFailure(response);
  if (!response.body) throw new ApiRequestError("BACKEND_UNAVAILABLE", "Streaming is unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) applyEvent(JSON.parse(dataLine.slice(6)), assistant);
    }
  }
}

async function createSession() {
  hideAlert();
  const { data: session } = await request("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ vehicleId: vehicleId() }),
  });
  setSession(session.sessionId, session.identityBoundary);
  resetConversation();
  clearAction();
  $("receipt-panel").hidden = true;
  return session;
}

async function restoreSession() {
  if (!sessionId) throw new ApiRequestError("SESSION_NOT_FOUND", "No saved session to restore");
  const { data: session } = await request(
    `/v1/sessions/${encodeURIComponent(sessionId)}${sessionQuery()}`,
  );
  setSession(session.sessionId, session.identityBoundary);
  $("conversation").replaceChildren();
  for (const message of session.messages)
    appendMessage(message.role, message.content, false, new Date(session.updatedAt));
  if (session.messages.length === 0) resetConversation();
  hideAlert();
}

async function sendMessage(event) {
  event.preventDefault();
  if (sending) return;
  const prompt = $("message").value.trim();
  if (!prompt) return;
  if (!sessionId) await createSession();
  sending = true;
  $("send-message").disabled = true;
  appendMessage("user", prompt);
  const assistant = appendMessage("assistant");
  $("message").value = "";
  resizeComposer();
  clearAction();
  $("receipt-panel").hidden = true;
  hideAlert();
  setProgress("understanding");
  try {
    const response = await fetch(
      `${apiBase}/v1/sessions/${encodeURIComponent(sessionId)}/messages/stream${sessionQuery()}`,
      { method: "POST", headers: headers(), body: JSON.stringify({ prompt }) },
    );
    await readSse(response, assistant);
    if (!assistant.textContent)
      assistant.textContent = "DriveGuard completed the request without a display message.";
    await refreshVehicle({ quiet: true });
  } catch (error) {
    const presentation = errorPresentation(
      error instanceof ApiRequestError ? error.code : "BACKEND_UNAVAILABLE",
    );
    assistant.textContent = presentation.message;
    assistant.classList.add("is-error");
    setExecution("Failed", "failure");
    showAlert(error);
  } finally {
    sending = false;
    $("send-message").disabled = false;
  }
}

async function decide(operation) {
  if (!pendingAction) return;
  const action = pendingAction;
  const actionSessionId = action.session_id || sessionId;
  if (!actionSessionId) return;
  $("confirm-action").disabled = true;
  $("reject-action").disabled = true;
  hideAlert();
  try {
    if (operation === "confirm") {
      setConfirmationStatus("confirmed");
      setProgress("executing");
      setConfirmationStatus("executing");
      setExecution("Executing", "running");
      const { data } = await request(
        `/v1/actions/${encodeURIComponent(action.action_id)}/confirm`,
        {
          method: "POST",
          body: JSON.stringify({
            sessionId: actionSessionId,
            confirmationCredential: action.confirmation_credential,
            vehicleId: vehicleId(),
          }),
        },
      );
      const execution = executionPresentation(data.execution);
      setConfirmationStatus(execution.successful ? "completed" : "failed");
      setExecution(
        data.execution.status,
        execution.successful ? "success" : "failure",
        data.execution,
      );
    } else {
      const { data } = await request(`/v1/actions/${encodeURIComponent(action.action_id)}/reject`, {
        method: "POST",
        body: JSON.stringify({ sessionId: actionSessionId, vehicleId: vehicleId() }),
      });
      setConfirmationStatus("cancelled");
      setProgress("completed", "failed");
      renderReceipt({ ...data, status: data.state ?? "CANCELLED" });
    }
    pendingAction = null;
    await refreshVehicle({ quiet: true });
  } catch (error) {
    const code = error instanceof ApiRequestError ? error.code : "BACKEND_UNAVAILABLE";
    const label =
      code === "ACTION_EXPIRED"
        ? "Expired"
        : code === "REPLAN_REQUIRED"
          ? "Replan required"
          : "Failed";
    setConfirmationStatus("failed");
    setExecution(label, "failure", { status: "FAILED", code });
    showAlert(error);
  } finally {
    $("confirm-action").disabled = false;
    $("reject-action").disabled = false;
  }
}

function renderVehicle(context) {
  const view = vehiclePresentation(context);
  $("vehicle-loading").hidden = true;
  $("vehicle-content").hidden = false;
  $("vehicle-speed").textContent = view.speed;
  $("vehicle-soc").textContent = view.soc === null ? "—%" : `${Math.round(view.soc)}%`;
  $("battery-level").style.width = `${view.soc ?? 0}%`;
  $("battery-level").classList.toggle("is-low", view.soc !== null && view.soc < 20);
  $("vehicle-range").textContent = view.range;
  $("vehicle-gear").textContent = view.gear;
  $("vehicle-mode").textContent = view.mode;
  $("cabin-temperature").textContent = view.cabin;
  $("outside-temperature").textContent = view.outside;
  $("trip-heading").textContent = view.destination;
  $("trip-distance").textContent = view.distance;
  $("trip-eta").textContent = view.eta;
  $("charging-heading").textContent = view.chargingState;
  $("charging-indicator").textContent = view.chargingFault
    ? "Fault"
    : view.chargingActive
      ? "Active"
      : "Idle";
  $("charging-indicator").className =
    `mini-status${view.chargingFault ? " is-fault" : view.chargingActive ? " is-active" : ""}`;
  $("context-snapshot").textContent = view.snapshot;
  $("vehicle-version").textContent = view.vehicleVersion;
  $("trip-version").textContent = view.tripVersion;
  $("context-updated").textContent = view.updatedAt
    ? new Date(view.updatedAt).toLocaleString()
    : "—";
}

async function refreshVehicle(options = {}) {
  if (!options.quiet) {
    $("vehicle-loading").hidden = false;
    $("vehicle-loading").className = "panel-state";
    $("vehicle-loading").innerHTML =
      '<span class="spinner" aria-hidden="true"></span><span>Refreshing vehicle state…</span>';
  }
  try {
    const { data } = await request(`/v1/context${sessionQuery()}`);
    renderVehicle(data);
    $("top-vehicle-id").textContent = data.vehicle.vehicleId;
  } catch (error) {
    if (!options.quiet) {
      $("vehicle-content").hidden = true;
      $("vehicle-loading").hidden = false;
      $("vehicle-loading").className = "panel-state is-error";
      $("vehicle-loading").textContent = errorPresentation(
        error instanceof ApiRequestError ? error.code : "BACKEND_UNAVAILABLE",
      ).message;
    }
    throw error;
  }
}

function renderDependencies(readiness) {
  const dependencies = readiness.dependencies ?? [];
  $("dependency-list").replaceChildren(
    ...dependencies.map((dependency) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      const status = document.createElement("strong");
      name.textContent = humanizeIdentifier(dependency.name);
      status.textContent = dependency.status;
      status.className = dependency.status === "up" ? "up" : "down";
      item.append(name, status);
      return item;
    }),
  );
  $("health-heading").textContent =
    readiness.status === "ready" ? "All systems ready" : "Service degraded";
}

async function checkHealth() {
  try {
    const live = await fetch(`${apiBase}/health/live`, { cache: "no-store" });
    if (!live.ok) throw new Error("liveness failed");
    setConnection("online", "Connected");
    const ready = await fetch(`${apiBase}/health/ready`, { cache: "no-store" });
    const readiness = await ready.json();
    renderDependencies(readiness);
    setReadiness(ready.ok ? "online" : "warning", ready.ok ? "Systems ready" : "Service degraded");
    if (ready.ok && $("global-alert").dataset.healthAlert === "true") hideAlert();
  } catch {
    setConnection("offline", "Backend unavailable");
    setReadiness("offline", "Readiness unknown");
    $("health-heading").textContent = "Backend unavailable";
    $("dependency-list").innerHTML =
      '<li><span>Backend</span><strong class="down">Down</strong></li>';
    if (!sending) {
      showAlert(new ApiRequestError("BACKEND_UNAVAILABLE", "Health check failed"));
      $("global-alert").dataset.healthAlert = "true";
    }
  }
}

async function loadUrgentHistory() {
  const { data: events } = await request("/v1/urgent-events");
  for (const event of [...events].reverse().slice(0, 5)) {
    addUrgentItem(`${event.severity} · ${event.status} — ${event.safeSummary}`);
  }
}

async function runUrgentStream() {
  while (true) {
    try {
      const response = await fetch(`${apiBase}/v1/urgent-events/stream`, { headers: headers() });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      urgentReconnectAttempt = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for (const frame of frames) {
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
          if (dataLine) applyUrgentEvent(JSON.parse(dataLine.slice(6)));
        }
      }
    } catch {
      urgentReconnectAttempt += 1;
      if (urgentReconnectAttempt === 1)
        addUrgentItem("Event stream disconnected; reconnecting safely.");
    }
    const delay = Math.min(2_000 * 2 ** Math.min(urgentReconnectAttempt, 3), 15_000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function resizeComposer() {
  $("message").style.height = "auto";
  $("message").style.height = `${Math.min($("message").scrollHeight, 150)}px`;
}

function applyIdentity() {
  clearSession();
  clearAction();
  $("receipt-panel").hidden = true;
  $("top-vehicle-id").textContent = vehicleId() || "No vehicle";
  $("identity-boundary").textContent = $("bearer-token").value.trim()
    ? "Bearer token supplied"
    : "Development identity";
  $("connection-settings").hidden = true;
  $("settings-toggle").setAttribute("aria-expanded", "false");
  resetConversation();
  void Promise.allSettled([checkHealth(), refreshVehicle()]);
}

function handleUiError(error) {
  showAlert(error);
  setExecution("Failed", "failure");
}

$("settings-toggle").addEventListener("click", () => {
  const nextHidden = !$("connection-settings").hidden;
  $("connection-settings").hidden = nextHidden;
  $("settings-toggle").setAttribute("aria-expanded", String(!nextHidden));
});
$("apply-identity").addEventListener("click", applyIdentity);
$("create-session").addEventListener("click", () => createSession().catch(handleUiError));
$("restore-session").addEventListener("click", () => restoreSession().catch(handleUiError));
$("message-form").addEventListener(
  "submit",
  (event) => void sendMessage(event).catch(handleUiError),
);
$("message").addEventListener("input", resizeComposer);
$("message").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("message-form").requestSubmit();
  }
});
$("confirm-action").addEventListener("click", () => void decide("confirm"));
$("reject-action").addEventListener("click", () => void decide("reject"));
$("refresh-vehicle").addEventListener("click", () => refreshVehicle().catch(handleUiError));
$("alert-retry").addEventListener(
  "click",
  () => void Promise.allSettled([checkHealth(), refreshVehicle()]),
);
for (const suggestion of document.querySelectorAll("[data-prompt]")) {
  suggestion.addEventListener("click", () => {
    $("message").value = suggestion.dataset.prompt;
    resizeComposer();
    $("message").focus();
  });
}

if (sessionId) $("session-id").textContent = sessionId;
$("top-vehicle-id").textContent = vehicleId();
void checkHealth();
void refreshVehicle().catch(() => undefined);
void loadUrgentHistory().catch(() => undefined);
void runUrgentStream();
healthTimer = setInterval(() => void checkHealth(), 15_000);
window.addEventListener("pagehide", () => clearInterval(healthTimer), { once: true });
