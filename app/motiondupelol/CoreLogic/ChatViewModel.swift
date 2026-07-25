import SwiftUI

struct ChatMessage: Identifiable {
    let id = UUID()
    let role: Role
    let text: String
    enum Role { case user, assistant }
}

// Unifies what used to be two separate, non-communicating chat
// implementations (SidebarView's and CalendarView's — two separate
// conversation threads) into one (2026-07-25 rebuild).
@Observable
final class ChatViewModel {
    var history: [ChatMessage] = []
    var conversationId: String?
    var isSending = false
    var lastUsage: ChatUsage?
    var sessionCostUsd: Double = 0

    // Fired when a reply's `proposals` array is non-empty — the approval
    // queue almost certainly changed.
    var onProposalsReceived: (() -> Void)?

    // Fired when `tasksChanged` comes back true — create_task/unassign_task
    // (2026-07-25) mutate the tasks table directly with no proposal to carry
    // the signal, unlike propose_calendar_change/assign_task_to_event.
    var onTasksChanged: (() -> Void)?

    func send(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        isSending = true
        history.append(ChatMessage(role: .user, text: trimmed))
        do {
            let response = try await APIClient.shared.chat(message: trimmed, conversationId: conversationId)
            conversationId = response.conversationId
            history.append(ChatMessage(role: .assistant, text: response.reply))
            lastUsage = response.usage
            sessionCostUsd += response.usage.estimatedCostUsd
            if !response.proposals.isEmpty {
                onProposalsReceived?()
            }
            if response.tasksChanged {
                onTasksChanged?()
            }
        } catch {
            history.append(ChatMessage(role: .assistant, text: "Error: \(error.localizedDescription)"))
        }
        isSending = false
    }
}
