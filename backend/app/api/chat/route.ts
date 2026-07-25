import Anthropic from '@anthropic-ai/sdk';
import { isAuthorized } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { getSchedulingConfig } from '@/lib/schedulingConfig';
import { NL_BEHAVIORAL_RULES } from '@/lib/nlSystemPrompt';
import { runChatLoop } from '@/lib/nlLoop';
import { formatTimeAnchors, formatCalendarDigest } from '@/lib/nlContext';
import { fetchCalendarDigest } from '@/lib/nlContextQuery';

export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HISTORY_MESSAGE_LIMIT = 20;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface ChatMessageRow {
  role: 'user' | 'assistant';
  content: string;
}

async function getOrCreateConversation(conversationId: string | undefined): Promise<string> {
  if (conversationId) {
    const { data, error } = await supabase
      .from('chat_conversations')
      .select('id')
      .eq('id', conversationId)
      .maybeSingle();
    if (error) throw new Error(`chat_conversations read failed: ${error.message}`);
    if (data) return data.id;
    // An unrecognized id is treated as "start fresh" rather than a 404 — a
    // thin client re-sending a stale/local id shouldn't hard-fail the chat.
  }

  const { data, error } = await supabase.from('chat_conversations').insert({}).select('id').single();
  if (error) throw new Error(`chat_conversations insert failed: ${error.message}`);
  return data.id;
}

async function fetchHistory(conversationId: string): Promise<ChatMessageRow[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_MESSAGE_LIMIT);
  if (error) throw new Error(`chat_messages read failed: ${error.message}`);
  return ((data ?? []) as ChatMessageRow[]).reverse();
}

async function saveMessage(conversationId: string, role: 'user' | 'assistant', content: string): Promise<void> {
  const { error } = await supabase.from('chat_messages').insert({ conversation_id: conversationId, role, content });
  if (error) throw new Error(`chat_messages insert failed: ${error.message}`);
  await supabase.from('chat_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return Response.json({ error: '"message" is required' }, { status: 400 });
  }
  if (body.conversation_id !== undefined && (typeof body.conversation_id !== 'string' || !UUID_RE.test(body.conversation_id))) {
    return Response.json({ error: '"conversation_id" must be a valid uuid' }, { status: 400 });
  }

  try {
    const conversationId = await getOrCreateConversation(body.conversation_id);
    const history = await fetchHistory(conversationId);

    const now = new Date();
    const config = getSchedulingConfig();
    const digestEvents = await fetchCalendarDigest(now);

    // Complete rebuild (2026-07-25): trimmed to just what the 2-tool
    // surface needs — resolved time anchors (so "today"/"this week"
    // resolve correctly) and the calendar digest (the only source of
    // existing event ids for move/delete, since there's no dedicated
    // lookup tool). Open state, scheduling-rules text, and data-freshness
    // were all dropped: none of them are actionable information for a
    // model that can only propose_calendar_change/find_free_time — a rule
    // violation or a conflict already comes back as a descriptive error on
    // the tool_result itself, so it doesn't need to be pre-listed here too.
    const volatileText = [
      '--- Resolved time anchors (refreshed every message) ---',
      formatTimeAnchors(now, config),
      '',
      '--- Upcoming calendar digest (next 7 days) ---',
      formatCalendarDigest(digestEvents),
    ].join('\n');

    // Stable content (tools + behavioral rules) gets the sole cache_control
    // breakpoint; the volatile block that follows is never cached — see
    // lib/nlContext.ts's top comment for why (resolved time anchors alone
    // changes on literally every request).
    //
    // ttl: '1h', not the API default of 5m — this is a low-frequency
    // single-user app, so separate chat sessions during the day are more
    // likely to be >5 minutes apart than not. Note: with only 2 tools, the
    // stable prefix is much smaller than the prior 33-tool version's
    // ~6.7k tokens — re-verify live whether it still clears the minimum
    // token threshold prompt caching needs before assuming this still pays
    // off (see backend-build-order.md's rebuild writeup).
    const systemBlocks: Anthropic.TextBlockParam[] = [
      { type: 'text', text: NL_BEHAVIORAL_RULES, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: volatileText },
    ];

    const messages: Anthropic.MessageParam[] = history.map((m) => ({
      role: m.role,
      content: [{ type: 'text', text: m.content }],
    }));
    messages.push({ role: 'user', content: [{ type: 'text', text: message }] });

    const loopResult = await runChatLoop(anthropic, systemBlocks, messages);

    await saveMessage(conversationId, 'user', message);
    await saveMessage(conversationId, 'assistant', loopResult.text);

    return Response.json({
      conversation_id: conversationId,
      reply: loopResult.text,
      proposals: loopResult.proposals,
      usage: loopResult.usage,
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
