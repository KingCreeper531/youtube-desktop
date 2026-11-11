// Preload for the Google sign-in window. Makes the page see a normal Firefox
// browser, matching the Firefox user agent the window sends.
const { contextBridge } = require('electron');

contextBridge.executeInMainWorld({
  func: () => {
    try { delete Navigator.prototype.userAgentData; } catch { /* ignore */ }
    try { Object.defineProperty(Navigator.prototype, 'webdriver', { configurable: true, get: () => false }); } catch { /* ignore */ }
    try { delete window.chrome; } catch { /* ignore */ }
  },
});
