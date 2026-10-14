# Typora RS

A local-first Markdown editor built with Rust and Tauri, inspired by the calm, live-preview writing experience of Typora.

## Current prototype

- Single-column live-preview writing canvas with a temporary Markdown source mode.
- Typora-inspired File, Edit, Paragraph, Format, View, Theme, and Help menus.
- Open, edit, save, and save-as Markdown documents; atomic saves retain LF/CRLF line endings.
- Outline and folder sidebars, word count, find, focus mode, and typewriter mode.
- Local recovery drafts are saved while editing and can be restored after an unexpected close; a successful save clears the recovery copy.
- Markdown headings, lists, quotes, code blocks, tables, images, links, and inline formatting.
- Table row and column insertion/removal, column alignment, Tab navigation, and row insertion with Ctrl+Enter.
- Task lists, strikethrough, footnotes, inline/display math (KaTeX), and Mermaid diagrams. Their renderer assets are bundled for offline use.
- Local images are copied into a sibling `.assets` folder. HTML export embeds math fonts and rendered diagrams.
- Print and PDF output through the Windows print dialog.
- Raw HTML is sanitized before preview.

## Run

Install the Rust MSVC toolchain and Microsoft C++ Build Tools. Tauri on Windows uses WebView2; current Windows 10/11 installations usually already include it.

```powershell
cargo run
```

To create a Windows installer after installing the Tauri CLI:

```powershell
cargo install tauri-cli --version '^2'
cargo tauri build
```

## Scope

This is a clean-room Markdown editor project. Markdown files remain ordinary text files and are not stored in a proprietary format.
