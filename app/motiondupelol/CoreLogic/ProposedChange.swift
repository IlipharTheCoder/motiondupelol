import Foundation

// Shared ISO8601 parsing, used by the computed date properties below —
// centralizes what used to be duplicated private `parseISO` helpers in
// SidebarView's TaskItemRow and PendingChangeRow (2026-07-25 rebuild).
func parseISODate(_ str: String) -> Date? {
    let f = ISO8601DateFormatter()
    if let d = f.date(from: str) { return d }
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.date(from: str)
}

// Mirrors the tasks table row. Decoded with convertFromSnakeCase.
struct TaskItem: Codable, Identifiable {
    let id: String
    let title: String
    let description: String?
    let deadline: String?
    let priority: String?           // critical | high | medium | low | null
    let tags: [String]
    let sourceSystem: String?       // todoist | canvas | manual
    let status: String              // unscheduled | scheduled | completed | discarded
    let scheduledEventId: String?
    let durationMinutes: Int?
    let createdAt: String?

    var deadlineDate: Date? { deadline.flatMap(parseISODate) }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id               = try c.decode(String.self,            forKey: .id)
        title            = try c.decode(String.self,            forKey: .title)
        description      = try c.decodeIfPresent(String.self,   forKey: .description)
        deadline         = try c.decodeIfPresent(String.self,   forKey: .deadline)
        priority         = try c.decodeIfPresent(String.self,   forKey: .priority)
        tags             = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        sourceSystem     = try c.decodeIfPresent(String.self,   forKey: .sourceSystem)
        status           = try c.decode(String.self,            forKey: .status)
        scheduledEventId = try c.decodeIfPresent(String.self,   forKey: .scheduledEventId)
        durationMinutes  = try c.decodeIfPresent(Int.self,      forKey: .durationMinutes)
        createdAt        = try c.decodeIfPresent(String.self,   forKey: .createdAt)
    }
}

// Mirrors the proposed_changes table row.
// Decoded with convertFromSnakeCase, so change_type → changeType, etc.
struct ProposedChange: Codable, Identifiable {
    let id: String
    let status: String              // pending | applied | rejected | failed
    let changeType: String?         // create | move | update | delete
    let proposedSummary: String?    // event / task title
    let proposedStart: String?      // ISO datetime
    let proposedEnd: String?        // ISO datetime
    let category: String?           // task | habit | focusTime | meeting | fixed | buffer | personal
    let priority: String?           // critical | high | medium | low
    let reason: String?             // human-readable justification from the engine
    let errorMessage: String?       // populated when status == "failed"
    let message: String?            // plain-language status summary from describeProposalOutcome
    let proposalGroupId: String?
    let createdAt: String?

    var proposedStartDate: Date? { proposedStart.flatMap(parseISODate) }
    var proposedEndDate: Date? { proposedEnd.flatMap(parseISODate) }
}
