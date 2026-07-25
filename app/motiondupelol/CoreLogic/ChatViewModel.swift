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
        } catch {
            history.append(ChatMessage(role: .assistant, text: "Error: \(error.localizedDescription)"))
        }
        isSending = false
    }
}
