// The TizenBrew-way of TizenTube. Uses CDP and SDB to inject the userscript.

const adbhost = require('adbhost');
const CDP = require('chrome-remote-interface');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');


var isConnecting = false;
const isTizen3 = tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version').startsWith('3.0');

// ---------------------------------------------------------------------------
// Local userScript.js (shipped inside the .wgt) instead of the jsDelivr CDN.
//
// The page that runs TizenTube is served from youtube.com (or localhost:8099),
// so it can never read a file inside the .wgt directly. This service (Node) is
// the one that reads the file; it then hands the code to the page either via
// CDP Runtime.evaluate (injector) or via a same-origin route (proxy in index.js).
//
// The path is resolved at runtime on purpose (not a literal in fs.readFileSync),
// so @vercel/ncc does not try to treat it as an asset at build time.
// ---------------------------------------------------------------------------
const USERSCRIPT_CANDIDATES = [
    'script/userScript.js',               // wgt: service/script/userScript.js, bundle in service/
    '../script/userScript.js',            // wgt: bundle in service/<subfolder>/
    'userScript.js',                      // userScript.js copied next to the bundle
    '../service/script/userScript.js',    // dev tree: standalone/service -> service/script
    '../../service/script/userScript.js'  // dev tree: standalone/service/dist -> service/script
];

function getUserScriptSearchPaths() {
    const bases = [__dirname, process.cwd()];
    const result = [];
    bases.forEach(base => {
        USERSCRIPT_CANDIDATES.forEach(rel => {
            const full = path.resolve(base, rel);
            if (result.indexOf(full) === -1) result.push(full);
        });
    });
    return result;
}

function findUserScriptPath() {
    const paths = getUserScriptSearchPaths();
    for (let i = 0; i < paths.length; i++) {
        try {
            if (fs.statSync(paths[i]).isFile()) return paths[i];
        } catch (e) { /* try next */ }
    }
    return null;
}

var userScriptCache = null;

// Returns the userScript.js source as a string (cached, re-read if the file changes).
function readUserScript() {
    const filePath = findUserScriptPath();
    if (!filePath) {
        throw new Error('userScript.js not found. Searched:\n' + getUserScriptSearchPaths().join('\n'));
    }
    const mtime = fs.statSync(filePath).mtimeMs;
    if (!userScriptCache || userScriptCache.path !== filePath || userScriptCache.mtime !== mtime) {
        userScriptCache = { path: filePath, mtime: mtime, code: fs.readFileSync(filePath, 'utf8') };
    }
    return userScriptCache.code;
}

function connectToDebugger(host, port, args) {
    fetch(`http://${host}:${port}`).then(_ => {
        CDP({ host, port, local: true }, client => {
            isConnecting = false;
            client.Runtime.enable();
            client.Page.enable();

            // Must be set BEFORE navigating, so the new document is created without CSP.
            client.Page.setBypassCSP({ enabled: true });

            client.on('Runtime.executionContextCreated', m => {
                // Runtime.evaluate is not subject to the page's CSP, and the file is read
                // locally from the .wgt, so no network request is needed at all.
                let modFile;
                try {
                    modFile = readUserScript();
                } catch (e) {
                    client.Runtime.evaluate({ expression: 'alert(' + JSON.stringify('TizenTube: failed to load local userScript.js\n' + e.message) + ')', contextId: m.context.id });
                    return;
                }
                client.Runtime.evaluate({ expression: modFile, contextId: m.context.id });
            });

            client.Page.navigate({ url: `https://youtube.com/tv?additionalDataUrl=http%3A%2F%2Flocalhost%3A8085%2Fdial%2Fapps%2FYouTube${args ? `&${args}` : ''}` });
        })
    }).catch(e => {
        return setTimeout(() => connectToDebugger(host, port, args), 100);
    })
}

function canConnectToDaemon() {
    return fetch('http://127.0.0.1:8001/api/v2/').then(res => res.json())
        .then(json => {
            return { canConnectToDaemon: (json.device.developerIP === '127.0.0.1' || json.device.developerIP === '1.0.0.127') && json.device.developerMode === '1', ip: json.device.ip, isConnecting }
        }).catch(e => {
            return canConnectToDaemon();
        });
}

function startDebugger(args) {
    return canConnectToDaemon().then(res => {
        if (!res.canConnectToDaemon) return false;
        const client = adbhost.createConnection({ host: '127.0.0.1', port: 26101 });

        client._stream.on('connect', () => {
            const packageId = tizen.application.getAppInfo().packageId;
            isConnecting = true;
            const shellCmd = client.createStream(`shell:0 debug ${packageId}.TizenTubeStandalone${isTizen3 ? ' 0' : ''}`);
            shellCmd.on('data', (data) => {
                const dataString = data.toString();
                if (dataString.includes('debug')) {
                    const port = Number(dataString.substr(dataString.indexOf(':') + 1, 6).replace(' ', ''));
                    connectToDebugger(res.ip, port, args);
                    setTimeout(() => client._stream.end(), 1000);
                }
            });
        });

        return true;
    });
}

module.exports = {
    startDebugger,
    canConnectToDaemon,
    readUserScript,
    getUserScriptSearchPaths
};