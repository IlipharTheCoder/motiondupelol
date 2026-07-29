// Feature parity with app/motiondupelol/Shared/TaskListView.swift — see
// extension/CLAUDE.md and the research this was planned against for the
// exact behaviors this replicates (compose/create, 4 sort options, 3-category
// multi-select filter, tag display, complete-only-when-eligible, and the
// refresh-button-calls-refresh()-first behavior).
import type { CalendarResyncResult, Task, TaskStatus, Priority } from '../lib/types';
import { sortTasks, type TaskSortOption } from '../lib/sort';
import { applyTaskFilter, deriveTagOptions, emptyFilterState, isFilterActive, type TaskFilterState } from '../lib/filter';
import { formatDeadline } from '../lib/dateFormat';
import { callBackground } from './backgroundClient';

const ALL_STATUSES: TaskStatus[] = ['unscheduled', 'scheduled', 'completed', 'discarded'];
const ALL_PRIORITIES: Priority[] = ['critical', 'high', 'medium', 'low'];
const SORT_OPTIONS: { value: TaskSortOption; label: string }[] = [
  { value: 'dueDate', label: 'Due Date' },
  { value: 'status', label: 'Scheduled' },
  { value: 'priority', label: 'Priority' },
  { value: 'tag', label: 'Tag' },
];

export interface TaskListHandle {
  element: HTMLElement;
  refresh(): Promise<void>;
}

export function createTaskListPanel(container: HTMLElement): TaskListHandle {
  let allTasks: Task[] = [];
  let loadError: string | null = null;
  let sortOption: TaskSortOption = 'dueDate';
  let filterState: TaskFilterState = emptyFilterState();

  const root = document.createElement('div');
  root.className = 'ai-cal-task-list';

  // ---- compose row ----
  const composeRow = document.createElement('div');
  composeRow.className = 'ai-cal-compose';
  const composeInput = document.createElement('input');
  composeInput.type = 'text';
  composeInput.placeholder = 'New task…';
  const composeButton = document.createElement('button');
  composeButton.type = 'button';
  composeButton.textContent = '➕';
  composeButton.disabled = true;
  composeRow.append(composeInput, composeButton);

  // ---- header: sort + filter + refresh ----
  const header = document.createElement('div');
  header.className = 'ai-cal-list-header';

  const sortSelect = document.createElement('select');
  for (const opt of SORT_OPTIONS) {
    const optionEl = document.createElement('option');
    optionEl.value = opt.value;
    optionEl.textContent = opt.label;
    sortSelect.appendChild(optionEl);
  }
  sortSelect.value = sortOption;

  const filterDetails = document.createElement('details');
  filterDetails.className = 'ai-cal-filter';
  const filterSummary = document.createElement('summary');
  filterSummary.textContent = 'Filter';
  filterDetails.appendChild(filterSummary);
  const filterBody = document.createElement('div');
  filterDetails.appendChild(filterBody);

  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.textContent = '⟳';
  refreshButton.className = 'ai-cal-refresh';
  refreshButton.title = 'Refresh (re-pulls from Todoist first)';

  // Distinct from refreshButton: that one re-pulls Todoist + does an
  // incremental Google Calendar sync; this force-clears sync state for every
  // tracked calendar and does a full backfill (POST /api/calendar/resync) —
  // for when a calendar's sync state has drifted and won't self-heal.
  const resyncButton = document.createElement('button');
  resyncButton.type = 'button';
  resyncButton.textContent = '🗓';
  resyncButton.className = 'ai-cal-refresh ai-cal-resync';
  resyncButton.title = 'Force full resync of all Google calendars (slower)';

  header.append(sortSelect, filterDetails, refreshButton, resyncButton);

  // ---- resync status (only shown during/after a resync) ----
  const resyncStatus = document.createElement('div');
  resyncStatus.className = 'ai-cal-resync-status';
  resyncStatus.hidden = true;

  // ---- list ----
  const listEl = document.createElement('div');
  listEl.className = 'ai-cal-list';

  root.append(composeRow, header, resyncStatus, listEl);
  container.appendChild(root);

  function renderFilterBody(): void {
    filterBody.textContent = '';

    const statusSection = document.createElement('fieldset');
    const statusLegend = document.createElement('legend');
    statusLegend.textContent = 'Status';
    statusSection.appendChild(statusLegend);
    for (const status of ALL_STATUSES) {
      statusSection.appendChild(
        checkboxRow(status, filterState.statuses.has(status), (checked) => {
          if (checked) filterState.statuses.add(status);
          else filterState.statuses.delete(status);
          render();
        })
      );
    }

    const prioritySection = document.createElement('fieldset');
    const priorityLegend = document.createElement('legend');
    priorityLegend.textContent = 'Priority';
    prioritySection.appendChild(priorityLegend);
    for (const priority of ALL_PRIORITIES) {
      prioritySection.appendChild(
        checkboxRow(priority, filterState.priorities.has(priority), (checked) => {
          if (checked) filterState.priorities.add(priority);
          else filterState.priorities.delete(priority);
          render();
        })
      );
    }

    filterBody.append(statusSection, prioritySection);

    const tagOptions = deriveTagOptions(allTasks);
    if (tagOptions.length > 0) {
      const tagSection = document.createElement('fieldset');
      const tagLegend = document.createElement('legend');
      tagLegend.textContent = 'Tags';
      tagSection.appendChild(tagLegend);
      for (const tag of tagOptions) {
        tagSection.appendChild(
          checkboxRow(tag, filterState.tags.has(tag), (checked) => {
            if (checked) filterState.tags.add(tag);
            else filterState.tags.delete(tag);
            render();
          })
        );
      }
      filterBody.appendChild(tagSection);
    }

    if (isFilterActive(filterState)) {
      const clearButton = document.createElement('button');
      clearButton.type = 'button';
      clearButton.textContent = 'Clear Filters';
      clearButton.className = 'ai-cal-clear-filters';
      clearButton.addEventListener('click', () => {
        filterState = emptyFilterState();
        render();
      });
      filterBody.appendChild(clearButton);
    }

    filterSummary.textContent = isFilterActive(filterState) ? 'Filter •' : 'Filter';
  }

  function checkboxRow(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLLabelElement {
    const row = document.createElement('label');
    row.className = 'ai-cal-checkbox-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    const text = document.createElement('span');
    text.textContent = label;
    row.append(input, text);
    return row;
  }

  function statusChip(status: TaskStatus): HTMLSpanElement {
    const labels: Record<TaskStatus, string> = {
      unscheduled: 'Unscheduled',
      scheduled: 'Scheduled',
      completed: 'Completed',
      discarded: 'Discarded',
    };
    const chip = document.createElement('span');
    chip.className = `ai-cal-chip ai-cal-status-${status}`;
    chip.textContent = labels[status];
    return chip;
  }

  function priorityChip(priority: Priority): HTMLSpanElement {
    const chip = document.createElement('span');
    chip.className = `ai-cal-chip ai-cal-priority-${priority}`;
    chip.textContent = priority.charAt(0).toUpperCase() + priority.slice(1);
    return chip;
  }

  function renderRow(task: Task): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ai-cal-task-row';

    const main = document.createElement('div');
    main.className = 'ai-cal-task-main';

    const title = document.createElement('div');
    title.className = 'ai-cal-task-title';
    title.textContent = task.title;
    main.appendChild(title);

    const chipRow = document.createElement('div');
    chipRow.className = 'ai-cal-chip-row';
    chipRow.appendChild(statusChip(task.status));
    if (task.priority) chipRow.appendChild(priorityChip(task.priority));
    if (task.deadline) {
      const deadline = document.createElement('span');
      deadline.className = 'ai-cal-deadline';
      deadline.textContent = formatDeadline(task.deadline);
      chipRow.appendChild(deadline);
    }
    main.appendChild(chipRow);

    if (task.tags.length > 0) {
      const tagsLine = document.createElement('div');
      tagsLine.className = 'ai-cal-tags-line';
      tagsLine.textContent = [...task.tags].sort().join(', ');
      main.appendChild(tagsLine);
    }

    row.appendChild(main);

    // Mirrors the backend's own completeTask precondition exactly — only
    // these two statuses can still be completed.
    const canComplete = task.status === 'unscheduled' || task.status === 'scheduled';
    if (canComplete) {
      const completeButton = document.createElement('button');
      completeButton.type = 'button';
      completeButton.className = 'ai-cal-complete-button';
      completeButton.textContent = '✓';
      completeButton.addEventListener('click', () => void completeTask(task.id, row, completeButton));
      row.appendChild(completeButton);
    }

    return row;
  }

  function render(): void {
    renderFilterBody();

    listEl.textContent = '';
    if (allTasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ai-cal-empty';
      empty.textContent = loadError ?? 'No tasks';
      listEl.appendChild(empty);
      return;
    }

    const visible = sortTasks(applyTaskFilter(allTasks, filterState), sortOption);
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ai-cal-empty';
      empty.textContent = 'No tasks match the current filter';
      listEl.appendChild(empty);
      return;
    }

    for (const task of visible) {
      listEl.appendChild(renderRow(task));
    }
  }

  async function load(): Promise<void> {
    try {
      allTasks = await callBackground<Task[]>({ type: 'listTasks' });
      loadError = null;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
    render();
  }

  async function completeTask(id: string, row: HTMLElement, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    row.classList.add('ai-cal-busy');
    try {
      const updated = await callBackground<Task>({ type: 'completeTask', id });
      // Updates the row in place (status flips) rather than removing it —
      // fetchTasks always returns every status unfiltered.
      const index = allTasks.findIndex((t) => t.id === id);
      if (index !== -1) allTasks[index] = updated;
      render();
    } catch {
      button.disabled = false;
      row.classList.remove('ai-cal-busy');
    }
  }

  composeInput.addEventListener('input', () => {
    composeButton.disabled = composeInput.value.trim().length === 0;
  });
  composeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submitNewTask();
  });
  composeButton.addEventListener('click', () => void submitNewTask());

  async function submitNewTask(): Promise<void> {
    const title = composeInput.value.trim();
    if (!title) return;
    composeInput.value = '';
    composeButton.disabled = true;
    try {
      const created = await callBackground<Task>({ type: 'createTask', input: { title } });
      allTasks.unshift(created);
      render();
    } catch {
      await load();
    }
  }

  sortSelect.addEventListener('change', () => {
    sortOption = sortSelect.value as TaskSortOption;
    render();
  });

  refreshButton.addEventListener('click', () => void refresh());

  // Re-pulls from Todoist first (via the combined /api/refresh sync), not
  // just our own database, THEN reloads the task list regardless of
  // whether the sync itself succeeded — matches TaskListView.swift's
  // refresh button exactly.
  async function refresh(): Promise<void> {
    refreshButton.disabled = true;
    try {
      await callBackground({ type: 'refresh' });
    } catch {
      // Best-effort — a sync failure shouldn't block reloading whatever we already have.
    }
    await load();
    refreshButton.disabled = false;
  }

  resyncButton.addEventListener('click', () => void resyncCalendars());

  // Can take up to ~60s (Vercel maxDuration) — no client-side timeout, the
  // button just stays disabled/busy for however long the real sync takes.
  async function resyncCalendars(): Promise<void> {
    resyncButton.disabled = true;
    resyncStatus.hidden = false;
    resyncStatus.classList.remove('ai-cal-resync-error');
    resyncStatus.textContent = 'Resyncing all calendars…';
    try {
      const result = await callBackground<CalendarResyncResult>({ type: 'resyncCalendars' });
      const totals = result.calendars.reduce(
        (acc, cal) => ({
          created: acc.created + cal.created,
          updated: acc.updated + cal.updated,
          deleted: acc.deleted + cal.deleted,
        }),
        { created: 0, updated: 0, deleted: 0 }
      );
      const errors = result.calendars.filter((cal) => cal.status === 'error');
      let message = `Resynced ${result.calendars.length} calendar(s): +${totals.created} ~${totals.updated} -${totals.deleted}.`;
      if (result.truncatedByTimeBudget) message += ' Not finished — click again to continue.';
      if (errors.length > 0) {
        message += ` ${errors.length} error(s): ${errors.map((e) => e.errorMessage).join('; ')}`;
        resyncStatus.classList.add('ai-cal-resync-error');
      }
      resyncStatus.textContent = message;
      await load();
    } catch (err) {
      resyncStatus.classList.add('ai-cal-resync-error');
      resyncStatus.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      resyncButton.disabled = false;
    }
  }

  render();

  return {
    element: root,
    refresh: load, // cross-module callers (an applied approval, tasks_changed from chat) just need a reload, not a full Todoist re-sync
  };
}
