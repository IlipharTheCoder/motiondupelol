import { describe, expect, it } from 'vitest';
import { buildCreateTaskBody, buildPatchProposedChangeBody, buildUpdateTaskBody } from './requestBodies';

describe('buildCreateTaskBody', () => {
  it('always includes title, omits everything else not provided', () => {
    expect(buildCreateTaskBody({ title: 'Buy milk' })).toEqual({ title: 'Buy milk' });
  });

  it('maps durationMinutes to duration_minutes on the wire', () => {
    expect(buildCreateTaskBody({ title: 'x', durationMinutes: 30 })).toEqual({
      title: 'x',
      duration_minutes: 30,
    });
  });
});

describe('buildUpdateTaskBody', () => {
  it('omits every field not explicitly provided (so an update never clobbers unspecified fields)', () => {
    expect(buildUpdateTaskBody({ title: 'New title' })).toEqual({ title: 'New title' });
  });

  it('includes an explicit null to clear a field (e.g. deadline: null)', () => {
    expect(buildUpdateTaskBody({ deadline: null })).toEqual({ deadline: null });
  });
});

describe('buildPatchProposedChangeBody', () => {
  it('maps durationMinutes to duration_minutes and omits unset fields', () => {
    expect(buildPatchProposedChangeBody({ priority: 'high' })).toEqual({ priority: 'high' });
    expect(buildPatchProposedChangeBody({ durationMinutes: 45 })).toEqual({ duration_minutes: 45 });
  });
});
