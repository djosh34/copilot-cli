// Built from src/extension.mts by npm run build.

// src/extension.mts
import { CopilotClient } from "@github/copilot-sdk";
import { rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

// src/config.mts
var off = {
  includeAISafety: false,
  includeToolInstructions: false,
  includeParallelToolCalling: false,
  includeEnvironmentContext: false,
  includeNoTmpFileInstructions: false,
  includeSoftFileOutputInstructions: false,
  includeCustomAgentInstructions: false,
  includeCustomInstructions: false,
  includeDynamicContextBoard: false,
  includeSessionSearchContext: false,
  includeConsolidationPrompt: false
};
var minimal = {
  systemMessage: { mode: "replace", content: "" },
  customAgents: [{ name: "gp", description: "General-purpose agent.", prompt: "", promptParts: off }],
  availableTools: ["task", "bash", "view", "apply_patch", "create", "edit", "web_fetch", "skill"],
  skipCustomInstructions: true,
  largeOutput: { maxSizeBytes: 8192 }
};

// src/extension.mts
var config = { ...minimal, suppressResumeEvent: true };
var id = process.env.SESSION_ID;
var marker = `${process.env.COPILOT_HOME || homedir() + "/.copilot"}/session-state/${id}/minprompt.${process.ppid}`;
var client = new CopilotClient({ _internalConnection: { kind: "parent-process" } });
var internal = client;
await client.start();
var send = internal.connection.sendRequest.bind(internal.connection);
internal.connection.sendRequest = (m, p, ...r) => send(m, m === "session.resume" ? { ...p, requestPermission: false } : p, ...r);
var join = async () => {
  await internal.resumeSessionForExtension(id, config, {});
  writeFileSync(marker, String(Date.now() + 500));
};
await join();
client.onLifecycle("session.background", (e) => {
  if (e.sessionId === id) rmSync(marker, { force: true });
});
client.onLifecycle("session.foreground", (e) => {
  if (e.sessionId === id) join().catch((err) => console.error(err));
});
