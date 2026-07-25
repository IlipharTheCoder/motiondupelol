import SwiftUI

@Observable
final class TasksViewModel {
    var tasks: [TaskItem] = []
    var loadError: String?

    func load() async {
        do {
            tasks = try await APIClient.shared.fetchTasks()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    // Updates the row in place (status → "completed") rather than removing
    // it — fetchTasks() returns every status, and TaskItemRow already
    // renders a "Completed" chip, so there's no separate list to move it to.
    func complete(id: String) async {
        guard let updated = try? await APIClient.shared.completeTask(id: id) else { return }
        if let idx = tasks.firstIndex(where: { $0.id == id }) {
            tasks[idx] = updated
        }
    }
}
