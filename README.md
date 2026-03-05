# BBL Language Extension for VS Code

Syntax highlighting, error diagnostics, completions, and hover for [BBL](https://github.com/icksaur/bbl).

## Prerequisites

Install `bbl` (the language runtime + LSP server):

```bash
# Arch Linux (from source)
cd /path/to/bbl
makepkg -si

# Verify
bbl --lsp <<< ''
```

## Install Extension

```bash
cd bbl-vscode
npm install
npx vsce package
code --install-extension bbl-language-0.0.1.vsix
```

Or for development (live-reload):

```bash
ln -s "$(pwd)" ~/.vscode/extensions/bbl-language
```

Restart VS Code after installing.

## Features

- **Syntax highlighting** — keywords, builtins, strings, numbers, binary literals, method calls
- **Parse error diagnostics** — red squiggles on syntax errors
- **Completions** — keywords and builtins after `(`, method names after `:`
- **Hover** — function signatures for builtins

## Usage

1. Open any `.bbl` file
2. Syntax highlighting applies automatically
3. The LSP server (`bbl --lsp`) starts in the background
4. Errors appear as you type
5. Type `(` for keyword completions, `:` for method completions
