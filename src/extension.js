const { LanguageClient, TransportKind } = require('vscode-languageclient/node');
const vscode = require('vscode');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let client;
let nreplSocket = null;
let nreplOutput = null;
let nreplStatus = null;
let nreplPendingId = 0;
let nreplPending = new Map();
let nreplBuffer = '';

class BblDebugAdapterFactory {
    createDebugAdapterDescriptor(session) {
        const config = session.configuration;
        if (config.request === 'attach') {
            return new vscode.DebugAdapterServer(config.port || 7889);
        }
        const bblPath = vscode.workspace.getConfiguration('bbl').get('serverPath', 'bbl');
        const port = config.port || 7889;
        const program = config.program;
        const child = spawn(bblPath, ['--dap', String(port), program], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        child.stderr.on('data', d => {
            const msg = d.toString();
            if (msg.includes('listening')) {
                vscode.window.setStatusBarMessage('BBL debug server started on port ' + port, 3000);
            }
        });
        child.on('exit', () => {
            vscode.debug.stopDebugging(session);
        });
        session._bblChild = child;
        return new Promise(resolve => {
            setTimeout(() => resolve(new vscode.DebugAdapterServer(port)), 500);
        });
    }

    dispose() {}
}

function activate(context) {
    const config = vscode.workspace.getConfiguration('bbl');
    const bblPath = config.get('serverPath', 'bbl');

    const serverOptions = {
        command: bblPath,
        args: ['--lsp'],
        transport: TransportKind.stdio
    };

    const clientOptions = {
        documentSelector: [{ scheme: 'file', language: 'bbl' }]
    };

    client = new LanguageClient('bbl', 'BBL Language Server', serverOptions, clientOptions);
    client.start();

    nreplOutput = vscode.window.createOutputChannel('BBL nREPL');
    nreplStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    nreplStatus.text = '$(debug-disconnect) BBL';
    nreplStatus.tooltip = 'BBL nREPL: disconnected';
    nreplStatus.command = 'bbl.nreplConnect';
    nreplStatus.show();
    context.subscriptions.push(nreplOutput, nreplStatus);

    context.subscriptions.push(
        vscode.commands.registerCommand('bbl.evalSelection', evalSelection),
        vscode.commands.registerCommand('bbl.evalFile', evalFile),
        vscode.commands.registerCommand('bbl.nreplConnect', nreplConnect),
        vscode.commands.registerCommand('bbl.nreplDisconnect', nreplDisconnect)
    );

    const debugFactory = new BblDebugAdapterFactory();
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('bbl', debugFactory),
        debugFactory
    );

    context.subscriptions.push(
        vscode.debug.onDidTerminateDebugSession(session => {
            if (session._bblChild) {
                session._bblChild.kill();
                session._bblChild = null;
            }
        })
    );

    tryAutoConnect();

    if (vscode.workspace.workspaceFolders) {
        const watcher = vscode.workspace.createFileSystemWatcher('**/.bbl-nrepl-port');
        watcher.onDidCreate(() => tryAutoConnect());
        watcher.onDidDelete(() => nreplDisconnect());
        context.subscriptions.push(watcher);
    }
}

function tryAutoConnect() {
    if (nreplSocket) return;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return;
    for (const folder of folders) {
        const portFile = path.join(folder.uri.fsPath, '.bbl-nrepl-port');
        if (fs.existsSync(portFile)) {
            const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
            if (port > 0) connectNrepl(port);
            return;
        }
    }
}

function connectNrepl(port) {
    if (nreplSocket) nreplDisconnect();
    nreplSocket = new net.Socket();
    nreplBuffer = '';

    nreplSocket.connect(port, '127.0.0.1', () => {
        nreplStatus.text = '$(debug-alt) BBL :' + port;
        nreplStatus.tooltip = 'BBL nREPL: connected to localhost:' + port;
        nreplOutput.appendLine('[nREPL] Connected to localhost:' + port);
    });

    nreplSocket.on('data', (data) => {
        nreplBuffer += data.toString();
        while (true) {
            const headerEnd = nreplBuffer.indexOf('\r\n\r\n');
            if (headerEnd < 0) break;
            const header = nreplBuffer.substring(0, headerEnd);
            const match = header.match(/Content-Length:\s*(\d+)/);
            if (!match) { nreplBuffer = ''; break; }
            const len = parseInt(match[1], 10);
            const bodyStart = headerEnd + 4;
            if (nreplBuffer.length < bodyStart + len) break;
            const body = nreplBuffer.substring(bodyStart, bodyStart + len);
            nreplBuffer = nreplBuffer.substring(bodyStart + len);
            handleNreplResponse(body);
        }
    });

    nreplSocket.on('error', (err) => {
        nreplOutput.appendLine('[nREPL] Error: ' + err.message);
        nreplDisconnect();
    });

    nreplSocket.on('close', () => {
        nreplOutput.appendLine('[nREPL] Disconnected');
        nreplSocket = null;
        nreplStatus.text = '$(debug-disconnect) BBL';
        nreplStatus.tooltip = 'BBL nREPL: disconnected';
    });
}

function handleNreplResponse(body) {
    try {
        const msg = JSON.parse(body);
        const resolve = nreplPending.get(msg.id);
        if (resolve) {
            nreplPending.delete(msg.id);
            resolve(msg.result || msg.error || msg);
        }
    } catch (e) {
        nreplOutput.appendLine('[nREPL] Parse error: ' + e.message);
    }
}

function sendNreplRequest(method, params) {
    return new Promise((resolve, reject) => {
        if (!nreplSocket) { reject(new Error('Not connected')); return; }
        const id = ++nreplPendingId;
        const req = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        const msg = 'Content-Length: ' + Buffer.byteLength(req) + '\r\n\r\n' + req;
        nreplPending.set(id, resolve);
        nreplSocket.write(msg);
        setTimeout(() => {
            if (nreplPending.has(id)) {
                nreplPending.delete(id);
                reject(new Error('Timeout'));
            }
        }, 10000);
    });
}

async function evalSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const selection = editor.selection;
    const code = selection.isEmpty
        ? editor.document.lineAt(selection.active.line).text
        : editor.document.getText(selection);
    if (!code.trim()) return;
    await evalCode(code, editor.document.fileName);
}

async function evalFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    await evalCode(editor.document.getText(), editor.document.fileName);
}

async function evalCode(code, filePath) {
    if (!nreplSocket) {
        vscode.window.showWarningMessage('BBL nREPL not connected. Start your program with (nrepl port).');
        return;
    }
    const file = filePath && filePath.endsWith('.bbl') ? filePath : '';
    try {
        const result = await sendNreplRequest('eval', { code, file });
        if (result.output) nreplOutput.appendLine(result.output);
        if (result.value) {
            nreplOutput.appendLine('=> ' + result.value);
            vscode.window.setStatusBarMessage('=> ' + result.value, 3000);
        }
        if (result.error) {
            nreplOutput.appendLine('ERROR: ' + result.error);
            vscode.window.showErrorMessage('BBL: ' + result.error);
        }
        nreplOutput.show(true);
    } catch (e) {
        vscode.window.showErrorMessage('BBL eval failed: ' + e.message);
    }
}

async function nreplConnect() {
    const input = await vscode.window.showInputBox({
        prompt: 'nREPL port',
        value: '7888',
        validateInput: v => /^\d+$/.test(v) ? null : 'Enter a port number'
    });
    if (input) connectNrepl(parseInt(input, 10));
}

function nreplDisconnect() {
    if (nreplSocket) {
        nreplSocket.destroy();
        nreplSocket = null;
    }
    nreplStatus.text = '$(debug-disconnect) BBL';
    nreplStatus.tooltip = 'BBL nREPL: disconnected';
}

function deactivate() {
    nreplDisconnect();
    if (client) return client.stop();
}

module.exports = { activate, deactivate };
