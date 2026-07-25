import SwiftUI

// Root view of the "calendar manager" rebuild (2026-07-25) — a single pane,
// three vertical sections, replacing the old NavigationSplitView (calendar
// grid detail pane + sprawling sidebar). This is the sole coordination
// point for the three view models: it wires refresh-after-action (a chat
// reply with proposals refreshes the approval queue; an applied change
// refreshes the task list) and the launch/foreground auto-refresh.
struct MainView: View {
    @State private var tasksVM = TasksViewModel()
    @State private var approvalsVM = ProposedChangesViewModel()
    @State private var chatVM = ChatViewModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 0) {
            TaskListView(vm: tasksVM)
            Divider()
            ApprovalQueueView(vm: approvalsVM)
            Divider()
            ChatInputView(vm: chatVM)
        }
        .navigationTitle("Calendar Manager")
        .task {
            chatVM.onProposalsReceived = { Task { await approvalsVM.refresh() } }
            approvalsVM.onApplied = { Task { await tasksVM.load() } }
            await tasksVM.load()
            await approvalsVM.refresh()
            approvalsVM.startPolling()
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                Task {
                    try? await APIClient.shared.refresh()
                    await tasksVM.load()
                    await approvalsVM.refresh()
                }
            } else {
                approvalsVM.stopPolling()
            }
        }
    }
}

#Preview {
    MainView()
        .frame(width: 480, height: 750)
}
