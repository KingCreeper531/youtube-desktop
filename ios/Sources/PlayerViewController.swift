import UIKit
import WebKit
import CryptoKit

/// Mobile YouTube in a WebView with the app's page script (Web/inject.js):
/// ad removal, SponsorBlock, dislike counts, background play and a green Update button.
final class PlayerViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    private static let home = URL(string: "https://m.youtube.com/")!
    private static let userAgent =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
    /// SponsorBlock categories that get skipped
    private static let categories = ["sponsor", "selfpromo", "interaction"]

    private var web: WKWebView!
    private let updater = Updater()
    private var isPlaying = false
    private var pendingURL: URL?
    private var ready = false

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.06, green: 0.06, blue: 0.06, alpha: 1)

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true

        let content = config.userContentController
        content.addScriptMessageHandler(WeakReplyHandler(self), contentWorld: .page, name: "rt")
        // The page script patches the page's own JavaScript, so it runs in the page world before YouTube's scripts.
        content.addUserScript(WKUserScript(source: Self.pageScript(),
                                           injectionTime: .atDocumentStart,
                                           forMainFrameOnly: true,
                                           in: .page))

        web = WKWebView(frame: .zero, configuration: config)
        web.customUserAgent = Self.userAgent
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.isOpaque = false
        web.backgroundColor = view.backgroundColor
        web.scrollView.backgroundColor = view.backgroundColor
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        // Block ad and tracking servers, then load the page.
        AdBlocker.install(into: content) { [weak self] in
            guard let self else { return }
            self.ready = true
            self.web.load(URLRequest(url: self.pendingURL ?? Self.home))
            self.pendingURL = nil
        }

        updater.onChange = { [weak self] in self?.pushUpdateState() }
        updater.start()

        NotificationCenter.default.addObserver(self, selector: #selector(didEnterBackground),
                                               name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    /// Opened from a link (ranchyt://watch?v=…, or a YouTube link shared to the app).
    func open(_ url: URL) {
        var target = Self.home
        if url.scheme == "ranchyt" {
            var c = URLComponents(string: "https://m.youtube.com/")!
            c.path = "/" + [url.host, url.path].compactMap { $0 }.joined().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            c.query = url.query
            if let u = c.url, c.path != "/" { target = u }
        } else if Self.isInternal(url) {
            target = url
        }
        // Before the first page load (ad rules still compiling), remember it for then
        guard ready else { pendingURL = target; return }
        web.load(URLRequest(url: target))
    }

    private static func pageScript() -> String {
        guard let url = Bundle.main.url(forResource: "inject", withExtension: "js"),
              let js = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return js
    }

    // MARK: - Messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else {
            return replyHandler(nil, nil)
        }
        switch type {
        case "state":
            isPlaying = body["playing"] as? Bool ?? false
            replyHandler(nil, nil)
        case "segments":
            guard let id = Self.videoId(body["id"]) else { return replyHandler([], nil) }
            loadSegments(for: id) { replyHandler($0, nil) }
        case "votes":
            guard let id = Self.videoId(body["id"]) else { return replyHandler(nil, nil) }
            loadVotes(for: id) { replyHandler($0, nil) }
        case "update":
            updater.openReleasePage()
            replyHandler(nil, nil)
        default:
            replyHandler(nil, nil)
        }
    }

    private static func videoId(_ any: Any?) -> String? {
        guard let id = any as? String, id.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil else { return nil }
        return id
    }

    private func pushUpdateState() {
        web?.evaluateJavaScript("window.__rtUpdate && window.__rtUpdate(\(updater.stateJSON()));")
    }

    // MARK: - SponsorBlock

    /// Asks with only the first 4 characters of the video ID's hash, so the server never learns which video you watch.
    private func loadSegments(for videoId: String, done: @escaping ([[String: Any]]) -> Void) {
        let hash = SHA256.hash(data: Data(videoId.utf8)).map { String(format: "%02x", $0) }.joined()
        let cats = Self.categories.map { "\"\($0)\"" }.joined(separator: ",")
        var c = URLComponents(string: "https://sponsor.ajay.app/api/skipSegments/\(hash.prefix(4))")!
        c.queryItems = [URLQueryItem(name: "categories", value: "[\(cats)]")]
        guard let url = c.url else { return done([]) }
        URLSession.shared.dataTask(with: url) { data, response, _ in
            var out: [[String: Any]] = []
            if (response as? HTTPURLResponse)?.statusCode == 200, let data,
               let videos = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
               let mine = videos.first(where: { ($0["videoID"] as? String) == videoId }),
               let segs = mine["segments"] as? [[String: Any]] {
                for s in segs {
                    guard let range = s["segment"] as? [Double], range.count == 2 else { continue }
                    if let action = s["actionType"] as? String, action != "skip" { continue }
                    out.append(["start": range[0], "end": range[1],
                                "category": s["category"] as? String ?? "sponsor",
                                "uuid": s["UUID"] as? String ?? UUID().uuidString])
                }
            }
            DispatchQueue.main.async { done(out) }
        }.resume()
    }

    // MARK: - Return YouTube Dislike

    private func loadVotes(for videoId: String, done: @escaping ([String: Any]?) -> Void) {
        guard let url = URL(string: "https://returnyoutubedislikeapi.com/votes?videoId=\(videoId)") else { return done(nil) }
        URLSession.shared.dataTask(with: url) { data, response, _ in
            var out: [String: Any]?
            if (response as? HTTPURLResponse)?.statusCode == 200, let data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                out = ["likes": (obj["likes"] as? NSNumber)?.intValue ?? 0,
                       "dislikes": (obj["dislikes"] as? NSNumber)?.intValue ?? 0]
            }
            DispatchQueue.main.async { done(out) }
        }.resume()
    }

    // MARK: - Background play

    /// iOS pauses web video when the app goes to the background; start it again so it keeps playing.
    @objc private func didEnterBackground() {
        guard isPlaying else { return }
        for delay in [0.3, 1.0, 2.5] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.web.evaluateJavaScript("(function(){var v=document.querySelector('video'); if (v && v.paused) { v.play(); }})();")
            }
        }
    }

    // MARK: - Navigation

    static func isInternal(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        if host == "music.youtube.com" { return false } // that's the YouTube Music app's job
        let allowed = ["youtube.com", "youtu.be", "google.com", "gstatic.com", "googleusercontent.com", "youtube-nocookie.com", "ggpht.com", "ytimg.com"]
        return allowed.contains { host == $0 || host.hasSuffix("." + $0) } || host.hasPrefix("accounts.google.")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "about" || scheme == "blob" || scheme == "data" { return decisionHandler(.allow) }
        if (scheme == "https" || scheme == "http") && Self.isInternal(url) { return decisionHandler(.allow) }
        if navigationAction.targetFrame?.isMainFrame ?? true, scheme == "https" || scheme == "http" {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    // Links that want a new window open in the same view (or in Safari if they leave YouTube).
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if Self.isInternal(url) { webView.load(URLRequest(url: url)) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pushUpdateState()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload() // iOS closed the page in the background; bring it back
    }
}

/// Avoids a retain cycle between the WebView and its message handler.
private final class WeakReplyHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: WKScriptMessageHandlerWithReply?
    init(_ target: WKScriptMessageHandlerWithReply) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let target else { return replyHandler(nil, nil) }
        target.userContentController(controller, didReceive: message, replyHandler: replyHandler)
    }
}
