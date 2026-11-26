// 0.13.2: the iPhone and iPad app's own native side. Most of the app's "native" work on iOS is
// TypeScript (src/ios/native.ts); this is only what a web view can't do by itself:
//
// - a hidden browser on a shop's own website, as Android has (StoreWeb.java): load a page, run a
//   script in it. The TypeScript side builds the requests and the page reading on top of these two.
// - the shop's website on screen (signing in, picking a branch, passing an "are you a person" check);
// - a folder the person picks in Files (iCloud Drive, or another app's), kept with a bookmark, and
//   reading and writing files in it;
// - the keychain, for a few secrets (a Home Assistant token, sync keys).
//
// The TypeScript side asks whether this plugin is there (Capacitor.isPluginAvailable) and carries on
// without it when it isn't.

import Capacitor
import Foundation
import Security
import UIKit
import UniformTypeIdentifiers
import WebKit

/// The app's own view controller: Capacitor's, plus this app's plugin.
class RestockViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        let plugin = RestockApplePlugin()
        bridge?.registerPluginInstance(plugin)
        RestockBackground.plugin = plugin
    }
}

private let restockSafariAgent =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

// MARK: - A hidden browser page

final class RestockHiddenWeb: NSObject, WKNavigationDelegate {
    let web: WKWebView
    private var onLoad: ((Int, String) -> Void)?
    private var status = 200
    private var pending: DispatchWorkItem?

    init(host: UIView?) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = .all
        web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: config)
        super.init()
        web.navigationDelegate = self
        web.isUserInteractionEnabled = false
        web.customUserAgent = restockSafariAgent
        // Behind everything else, so its scripts and timers run as they would on screen.
        host?.insertSubview(web, at: 0)
    }

    func load(_ url: URL, timeout: TimeInterval, done: @escaping (Int, String) -> Void) {
        finish(-1)
        status = 200
        onLoad = done
        let item = DispatchWorkItem { [weak self] in self?.finish(nil) }
        pending = item
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: item)
        web.load(URLRequest(url: url))
    }

    private func finish(_ code: Int?) {
        pending?.cancel()
        pending = nil
        guard let done = onLoad else { return }
        onLoad = nil
        done(code ?? status, web.url?.absoluteString ?? "")
    }

    func close() {
        finish(-1)
        web.stopLoading()
        web.navigationDelegate = nil
        web.removeFromSuperview()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse {
            status = http.statusCode
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finish(nil)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(0)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(0)
    }
}

// MARK: - A shop's website on screen

final class RestockShopBrowser: UIViewController, WKNavigationDelegate, WKUIDelegate {
    var startURL: URL?
    var message: String = ""
    /// Hosts the page may go to (each covers its subdomains). Empty: anywhere.
    var allowed: [String] = []
    /// A page address that closes the browser by itself (picking a branch).
    var closeOn: NSRegularExpression?
    var onClose: ((String, Bool) -> Void)?
    /// A script run in each of the shop's own pages once it has loaded (recording a trolley).
    var script: String = ""
    /// Evaluated in the shop's own page when Done is tapped; what it gives is kept in `value`.
    var readOnDone: String = ""
    var value: String = ""

    private var web: WKWebView?
    private var closed = false
    private var watch: Timer?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.systemBackground
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(doneTapped))
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Back", style: .plain, target: self, action: #selector(backTapped))
        navigationItem.title = startURL?.host ?? "Shop"

        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.default()
        let page = WKWebView(frame: .zero, configuration: config)
        page.navigationDelegate = self
        page.uiDelegate = self
        page.customUserAgent = restockSafariAgent
        page.allowsBackForwardNavigationGestures = true
        page.translatesAutoresizingMaskIntoConstraints = false
        web = page

        let note = UILabel()
        note.text = message
        note.numberOfLines = 0
        note.font = UIFont.preferredFont(forTextStyle: .footnote)
        note.textColor = UIColor.secondaryLabel
        note.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(note)
        view.addSubview(page)
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            note.topAnchor.constraint(equalTo: guide.topAnchor, constant: message.isEmpty ? 0 : 8),
            note.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
            note.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),
            page.topAnchor.constraint(equalTo: note.bottomAnchor, constant: message.isEmpty ? 0 : 8),
            page.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            page.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            page.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        if let url = startURL {
            page.load(URLRequest(url: url))
        }
        // While it's open, look at the address once a second too (a site that changes it without loading a new page).
        if closeOn != nil {
            watch = Timer.scheduledTimer(timeInterval: 1.0, target: self, selector: #selector(watchTick), userInfo: nil, repeats: true)
        }
    }

    @objc private func watchTick() {
        checkAddress()
    }

    @objc private func doneTapped() {
        // Read back from the page before it goes, and only from the shop's own site.
        guard !readOnDone.isEmpty, let page = web, hostAllowed(page.url?.host) else {
            finish(matched: false)
            return
        }
        page.evaluateJavaScript(readOnDone) { [weak self] result, _ in
            self?.value = (result as? String) ?? ""
            self?.finish(matched: false)
        }
    }

    @objc private func backTapped() {
        if let page = web, page.canGoBack {
            page.goBack()
        }
    }

    private func finish(matched: Bool) {
        if closed { return }
        closed = true
        watch?.invalidate()
        watch = nil
        let at = web?.url?.absoluteString ?? ""
        let done = onClose
        onClose = nil
        dismiss(animated: true) {
            done?(at, matched)
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Dismissed some other way than Done (not merely covered by something it presented itself).
        let going = isBeingDismissed || (navigationController?.isBeingDismissed ?? false)
        if going && !closed {
            closed = true
            watch?.invalidate()
            watch = nil
            let done = onClose
            onClose = nil
            done?(web?.url?.absoluteString ?? "", false)
        }
    }

    private func hostAllowed(_ host: String?) -> Bool {
        if allowed.isEmpty { return true }
        guard let h = host?.lowercased() else { return false }
        for a in allowed {
            let want = a.lowercased()
            if h == want || h.hasSuffix("." + want) { return true }
        }
        return false
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let main = navigationAction.targetFrame?.isMainFrame ?? true
        let scheme = url.scheme?.lowercased() ?? ""
        if main && (scheme == "http" || scheme == "https") {
            if !hostAllowed(url.host) {
                // Somewhere other than the shop's own site: Safari opens it, Restock's browser stays put.
                decisionHandler(.cancel)
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
                return
            }
            if let rule = closeOn {
                let text = url.absoluteString
                if rule.firstMatch(in: text, options: [], range: NSRange(location: 0, length: (text as NSString).length)) != nil {
                    decisionHandler(.allow)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                        self?.finish(matched: true)
                    }
                    return
                }
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        navigationItem.title = webView.url?.host ?? navigationItem.title
        if !script.isEmpty && hostAllowed(webView.url?.host) {
            webView.evaluateJavaScript(script, completionHandler: nil)
        }
        checkAddress()
    }

    /// Closes by itself once the page's address is the one waited for (a site that changes its address without loading a new page).
    func checkAddress() {
        guard let rule = closeOn, !closed else { return }
        let text = web?.url?.absoluteString ?? ""
        if rule.firstMatch(in: text, options: [], range: NSRange(location: 0, length: (text as NSString).length)) != nil {
            finish(matched: true)
        }
    }

    // A link that asks for a new window opens in this one.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil {
            webView.load(navigationAction.request)
        }
        return nil
    }
}

// MARK: - The plugin

@objc(RestockApplePlugin)
public class RestockApplePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "RestockApplePlugin"
    public let jsName = "RestockApple"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "webLoad", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "webEval", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "webClose", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "webOpen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "folderPick", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "folderList", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "folderRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "folderWrite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "folderDelete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lanInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lanDial", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lanAsk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lanClose", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lanListen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lanReply", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lanStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lanAdvertise", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lanUnadvertise", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lanBrowse", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "backgroundSchedule", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "backgroundDone", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "backgroundCheckDone", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkTaskStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkTaskProgress", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkTaskEnd", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storeRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storeWrite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storeDelete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sqlQuery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sqlRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sqlRun", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sqlBatch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sqlKeepCopy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sqlClose", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "iconGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "iconSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "netInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretDelete", returnType: CAPPluginReturnPromise)
    ]

    private var pages: [String: RestockHiddenWeb] = [:]
    private var pickCall: CAPPluginCall?

    @objc func info(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve([
                "version": 5,
                // 0.15.1: "appstore" in the App Store build (ios.yml sets it); otherwise installed from a computer.
                "channel": (Bundle.main.object(forInfoDictionaryKey: "RestockChannel") as? String) ?? "sideload",
                "pad": UIDevice.current.userInterfaceIdiom == .pad,
                "system": UIDevice.current.systemVersion
            ])
        }
    }

    // MARK: hidden pages

    private func page(_ key: String) -> RestockHiddenWeb {
        if let have = pages[key] { return have }
        var host: UIView? = bridge?.viewController?.view
        if let window = bridge?.viewController?.view.window {
            host = window
        }
        let made = RestockHiddenWeb(host: host)
        pages[key] = made
        return made
    }

    @objc func webLoad(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let text = call.getString("url"), let url = URL(string: text),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            call.reject("A web address is needed")
            return
        }
        let seconds = Double(call.getInt("timeoutMs") ?? 25000) / 1000.0
        DispatchQueue.main.async {
            self.page(key).load(url, timeout: seconds) { status, at in
                call.resolve(["status": status, "url": at])
            }
        }
    }

    @objc func webEval(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let js = call.getString("js") else {
            call.reject("A page and a script are needed")
            return
        }
        DispatchQueue.main.async {
            guard let have = self.pages[key] else {
                call.reject("That page isn't open")
                return
            }
            have.web.callAsyncJavaScript(js, arguments: [:], in: nil, in: WKContentWorld.page) { result in
                switch result {
                case .success(let value):
                    if let text = value as? String {
                        call.resolve(["value": text])
                    } else if value is NSNull {
                        call.resolve(["value": ""])
                    } else {
                        call.resolve(["value": String(describing: value)])
                    }
                case .failure(let error):
                    call.reject(error.localizedDescription)
                }
            }
        }
    }

    @objc func webClose(_ call: CAPPluginCall) {
        let key = call.getString("key")
        DispatchQueue.main.async {
            if let one = key {
                self.pages[one]?.close()
                self.pages[one] = nil
            } else {
                for (_, p) in self.pages { p.close() }
                self.pages.removeAll()
            }
            call.resolve()
        }
    }

    // MARK: the shop's site on screen

    @objc func webOpen(_ call: CAPPluginCall) {
        guard let text = call.getString("url"), let url = URL(string: text),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            call.reject("A web address is needed")
            return
        }
        let message = call.getString("message") ?? ""
        let allowed: [String] = call.getArray("allowed", String.self) ?? []
        let pattern = call.getString("closeOn") ?? ""
        let rule: NSRegularExpression? = pattern.isEmpty ? nil : (try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]))
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("Nothing to show the page on")
                return
            }
            let browser = RestockShopBrowser()
            browser.startURL = url
            browser.message = message
            browser.allowed = allowed
            browser.closeOn = rule
            browser.script = call.getString("script") ?? ""
            browser.readOnDone = call.getString("readOnDone") ?? ""
            browser.onClose = { [weak browser] at, matched in
                call.resolve(["url": at, "matched": matched, "value": browser?.value ?? ""])
            }
            let nav = UINavigationController(rootViewController: browser)
            nav.modalPresentationStyle = .fullScreen
            presenter.present(nav, animated: true, completion: nil)
        }
    }

    // MARK: a folder picked in Files

    @objc func folderPick(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("Nothing to show the folders on")
                return
            }
            self.pickCall?.reject("cancelled")
            call.keepAlive = true
            self.pickCall = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder], asCopy: false)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            presenter.present(picker, animated: true, completion: nil)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pickCall else { return }
        pickCall = nil
        guard let url = urls.first else {
            call.reject("cancelled")
            return
        }
        let scoped = url.startAccessingSecurityScopedResource()
        defer {
            if scoped { url.stopAccessingSecurityScopedResource() }
        }
        do {
            let mark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            call.resolve(["bookmark": mark.base64EncodedString(), "name": url.lastPathComponent])
        } catch {
            call.reject("That folder can't be kept: " + error.localizedDescription)
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickCall?.reject("cancelled")
        pickCall = nil
    }

    /// Opens the bookmarked folder for `body`, on a background queue. A refreshed bookmark goes back as "bookmark".
    private func withFolder(_ call: CAPPluginCall, _ body: @escaping (URL) throws -> [String: Any]) {
        guard let text = call.getString("bookmark"), let mark = Data(base64Encoded: text) else {
            call.reject("No folder is set")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                var stale = false
                let url = try URL(resolvingBookmarkData: mark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
                let scoped = url.startAccessingSecurityScopedResource()
                defer {
                    if scoped { url.stopAccessingSecurityScopedResource() }
                }
                var out = try body(url)
                if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
                    out["bookmark"] = fresh.base64EncodedString()
                }
                call.resolve(out)
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    /// A plain file name only: nothing that could step outside the folder.
    private func safeName(_ call: CAPPluginCall) -> String? {
        guard let name = call.getString("name"), !name.isEmpty, name.count <= 200,
              !name.contains("/"), !name.contains("\\"), name != ".", name != ".." else {
            return nil
        }
        return name
    }

    @objc func folderList(_ call: CAPPluginCall) {
        withFolder(call) { folder in
            var files: [[String: Any]] = []
            var failure: Error?
            var coordinating: NSError?
            NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: folder, options: [], error: &coordinating) { at in
                // A nudge for iCloud to bring this folder's list up to date (it does nothing for a folder that isn't in iCloud).
                try? FileManager.default.startDownloadingUbiquitousItem(at: at)
                do {
                    let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isDirectoryKey]
                    let found = try FileManager.default.contentsOfDirectory(at: at, includingPropertiesForKeys: keys, options: [])
                    for item in found {
                        var name = item.lastPathComponent
                        var waiting = false
                        // A file iCloud hasn't brought down yet shows as ".name.icloud": ask for it, and list it by its real name.
                        if name.hasPrefix(".") && name.hasSuffix(".icloud") {
                            name = String(name.dropFirst().dropLast(7))
                            waiting = true
                            try? FileManager.default.startDownloadingUbiquitousItem(at: at.appendingPathComponent(name))
                        } else if name.hasPrefix(".") {
                            continue
                        }
                        let values = try? item.resourceValues(forKeys: Set(keys))
                        if values?.isDirectory == true { continue }
                        files.append([
                            "name": name,
                            "size": values?.fileSize ?? 0,
                            "mtime": Int((values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000),
                            "waiting": waiting
                        ])
                    }
                } catch {
                    failure = error
                }
            }
            if let e = coordinating { throw e }
            if let e = failure { throw e }
            return ["files": files]
        }
    }

    @objc func folderRead(_ call: CAPPluginCall) {
        guard let name = safeName(call) else {
            call.reject("Not a file name")
            return
        }
        withFolder(call) { folder in
            let file = folder.appendingPathComponent(name)
            var data: Data?
            var failure: Error?
            var coordinating: NSError?
            // A coordinated read waits for iCloud to bring the file down first.
            NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: file, options: [], error: &coordinating) { at in
                do {
                    data = try Data(contentsOf: at)
                } catch {
                    failure = error
                }
            }
            if let e = coordinating { throw e }
            if let e = failure { throw e }
            return ["data": (data ?? Data()).base64EncodedString()]
        }
    }

    @objc func folderWrite(_ call: CAPPluginCall) {
        guard let name = safeName(call), let text = call.getString("data"), let data = Data(base64Encoded: text) else {
            call.reject("A file name and its contents are needed")
            return
        }
        withFolder(call) { folder in
            let file = folder.appendingPathComponent(name)
            var failure: Error?
            var coordinating: NSError?
            NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: file, options: .forReplacing, error: &coordinating) { at in
                do {
                    try data.write(to: at, options: .atomic)
                } catch {
                    failure = error
                }
            }
            if let e = coordinating { throw e }
            if let e = failure { throw e }
            return ["bytes": data.count]
        }
    }

    @objc func folderDelete(_ call: CAPPluginCall) {
        guard let name = safeName(call) else {
            call.reject("Not a file name")
            return
        }
        withFolder(call) { folder in
            let file = folder.appendingPathComponent(name)
            var failure: Error?
            var coordinating: NSError?
            NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: file, options: .forDeleting, error: &coordinating) { at in
                do {
                    if FileManager.default.fileExists(atPath: at.path) {
                        try FileManager.default.removeItem(at: at)
                    }
                } catch {
                    failure = error
                }
            }
            if let e = coordinating { throw e }
            if let e = failure { throw e }
            return [:]
        }
    }

    // MARK: the keychain

    private func secretQuery(_ key: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "family.plenty.restock",
            kSecAttrAccount as String: key
        ]
    }

    @objc func secretSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty, let value = call.getString("value"), let data = value.data(using: .utf8) else {
            call.reject("A name and a value are needed")
            return
        }
        var query = secretQuery(key)
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("The keychain refused it (\(status))")
        }
    }

    @objc func secretGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("A name is needed")
            return
        }
        var query = secretQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &found)
        if status == errSecSuccess, let data = found as? Data, let text = String(data: data, encoding: .utf8) {
            call.resolve(["value": text, "found": true])
        } else if status == errSecItemNotFound {
            call.resolve(["found": false])
        } else {
            call.reject("The keychain refused it (\(status))")
        }
    }

    @objc func secretDelete(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("A name is needed")
            return
        }
        SecItemDelete(secretQuery(key) as CFDictionary)
        call.resolve()
    }
}
