/**
 * openclaw-turn-plugin.ts — OpenClaw's native per-turn hook for the
 * brain-first rule: a hook-only OpenClaw plugin whose `before_prompt_build`
 * handler returns the rule as `prependContext`, so it reaches the model next
 * to each user turn (without its reply sentence on `internal_system` turns).
 * The workspace AGENTS.md block reaches the system prompt only, and bots read
 * it as identity, not as an instruction to call a tool.
 *
 * The plugin is self-contained (the rule text is written into its code; it
 * reads nothing and calls nothing) and lives in <OpenClaw state dir>/gbrain/.
 * Setup installs it with OpenClaw's own CLI, the supported path: a linked
 * install with capability consent, enabled, and
 * `plugins.entries.gbrain-turn-rule.hooks.allowConversationAccess`, which
 * OpenClaw requires of a non-bundled plugin's `before_prompt_build`. With no
 * `openclaw` on PATH, setup writes the plugin and prints those commands.
 *
 * OpenClaw loads a plugin for the whole gateway, so per-agent opt-out lives in
 * the plugin: the workspaces whose block was declined (`--no-instructions
 * --workspace <dir>`, read from the instruction ledger) and the agents
 * openclaw.json gives those workspaces are written into it, and a turn whose
 * hook context names one of them gets no rule.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { bunSpawnSync } from '../spawn.ts';
import { expandHome, openclawConfigPath, openclawStateDir, parseJson5ish, readBrainFirstLedger, renderBrainFirstTurnRule, type BrainFirstAccess } from './brain-first.ts';

export const OPENCLAW_TURN_PLUGIN_ID = 'gbrain-turn-rule';

export interface OpenclawTurnPluginOutcome { action: 'write' | 'keep' | 'print' | 'remove' | 'skip'; path: string; detail: string; commands?: string[]; unchanged?: true }

/** Whether OpenClaw's config already loads the plugin at dir, enables it, lets its plugin policy (plugins.enabled, allow, deny) load it and allows it conversation access (so no CLI call is needed). */
export function openclawPluginRegistered(id: string, dir: string): boolean {
  try {
    const cfg = parseJson5ish(readFileSync(openclawConfigPath(), 'utf8')) as { plugins?: { enabled?: unknown; allow?: unknown; deny?: unknown; load?: { paths?: unknown }; entries?: Record<string, { enabled?: unknown; hooks?: { allowConversationAccess?: unknown } }> } } | undefined;
    const plugins = cfg?.plugins;
    const entry = plugins?.entries?.[id];
    const paths = Array.isArray(plugins?.load?.paths) ? plugins!.load!.paths as unknown[] : [];
    const allowed = plugins?.enabled !== false && !(Array.isArray(plugins?.deny) && plugins!.deny.includes(id)) && !(Array.isArray(plugins?.allow) && plugins!.allow.length > 0 && !plugins!.allow.includes(id));
    return allowed && !!entry && entry.enabled !== false && entry.hooks?.allowConversationAccess === true && paths.includes(dir);
  } catch { return false; }
}

export function openclawTurnPluginDir(): string {
  return join(openclawStateDir(), 'gbrain', OPENCLAW_TURN_PLUGIN_ID);
}

/** Agents and workspaces whose turns get no rule: the workspaces that opted out, and the agents configured with them. */
export interface OpenclawTurnSkip { workspaces: string[]; agents: string[] }

const NO_SKIP: OpenclawTurnSkip = { workspaces: [], agents: [] };
const workspaceKey = (p: string) => resolve(expandHome(p.trim()));

/** Each configured agent's explicit workspace (agents.list[] or agents.entries{}), normalized; agents with none are matched by workspaceDir only. */
function openclawAgentWorkspaces(): [string, string][] {
  try {
    const cfg = parseJson5ish(readFileSync(openclawConfigPath(), 'utf8')) as { agents?: { list?: unknown; entries?: unknown } } | undefined;
    const { list, entries } = cfg?.agents ?? {};
    const rows: [unknown, unknown][] = Array.isArray(list)
      ? list.map((a: { id?: unknown; workspace?: unknown } | null) => [a?.id, a?.workspace])
      : entries && typeof entries === 'object'
        ? Object.entries(entries as Record<string, { id?: unknown; workspace?: unknown } | null>).map(([id, a]) => [a?.id ?? id, a?.workspace])
        : [];
    return rows.filter((r): r is [string, string] => typeof r[0] === 'string' && typeof r[1] === 'string' && r[1].trim() !== '').map(([id, w]) => [id, workspaceKey(w)]);
  } catch { return []; }
}

/**
 * The plugin's skip list: every OpenClaw workspace the ledger records as declined, with `current` (this run's
 * workspace and decision, which a dry run has not recorded) applied on top, plus the agents configured with them.
 */
export function openclawTurnSkip(current?: { workspace: string; declined: boolean }): OpenclawTurnSkip {
  const workspaces = new Set(readBrainFirstLedger().filter((e) => e.harness === 'openclaw' && e.status === 'declined').map((e) => workspaceKey(dirname(e.path))));
  if (current) {
    const w = workspaceKey(current.workspace);
    if (current.declined) workspaces.add(w); else workspaces.delete(w);
  }
  const agents = openclawAgentWorkspaces().filter(([, w]) => workspaces.has(w)).map(([id]) => id);
  return { workspaces: [...workspaces].sort(), agents: [...new Set(agents)].sort() };
}

const describeSkip = (skip: OpenclawTurnSkip) => (skip.workspaces.length === 0 ? '' : `; skips ${skip.agents.length > 0 ? `agents ${skip.agents.join(', ')} and ` : ''}workspaces ${skip.workspaces.join(', ')} (opted out)`);

const DESCRIPTION = 'Puts the GBrain brain-first rule next to every user turn (managed by gbrain setup openclaw).';

export function openclawTurnPluginFiles(access: BrainFirstAccess, skip: OpenclawTurnSkip = NO_SKIP): Record<string, string> {
  const rule = renderBrainFirstTurnRule(access, 'openclaw');
  const skips = skip.workspaces.length > 0 || skip.agents.length > 0;
  const prepend = "{ prependContext: ctx?.inputProvenance?.kind === 'internal_system' ? INTERNAL_RULE : RULE }";
  return {
    'package.json': `${JSON.stringify({ name: OPENCLAW_TURN_PLUGIN_ID, version: '1.0.0', private: true, type: 'module', openclaw: { extensions: ['./index.js'] }, gbrain: { access, ...(skips ? { skip } : {}) } }, null, 2)}\n`,
    'openclaw.plugin.json': `${JSON.stringify({ id: OPENCLAW_TURN_PLUGIN_ID, name: 'GBrain turn rule', description: DESCRIPTION, configSchema: { type: 'object', additionalProperties: false } }, null, 2)}\n`,
    'index.js': [
      '// Managed by gbrain setup openclaw; a re-run rewrites this file. Remove: gbrain setup openclaw --remove',
      `const RULE = ${JSON.stringify(rule)};`,
      `const INTERNAL_RULE = ${JSON.stringify(renderBrainFirstTurnRule(access, 'openclaw', { reply: false }))};`,
      ...(skips ? [
        '// Opted out with gbrain setup openclaw --instructions-only --no-instructions --workspace <dir>: their turns get no rule.',
        `const SKIP_AGENTS = new Set(${JSON.stringify(skip.agents)});`,
        `const SKIP_WORKSPACES = new Set(${JSON.stringify(skip.workspaces)});`,
        "const skipped = (ctx) => SKIP_AGENTS.has(ctx?.agentId) || SKIP_WORKSPACES.has(String(ctx?.workspaceDir ?? '').replace(/\\/+$/, ''));",
      ] : []),
      'export default {',
      `  id: ${JSON.stringify(OPENCLAW_TURN_PLUGIN_ID)},`,
      "  name: 'GBrain turn rule',",
      `  description: ${JSON.stringify(DESCRIPTION)},`,
      '  register(api) {',
      skips
        ? `    api.on('before_prompt_build', (_event, ctx) => (skipped(ctx) ? undefined : ${prepend}));`
        : `    api.on('before_prompt_build', (_event, ctx) => (${prepend}));`,
      '  },',
      '};',
      '',
    ].join('\n'),
  };
}

type Run = (argv: string[]) => { ok: boolean; output: string };

/** One openclaw CLI call; a call killed at its timeout ends its output with "timed out after N s", so the failure line names the stall instead of the last thing it printed. */
export function runOpenclawCli(argv: string[], timeout = 120_000): { ok: boolean; output: string; stdout: string } {
  const r = bunSpawnSync(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env, timeout });
  const output = `${r.stdout.toString()}${r.stderr.toString()}`.trim();
  return { ok: r.exitCode === 0, output: r.exitedDueToTimeout ? `${output}
timed out after ${timeout / 1000} s`.trim() : output, stdout: r.stdout.toString() };
}

function findOpenclaw(): string | null {
  try { return Bun.which('openclaw', { PATH: process.env.PATH ?? '' }); } catch { return null; }
}

const installArgv = (bin: string, dir: string): string[][] => [
  [bin, 'plugins', 'install', '--link', dir, '--force', '--accept-capabilities'],
  [bin, 'plugins', 'enable', OPENCLAW_TURN_PLUGIN_ID],
  [bin, 'config', 'set', `plugins.entries.${OPENCLAW_TURN_PLUGIN_ID}.hooks.allowConversationAccess`, 'true'],
];

const shown = (argv: string[]) => argv.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');

/**
 * What an installed plugin was written for: the access its package.json records, else (an older gbrain recorded
 * none) the server or launcher its RULE literal names. undefined with no plugin, null when neither can be read.
 */
function installedAccess(dir: string): { access: BrainFirstAccess; recorded: boolean } | null | undefined {
  if (!existsSync(join(dir, 'index.js'))) return undefined;
  try {
    const recorded = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { gbrain?: { access?: BrainFirstAccess } }).gbrain?.access;
    if (recorded) return { access: recorded, recorded: true };
    const literal = /^const RULE = (".*");$/m.exec(readFileSync(join(dir, 'index.js'), 'utf8'))?.[1];
    const rule = literal ? JSON.parse(literal) as string : '';
    const server = /on the `([^`]+)` MCP server/.exec(rule)?.[1];
    const launcher = /check GBrain first \(`(.+?) search "<names>"`/.exec(rule)?.[1];
    return server ? { access: { kind: 'mcp', server }, recorded: false } : launcher ? { access: { kind: 'cli', launcher }, recorded: false } : null;
  } catch { return null; }
}

const named = (a: BrainFirstAccess) => (a.kind === 'mcp' ? `the \`${a.server}\` MCP server` : `\`${a.launcher}\``);

/**
 * Write the plugin and install it with OpenClaw's CLI (accepted decision). Never throws. Every agent on the gateway gets
 * the plugin's rule, so a `workspace`-scoped run leaves an installed plugin whose rule would name another server (or
 * one it cannot read) and prints, unverified, the command that changes it for every agent.
 */
export function syncOpenclawTurnPlugin(opts: { access: BrainFirstAccess; skip?: OpenclawTurnSkip; dryRun: boolean; workspace?: string; openclawBin?: string | null; run?: Run }): OpenclawTurnPluginOutcome {
  const dir = openclawTurnPluginDir();
  const installed = opts.workspace ? installedAccess(dir) : undefined;
  const same = installed && (installed.recorded
    ? renderBrainFirstTurnRule(installed.access, 'openclaw') === renderBrainFirstTurnRule(opts.access, 'openclaw')
    : named(installed.access) === named(opts.access));
  if (installed !== undefined && !same) {
    return { action: 'print', path: dir, detail: `${dir} left as it is: every agent on this OpenClaw gateway gets its rule, which ${installed ? `names ${named(installed.access)}` : 'gbrain cannot read'}, so a --workspace run does not rewrite it. To change it for every agent, run this, then this setup again`, commands: [`gbrain setup openclaw --remove --workspace ${opts.workspace}`] };
  }
  const skip = opts.skip ?? NO_SKIP;
  const files = openclawTurnPluginFiles(opts.access, skip);
  const bin = opts.openclawBin !== undefined ? opts.openclawBin : findOpenclaw();
  const commands = installArgv(bin ?? 'openclaw', dir);
  const changed = Object.entries(files).some(([name, text]) => {
    try { return readFileSync(join(dir, name), 'utf8') !== text; } catch { return true; }
  });
  if (opts.dryRun) return { action: changed ? 'write' : 'keep', path: dir, detail: `per-turn rule plugin ${OPENCLAW_TURN_PLUGIN_ID} (before_prompt_build) at ${dir}${bin ? ', installed with the openclaw CLI' : ''}${describeSkip(skip)}` };
  try {
    if (changed) {
      mkdirSync(dir, { recursive: true });
      for (const [name, text] of Object.entries(files)) atomicWriteTextFile(join(dir, name), text, { freshMode: 0o644 });
    }
  } catch (e) {
    return { action: 'print', path: dir, detail: `the plugin could not be written to ${dir} (${(e as Error).message})` };
  }
  if (!changed && openclawPluginRegistered(OPENCLAW_TURN_PLUGIN_ID, dir)) return { action: 'keep', path: dir, detail: `per-turn rule plugin ${OPENCLAW_TURN_PLUGIN_ID} (before_prompt_build) at ${dir}, already installed, enabled and allowed in OpenClaw, so no openclaw command ran${describeSkip(skip)}`, unchanged: true };
  if (!bin) return { action: 'print', path: dir, detail: `plugin written to ${dir}; no openclaw on PATH, so run these on the OpenClaw host, then restart the gateway`, commands: commands.map(shown) };
  const run = opts.run ?? runOpenclawCli;
  for (const [i, argv] of commands.entries()) {
    const r = run(argv);
    if (!r.ok) return { action: 'print', path: dir, detail: `\`${shown(argv)}\` failed (${r.output.split('\n').at(-1) ?? 'no output'}); run the rest yourself`, commands: commands.slice(i).map(shown) };
  }
  return { action: changed ? 'write' : 'keep', path: dir, detail: `per-turn rule plugin ${OPENCLAW_TURN_PLUGIN_ID} (before_prompt_build) at ${dir}, installed and enabled${describeSkip(skip)}; restart the gateway if it is running` };
}

/**
 * One workspace's opt-out (`--no-instructions --workspace <dir>`): the plugin is gateway-wide, so it stays and is
 * rewritten, with the access it was written for, to skip that workspace's turns. Never throws.
 */
export function skipInOpenclawTurnPlugin(opts: { workspace: string; skip: OpenclawTurnSkip; dryRun: boolean; openclawBin?: string | null; run?: Run }): OpenclawTurnPluginOutcome {
  const dir = openclawTurnPluginDir();
  const installed = installedAccess(dir);
  if (installed === undefined) return { action: 'skip', path: dir, detail: `no per-turn rule plugin at ${dir}` };
  if (!installed?.recorded) {
    return { action: 'print', path: dir, detail: `${dir} left as it is: it does not record the access it was written for, so it cannot be rewritten to skip ${opts.workspace}. Re-run setup for a workspace that uses gbrain, then this again`, commands: ['gbrain setup openclaw --instructions-only --workspace <a workspace that uses gbrain>'] };
  }
  return syncOpenclawTurnPlugin({ access: installed.access, skip: opts.skip, dryRun: opts.dryRun, workspace: opts.workspace, openclawBin: opts.openclawBin, run: opts.run });
}

/**
 * Uninstall the plugin, then delete its directory (decline or --remove). Never throws. The directory stays
 * until the uninstall succeeds: `install --link` put it in plugins.load.paths, and OpenClaw refuses a config
 * whose load path is missing.
 */
export function removeOpenclawTurnPlugin(opts: { dryRun: boolean; openclawBin?: string | null; run?: Run }): OpenclawTurnPluginOutcome {
  const dir = openclawTurnPluginDir();
  if (!existsSync(dir)) return { action: 'skip', path: dir, detail: `no per-turn rule plugin at ${dir}` };
  if (opts.dryRun) return { action: 'remove', path: dir, detail: `per-turn rule plugin ${OPENCLAW_TURN_PLUGIN_ID} at ${dir}` };
  const bin = opts.openclawBin !== undefined ? opts.openclawBin : findOpenclaw();
  const uninstall = [bin ?? 'openclaw', 'plugins', 'uninstall', OPENCLAW_TURN_PLUGIN_ID, '--force'];
  const r = bin ? (opts.run ?? runOpenclawCli)(uninstall) : { ok: false, output: 'no openclaw on PATH' };
  if (!r.ok) return { action: 'print', path: dir, detail: `${dir} left in place (OpenClaw still loads it); ${r.output.split('\n').at(-1)}, so run this on the OpenClaw host, then delete ${dir}`, commands: [shown(uninstall)] };
  try {
    rmSync(dir, { recursive: true, force: true });
    if (readdirSync(dirname(dir)).length === 0) rmdirSync(dirname(dir));
  } catch { /* uninstalled; a leftover directory is no longer loaded */ }
  return { action: 'remove', path: dir, detail: `per-turn rule plugin ${OPENCLAW_TURN_PLUGIN_ID} uninstalled and ${dir} removed` };
}
