// Test-Stubs: bilden Capacitor und die iCloud-APIs nach, damit die Dateilogik
// von SeeYouStoragePlugin.swift auf Linux ausgeführt werden kann.
import Foundation
typealias NSErrorPointer = UnsafeMutablePointer<NSError?>?
public typealias PluginCallResultData = [String: Any]
public let CAPPluginReturnPromise = "promise"
public final class CAPPluginMethod { public init(name: String, returnType: String) {} }
public protocol CAPBridgedPlugin { var identifier: String { get }; var jsName: String { get }; var pluginMethods: [CAPPluginMethod] { get } }
open class CAPPlugin { public init() {} }
// Aufzeichnender Call: wartet synchron auf resolve/reject
open class CAPPluginCall {
    var opts: [String: String]
    var result: [String: Any]? = nil
    var error: (String, String?)? = nil
    let sem = DispatchSemaphore(value: 0)
    init(_ opts: [String: String]) { self.opts = opts }
    public func getString(_ key: String) -> String? { opts[key] }
    public func resolve() { result = [:]; sem.signal() }
    public func resolve(_ data: PluginCallResultData) { result = data; sem.signal() }
    public func reject(_ message: String, _ code: String? = nil, _ error: Error? = nil, _ data: PluginCallResultData? = nil) { self.error = (message, code); sem.signal() }
    func wait() -> Self { sem.wait(); return self }
}
// Simuliertes iCloud: ein Ordner, den eine Umgebungsvariable an-/abschaltet
let fakeCloud = URL(fileURLWithPath: ProcessInfo.processInfo.environment["FAKE_CLOUD"]!)
var cloudOn = true
extension FileManager {
    var ubiquityIdentityToken: NSString? { cloudOn ? "token" : nil }
    func url(forUbiquityContainerIdentifier id: String?) -> URL? { cloudOn ? fakeCloud : nil }
    func startDownloadingUbiquitousItem(at url: URL) throws {
        let ph = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
        if fileExists(atPath: ph.path) { try moveItem(at: ph, to: url) } // "Download" = Platzhalter wird zur Datei
    }
    func setUbiquitous(_ flag: Bool, itemAt url: URL, destinationURL: URL) throws { try moveItem(at: url, to: destinationURL) }
}
final class NSFileCoordinator {
    struct ReadingOptions: OptionSet { let rawValue: Int }
    struct WritingOptions: OptionSet { let rawValue: Int; static let forReplacing = WritingOptions(rawValue: 1); static let forDeleting = WritingOptions(rawValue: 2) }
    func coordinate(writingItemAt url: URL, options: WritingOptions = [], error: NSErrorPointer, byAccessor: (URL) -> Void) { byAccessor(url) }
    func coordinate(readingItemAt url: URL, options: ReadingOptions = [], error: NSErrorPointer, byAccessor: (URL) -> Void) { byAccessor(url) }
}
