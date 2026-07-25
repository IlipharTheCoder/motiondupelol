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
}
