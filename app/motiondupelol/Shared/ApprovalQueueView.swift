import SwiftUI

// Middle section of the new single-pane layout (2026-07-25 rebuild).
// Auto-updates two ways: MainView calls vm.refresh() after any action that
// could change the queue (chat producing proposals, approve, reject), and
// vm itself polls independently every 25s while the app is active
// (ProposedChangesViewModel.startPolling) — see that file for the race
// this composition deliberately accepts rather than engineering around.
struct ApprovalQueueView: View {
    var vm: ProposedChangesViewModel

    @State private var isLoading = false

    var body: some View {
        List {
            Section {
                if vm.pendingChanges.isEmpty {
                    Text("No pending changes")
                        .foregroundStyle(.tertiary).font(.caption).italic()
                } else {
                    ForEach(vm.pendingChanges) { change in
                        PendingChangeRow(
                            change: change,
                            onApprove: { await vm.approve(id: change.id) },
                            onReject: { await vm.reject(id: change.id) },
                            onSetPriority: { priority in await vm.setPriority(id: change.id, priority: priority) }
                        )
                    }
                }
            } header: {
                HStack {
                    Text("Approval Queue")
                    Spacer()
                    Button {
                        guard !isLoading else { return }
                        isLoading = true
                        Task {
                            await vm.refresh()
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

// MARK: - Pending change row

private let PRIORITY_OPTIONS = ["critical", "high", "medium", "low"]

private struct PendingChangeRow: View {
    let change: ProposedChange
    let onApprove: () async -> Void
    let onReject: () async -> Void
    let onSetPriority: (String) async -> Void

    @State private var busy = false
    private let isFailed: Bool
    // Mirrors the backend's own isCalendarCreate gate (lib/proposedChanges.ts)
    // exactly — a real calendar-block create with no priority yet, which the
    // server refuses to approve (2026-07-25: priority deferred to review
    // time for chat-created proposals). A move never needs priority, and the
    // task-list-intake create shape (no start/end) means tasks.priority, a
    // separate concern — neither is gated here either.
    private let needsPriority: Bool

    init(
        change: ProposedChange,
        onApprove: @escaping () async -> Void,
        onReject: @escaping () async -> Void,
        onSetPriority: @escaping (String) async -> Void
    ) {
        self.change = change
        self.onApprove = onApprove
        self.onReject = onReject
        self.onSetPriority = onSetPriority
        self.isFailed = change.status == "failed"
        self.needsPriority = change.changeType == "create"
            && change.proposedStartDate != nil
            && change.proposedEndDate != nil
            && change.priority == nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {

            // ── Top row: change-type badge + optional failed badge + priority ──
            HStack(spacing: 5) {
                if let ct = change.changeType {
                    badge(ct.uppercased(), color: changeTypeColor(ct))
                }
                if isFailed {
                    badge("FAILED", color: .red)
                }
                Spacer()
                if let pri = change.priority {
                    Text(pri.capitalized)
                        .font(.system(.caption2, weight: .medium))
                        .foregroundStyle(priorityColor(pri))
                } else if needsPriority {
                    Menu {
                        ForEach(PRIORITY_OPTIONS, id: \.self) { option in
                            Button(option.capitalized) {
                                Task { await onSetPriority(option) }
                            }
                        }
                    } label: {
                        Label("Set priority", systemImage: "flag.badge.ellipsis")
                            .font(.system(.caption2, weight: .medium))
                    }
                    .disabled(busy)
                }
            }

            // ── Title ──────────────────────────────────────────────────────────
            Text(change.proposedSummary ?? change.message ?? "Proposed change")
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)

            // ── Time window ────────────────────────────────────────────────────
            if let start = change.proposedStartDate {
                HStack(spacing: 4) {
                    Image(systemName: "clock")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(timeLabel(start: start, end: change.proposedEndDate))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            // ── Reason ─────────────────────────────────────────────────────────
            if let reason = change.reason, !reason.isEmpty {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // ── Error message (failed only) ────────────────────────────────────
            if isFailed, let err = change.errorMessage, !err.isEmpty {
                HStack(alignment: .top, spacing: 4) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(.red)
                    Text(err)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.caption)
                .foregroundStyle(.red)
            }

            // ── Approve / Reject ───────────────────────────────────────────────
            if needsPriority {
                Text("Set a priority above before you can approve this.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                Button {
                    busy = true
                    Task {
                        await onApprove()
                        busy = false
                    }
                } label: {
                    Label(isFailed ? "Retry" : "Approve",
                          systemImage: isFailed ? "arrow.clockwise" : "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.mini)
                .disabled(busy || needsPriority)

                Button {
                    busy = true
                    Task {
                        await onReject()
                        busy = false
                    }
                } label: {
                    Label("Reject", systemImage: "xmark")
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .tint(.secondary)
                .disabled(busy)
            }
        }
        .padding(.vertical, 5)
        .opacity(busy ? 0.5 : 1)
    }

    @ViewBuilder
    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(.caption2, design: .default, weight: .bold))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.13))
            .foregroundStyle(color)
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    private func changeTypeColor(_ ct: String) -> Color {
        switch ct.lowercased() {
        case "create": return .green
        case "move":   return .blue
        case "update": return .orange
        case "delete": return .red
        default:       return .secondary
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

    private func timeLabel(start: Date, end: Date?) -> String {
        let s = start.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute())
        if let end {
            return "\(s) – \(end.formatted(.dateTime.hour().minute()))"
        }
        return s
    }
}
