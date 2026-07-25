import SwiftUI

// Bottom section of the new single-pane layout (2026-07-25 rebuild) — the
// single unified chat, replacing what used to be two independent
// implementations (SidebarView's and CalendarView's, two separate
// conversation threads). The backend has exactly two abilities here:
// propose a calendar create/move/delete, or find free time.
struct ChatInputView: View {
    var vm: ChatViewModel

    @State private var input = ""
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            if let usage = vm.lastUsage {
                UsageStatsBox(usage: usage, sessionCostUsd: vm.sessionCostUsd)
                Divider()
            }
            if !vm.history.isEmpty {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 6) {
                            ForEach(vm.history) { msg in
                                ChatBubble(message: msg)
                                    .id(msg.id)
                            }
                            Color.clear.frame(height: 1).id("chatBottom")
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                    }
                    .frame(maxHeight: 220)
                    .onChange(of: vm.history.count) { _, _ in
                        withAnimation(.easeOut(duration: 0.15)) {
                            proxy.scrollTo("chatBottom", anchor: .bottom)
                        }
                    }
                }
                Divider()
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Ask anything…", text: $input, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...4)
                    .focused($inputFocused)
                    .disabled(vm.isSending)
                    .onSubmit(send)
                Group {
                    if vm.isSending {
                        ProgressView().controlSize(.small)
                    } else {
                        Button(action: send) {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.title2)
                                .foregroundStyle(canSend ? Color.blue : Color.secondary.opacity(0.35))
                        }
                        .buttonStyle(.plain)
                        .disabled(!canSend)
                    }
                }
                .frame(width: 28)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
    }

    private var canSend: Bool {
        !input.trimmingCharacters(in: .whitespaces).isEmpty && !vm.isSending
    }

    private func send() {
        let text = input
        input = ""
        Task { await vm.send(text) }
    }
}

// MARK: - Usage stats box (salvaged from the old CalendarView)

private struct UsageStatsBox: View {
    let usage: ChatUsage
    let sessionCostUsd: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("API Usage")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 8, verticalSpacing: 2) {
                usageRow("In", value: "\(usage.inputTokens.formatted()) tok")
                usageRow("Out", value: "\(usage.outputTokens.formatted()) tok")
                if usage.cacheReadTokens > 0 {
                    usageRow("Cache hit", value: "\(usage.cacheReadTokens.formatted()) tok")
                }
                if usage.cacheCreation5mTokens + usage.cacheCreation1hTokens > 0 {
                    let total = usage.cacheCreation5mTokens + usage.cacheCreation1hTokens
                    usageRow("Cache write", value: "\(total.formatted()) tok")
                }
                usageRow("Last call", value: String(format: "$%.5f", usage.estimatedCostUsd))
                usageRow("Session", value: String(format: "$%.5f", sessionCostUsd))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.07))
    }

    @ViewBuilder
    private func usageRow(_ label: String, value: String) -> some View {
        GridRow {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Chat bubble

private struct ChatBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 32) }
            Text(message.text)
                .font(.callout)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    message.role == .user
                        ? Color.blue.opacity(0.85)
                        : Color.secondary.opacity(0.12)
                )
                .foregroundStyle(message.role == .user ? Color.white : Color.primary)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .fixedSize(horizontal: false, vertical: true)
            if message.role == .assistant { Spacer(minLength: 32) }
        }
    }
}
