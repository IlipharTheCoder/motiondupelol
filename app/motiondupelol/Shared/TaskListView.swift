import SwiftUI

// Top section of the new single-pane layout (2026-07-25 rebuild). View,
// create, and complete — no title/priority/deadline edit UI yet (the
// backend endpoint exists now, PATCH /api/tasks/{id}, but nothing here
// calls it), just a checkmark to mark a task done
// (POST /api/tasks/{id}/complete, added 2026-07-25).
struct TaskListView: View {
    var vm: TasksViewModel

    @State private var newTaskTitle = ""
    @State private var isLoading = false
    @State private var sortOption: TaskSortOption = .dueDate
    @FocusState private var composeFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                TextField("New task…", text: $newTaskTitle)
                    .textFieldStyle(.plain)
                    .focused($composeFocused)
                    .onSubmit(submitNewTask)
                Button(action: submitNewTask) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(canSubmitNewTask ? Color.blue : Color.secondary.opacity(0.35))
                }
                .buttonStyle(.plain)
                .disabled(!canSubmitNewTask)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider()

            List {
                Section {
                    if vm.tasks.isEmpty {
                        Text(vm.loadError ?? "No tasks")
                            .foregroundStyle(.secondary).font(.caption)
                    } else {
                        ForEach(sortOption.sorted(vm.tasks)) { task in
                            TaskItemRow(task: task, onComplete: { await vm.complete(id: task.id) })
                        }
                    }
                } header: {
                    HStack {
                        Text("Tasks")
                        Spacer()
                        Menu {
                            ForEach(TaskSortOption.allCases) { option in
                                Button {
                                    sortOption = option
                                } label: {
                                    if option == sortOption {
                                        Label(option.title, systemImage: "checkmark")
                                    } else {
                                        Text(option.title)
                                    }
                                }
                            }
                        } label: {
                            Label(sortOption.title, systemImage: "arrow.up.arrow.down")
                                .font(.caption2)
                        }
                        .menuStyle(.borderlessButton)
                        .fixedSize()
                        .foregroundStyle(.secondary)
                        Button {
                            guard !isLoading else { return }
                            isLoading = true
                            Task {
                                await vm.load()
                                isLoading = false
                            }
                        } label: {
                            Group {
                                if isLoading {
                                    ProgressView().controlSize(.mini)
                                } else {
                                    Image(systemName: "arrow.clockwise")
                                }
                            }
                            .frame(width: 14, height: 14)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                        .disabled(isLoading)
                    }
                }
            }
        }
    }

    private var canSubmitNewTask: Bool {
        !newTaskTitle.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func submitNewTask() {
        let trimmed = newTaskTitle.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        newTaskTitle = ""
        Task {
            if let created = try? await APIClient.shared.createTask(title: trimmed) {
                vm.tasks.insert(created, at: 0)
            } else {
                await vm.load()
            }
        }
    }
}

// MARK: - Task item row (tasks table)

private struct TaskItemRow: View {
    let task: TaskItem
    let onComplete: () async -> Void

    @State private var busy = false

    // Mirrors the backend's own completeTask precondition (lib/aiTasks.ts) —
    // only these two statuses can still be completed.
    private var canComplete: Bool {
        task.status == "unscheduled" || task.status == "scheduled"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title).font(.body)
                HStack(spacing: 5) {
                    statusChip
                    if let pri = task.priority {
                        Text(pri.capitalized)
                            .font(.caption2)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(priorityColor(pri).opacity(0.15))
                            .foregroundStyle(priorityColor(pri))
                            .clipShape(Capsule())
                    }
                    if let deadline = task.deadlineDate {
                        Text(deadline.formatted(.dateTime.month(.abbreviated).day()))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer()
            if canComplete {
                Button {
                    busy = true
                    Task {
                        await onComplete()
                        busy = false
                    }
                } label: {
                    Image(systemName: "checkmark.circle")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .disabled(busy)
            }
        }
        .padding(.vertical, 2)
        .opacity(busy ? 0.5 : 1)
    }

    private var statusChip: some View {
        let (label, color) = statusInfo(task.status)
        return Text(label)
            .font(.caption2)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(color.opacity(0.15))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    private func statusInfo(_ s: String) -> (String, Color) {
        switch s {
        case "unscheduled": return ("Unscheduled", Color.blue)
        case "scheduled":   return ("Scheduled", Color.green)
        case "completed":   return ("Completed", Color.secondary)
        case "discarded":   return ("Discarded", Color.red)
        default:            return (s.capitalized, Color.secondary)
        }
    }

    private func priorityColor(_ p: String) -> Color {
        switch p {
        case "critical": return .red
        case "high":     return .orange
        case "medium":   return Color(red: 0.8, green: 0.6, blue: 0)
        case "low":      return .secondary
        default:         return .secondary
        }
    }
}

// MARK: - Sort options (client-side only — GET /api/tasks has no sort param;
// vm.tasks is fetched once and re-sorted here on option change, not re-fetched)

private enum TaskSortOption: String, CaseIterable, Identifiable {
    case status
    case dueDate
    case priority

    var id: String { rawValue }

    var title: String {
        switch self {
        case .status:   return "Scheduled"
        case .dueDate:  return "Due Date"
        case .priority: return "Priority"
        }
    }

    // Lower number = sorts first. Matches this project's own convention
    // (backend's PRIORITY_RANK / TaskItemRow's statusInfo ordering above).
    private static let statusRank: [String: Int] = [
        "unscheduled": 0, "scheduled": 1, "completed": 2, "discarded": 3,
    ]
    private static let priorityRank: [String: Int] = [
        "critical": 0, "high": 1, "medium": 2, "low": 3,
    ]

    func sorted(_ tasks: [TaskItem]) -> [TaskItem] {
        switch self {
        case .status:
            return tasks.sorted {
                (Self.statusRank[$0.status] ?? 99) < (Self.statusRank[$1.status] ?? 99)
            }
        case .dueDate:
            // Tasks with no deadline sort last, regardless of direction.
            return tasks.sorted {
                switch ($0.deadlineDate, $1.deadlineDate) {
                case let (l?, r?): return l < r
                case (nil, nil):   return false
                case (nil, _):     return false
                case (_, nil):     return true
                }
            }
        case .priority:
            // Tasks with no priority sort last.
            return tasks.sorted {
                (Self.priorityRank[$0.priority ?? ""] ?? 99) < (Self.priorityRank[$1.priority ?? ""] ?? 99)
            }
        }
    }
}
