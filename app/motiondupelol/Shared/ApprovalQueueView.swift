import SwiftUI

// Middle section of the new single-pane layout (2026-07-25 rebuild).
// Auto-updates two ways: MainView calls vm.refresh() after any action that
// could change the queue (chat producing proposals, approve, reject), and
// vm itself polls independently every 25s while the app is active
// (ProposedChangesViewModel.startPolling) — see that file for the race
// this composition deliberately accepts rather than engineering around.
//
// Rows rendered as a single Grid (added 2026-07-25, replacing a tall
// per-change VStack card) for a genuinely table-style, column-aligned,
// compact layout — same Grid + @ViewBuilder-row-function pattern already
// used by ChatInputView's UsageStatsBox in this codebase. Reason/error text
// is truncated to one line as part of this compactness tradeoff; tap
// behavior (approve/reject/set-priority) is unchanged.
struct ApprovalQueueView: View {
    var vm: ProposedChangesViewModel

    @State private var isLoading = false
    // Per-row busy tracking — a plain Set instead of a per-row @State, since
    // rows are now @ViewBuilder function calls, not separate View structs.
    @State private var busyIds: Set<String> = []

    var body: some View {
        List {
            Section {
                if vm.pendingChanges.isEmpty {
                    Text("No pending changes")
                        .foregroundStyle(.tertiary).font(.caption).italic()
                } else {
                    Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 6) {
                        ForEach(vm.pendingChanges) { change in
                            changeRow(change)
                        }
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

    // MARK: - One table row: [type badge] [title + secondary line] [priority] [actions]

    @ViewBuilder
    private func changeRow(_ change: ProposedChange) -> some View {
        let isFailed = change.status == "failed"
        // Mirrors the backend's own isCalendarCreate gate (lib/proposedChanges.ts)
        // exactly — a real calendar-block create with no priority yet, which the
        // server refuses to approve (2026-07-25: priority deferred to review
        // time for chat-created proposals). A move never needs priority, and the
        // task-list-intake create shape (no start/end) means tasks.priority, a
        // separate concern — neither is gated here either.
        let needsPriority = change.changeType == "create"
            && change.proposedStartDate != nil
            && change.proposedEndDate != nil
            && change.priority == nil
        let busy = busyIds.contains(change.id)

        GridRow(alignment: .center) {
            if let ct = change.changeType {
                badge(ct.uppercased(), color: changeTypeColor(ct))
            } else {
                EmptyView()
            }

            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    Text(change.proposedSummary ?? change.message ?? "Proposed change")
                        .font(.subheadline)
                        .lineLimit(1)
                    if isFailed {
                        badge("FAILED", color: .red)
                    }
                }
                if let secondary = secondaryLine(change, isFailed: isFailed) {
                    Text(secondary)
                        .font(.caption2)
                        .foregroundStyle(isFailed ? .red : .secondary)
                        .lineLimit(1)
                }
            }

            if let pri = change.priority {
                Text(pri.capitalized)
                    .font(.system(.caption2, weight: .medium))
                    .foregroundStyle(priorityColor(pri))
            } else if needsPriority {
                Menu {
                    ForEach(PRIORITY_OPTIONS, id: \.self) { option in
                        Button(option.capitalized) {
                            Task { await vm.setPriority(id: change.id, priority: option) }
                        }
                    }
                } label: {
                    Image(systemName: "flag.badge.ellipsis")
                        .font(.caption)
                }
                .disabled(busy)
            } else {
                EmptyView()
            }

            HStack(spacing: 4) {
                Button {
                    runApprove(change.id)
                } label: {
                    Image(systemName: isFailed ? "arrow.clockwise" : "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(busy || needsPriority)
                .help(needsPriority ? "Set a priority before approving" : (isFailed ? "Retry" : "Approve"))

                Button {
                    runReject(change.id)
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.secondary)
                .disabled(busy)
                .help("Reject")
            }
        }
        .padding(.vertical, 3)
        .opacity(busy ? 0.5 : 1)
    }

    private func secondaryLine(_ change: ProposedChange, isFailed: Bool) -> String? {
        if isFailed, let err = change.errorMessage, !err.isEmpty { return err }
        var parts: [String] = []
        if let start = change.proposedStartDate {
            parts.append(timeLabel(start: start, end: change.proposedEndDate))
        }
        if let reason = change.reason, !reason.isEmpty {
            parts.append(reason)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func runApprove(_ id: String) {
        busyIds.insert(id)
        Task {
            await vm.approve(id: id)
            busyIds.remove(id)
        }
    }

    private func runReject(_ id: String) {
        busyIds.insert(id)
        Task {
            await vm.reject(id: id)
            busyIds.remove(id)
        }
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

private let PRIORITY_OPTIONS = ["critical", "high", "medium", "low"]
