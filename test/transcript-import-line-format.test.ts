/**
 * Transcript-import pages declare their line format; the parser honors it.
 *
 * Assistant turns full of `**Label:** value` lines outscore the real
 * `**Speaker** (date time):` anchors under `bold-name-no-time`, so scoring
 * alone turns every label into a speaker. The importer stamps
 * `transcript_import.line_format`, and pages imported before that field
 * existed (bare `transcript_import`) were rendered in the same format.
 */

import { describe, expect, test } from 'bun:test';
import { parseConversation } from '../src/core/conversation-parser/parse.ts';
import { redactSession, renderSessionParts, TRANSCRIPT_LINE_FORMAT } from '../src/core/transcripts/render.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';
import type { Page } from '../src/core/types.ts';

function page(frontmatter: Record<string, unknown>): Page {
  return {
    id: 1,
    source_id: 'default',
    slug: 'conversations/claude/2026-09-01-widget-plan-abc123',
    type: 'conversation',
    title: 'Widget plan',
    compiled_truth: '',
    timeline: '',
    frontmatter: { date: '2026-09-01', ...frontmatter },
    content_hash: undefined,
    created_at: new Date(),
    updated_at: new Date(),
    effective_date: null,
  } as Page;
}

const LABELS = [
  '**Philosophie:** Understatement mit Substanz',
  '**Stil:** knapp',
  '**Zielgruppe:** acme-example leadership',
  '**Ton:** direkt',
  '**Format:** one page',
];

const LABEL_HEAVY_BODY = [
  '**User** (2026-09-01 10:00 AM): Give me three concepts for the widget-co landing page.',
  `**Assistant** (2026-09-01 10:01 AM): Concept one.\n${LABELS.join('\n')}`,
  `Concept two.\n${LABELS.join('\n')}`,
  `Concept three.\n${LABELS.join('\n')}`,
  '**User** (2026-09-01 10:05 AM): Go with concept two.',
  '**Assistant** (2026-09-01 10:06 AM): Done.',
].join('\n\n');

describe('declared transcript line format', () => {
  test('a label-heavy imported page parses into its real turns, not one message per label', () => {
    const r = parseConversation(LABEL_HEAVY_BODY, {
      page: page({ transcript_import: { harness: 'claude-export', line_format: 'imessage-slack' } }),
    });
    expect(r.matched_pattern_id).toBe('imessage-slack');
    expect(r.messages.map((m) => m.speaker)).toEqual(['User', 'Assistant', 'User', 'Assistant']);
    expect(r.messages[1].text).toContain('Concept three.');
  });

  test('pages imported before line_format existed default to imessage-slack', () => {
    const r = parseConversation(LABEL_HEAVY_BODY, { page: page({ transcript_import: { harness: 'claude-export' } }) });
    expect(r.matched_pattern_id).toBe('imessage-slack');
    expect(r.messages).toHaveLength(4);
  });

  test('a page without transcript_import is still scored across every candidate', () => {
    const notes = ['**Alice Example:** we should ship', '**Bob Example:** agreed', '**Alice Example:** friday then'].join('\n');
    const r = parseConversation(notes, { page: page({}) });
    expect(r.matched_pattern_id).toBe('bold-name-no-time');
    expect(r.messages.map((m) => m.speaker)).toEqual(['Alice Example', 'Bob Example', 'Alice Example']);
  });

  test('an unknown or disabled declared format falls back to scoring', () => {
    const unknown = parseConversation(LABEL_HEAVY_BODY, {
      page: page({ transcript_import: { line_format: 'no-such-format' } }),
    });
    const disabled = parseConversation(LABEL_HEAVY_BODY, {
      page: page({ transcript_import: { line_format: 'imessage-slack' } }),
      disabledBuiltinIds: ['imessage-slack'],
    });
    const undeclared = parseConversation(LABEL_HEAVY_BODY, { page: page({}) });
    expect(unknown.matched_pattern_id).toBe(undeclared.matched_pattern_id);
    expect(disabled.matched_pattern_id).not.toBe('imessage-slack');
  });

  test('a declared format with no anchor in the body is no_match, not an empty regex_match', () => {
    const r = parseConversation('Just prose.\n\nNo turns here.', {
      page: page({ transcript_import: { line_format: 'imessage-slack' } }),
    });
    expect(r.phase).toBe('no_match');
    expect(r.messages).toEqual([]);
  });

  test('rendered transcript pages stamp the format and round-trip through the parser', () => {
    const session: ParsedSession = {
      meta: { harness: 'claude-export', sessionId: 'claude-conv-labels', title: 'Widget plan', startedAt: '2026-09-01T10:00:00.000Z' },
      messages: [
        { role: 'user', timestamp: '2026-09-01T10:00:00.000Z', text: 'Give me three concepts.' },
        { role: 'assistant', timestamp: '2026-09-01T10:01:00.000Z', text: `Concept one.\n${LABELS.join('\n')}\n\nConcept two.\n${LABELS.join('\n')}` },
        { role: 'user', timestamp: '2026-09-01T10:05:00.000Z', text: 'Go with concept two.' },
      ],
    };
    const [part] = renderSessionParts(redactSession(session, { patterns: [] }), { sourcePath: 'x' }).parts;
    const ti = part.frontmatter.transcript_import as Record<string, unknown>;
    expect(ti.line_format).toBe(TRANSCRIPT_LINE_FORMAT);
    const r = parseConversation(part.body, { page: page(part.frontmatter) });
    expect(r.matched_pattern_id).toBe('imessage-slack');
    expect(r.messages.map((m) => m.speaker)).toEqual(['User', 'Assistant', 'User']);
  });
});
