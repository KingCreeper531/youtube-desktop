import UIKit

/// Checks GitHub Releases for a newer iOS build. iOS doesn't let apps install
/// updates themselves, so the green Update button opens the download page.
final class Updater {
    var onChange: (() -> Void)?
    private(set) var status = "idle"
    private(set) var version: String?
    private var releaseURL = URL(string: "https://github.com/KingCreeper531/youtube-desktop/releases/latest")!
    private var timer: Timer?
    private var lastCheck = Date.distantPast
    private let current = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"

    func start() {
        check()
        timer = Timer.scheduledTimer(withTimeInterval: 30 * 60, repeats: true) { [weak self] _ in self?.check() }
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, Date().timeIntervalSince(self.lastCheck) > 10 * 60 else { return }
            self.check()
        }
    }

    func check() {
        guard status != "available" else { return }
        lastCheck = Date()
        var request = URLRequest(url: URL(string: "https://api.github.com/repos/KingCreeper531/youtube-desktop/releases/latest")!)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("RanchYouTube-iOS", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self, let data,
                  let release = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let tag = release["tag_name"] as? String else { return }
            let latest = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
            let assets = release["assets"] as? [[String: Any]] ?? []
            // The .ipa is added a few minutes after a release is published; only offer it once it's there.
            let hasIpa = assets.contains { (($0["name"] as? String) ?? "").lowercased().hasSuffix(".ipa") }
            if let page = release["html_url"] as? String, let url = URL(string: page) { self.releaseURL = url }
            DispatchQueue.main.async {
                if hasIpa && Updater.isNewer(latest, than: self.current) {
                    self.status = "available"
                    self.version = latest
                } else {
                    self.status = "latest"
                }
                self.onChange?()
            }
        }.resume()
    }

    func openReleasePage() {
        UIApplication.shared.open(releaseURL)
    }

    func stateJSON() -> String {
        var obj: [String: Any] = ["status": status, "current": current]
        if let version { obj["version"] = version }
        guard let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }

    static func isNewer(_ a: String, than b: String) -> Bool {
        let x = a.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
        let y = b.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let p = i < x.count ? x[i] : 0
            let q = i < y.count ? y[i] : 0
            if p != q { return p > q }
        }
        return false
    }
}
