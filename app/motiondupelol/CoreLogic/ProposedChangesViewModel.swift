import SwiftUI

@Observable
final class ProposedChangesViewModel {
    var pendingChanges: [ProposedChange] = []
    var isLoading = false

    // Fired after a successful approve — MainView uses this to also refresh
    // the task list, since an applied change can affect the tasks table.
    var onApplied: (() -> Void)?

    private var pollTask: Task<Void, Never>?

    // Fetches both "pending" and "failed" rows — a failed row is still
    // actionable (retry via approve, or reject to give up on it), so it
    // belongs in the same queue as pending ones, not hidden.
    func refresh() async {
        let pending = (try? await APIClient.shared.fetchProposedChanges(status: "pending")) ?? []
        let failed = (try? await APIClient.shared.fetchProposedChanges(status: "failed")) ?? []
        pendingChanges = pending + failed
    }

    // Applying can itself fail (a conflict/rule violation) — that comes back
    // as an ordinary 200 with status "failed", not a thrown error, so the
    // row gets updated in place rather than removed.
    func approve(id: String) async {
        guard let updated = try? await APIClient.shared.approveChange(id: id) else { return }
        if updated.status == "applied" {
            pendingChanges.removeAll { $0.id == id }
            onApplied?()
        } else if let idx = pendingChanges.firstIndex(where: { $0.id == id }) {
            pendingChanges[idx] = updated
        }
    }

    func reject(id: String) async {
        try? await APIClient.shared.rejectChange(id: id)
        pendingChanges.removeAll { $0.id == id }
    }

    // Review-time priority pick for a chat-created calendar-block proposal
    // (2026-07-25) — those always land with priority unset, and the server
    // refuses to approve one until this is called first.
    func setPriority(id: String, priority: String) async {
        guard let updated = try? await APIClient.shared.setProposedChangePriority(id: id, priority: priority) else { return }
        if let idx = pendingChanges.firstIndex(where: { $0.id == id }) {
            pendingChanges[idx] = updated
        }
    }

    // Plain async loop, not Timer.publish — this codebase's own convention
    // is @Observable, not Combine (see app CLAUDE.md). Catches changes this
    // client didn't cause itself (e.g. a server-side auto-applied proposal);
    // most changes are already caught immediately by refresh-after-action.
    func startPolling(interval: Duration = .seconds(25)) {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled else { return }
                await refresh()
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }
}
