import EventKit
import Foundation

@main
struct MacCalendarReader {
    static func writeJSON(_ value: Any) throws {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
    }

    static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data(message.utf8))
        exit(2)
    }

    static func status() -> String {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return "fullAccess"
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .writeOnly: return "writeOnly"
        case .authorized: return "fullAccess"
        @unknown default: return "unknown"
        }
    }

    static func main() async {
        let arguments = CommandLine.arguments
        guard arguments.count >= 2 else { fail("Missing command") }
        let store = EKEventStore()
        let command = arguments[1]
        do {
            if command == "status" {
                try writeJSON(["status": status()])
                return
            }
            if command == "authorize" {
                if status() == "notDetermined" {
                    if #available(macOS 14, *) {
                        _ = try await store.requestFullAccessToEvents()
                    } else {
                        _ = try await store.requestAccess(to: .event)
                    }
                }
                try writeJSON(["status": status()])
                return
            }
            guard status() == "fullAccess" else {
                fail("Calendar permission required. Enable full access in System Settings > Privacy & Security > Calendars.")
            }
            if command == "calendars" {
                let calendars = store.calendars(for: .event).map { calendar in
                    ["id": calendar.calendarIdentifier,
                     "title": calendar.title,
                     "source": calendar.source.title]
                }
                try writeJSON(["calendars": calendars])
                return
            }
            guard command == "events", arguments.count == 5 else { fail("Invalid events arguments") }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime]
            guard let start = formatter.date(from: arguments[2]),
                  let end = formatter.date(from: arguments[3]), end > start else {
                fail("Invalid date range")
            }
            let selected = Set(arguments[4].split(separator: ",").map(String.init))
            let calendars = store.calendars(for: .event).filter { selected.contains($0.calendarIdentifier) }
            guard !calendars.isEmpty, calendars.count == selected.count else { fail("Calendar selection is invalid") }
            let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
            let outputFormatter = ISO8601DateFormatter()
            outputFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let events = store.events(matching: predicate).map { event -> [String: Any] in
                let declined = event.attendees?.contains(where: {
                    $0.isCurrentUser && $0.participantStatus == .declined
                }) ?? false
                return ["id": event.eventIdentifier ?? event.calendarItemIdentifier,
                        "calendarId": event.calendar.calendarIdentifier,
                        "title": event.title ?? "",
                        "start": outputFormatter.string(from: event.startDate),
                        "end": outputFormatter.string(from: event.endDate),
                        "allDay": event.isAllDay,
                        "canceled": event.status == .canceled,
                        "declined": declined,
                        "free": event.availability == .free,
                        "hasAttendees": event.hasAttendees]
            }
            try writeJSON(["events": events])
        } catch {
            fail("Calendar access failed: \(error.localizedDescription)")
        }
    }
}
