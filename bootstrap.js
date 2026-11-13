var scholarScope;
var scholarChrome;
function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  scholarScope = this;
  try {
    // XUL windows must be opened through a registered chrome content URL.
    scholarChrome = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
      .getService(Components.interfaces.amIAddonManagerStartup)
      .registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
        ["content", "zotero10-scholar", "./"]
      ]);
    Services.scriptloader.loadSubScriptWithOptions(`${rootURI}src/core.js`, { target: scholarScope, ignoreCache: true });
    Services.scriptloader.loadSubScriptWithOptions(`${rootURI}src/metadata.js`, { target: scholarScope, ignoreCache: true });
    Services.scriptloader.loadSubScriptWithOptions(`${rootURI}src/search.js`, { target: scholarScope, ignoreCache: true });
    Services.scriptloader.loadSubScriptWithOptions(`${rootURI}src/reports.js`, { target: scholarScope, ignoreCache: true });
    Services.scriptloader.loadSubScriptWithOptions(`${rootURI}src/attachments.js`, { target: scholarScope, ignoreCache: true });
    Services.scriptloader.loadSubScriptWithOptions(`${rootURI}src/plugin.js`, { target: scholarScope, ignoreCache: true });
    await scholarScope.ScholarPlugin.start({ id, version, rootURI });
  } catch (error) {
    try { await scholarScope.ScholarPlugin?.stop(); }
    finally { scholarChrome?.destruct(); scholarChrome = undefined; }
    throw error;
  }
}

function onMainWindowLoad({ window }) { scholarScope?.ScholarPlugin.addWindow(window); }
function onMainWindowUnload({ window }) { scholarScope?.ScholarPlugin.removeWindow(window); }

async function shutdown() {
  try { await scholarScope?.ScholarPlugin?.stop(); }
  finally {
    scholarChrome?.destruct();
    scholarChrome = undefined;
    scholarScope = undefined;
  }
}
