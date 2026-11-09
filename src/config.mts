// The minimal session config, shared by the extension (terminal sessions) and the ACP adapter (copilot-min --acp):
// an empty main system prompt, the gp subagent with Copilot's prompt parts off, the tool allowlist, no custom
// instructions and the 8 KB output limit. promptParts is internal and missing from the SDK's types.
const off = {
  includeAISafety: false, includeToolInstructions: false, includeParallelToolCalling: false,
  includeEnvironmentContext: false, includeNoTmpFileInstructions: false, includeSoftFileOutputInstructions: false,
  includeCustomAgentInstructions: false, includeCustomInstructions: false, includeDynamicContextBoard: false,
  includeSessionSearchContext: false, includeConsolidationPrompt: false,
};

export const minimal = {
  systemMessage: { mode: 'replace' as const, content: '' },
  customAgents: [{ name: 'gp', description: 'General-purpose agent.', prompt: '', promptParts: off }],
  availableTools: ['task', 'bash', 'view', 'apply_patch', 'create', 'edit', 'web_fetch', 'skill'],
  skipCustomInstructions: true,
  largeOutput: { maxSizeBytes: 8192 },
};
