import Foundation

struct ChatUsage: Decodable {
    let inputTokens: Int
    let outputTokens: Int
    let cacheCreation5mTokens: Int
    let cacheCreation1hTokens: Int
    let cacheReadTokens: Int
    let estimatedCostUsd: Double
}

struct ChatResponse: Decodable {
    let conversationId: String
    let reply: String
    let proposals: [ProposedChange]
    let usage: ChatUsage
}

struct APIClient {
    static let shared = APIClient()
    private init() {}

    private let baseURL = URL(string: Secrets.backendBaseURL)!
    private let apiKey = Secrets.backendAPIKey

    private func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    // Every POST request with an Encodable body goes through here. Add a new
    // endpoint by calling this with its path, body, and expected return type.
    private func post<T: Decodable, Body: Encodable>(_ path: String, body: Body) async throws -> T {
        var req = URLRequest(url: baseURL.appending(path: path))
        req.httpMethod = "POST"
        req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try decoder().decode(T.self, from: data)
    }

    // Fetches proposed_changes rows. appending(path:) percent-encodes "?" so query
    // params must go through URLComponents, not inline string concatenation.
    func fetchProposedChanges(status: String? = "pending") async throws -> [ProposedChange] {
        var components = URLComponents(url: baseURL.appending(path: "/api/proposed-changes"),
                                       resolvingAgainstBaseURL: false)!
        if let status {
            components.queryItems = [URLQueryItem(name: "status", value: status)]
        }
        var req = URLRequest(url: components.url!)
        req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.server(message: "No HTTP response")
        }
        switch http.statusCode {
        case 200..<300:
            do { return try decoder().decode([ProposedChange].self, from: data) }
            catch { throw APIError.decoding(error) }
        case 401: throw APIError.unauthorized
        default:
            let msg = (try? decoder().decode([String: String].self, from: data))?["error"] ?? "Fetch failed"
            throw APIError.server(message: msg)
        }
    }

    // Returns the updated row so the caller can inspect status:
    //   "applied" → the change was written to the calendar
    //   "failed"  → conflict or rule violation (HTTP 200 but nothing written — check errorMessage)
    func approveChange(id: String) async throws -> ProposedChange {
        var req = URLRequest(url: baseURL.appending(path: "/api/proposed-changes/\(id)/approve"))
        req.httpMethod = "POST"
        req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.server(message: "No HTTP response")
        }
        switch http.statusCode {
        case 200..<300:
            do { return try decoder().decode(ProposedChange.self, from: data) }
            catch { throw APIError.decoding(error) }
        case 401: throw APIError.unauthorized
        default:
            let msg = (try? decoder().decode([String: String].self, from: data))?["error"] ?? "Approve failed"
            throw APIError.server(message: msg)
        }
    }

    func rejectChange(id: String) async throws {
        var req = URLRequest(url: baseURL.appending(path: "/api/proposed-changes/\(id)/reject"))
        req.httpMethod = "POST"
        req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.server(message: "No HTTP response")
        }
        switch http.statusCode {
        case 200..<300: return
        case 401: throw APIError.unauthorized
        default:
            let msg = (try? decoder().decode([String: String].self, from: data))?["error"] ?? "Reject failed"
            throw APIError.server(message: msg)
        }
    }

    // Sends a message in the NL chat layer. Pass the last conversationId to
    // continue a thread; nil starts fresh. Stale ids are silently reset server-side.
    func chat(message: String, conversationId: String?) async throws -> ChatResponse {
        var body: [String: Any] = ["message": message]
        if let cid = conversationId { body["conversation_id"] = cid }

        var req = URLRequest(url: baseURL.appending(path: "/api/chat"))
        req.httpMethod = "POST"
        req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.server(message: "No HTTP response")
        }
        switch http.statusCode {
        case 200..<300:
            do { return try decoder().decode(ChatResponse.self, from: data) }
            catch { throw APIError.decoding(error) }
        case 401:
            throw APIError.unauthorized
        default:
            let msg = (try? decoder().decode([String: String].self, from: data))?["error"] ?? "Chat failed"
            throw APIError.server(message: msg)
        }
    }

    // Fetches tasks rows. Uses URLComponents so the optional status param is
    // safely appended without percent-encoding issues.
    func fetchTasks(status: String? = nil) async throws -> [TaskItem] {
        var components = URLComponents(url: baseURL.appending(path: "/api/tasks"),
                                       resolvingAgainstBaseURL: false)!
        if let status {
            components.queryItems = [URLQueryItem(name: "status", value: status)]
        }
        var req = URLRequest(url: components.url!)
        req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.server(message: "No HTTP response")
        }
        switch http.statusCode {
        case 200..<300:
            do { return try decoder().decode([TaskItem].self, from: data) }
            catch { throw APIError.decoding(error) }
        case 401: throw APIError.unauthorized
        default:
            let msg = (try? decoder().decode([String: String].self, from: data))?["error"] ?? "Fetch tasks failed"
            throw APIError.server(message: msg)
        }
    }

    private struct CreateTaskBody: Encodable { let title: String }

    func createTask(title: String) async throws -> TaskItem {
        try await post("/api/tasks", body: CreateTaskBody(title: title))
    }

    // Combined calendar + Todoist sync (POST /api/refresh). Called automatically
    // on launch/foreground (see MainView) — never a user-facing button. The
    // response has union-typed calendar/todoist fields nothing in the UI
    // reads, so we only confirm success rather than modeling the body.
    func refresh() async throws {
        var req = URLRequest(url: baseURL.appending(path: "/api/refresh"))
        req.httpMethod = "POST"
        req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.server(message: "No HTTP response")
        }
        switch http.statusCode {
        case 200..<300: return
        case 401: throw APIError.unauthorized
        default:
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "Refresh failed"
            throw APIError.server(message: message)
        }
    }
}
