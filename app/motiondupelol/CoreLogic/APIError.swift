import Foundation

enum APIError: Error, LocalizedError {
    case unauthorized
    case server(message: String)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .unauthorized:         return "Unauthorized — check your API key"
        case .server(let msg):      return "Server error: \(msg)"
        case .decoding(let err):    return "Decoding error: \(err.localizedDescription)"
        }
    }
}
