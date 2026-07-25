// Tool schemas for the Phase 5 NL chat layer — this is the stable/cacheable
// half of app/api/chat/route.ts's system prompt (goes before the
// cache_control breakpoint, alongside the behavioral rules text).
//
// Complete rebuild (2026-07-25): trimmed from 33 tools down to exactly 2,
// per an explicit user decision — the prior surface was too large for
// claude-haiku-4-5 to reliably keep track of. This is deliberately not a
// "cut the least-used tools" trim; it's a hard reset to the smallest useful
// surface: propose a calendar change (create/move/delete), and find free
// time. Everything else (tasks, habits, scheduling rules, batch/group
// operations, bulk-edit, recurring series, relocate, reschedule/rebalance,
// focus/buffer/task/habit auto-placement, approve/reject/revert, capability
// logging, progressive-disclosure reference docs) is gone from chat
// entirely — still reachable through the direct API (`backend-api-reference.md`),
// just not from this conversation.
//
// No approve/reject/revert tool exists — this is structural, not a prompt
// instruction: the model cannot apply anything it proposes even if it tried.
// lib/nlToolDispatch.ts additionally forces `skipAutoApply: true` on every
// proposal this layer creates, so even a category later added to
// AUTO_APPLY_CATEGORIES can never bypass manual review through this path.
import type Anthropic from '@anthropic-ai/sdk';
import { BURNER_EVENT_TYPES, EVENT_PRIORITIES } from './eventMetadata';

const CHANGE_TYPES = ['create', 'move', 'delete'];

export const NL_TOOLS: Anthropic.Tool[] = [
  {
    name: 'propose_calendar_change',
    description:
      'Propose creating, moving, or deleting a calendar event (a normal block, focus time, a meeting, a buffer — any category). This only ever creates a "pending" proposal in the review queue — it never applies anything to the real calendar. The user must approve it themselves through the app; you cannot approve it, and there is no way to make this apply automatically.',
    input_schema: {
      type: 'object',
      properties: {
        change_type: { type: 'string', enum: CHANGE_TYPES, description: 'What kind of change this is.' },
        category: { type: 'string', enum: BURNER_EVENT_TYPES, description: 'Always required, regardless of change_type.' },
        target_event_id: { type: 'string', description: 'Required for move/delete. Must be omitted for create. Get this from the calendar digest already in context — there is no separate lookup tool.' },
        proposed_start: { type: 'string', description: 'ISO datetime. Required for create and move.' },
        proposed_end: { type: 'string', description: 'ISO datetime. Required alongside proposed_start.' },
        proposed_summary: { type: 'string', description: 'Required for create — the event title.' },
        proposed_description: { type: 'string' },
        priority: { type: 'string', enum: EVENT_PRIORITIES, description: 'Only meaningful for create.' },
        flexible: { type: 'string', enum: ['true', 'false'], description: 'Only meaningful for create.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Only meaningful for create.' },
        reason: { type: 'string', description: 'A short human-readable justification, shown in the review queue.' },
      },
      required: ['change_type', 'category'],
    },
  },
  {
    name: 'find_free_time',
    description:
      'Find open time windows in a range, honoring working hours and any standing scheduling rules. Read-only — does not create or change anything. Use this before propose_calendar_change when the user hasn\'t named an exact time themselves.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO datetime.' },
        to: { type: 'string', description: 'ISO datetime.' },
        min_duration_minutes: { type: 'number' },
        category: { type: 'string', enum: BURNER_EVENT_TYPES, description: 'Narrows which standing scheduling rules apply to the search.' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['from', 'to'],
    },
  },
];
