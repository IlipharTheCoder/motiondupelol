// Wire-format (snake_case) request body builders — the inverse direction of
// caseConvert.ts's camelizeKeys, kept as small explicit mappers rather than
// a generic recursive decamelizer, since the input shapes here are small and
// fixed (CreateTaskInput/UpdateTaskInput/PatchProposedChangeInput). Same
// "pure and tested" treatment as lib/chat.ts's buildChatRequestBody — a
// field is included only when actually provided, so an update PATCH doesn't
// accidentally clear fields the caller didn't mean to touch.
import type { CreateTaskInput, UpdateTaskInput, PatchProposedChangeInput } from './types';

export function buildCreateTaskBody(input: CreateTaskInput): Record<string, unknown> {
  const body: Record<string, unknown> = { title: input.title };
  if (input.description !== undefined) body.description = input.description;
  if (input.deadline !== undefined) body.deadline = input.deadline;
  if (input.priority !== undefined) body.priority = input.priority;
  if (input.durationMinutes !== undefined) body.duration_minutes = input.durationMinutes;
  if (input.tags !== undefined) body.tags = input.tags;
  return body;
}

export function buildUpdateTaskBody(input: UpdateTaskInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.title = input.title;
  if (input.description !== undefined) body.description = input.description;
  if (input.deadline !== undefined) body.deadline = input.deadline;
  if (input.priority !== undefined) body.priority = input.priority;
  if (input.durationMinutes !== undefined) body.duration_minutes = input.durationMinutes;
  if (input.tags !== undefined) body.tags = input.tags;
  return body;
}

export function buildPatchProposedChangeBody(input: PatchProposedChangeInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.priority !== undefined) body.priority = input.priority;
  if (input.tags !== undefined) body.tags = input.tags;
  if (input.durationMinutes !== undefined) body.duration_minutes = input.durationMinutes;
  return body;
}
