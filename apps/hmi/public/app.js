const apiBase = "/api";
const $ = (id) => document.getElementById(id);
let sessionId = localStorage.getItem("driveguard.sessionId");
let pendingAction = null;
let sending = false;

class ApiRequestError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

function headers() {
  const bearerToken = $("bearer-token").value.trim();
  if (bearerToken)
    return { "content-type": "application/json", authorization: `Bearer ${bearerToken}` };
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

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new ApiRequestError(
      payload.error?.code || "ERROR",
      payload.error?.message || "Request failed",
    );
  }
  return payload.data;
}

function setSession(id) {
  sessionId = id;
  localStorage.setItem("driveguard.sessionId", id);
  $("session-id").textContent = id;
}

function appendMessage(role, content = "") {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = content;
  $("conversation").append(node);
  $("conversation").scrollTop = $("conversation").scrollHeight;
  return node;
}

function addTimeline(label) {
  if ($("timeline").querySelector(".muted")) $("timeline").replaceChildren();
  const item = document.createElement("li");
  item.textContent = label;
  $("timeline").append(item);
}

function setExecution(label, kind, value) {
  $("execution-status").textContent = label;
  $("execution-status").className = `state-pill ${kind}`;
  if (value !== undefined) $("result").textContent = JSON.stringify(value, null, 2);
}

function showAction(data) {
  pendingAction = data;
  $("action-empty").hidden = true;
  $("action-card").hidden = false;
  $("action-risk").textContent = data.risk_level;
  $("action-tool").textContent = data.tool;
  $("action-summary").textContent = data.summary;
  $("action-parameters").textContent = JSON.stringify(data.parameters, null, 2);
  $("action-expiry").textContent = `Expires ${new Date(data.expires_at).toLocaleString()}`;
  addTimeline("Waiting for user confirmation");
  setExecution("Waiting confirmation", "running");
}

function clearAction() {
  pendingAction = null;
  $("action-empty").hidden = false;
  $("action-card").hidden = true;
}

function applyEvent(event, assistant) {
  const data = event.data || {};
  switch (event.event_type) {
    case "run.started":
      addTimeline("Agent run started");
      break;
    case "assistant.delta":
      assistant.textContent += data.delta || "";
      break;
    case "tool.requested":
      addTimeline(`Agent requested ${data.tool}`);
      break;
    case "policy.decision":
      addTimeline(`Policy: ${data.decision}`);
      $("result").textContent = JSON.stringify(data, null, 2);
      break;
    case "confirmation.required":
      showAction(data);
      break;
    case "tool.completed":
      addTimeline(`${data.tool} returned${data.is_error ? " an error" : ""}`);
      break;
    case "assistant.completed":
      if (!assistant.textContent) assistant.textContent = data.response || "";
      if (data.status === "completed") setExecution("Completed", "success", data);
      break;
    case "run.failed":
      if (data.code === "POLICY_REPLAN_REQUIRED" || data.code === "REPLAN_REQUIRED") {
        setExecution("Replan required", "failure", data);
      } else if (data.code === "ACTION_EXPIRED") {
        setExecution("Expired", "failure", data);
      } else {
        setExecution("Failed", "failure", data);
      }
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
  if ($("urgent-events").querySelector(".muted")) $("urgent-events").replaceChildren();
  const item = document.createElement("li");
  item.textContent = label;
  $("urgent-events").prepend(item);
}

function applyUrgentEvent(event) {
  const data = event.data || {};
  addUrgentItem(
    `${data.severity || "UNKNOWN"} · ${data.event_type || "UNKNOWN"} · ${data.status || "UNKNOWN"} — ${data.summary || "No summary"}`,
  );
  addTimeline(`Urgent event: ${data.event_type || "UNKNOWN"} (${data.status || "UNKNOWN"})`);
  if (event.event_type === "urgent.confirmation_required") showAction(data);
  if (event.event_type === "urgent.failed") setExecution("Urgent event blocked", "failure", data);
}

async function readSse(response, assistant) {
  if (!response.ok || !response.body) throw new Error(`STREAM_ERROR: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) applyEvent(JSON.parse(dataLine.slice(6)), assistant);
    }
  }
}

async function createSession() {
  const session = await request("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ vehicleId: vehicleId() }),
  });
  setSession(session.sessionId);
  $("conversation").replaceChildren();
  clearAction();
  addTimeline("Session created");
}

async function restoreSession() {
  if (!sessionId) throw new Error("No saved session to restore");
  const session = await request(`/v1/sessions/${encodeURIComponent(sessionId)}${sessionQuery()}`);
  setSession(session.sessionId);
  $("conversation").replaceChildren();
  for (const message of session.messages) appendMessage(message.role, message.content);
  addTimeline("Durable session restored");
}

async function sendMessage(event) {
  event.preventDefault();
  if (sending) return;
  const prompt = $("message").value.trim();
  if (!prompt) return;
  if (!sessionId) await createSession();
  sending = true;
  $("message-form").querySelector("button").disabled = true;
  appendMessage("user", prompt);
  const assistant = appendMessage("assistant");
  $("message").value = "";
  clearAction();
  setExecution("Running", "running");
  try {
    const response = await fetch(
      `${apiBase}/v1/sessions/${encodeURIComponent(sessionId)}/messages/stream${sessionQuery()}`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ prompt }),
      },
    );
    await readSse(response, assistant);
  } catch (error) {
    assistant.textContent = error instanceof Error ? error.message : "Request failed";
    setExecution("Failed", "failure");
  } finally {
    sending = false;
    $("message-form").querySelector("button").disabled = false;
  }
}

async function decide(operation) {
  if (!pendingAction) return;
  const actionSessionId = pendingAction.session_id || sessionId;
  if (!actionSessionId) return;
  $("confirm-action").disabled = true;
  $("reject-action").disabled = true;
  try {
    addTimeline(operation === "confirm" ? "Confirmed" : "Rejected");
    if (operation === "confirm") {
      setExecution("Executing", "running");
      const data = await request(
        `/v1/actions/${encodeURIComponent(pendingAction.action_id)}/confirm`,
        {
          method: "POST",
          body: JSON.stringify({
            sessionId: actionSessionId,
            confirmationCredential: pendingAction.confirmation_credential,
            vehicleId: vehicleId(),
          }),
        },
      );
      addTimeline(
        data.execution.status === "SUCCEEDED" ? "Execution succeeded" : "Execution failed",
      );
      setExecution(
        data.execution.status,
        data.execution.status === "SUCCEEDED" ? "success" : "failure",
        data.execution,
      );
    } else {
      const data = await request(
        `/v1/actions/${encodeURIComponent(pendingAction.action_id)}/reject`,
        {
          method: "POST",
          body: JSON.stringify({ sessionId: actionSessionId, vehicleId: vehicleId() }),
        },
      );
      setExecution("Rejected", "failure", data);
    }
    clearAction();
  } catch (error) {
    const label =
      error instanceof ApiRequestError && error.code === "ACTION_EXPIRED"
        ? "Expired"
        : error instanceof ApiRequestError && error.code === "REPLAN_REQUIRED"
          ? "Replan required"
          : "Failed";
    setExecution(label, "failure", {
      message: error instanceof Error ? error.message : "Request failed",
    });
  } finally {
    $("confirm-action").disabled = false;
    $("reject-action").disabled = false;
  }
}

async function loadUrgentHistory() {
  const events = await request("/v1/urgent-events");
  for (const event of [...events].reverse()) {
    addUrgentItem(
      `${event.severity} · ${event.eventType} · ${event.status} — ${event.safeSummary}`,
    );
  }
}

async function runUrgentStream() {
  while (true) {
    try {
      const response = await fetch(`${apiBase}/v1/urgent-events/stream`, { headers: headers() });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for (const frame of frames) {
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
          if (dataLine) applyUrgentEvent(JSON.parse(dataLine.slice(6)));
        }
      }
    } catch {
      addUrgentItem("Urgent event stream disconnected; reconnecting safely.");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

$("create-session").addEventListener("click", () =>
  createSession().catch((error) => setExecution("Failed", "failure", { message: error.message })),
);
$("restore-session").addEventListener("click", () =>
  restoreSession().catch((error) => setExecution("Failed", "failure", { message: error.message })),
);
$("message-form").addEventListener("submit", sendMessage);
$("confirm-action").addEventListener("click", () => decide("confirm"));
$("reject-action").addEventListener("click", () => decide("reject"));
if (sessionId) $("session-id").textContent = sessionId;
void loadUrgentHistory().catch(() => undefined);
void runUrgentStream();
