# Blame LSP

A simple Git Blame Language Server for use in the Helix editor.

A tiny Language Server (LSP) that shows git blame info on code actions
`⎇ ${author}, ${when} · ${message} ↗`

## Motivation
Pretty much the only thing I miss after moving away from the noisy environment in VSCode and Zed (How many AI popups do we need?) is Gitlens. 

## Usage in Helix
You need to add the LSP to you languages config, usually located in `~/.config/helix/languages.toml`.

Define the server
```toml
[language-server.blame-lsp]
command = "blame-lsp"
args = ["--stdio"]

```

Then for all languages you want Blame-LSP add it as a server
```toml
[[language]]
name = "javascript"
language-servers = ["eslint", "typescript-language-server", "blame-lsp"]
formatter = { command = "npx", args = ["prettier", "--parser", "typescript"] }
auto-format = true

[[language]]
name = "typescript"
language-servers = ["eslint", "typescript-language-server", "blame-lsp"]
formatter = { command = "npx", args = ["prettier", "--parser", "typescript"] }
auto-format = true

```

The order you add it is signiticant. In this case I have it at the end so it appears as the last item in the code actions menu, if you put it first it will be first.

## Install & build locally

```bash
npm i
npm run build
npm link
```
