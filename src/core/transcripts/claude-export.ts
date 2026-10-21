/**
 * claude-export.ts — Claude.ai data-export adapter (cathedral-4, CP1).
 *
 * v1 consumes the EXTRACTED conversations.json from the account export
 * ("unzip first" documented; zip wrapper is a filed TODO). One file = MANY
 * conversations.
 *
 * Two export facts shape the parse:
 *   - An assistant message's flat `text` concatenates its thinking blocks
 *     with the reply. The reply is the `type: "text"` blocks of `content`;
 *     `text` is the fallback only when a message carries no content blocks.
 *   - Messages form a tree through `parent_message_uuid` (an edit or a
 *     regenerate adds a sibling). The active thread is the path to the
 *     newest leaf. An abandoned thread with at least ALT_BRANCH_MIN_MESSAGES
 *     of its own becomes a separate `(alternate branch N)` session instead of
 *     interleaving with the active one; shorter ones (retries) are dropped.
 */

import type { HostSpecTarget } from '../bootstrap/host-specs.ts';
import type {
  FileDiagnostics,
  ParsedSession,
  ParseSessionsOpts,
  TranscriptAdapter,
  TranscriptMessage,
} from './types.ts';
import { loadExportConversations } from './export-json.ts';
import { utcTimestamp } from './types.ts';

export const CLAUDE_EXPORT_SPEC_TARGET: HostSpecTarget = {
  id: 'claude-ai-export-2026-10',
  status: 'verified',
  verifiedAt: '2026-10-21',
  references: [
    'Claude.ai account data export: conversations.json',
    'test/fixtures/transcripts/claude-export.json',
    'test/fixtures/transcripts/claude-export-branches.json',
  ],
  note:
    'Top level: ARRAY of conversations {uuid, name, created_at ISO, ' +
    'chat_messages:[{uuid, parent_message_uuid, text, content:[{type, text|thinking|…}], ' +
    'sender, created_at}]}. sender "human" maps to user; "assistant" stays. ' +
    'Reply text = content text blocks (flat `text` also holds thinking). ' +
    'Empty messages are skipped. Monolithic JSON: over-cap files are ' +
    'REJECTED, never truncated.',
};

/** Own (unshared) messages an abandoned thread needs to survive as its own session. */
export const ALT_BRANCH_MIN_MESSAGES = 4;

type Row = Record<string, unknown>;

function replyText(row: Row): string {
  const blocks = Array.isArray(row.content) ? (row.content as unknown[]) : [];
  const parts: string[] = [];
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null) continue;
    const block = b as Row;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) parts.push(block.text);
  }
  if (parts.length) return parts.join('\n\n').trim();
  return typeof row.text === 'string' ? row.text.trim() : '';
}

/**
 * Split a conversation's rows into its active thread and the alternate
 * threads worth keeping. Rows without parent links keep their export order
 * as one thread.
 */
export function claudeExportThreads(rows: readonly Row[]): { active: Row[]; alternates: Row[][] } {
  const byId = new Map<string, Row>();
  for (const r of rows) if (typeof r.uuid === 'string') byId.set(r.uuid, r);
  const linked = rows.some((r) => typeof r.parent_message_uuid === 'string');
  if (!linked || byId.size !== rows.length) return { active: [...rows], alternates: [] };

  const parents = new Set(rows.map((r) => r.parent_message_uuid));
  const leaves = rows
    .filter((r) => !parents.has(r.uuid))
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  const pathTo = (leaf: Row): Row[] => {
    const path: Row[] = [];
    const seen = new Set<string>();
    for (let node: Row | undefined = leaf; node && !seen.has(node.uuid as string); ) {
      seen.add(node.uuid as string);
      path.push(node);
      node = byId.get(node.parent_message_uuid as string);
    }
    return path.reverse();
  };

  const newest = leaves.pop();
  if (!newest) return { active: [...rows], alternates: [] };
  const active = pathTo(newest);
  const covered = new Set(active.map((r) => r.uuid));
  const alternates: Row[][] = [];
  for (const leaf of leaves.reverse()) {
    const path = pathTo(leaf);
    const own = path.filter((r) => !covered.has(r.uuid));
    if (own.length < ALT_BRANCH_MIN_MESSAGES) continue;
    alternates.push(path);
    for (const r of own) covered.add(r.uuid);
  }
  return { active, alternates };
}

function toMessages(rows: readonly Row[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const r of rows) {
    const role = r.sender === 'human' ? 'user' : r.sender === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const text = replyText(r);
    if (!text) continue;
    messages.push({ role, timestamp: utcTimestamp(r.created_at), text });
  }
  return messages;
}

export const claudeExportAdapter: TranscriptAdapter = {
  format: 'claude-export',
  specTarget: CLAUDE_EXPORT_SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    if (!path.endsWith('.json')) return false;
    const head = sample.toString('utf8');
    // Symmetric guard with the chatgpt detector: a ChatGPT export whose
    // early message TEXT contains the literal key name must not misdetect.
    return head.includes('"chat_messages"') && !head.includes('"mapping"');
  },

  async *parse(path: string, opts: ParseSessionsOpts = {}): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const { data, bytes: size } = loadExportConversations(path, {
      maxBytes: opts.maxBytes,
      label: 'claude',
    });

    let sessions = 0;
    for (const conv of data) {
      if (typeof conv !== 'object' || conv === null) continue;
      const c = conv as Row;
      if (!Array.isArray(c.chat_messages)) continue;
      const rows = (c.chat_messages as unknown[]).filter((r): r is Row => typeof r === 'object' && r !== null);
      const { active, alternates } = claudeExportThreads(rows);
      const name = typeof c.name === 'string' ? c.name : '';

      for (const [i, thread] of [active, ...alternates].entries()) {
        const messages = toMessages(thread);
        if (!messages.length) continue;
        // Content-derived fallback (see chatgpt-export.ts): a bare per-file
        // ordinal collides across export files.
        const baseId =
          (typeof c.uuid === 'string' && c.uuid) ||
          `claude-export-fallback-${name}-${
            typeof c.created_at === 'string' ? c.created_at : ''
          }-${messages[0]?.timestamp ?? ''}-${sessions}`;
        const sessionId = i === 0 ? baseId : `${baseId}-alt${i}`;
        const title = i === 0 ? name : `${name || 'Untitled'} (alternate branch ${i})`;
        sessions++;
        yield {
          meta: {
            harness: 'claude-export',
            sessionId,
            title: title || undefined,
            startedAt: utcTimestamp(c.created_at) || messages[0].timestamp || undefined,
            raw: {
              conversation_uuid: sessionId,
              name: name || null,
              source_path: path,
            },
            ownerBasis: 'export_user',
          },
          messages,
        };
      }
    }
    return {
      bytesRead: size,
      skippedLines: 0,
      truncated: false,
      sessions,
      zeroSessionsReason:
        sessions === 0 ? 'no conversations with human/assistant text messages' : undefined,
    };
  },
};
