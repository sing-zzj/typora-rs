# Typora RS

A local-first Markdown editor built with Rust and Tauri, inspired by the calm, live-preview writing experience of Typora.

## Current prototype

- Single-column live-preview writing canvas with a temporary Markdown source mode.
- Typora-inspired File, Edit, Paragraph, Format, View, Theme, and Help menus.
- Open, edit, save, and save-as Markdown documents; atomic saves retain LF/CRLF line endings.
- Outline and folder sidebars, word count, find, focus mode, and typewriter mode.
- Markdown headings, lists, quotes, code blocks, tables, images, links, and inline formatting.
- Table, task list, strikethrough, and footnote rendering. Local images are copied into a sibling `.assets` folder.
- HTML export and raw-HTML-as-text rendering for local documents.

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
