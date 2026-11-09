// Runs the ACP test kit (agentclientprotocol/acp-tck, pinned below) v1 suite against copilot-min --acp, after
// install.sh in a throwaway home, against the fake model. Needs git, uv and Python 3.14 (uv fetches it if missing).
// Usage: node test/tck.ts
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { copilotEnv, families, install, root, scratch } from './common.ts';
import { holdMarker, startFakeLlm } from './fake-llm.ts';

const commit = 'b7f40fb3c003c45926547be5a1f7e2b374035815';
// Tests that can't apply to this agent, by name, with the reason. CI runs this file, so this is the CI's skip list.
const skipped: Record<string, string> = {
  // Advisory ACP-SESSION-004. The adapter ignores the client's MCP servers on purpose: no tools from the client
  // (https://github.com/djosh34/copilot-cli/issues/79).
  test_agent_connects_to_the_stdio_mcp_server: 'client MCP servers are ignored by design',
};

const tck = join(root, 'node_modules/.cache', `acp-tck-${commit}`);
const bin = join(tck, '.venv/bin/acp-tck');
if (!existsSync(bin)) {
  rmSync(tck, { recursive: true, force: true });
  execFileSync('git', ['clone', '--quiet', 'https://github.com/agentclientprotocol/acp-tck.git', tck], { stdio: 'inherit' });
  execFileSync('git', ['-C', tck, 'checkout', '--quiet', commit], { stdio: 'inherit' });
  execFileSync('uv', ['sync', '--frozen', '--project', tck], { stdio: 'inherit' });
}

const d = scratch();
const llm = await startFakeLlm({ parent: [{ text: 'tck-ok' }], subagent: [] });
try {
  install(d, 'y');
  const report = join(d.dir, 'report.json');
  const filter = Object.keys(skipped).map(name => `not ${name}`).join(' and ');
  // Async, so the fake model in this process keeps answering while the kit runs.
  const kit = spawn(bin, [
    '--agent-cwd', d.project,
    '--cancel-prompt', `Wait ${holdMarker}`,
    '--report-json', report,
    ...(filter ? ['-k', filter] : []),
    '--', join(root, 'bin/copilot-min'), '--acp', '--sync-session', 'off',
  ], { stdio: 'inherit', env: copilotEnv(d, families[0], llm.url) });
  const [code] = await once(kit, 'close');
  // The kit's summary names tests; also print each failed requirement with its diagnostics.
  const { requirements } = JSON.parse(readFileSync(report, 'utf8'));
  for (const r of requirements.filter((r: any) => r.status === 'FAIL')) {
    console.log(`FAIL ${r.tier} ${r.id}: ${r.text}`);
    for (const t of r.tests.filter((t: any) => t.status !== 'PASS')) console.log(`  ${t.nodeid}: ${t.message}\n  agent stderr: ${t.stderr ?? ''}`);
  }
  assert.equal(code, 0, 'the ACP test kit passed');
  assert.ok(llm.requests.length > 0, 'the test kit prompts reached the fake model');
} finally {
  llm.close();
  rmSync(d.dir, { recursive: true, force: true });
}
