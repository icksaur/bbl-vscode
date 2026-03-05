const { LanguageClient, TransportKind } = require('vscode-languageclient/node');
const vscode = require('vscode');

let client;

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
}

function deactivate() {
    if (client) return client.stop();
}

module.exports = { activate, deactivate };
