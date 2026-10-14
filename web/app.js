const { invoke } = window.__TAURI__.core;

const editor = document.querySelector("#editor");
const source = document.querySelector("#source");
const sidebar = document.querySelector("#sidebar");
const outline = document.querySelector("#outline");
const wordCount = document.querySelector("#word-count");
const statusCenter = document.querySelector("#status-center");
const findbar = document.querySelector("#findbar");
const findInput = document.querySelector("#find-input");
const findCount = document.querySelector("#find-count");
const wordPopover = document.querySelector("#word-popover");
const BACKTICK = String.fromCharCode(96);

let activePath = null;
let activeLineEnding = "lf";
let savedMarkdown = "";
let dirty = false;
let sourceMode = false;
let focusMode = false;
let typewriterMode = false;
let activePanel = "outline";
let folderPath = null;
let zoomLevel = 1;

function markdownNow() {
  return sourceMode ? source.value : serializeDocument(editor);
}

function setDirty(value) {
  dirty = value;
  statusCenter.textContent = dirty ? "Unsaved Changes" : "";
  const title = (dirty ? "● " : "") + (activePath ? activePath.split(/[\\/]/).pop() : "Untitled") + " - Typora RS";
  document.title = title;
  try { void window.__TAURI__.window.getCurrentWindow().setTitle(title); } catch (_) {}
}

function wordTotal(text) {
  const matches = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}

function updateWordCount() {
  const value = sourceMode ? source.value : editor.innerText;
  const words = wordTotal(value);
  wordCount.textContent = words.toLocaleString("en-US") + " Words";
  const characters = [...value].length;
  const compact = [...value].filter((character) => !/\s/u.test(character)).length;
  const paragraphs = value.split(/\n+/).filter((line) => line.trim()).length;
  wordPopover.innerHTML = "<div><span>Words</span><b>" + words.toLocaleString("en-US") + "</b></div>" +
    "<div><span>Characters (with spaces)</span><b>" + characters.toLocaleString("en-US") + "</b></div>" +
    "<div><span>Characters (without spaces)</span><b>" + compact.toLocaleString("en-US") + "</b></div>" +
    "<div><span>Paragraphs</span><b>" + paragraphs.toLocaleString("en-US") + "</b></div>";
}

function slugify(text) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/[ _]+/g, "-") || "section";
}

function updateOutline() {
  outline.replaceChildren();
  const headings = [...editor.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  if (!headings.length) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "Headings will appear here";
    outline.append(empty);
    return;
  }
  const used = new Map();
  headings.forEach((heading) => {
    const label = heading.innerText.trim() || "（空标题）";
    const level = Number(heading.tagName.slice(1));
    const base = slugify(label);
    const suffix = used.get(base) || 0;
    used.set(base, suffix + 1);
    heading.id = base + (suffix ? "-" + suffix : "");
    const item = document.createElement("button");
    item.className = "outline-item level-" + level;
    item.textContent = label;
    item.title = label;
    item.addEventListener("click", () => {
      heading.scrollIntoView({ behavior: "smooth", block: "center" });
      placeCaretAtStart(heading);
    });
    outline.append(item);
  });
}

function renderMarkdown(markdown) {
  return invoke("render_markdown", { source: markdown, documentPath: activePath }).then((result) => {
    editor.innerHTML = result.html;
    editor.querySelectorAll("img").forEach((image, index) => {
      if (result.images[index]) image.dataset.markdownSrc = result.images[index].markdownUrl;
    });
    if (!editor.firstChild) editor.innerHTML = "<p><br></p>";
    editor.classList.toggle("is-empty", !markdown.trim());
    editor.querySelectorAll("input[type=checkbox]").forEach((checkbox) => {
      checkbox.disabled = false;
      checkbox.addEventListener("change", updateAfterEdit);
    });
    updateOutline();
    updateWordCount();
  });
}

function escapeText(value) {
  return value.replace(/\\/g, "\\\\").replace(/([*_\[\]])/g, "\\$1");
}

function inlineMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.nodeValue || "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName;
  if (tag === "BR") return "  \n";
  if (tag === "IMG") return "![" + (node.getAttribute("alt") || "") + "](" + (node.dataset.markdownSrc || node.getAttribute("src") || "") + ")";
  if (tag === "INPUT") return node.checked ? "[x] " : "[ ] ";
  const content = Array.from(node.childNodes).map(inlineMarkdown).join("");
  if (tag === "STRONG" || tag === "B") return "**" + content + "**";
  if (tag === "EM" || tag === "I") return "*" + content + "*";
  if (tag === "DEL" || tag === "S" || tag === "STRIKE") return "~~" + content + "~~";
  if (tag === "CODE") return BACKTICK + content.replace(/`/g, "\\`") + BACKTICK;
  if (tag === "A") return "[" + content + "](" + (node.getAttribute("href") || "") + ")";
  return content;
}

function listMarkdown(list, depth) {
  const ordered = list.tagName === "OL";
  const start = Number(list.getAttribute("start") || "1");
  const lines = [];
  Array.from(list.children).filter((item) => item.tagName === "LI").forEach((item, index) => {
    let text = "";
    const nested = [];
    Array.from(item.childNodes).forEach((child) => {
      if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === "UL" || child.tagName === "OL")) nested.push(child);
      else if (!(child.nodeType === Node.ELEMENT_NODE && child.tagName === "INPUT")) text += inlineMarkdown(child);
    });
    const checkbox = item.querySelector(":scope > input[type=checkbox]");
    if (checkbox) text = (checkbox.checked ? "[x] " : "[ ] ") + text;
    const marker = ordered ? (start + index) + ". " : "- ";
    lines.push("  ".repeat(depth) + marker + text.trim());
    nested.forEach((child) => lines.push(listMarkdown(child, depth + 1)));
  });
  return lines.join("\n");
}

function tableMarkdown(table) {
  const rows = [...table.querySelectorAll("tr")].map((row) => [...row.children].map((cell) => inlineMarkdown(cell).trim()));
  if (!rows.length) return "";
  const columns = Math.max(...rows.map((row) => row.length));
  const header = rows[0];
  const alignCells = [...(table.querySelector("tr")?.children || [])];
  const divider = Array.from({ length: columns }, (_, index) => {
    const align = alignCells[index]?.style.textAlign;
    if (align === "center") return ":---:";
    if (align === "right") return "---:";
    if (align === "left") return ":---";
    return "---";
  });
  const format = (row) => "| " + Array.from({ length: columns }, (_, index) => row[index] || "").join(" | ") + " |";
  return [format(header), format(divider), ...rows.slice(1).map(format)].join("\n");
}

function blockMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.nodeValue || "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName;
  if (tag === "UL" || tag === "OL") return listMarkdown(node, 0);
  if (tag === "HR") return "---";
  if (tag === "TABLE") return tableMarkdown(node);
  if (tag === "PRE") {
    const code = node.querySelector("code");
    const languageClass = code ? [...code.classList].find((name) => name.startsWith("language-")) : null;
    const language = languageClass ? languageClass.slice(9) : "";
    return BACKTICK.repeat(3) + language + "\n" + (code ? code.innerText : node.innerText).replace(/\n$/, "") + "\n" + BACKTICK.repeat(3);
  }
  if (tag === "BLOCKQUOTE") {
    const quoted = serializeContainer(node);
    return quoted.split("\n").map((line) => "> " + line).join("\n");
  }
  if (/^H[1-6]$/.test(tag)) return "#".repeat(Number(tag[1])) + " " + Array.from(node.childNodes).map(inlineMarkdown).join("").trim();
  if (tag === "P" || tag === "DIV") {
    if (!node.textContent.trim()) return "";
    return Array.from(node.childNodes).map(inlineMarkdown).join("").trimEnd();
  }
  return Array.from(node.childNodes).map(inlineMarkdown).join("");
}

function serializeContainer(container) {
  return Array.from(container.childNodes).map(blockMarkdown).join("\n\n").replace(/\n{3,}/g, "\n\n");
}

function serializeDocument(container) {
  const content = serializeContainer(container).replace(/^\n+|\n+$/g, "");
  return content ? content + "\n" : "";
}

function placeCaretAtStart(element) {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeCaretAtEnd(element) {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

async function openDocument() {
  if (dirty && !window.confirm("This document has unsaved changes. Continue and discard them?")) return;
  try {
    const file = await invoke("open_document");
    if (!file) return;
    await showDocument(file);
  } catch (error) {
    window.alert(String(error));
  }
}

async function showDocument(file) {
  activePath = file.path;
  activeLineEnding = file.lineEnding;
  folderPath = activePath.replace(/[\\/][^\\/]+$/, "");
  sourceMode = false;
  source.hidden = true;
  editor.hidden = false;
  document.body.classList.remove("source-mode");
  const markdown = file.content.replace(/\r\n?/g, "\n");
  source.value = markdown;
  await renderMarkdown(markdown);
  savedMarkdown = markdown;
  setDirty(false);
  if (activePanel === "files") {
    await refreshFolder(folderPath);
  }
}

async function refreshFolder(path) {
  try {
    const listing = await invoke("list_folder", { path });
    folderPath = listing.path;
    const panel = document.querySelector("#files-panel");
    panel.replaceChildren();
    const top = document.createElement("div");
    top.className = "file-panel-top";
    const choose = document.createElement("button");
    choose.textContent = "打开文件夹…";
    choose.addEventListener("click", chooseFolder);
    const pathLabel = document.createElement("div");
    pathLabel.className = "folder-path";
    pathLabel.textContent = folderPath;
    pathLabel.title = folderPath;
    top.append(choose, pathLabel);
    panel.append(top);
    const list = document.createElement("div");
    list.className = "file-list";
    if (listing.entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sidebar-empty";
      empty.textContent = "此文件夹没有子文件夹或 Markdown 文件";
      list.append(empty);
    }
    listing.entries.forEach((entry) => {
      const button = document.createElement("button");
      button.className = "file-entry" + (entry.isDirectory ? " directory" : "") + (entry.path === activePath ? " active" : "");
      button.textContent = (entry.isDirectory ? "▸ " : "") + entry.name;
      button.title = entry.path;
      button.addEventListener("click", async () => {
        if (entry.isDirectory) await refreshFolder(entry.path);
          else if (!dirty || window.confirm("This document has unsaved changes. Continue and discard them?")) {
          try { await showDocument(await invoke("open_document_by_path", { path: entry.path })); }
          catch (error) { window.alert(String(error)); }
        }
      });
      list.append(button);
    });
    panel.append(list);
  } catch (error) {
    window.alert(String(error));
  }
}

async function chooseFolder() {
  try {
    const listing = await invoke("choose_folder");
    if (!listing) return;
    folderPath = listing.path;
    activePanel = "files";
    showSidebar("files");
    await refreshFolder(folderPath);
  } catch (error) { window.alert(String(error)); }
}

async function saveDocument(saveAs) {
  if (!dirty && !saveAs && activePath) return;
  const markdown = markdownNow();
  try {
    const path = await invoke("save_document", { content: markdown, saveAs: Boolean(saveAs), lineEnding: activeLineEnding });
    if (!path) return;
    activePath = path;
    savedMarkdown = markdown;
    source.value = markdown;
    setDirty(false);
  } catch (error) {
    window.alert(String(error));
  }
}

async function toggleSourceMode() {
  if (!sourceMode) {
    source.value = dirty ? serializeDocument(editor) : savedMarkdown;
    source.hidden = false;
    editor.hidden = true;
    sourceMode = true;
    source.focus();
    source.setSelectionRange(0, 0);
  } else {
    const markdown = source.value;
    sourceMode = false;
    source.hidden = true;
    editor.hidden = false;
    await renderMarkdown(markdown);
    editor.focus();
    placeCaretAtEnd(editor.lastElementChild || editor);
  }
  document.body.classList.toggle("source-mode", sourceMode);
  updateWordCount();
}

function toggleSidebar(panel) {
  if (panel && (sidebar.hidden || activePanel !== panel)) {
    showSidebar(panel);
    return;
  }
  sidebar.hidden = !sidebar.hidden;
  updateSidebarPanel();
}

function showSidebar(panel) {
  activePanel = panel;
  sidebar.hidden = false;
  updateSidebarPanel();
}

function updateSidebarPanel() {
  document.querySelectorAll(".sidebar-tab").forEach((tab) => tab.classList.toggle("selected", tab.dataset.panel === activePanel));
  document.querySelector("#outline-panel").hidden = activePanel !== "outline";
  document.querySelector("#files-panel").hidden = activePanel !== "files";
}

function showFindbar() {
  findbar.hidden = false;
  findInput.focus();
  findInput.select();
}

function findNext(backwards) {
  const query = findInput.value;
  if (!query) { findCount.textContent = ""; return; }
  const text = sourceMode ? source.value : editor.innerText;
  const matches = text.toLocaleLowerCase().split(query.toLocaleLowerCase()).length - 1;
  findCount.textContent = matches ? matches + " matches" : "No results";
  if (sourceMode) {
    const haystack = source.value.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    const from = backwards ? Math.max(0, source.selectionStart - 1) : source.selectionEnd;
    let index = backwards ? haystack.lastIndexOf(needle, from) : haystack.indexOf(needle, from);
    if (index < 0) index = backwards ? haystack.lastIndexOf(needle) : haystack.indexOf(needle);
    if (index >= 0) { source.focus(); source.setSelectionRange(index, index + query.length); }
  } else {
    window.find(query, false, Boolean(backwards), true, false, false, false);
  }
}

function insertTable() {
  const columnInput = window.prompt("Number of columns", "3");
  if (columnInput === null) return;
  const rowInput = window.prompt("Number of data rows", "2");
  if (rowInput === null) return;
  const columns = Math.max(1, Math.min(12, Number(columnInput) || 1));
  const rows = Math.max(1, Math.min(30, Number(rowInput) || 1));
  if (!columns || !rows) return;
  let html = "<table><thead><tr>";
  for (let col = 0; col < columns; col += 1) html += "<th>Header</th>";
  html += "</tr></thead><tbody>";
  for (let row = 0; row < rows; row += 1) {
    html += "<tr>";
    for (let col = 0; col < columns; col += 1) html += "<td><br></td>";
    html += "</tr>";
  }
  html += "</tbody></table><p><br></p>";
  editor.focus();
  document.execCommand("insertHTML", false, html);
  updateAfterEdit();
}

function insertLink() {
  editor.focus();
  const url = window.prompt("Link URL", "https://");
  if (!url) return;
  const scheme = url.trim().split(":", 1)[0].toLowerCase();
  if (url.includes(":") && !["http", "https", "mailto"].includes(scheme)) {
    window.alert("Only HTTP, HTTPS, mailto, and relative links are allowed.");
    return;
  }
  document.execCommand("createLink", false, url);
}

async function insertImage() {
  try {
    const image = await invoke("import_image");
    if (!image) return;
    editor.focus();
    const html = '<img alt="' + escapeAttribute(image.alt) + '" src="' + escapeAttribute(image.dataUrl) + '" data-markdown-src="' + escapeAttribute(image.markdownUrl) + '">';
    document.execCommand("insertHTML", false, html);
    updateAfterEdit();
  } catch (error) { window.alert(String(error)); }
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function applyHeading(level) {
  editor.focus();
  document.execCommand("formatBlock", false, level ? "H" + level : "P");
  updateAfterEdit();
}

function performAction(action, item) {
  closeMenus();
  switch (action) {
    case "open": void openDocument(); break;
    case "save": void saveDocument(false); break;
    case "save-as": void saveDocument(true); break;
    case "source": void toggleSourceMode(); break;
    case "outline": toggleSidebar("outline"); break;
    case "files": toggleSidebar("files"); break;
    case "focus": focusMode = !focusMode; document.body.classList.toggle("focus-mode", focusMode); break;
    case "typewriter": typewriterMode = !typewriterMode; document.body.classList.toggle("typewriter-mode", typewriterMode); break;
    case "word-count": wordPopover.hidden = !wordPopover.hidden; break;
    case "status-bar": document.body.classList.toggle("hide-statusbar"); break;
    case "fullscreen":
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
      break;
    case "zoom-in": zoomLevel = Math.min(1.5, zoomLevel + 0.1); document.body.style.zoom = zoomLevel; break;
    case "zoom-out": zoomLevel = Math.max(0.7, zoomLevel - 0.1); document.body.style.zoom = zoomLevel; break;
    case "zoom-reset": zoomLevel = 1; document.body.style.zoom = ""; break;
    case "bold": document.execCommand("bold"); break;
    case "italic": document.execCommand("italic"); break;
    case "strike": document.execCommand("strikeThrough"); break;
    case "inline-code": document.execCommand("insertHTML", false, "<code>代码</code>"); break;
    case "link": insertLink(); break;
    case "image": void insertImage(); break;
    case "heading": applyHeading(Number(item.dataset.level)); break;
    case "paragraph": applyHeading(0); break;
    case "unordered-list": document.execCommand("insertUnorderedList"); break;
    case "ordered-list": document.execCommand("insertOrderedList"); break;
    case "quote": document.execCommand("formatBlock", false, "BLOCKQUOTE"); break;
    case "code-block": document.execCommand("insertHTML", false, "<pre><code><br></code></pre>"); break;
    case "table": insertTable(); break;
    case "find": showFindbar(); break;
    case "select-all": (sourceMode ? source : editor).focus(); document.execCommand("selectAll"); break;
    case "undo": document.execCommand("undo"); break;
    case "redo": document.execCommand("redo"); break;
    case "about": window.alert("Typora RS 0.1.0\nRust + Tauri Markdown 编辑器"); break;
    case "shortcuts": window.alert("Ctrl+O 打开 · Ctrl+S 保存 · Ctrl+/ 源码模式\nCtrl+B 加粗 · Ctrl+I 斜体 · Ctrl+K 链接\nCtrl+Shift+O 大纲 · Ctrl+Shift+T 打字机模式"); break;
    case "export-html": void exportHtml(); break;
  }
}

async function exportHtml() {
  try {
    const markdown = markdownNow();
    const rendered = await invoke("render_markdown", { source: markdown, documentPath: activePath });
    await invoke("export_html", { html: rendered.html });
  } catch (error) { window.alert(String(error)); }
}

function closeMenus() {
  document.querySelectorAll(".menu-popup").forEach((menu) => { menu.hidden = true; });
  document.querySelectorAll(".menu-trigger").forEach((button) => button.classList.remove("open"));
}

function updateAfterEdit() {
  updateOutline();
  updateWordCount();
  setDirty(markdownNow() !== savedMarkdown);
  editor.classList.toggle("is-empty", !editor.innerText.trim());
  if (typewriterMode) activeBlock()?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function activeBlock() {
  const selection = window.getSelection();
  let node = selection?.anchorNode;
  if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
  return node?.closest?.("p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,table") || null;
}

document.querySelectorAll(".menu-trigger").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = document.querySelector("#menu-" + button.dataset.menu);
    const open = menu.hidden;
    closeMenus();
    menu.hidden = !open;
    button.classList.toggle("open", open);
  });
});

document.querySelectorAll("[data-action]").forEach((item) => {
  item.addEventListener("click", () => performAction(item.dataset.action, item));
});

document.querySelectorAll("[data-theme]").forEach((button) => {
  button.addEventListener("click", () => {
    document.body.dataset.theme = button.dataset.theme;
    closeMenus();
  });
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".app-menu")) closeMenus();
});

document.querySelectorAll(".sidebar-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    activePanel = tab.dataset.panel;
    document.querySelectorAll(".sidebar-tab").forEach((other) => other.classList.toggle("selected", other === tab));
    document.querySelector("#outline-panel").hidden = activePanel !== "outline";
    document.querySelector("#files-panel").hidden = activePanel !== "files";
    if (activePanel === "files" && folderPath) void refreshFolder(folderPath);
  });
});

document.querySelector("#close-sidebar").addEventListener("click", () => { sidebar.hidden = true; });
document.querySelector("#toggle-sidebar").addEventListener("click", () => toggleSidebar());
document.querySelector("#toggle-source").addEventListener("click", () => { void toggleSourceMode(); });
document.querySelector("#word-count").addEventListener("click", () => performAction("word-count"));
document.querySelector("#open-folder").addEventListener("click", chooseFolder);
document.querySelector("#find-close").addEventListener("click", () => { findbar.hidden = true; editor.focus(); });
document.querySelector("#find-next").addEventListener("click", () => findNext(false));
document.querySelector("#find-prev").addEventListener("click", () => findNext(true));
findInput.addEventListener("input", () => findNext(false));
findInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); findNext(event.shiftKey); }
  if (event.key === "Escape") findbar.hidden = true;
});

editor.addEventListener("input", updateAfterEdit);
source.addEventListener("input", updateAfterEdit);

editor.addEventListener("keydown", (event) => {
  const block = activeBlock();
  if (event.key === " ") {
    const text = block?.innerText || "";
    const heading = text.match(/^(#{1,6})$/);
    const bullet = text.match(/^[-+*]$/);
    const ordered = text.match(/^(\d+)[.)]$/);
    if (heading || bullet || ordered) {
      event.preventDefault();
      if (heading) applyHeading(heading[1].length);
      else document.execCommand(ordered ? "insertOrderedList" : "insertUnorderedList");
    }
  }
  if (event.key === "Enter" && typewriterMode) setTimeout(() => activeBlock()?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
});

document.addEventListener("selectionchange", () => {
  const block = activeBlock();
  document.querySelectorAll(".active-block").forEach((element) => element.classList.remove("active-block"));
  if (block) block.classList.add("active-block");
});

document.addEventListener("keydown", (event) => {
  if (event.key === "F11") { event.preventDefault(); performAction("fullscreen"); return; }
  if ((event.ctrlKey || event.metaKey) && event.key === "0" && !event.shiftKey) { event.preventDefault(); performAction("zoom-reset"); return; }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "=" || event.key === "+")) { event.preventDefault(); performAction("zoom-in"); return; }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "-" || event.key === "_")) { event.preventDefault(); performAction("zoom-out"); return; }
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (event.shiftKey && key === "o") { event.preventDefault(); toggleSidebar("outline"); }
  else if (key === "o") { event.preventDefault(); void openDocument(); }
  else if (key === "s") { event.preventDefault(); void saveDocument(false); }
  else if (key === "/" || event.code === "Slash") { event.preventDefault(); void toggleSourceMode(); }
  else if (key === "f") { event.preventDefault(); showFindbar(); }
  else if (event.shiftKey && key === "t") { event.preventDefault(); performAction("typewriter"); }
  else if (event.shiftKey && (key === "0" || event.code === "Digit0")) { event.preventDefault(); performAction("focus"); }
  else if (event.altKey && /^[1-6]$/.test(key) && !sourceMode) { event.preventDefault(); applyHeading(Number(key)); }
  else if (key === "k" && !sourceMode) { event.preventDefault(); insertLink(); }
});

source.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    const start = source.selectionStart;
    const end = source.selectionEnd;
    source.setRangeText("  ", start, end, "end");
    updateAfterEdit();
  }
});

window.addEventListener("beforeunload", (event) => {
  if (dirty) { event.preventDefault(); event.returnValue = ""; }
});

renderMarkdown("").then(() => {
  editor.innerHTML = "<p><br></p>";
  updateOutline();
  updateWordCount();
  setDirty(false);
  placeCaretAtStart(editor.firstElementChild || editor);
});
