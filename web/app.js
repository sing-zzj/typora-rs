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
const replaceInput = document.querySelector("#replace-input");
const replaceRow = document.querySelector("#replace-row");
const wordPopover = document.querySelector("#word-popover");
const tableToolbar = document.querySelector("#table-toolbar");
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
let folderRoot = null;
let folderFilter = "";
let zoomLevel = 1;
let recoveryTimer = null;
let wordCountTimer = null;
let activeTableCell = null;
let renderSequence = 0;
let outlineSignature = null;
const previewObservers = new Set();

function markdownNow() {
  if (sourceMode) return source.value;
  const content = serializeDocument(editor);
  const frontMatter = editor.dataset.frontMatter;
  return frontMatter ? frontMatter.replace(/\r\n?/g, "\n").replace(/\n*$/, "\n\n") + content : content;
}

function setDirty(value) {
  dirty = value;
  statusCenter.textContent = dirty ? "Unsaved Changes" : "";
  const title = (dirty ? "● " : "") + (activePath ? activePath.split(/[\\/]/).pop() : "Untitled") + " - Typora RS";
  if (document.title !== title) {
    document.title = title;
    try { void window.__TAURI__.window.getCurrentWindow().setTitle(title); } catch (_) {}
  }
}

function wordTotal(text) {
  const matches = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}

function updateWordCount() {
  const value = sourceMode ? source.value : editor.textContent;
  const words = wordTotal(value);
  wordCount.textContent = words.toLocaleString("en-US") + " Words";
  if (wordPopover.hidden) return;
  const detailValue = value;
  const characters = [...detailValue].length;
  const compact = [...detailValue].filter((character) => !/\s/u.test(character)).length;
  const paragraphs = sourceMode
    ? detailValue.split(/\n+/).filter((line) => line.trim()).length
    : editor.querySelectorAll("p").length;
  wordPopover.innerHTML = "<div><span>Words</span><b>" + words.toLocaleString("en-US") + "</b></div>" +
    "<div><span>Characters (with spaces)</span><b>" + characters.toLocaleString("en-US") + "</b></div>" +
    "<div><span>Characters (without spaces)</span><b>" + compact.toLocaleString("en-US") + "</b></div>" +
    "<div><span>Paragraphs</span><b>" + paragraphs.toLocaleString("en-US") + "</b></div>";
}

function scheduleWordCount() {
  clearTimeout(wordCountTimer);
  wordCountTimer = setTimeout(updateWordCount, 180);
}

function slugify(text) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/[ _]+/g, "-") || "section";
}

function updateOutline() {
  const headings = [...editor.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  const used = new Map();
  const rows = headings.map((heading) => {
    const label = heading.textContent.trim() || "（空标题）";
    const level = Number(heading.tagName.slice(1));
    if (!Object.hasOwn(heading.dataset, "outlineSourceId")) heading.dataset.outlineSourceId = heading.id;
    const base = heading.dataset.outlineSourceId || slugify(label);
    const suffix = used.get(base) || 0;
    used.set(base, suffix + 1);
    const id = base + (suffix ? "-" + suffix : "");
    return { heading, label, level, id };
  });
  const signature = rows.map(({ label, level, id }) => `${level}:${id}:${label}`).join("\u001f");
  if (signature === outlineSignature) return;
  outlineSignature = signature;
  outline.replaceChildren();
  if (!headings.length) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "Headings will appear here";
    outline.append(empty);
    return;
  }
  rows.forEach(({ heading, label, level, id }) => {
    heading.id = id;
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
  const sequence = ++renderSequence;
  previewObservers.forEach((observer) => observer.disconnect());
  previewObservers.clear();
  editor.setAttribute("aria-busy", "true");
  statusCenter.textContent = "正在解析 Markdown…";
  return invoke("render_markdown", { source: markdown, documentPath: activePath }).then(async (result) => {
    if (sequence !== renderSequence) return;
    const frontMatter = markdown.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
    editor.dataset.frontMatter = frontMatter ? frontMatter[0].replace(/\r\n?/g, "\n") : "";
    outlineSignature = null;
    editor.innerHTML = result.html.replace(/<img(?=[\s/>])/g, '<img loading="lazy" decoding="async"');
    editor.querySelectorAll("img").forEach((image, index) => {
      image.loading = "lazy";
      image.decoding = "async";
      if (result.images[index]) image.dataset.markdownSrc = result.images[index].markdownUrl;
    });
    if (!editor.firstChild) editor.innerHTML = "<p><br></p>";
    await enhancePreview(editor);
    editor.classList.toggle("is-empty", !markdown.trim());
    editor.querySelectorAll("input[type=checkbox]").forEach((checkbox) => {
      checkbox.disabled = false;
      checkbox.addEventListener("change", updateAfterEdit);
    });
    updateOutline();
    updateWordCount();
  }).finally(() => {
    if (sequence === renderSequence) {
      editor.removeAttribute("aria-busy");
      statusCenter.textContent = "";
    }
  });
}

function escapeText(value) {
  return value.replace(/\\/g, "\\\\").replace(/([*_\[\]])/g, "\\$1");
}

function inlineMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.nodeValue || "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName;
  if (node.classList.contains("math-inline")) return "$" + (node.dataset.markdownMath || node.textContent) + "$";
  if (node.classList.contains("math-display")) return "$$\n" + (node.dataset.markdownMath || node.textContent) + "\n$$";
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
  if (node.classList.contains("mermaid-block")) return BACKTICK.repeat(3) + "mermaid\n" + (node.dataset.markdownSource || "") + "\n" + BACKTICK.repeat(3);
  if (node.classList.contains("math-display")) return "$$\n" + (node.dataset.markdownMath || node.textContent) + "\n$$";
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
    await invoke("clear_recovery_draft");
    await showDocument(file);
  } catch (error) {
    window.alert(String(error));
  }
}

async function showDocument(file) {
  activePath = file.path;
  activeLineEnding = file.lineEnding;
  folderPath = activePath.replace(/[\\/][^\\/]+$/, "");
  folderFilter = "";
  sourceMode = false;
  source.hidden = true;
  editor.hidden = false;
  document.body.classList.remove("source-mode");
  const markdown = file.content.replace(/\r\n?/g, "\n");
  source.value = markdown;
  await renderMarkdown(markdown);
  savedMarkdown = markdown;
  setDirty(false);
  activePanel = "files";
  showSidebar("files");
  await refreshFolder(folderPath);
}

async function refreshFolder(path) {
  try {
    if (folderPath && path.toLocaleLowerCase() !== folderPath.toLocaleLowerCase()) folderFilter = "";
    const listing = await invoke("list_folder", { path });
    folderPath = listing.path;
    folderRoot = listing.rootPath;
    const panel = document.querySelector("#files-panel");
    panel.replaceChildren();
    const top = document.createElement("div");
    top.className = "file-panel-top";
    const choose = document.createElement("button");
    choose.id = "open-folder";
    choose.className = "open-folder-button";
    choose.textContent = "打开文件夹…";
    choose.addEventListener("click", chooseFolder);
    const actions = document.createElement("div");
    actions.className = "file-panel-actions";
    actions.append(choose);
    const atRoot = folderPath.toLocaleLowerCase() === folderRoot.toLocaleLowerCase();
    const up = document.createElement("button");
    up.className = "file-panel-icon-button";
    up.textContent = "↑";
    up.title = "返回上级目录";
    up.disabled = atRoot;
    up.addEventListener("click", () => refreshFolder(parentDirectory(folderPath)));
    const refresh = document.createElement("button");
    refresh.className = "file-panel-icon-button";
    refresh.textContent = "↻";
    refresh.title = "刷新目录";
    refresh.addEventListener("click", () => refreshFolder(folderPath));
    const copy = document.createElement("button");
    copy.className = "file-panel-icon-button";
    copy.textContent = "⧉";
    copy.title = "复制完整路径";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(folderPath);
        copy.title = "已复制";
        setTimeout(() => { copy.title = "复制完整路径"; }, 1200);
      } catch (_) { window.prompt("文件夹路径", folderPath); }
    });
    actions.append(up, refresh, copy);
    const location = document.createElement("div");
    location.className = "folder-location";
    const folderName = folderPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folderPath;
    const title = document.createElement("strong");
    title.textContent = folderName;
    title.title = folderPath;
    const pathLabel = document.createElement("button");
    pathLabel.className = "folder-path";
    pathLabel.textContent = folderPath;
    pathLabel.title = "点击复制完整路径";
    pathLabel.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(folderPath); }
      catch (_) { window.prompt("文件夹路径", folderPath); }
    });
    location.append(title, pathLabel);
    const filter = document.createElement("input");
    filter.className = "file-filter";
    filter.type = "search";
    filter.placeholder = "筛选文件…";
    filter.setAttribute("aria-label", "筛选文件");
    filter.value = folderFilter;
    filter.addEventListener("input", () => {
      folderFilter = filter.value;
      list.querySelectorAll(".file-entry").forEach((row) => {
        row.hidden = !row.dataset.name.toLocaleLowerCase().includes(folderFilter.toLocaleLowerCase());
      });
    });
    top.append(actions, location, filter);
    panel.append(top);
    const list = document.createElement("div");
    list.className = "file-list";
    const summary = document.createElement("div");
    summary.className = "file-list-summary";
    summary.textContent = listing.entries.length + " 个项目";
    list.append(summary);
    if (listing.entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sidebar-empty";
      empty.textContent = "此文件夹没有子文件夹或 Markdown 文件";
      list.append(empty);
    }
    listing.entries.forEach((entry) => {
      const button = document.createElement("button");
      button.className = "file-entry" + (entry.isDirectory ? " directory" : "") + (entry.path === activePath ? " active" : "");
      button.dataset.name = entry.name;
      button.title = entry.path;
      const icon = document.createElement("span");
      icon.className = "file-entry-icon";
      icon.textContent = entry.isDirectory ? "▸" : "▤";
      icon.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "file-entry-name";
      name.textContent = entry.name;
      button.append(icon, name);
      button.hidden = !entry.name.toLocaleLowerCase().includes(folderFilter.toLocaleLowerCase());
      button.addEventListener("click", async () => {
        if (entry.isDirectory) await refreshFolder(entry.path);
        else if (!dirty || window.confirm("This document has unsaved changes. Continue and discard them?")) {
          try {
            const file = await invoke("open_document_by_path", { path: entry.path });
            await invoke("clear_recovery_draft");
            await showDocument(file);
          }
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

function parentDirectory(path) {
  const normalized = path.replace(/[\\/]+$/, "");
  const separator = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  if (separator < 0) return path;
  if (separator === 2 && /^[A-Za-z]:/.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, separator) || normalized.slice(0, 1);
}

async function chooseFolder() {
  try {
    const listing = await invoke("choose_folder");
    if (!listing) return;
    folderPath = listing.path;
    folderFilter = "";
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
    clearTimeout(recoveryTimer);
    await invoke("clear_recovery_draft");
    setDirty(false);
  } catch (error) {
    window.alert(String(error));
  }
}

async function toggleSourceMode() {
  if (!sourceMode) {
    source.value = dirty ? markdownNow() : savedMarkdown;
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

function showFindbar(showReplace = false) {
  findbar.hidden = false;
  replaceRow.hidden = !showReplace;
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

function replaceCurrent() {
  const query = findInput.value;
  if (!query) return;
  if (sourceMode) {
    let start = source.selectionStart;
    let end = source.selectionEnd;
    if (source.value.slice(start, end).toLocaleLowerCase() !== query.toLocaleLowerCase()) {
      const haystack = source.value.toLocaleLowerCase();
      const index = haystack.indexOf(query.toLocaleLowerCase(), end);
      start = index >= 0 ? index : haystack.indexOf(query.toLocaleLowerCase());
      if (start < 0) return;
      end = start + query.length;
    }
    source.setRangeText(replaceInput.value, start, end, "end");
    source.focus();
    updateAfterEdit();
  } else {
    let selection = window.getSelection();
    if (selection?.toString().toLocaleLowerCase() !== query.toLocaleLowerCase()) {
      findNext(false);
      selection = window.getSelection();
    }
    if (selection?.toString().toLocaleLowerCase() !== query.toLocaleLowerCase()) return;
    editor.focus();
    document.execCommand("insertText", false, replaceInput.value);
    updateAfterEdit();
  }
  findNext(false);
}

function replaceAll() {
  const query = findInput.value;
  if (!query) return;
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  let count = 0;
  if (sourceMode) {
    source.value = source.value.replace(expression, () => { count += 1; return replaceInput.value; });
    source.focus();
    updateAfterEdit();
  } else {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest(".math-inline,.math-display,.mermaid-block")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      node.nodeValue = node.nodeValue.replace(expression, () => { count += 1; return replaceInput.value; });
    });
    editor.focus();
    updateAfterEdit();
  }
  findCount.textContent = count + " replaced";
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

function focusTableCell(cell) {
  if (!cell) return;
  activeTableCell = cell;
  editor.focus();
  const range = document.createRange();
  if (!cell.firstChild) cell.append(document.createElement("br"));
  range.selectNodeContents(cell);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function editActiveTable(action) {
  const cell = activeTableCell;
  if (!cell || !editor.contains(cell)) return;
  const row = cell.closest("tr");
  const table = cell.closest("table");
  if (!row || !table) return;
  const column = cell.cellIndex;
  const body = table.tBodies[0] || table.createTBody();
  let nextCell = cell;
  if (action === "add-row") {
    const rowIndex = row.parentElement.tagName === "THEAD" ? 0 : [...body.rows].indexOf(row) + 1;
    const newRow = body.insertRow(Math.max(0, rowIndex));
    for (let index = 0; index < Math.max(1, row.cells.length); index += 1) newRow.insertCell().append(document.createElement("br"));
    nextCell = newRow.cells[Math.min(column, newRow.cells.length - 1)];
  } else if (action === "delete-row") {
    if (row.parentElement.tagName === "THEAD") return;
    if (body.rows.length <= 1) {
      [...row.cells].forEach((item) => { item.replaceChildren(document.createElement("br")); });
    } else {
      const index = [...body.rows].indexOf(row);
      row.remove();
      const target = body.rows[Math.min(index, body.rows.length - 1)];
      nextCell = target?.cells[Math.min(column, (target?.cells.length || 1) - 1)] || null;
    }
  } else if (action === "add-column") {
    [...table.rows].forEach((tableRow) => {
      const newCell = document.createElement(tableRow.parentElement.tagName === "THEAD" ? "th" : "td");
      newCell.append(document.createElement("br"));
      tableRow.insertBefore(newCell, tableRow.cells[column + 1] || null);
      if (tableRow === row) nextCell = newCell;
    });
  } else if (action === "delete-column") {
    const columns = Math.max(...[...table.rows].map((tableRow) => tableRow.cells.length));
    if (columns <= 1) return;
    [...table.rows].forEach((tableRow) => tableRow.cells[column]?.remove());
    nextCell = row.cells[Math.min(column, row.cells.length - 1)] || row.cells[row.cells.length - 1] || null;
  } else if (action.startsWith("align-")) {
    const align = action.slice(6);
    [...table.rows].forEach((tableRow) => { if (tableRow.cells[column]) tableRow.cells[column].style.textAlign = align; });
  }
  updateAfterEdit();
  if (nextCell) focusTableCell(nextCell);
}

function runWhenVisible(container, elements, action, eager) {
  if (!elements.length) return;
  if (eager || !("IntersectionObserver" in window)) {
    elements.forEach((element) => { void action(element); });
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      observer.unobserve(entry.target);
      void action(entry.target);
    });
  }, { root: container === editor ? document.querySelector("#main-area") : null, rootMargin: "700px 0px" });
  previewObservers.add(observer);
  elements.forEach((element) => observer.observe(element));
}

async function enhancePreview(container, { eager = false } = {}) {
  container.querySelectorAll(".math-inline,.math-display").forEach((math) => {
    const tex = math.textContent || "";
    math.dataset.markdownMath = tex;
    math.contentEditable = "false";
    if (window.katex) window.katex.render(tex, math, {
      displayMode: math.classList.contains("math-display"),
      throwOnError: false,
      strict: "ignore"
    });
  });
  if (window.hljs) runWhenVisible(container, [...container.querySelectorAll("pre code:not(.language-mermaid)")], (code) => window.hljs.highlightElement(code), eager);
  const diagrams = [...container.querySelectorAll("pre code.language-mermaid")].map((code) => {
    const sourceText = code.textContent || "";
    const diagram = document.createElement("div");
    diagram.className = "mermaid mermaid-block";
    diagram.dataset.markdownSource = sourceText;
    diagram.contentEditable = "false";
    diagram.textContent = sourceText;
    code.closest("pre").replaceWith(diagram);
    return diagram;
  });
  if (diagrams.length && window.mermaid) {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
    const renderDiagram = async (diagram) => {
      try { await window.mermaid.run({ nodes: [diagram] }); }
      catch (error) {
        diagram.classList.add("diagram-error");
        diagram.textContent = "Diagram could not be rendered. Edit it in Source Code Mode.\n\n" + (diagram.dataset.markdownSource || "");
        console.warn("Mermaid render failed", error);
      }
    };
    if (eager) await Promise.all(diagrams.map(renderDiagram));
    else runWhenVisible(container, diagrams, renderDiagram, false);
  }
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
    case "word-count":
      wordPopover.hidden = !wordPopover.hidden;
      if (!wordPopover.hidden) updateWordCount();
      break;
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
    case "find": showFindbar(false); break;
    case "replace": showFindbar(true); break;
    case "select-all": (sourceMode ? source : editor).focus(); document.execCommand("selectAll"); break;
    case "undo": document.execCommand("undo"); break;
    case "redo": document.execCommand("redo"); break;
    case "about": window.alert("Typora RS 0.1.0\nRust + Tauri Markdown 编辑器"); break;
    case "shortcuts": window.alert("Ctrl+O 打开 · Ctrl+S 保存 · Ctrl+/ 源码模式\nCtrl+F 查找 · Ctrl+H 查找替换\nCtrl+B 加粗 · Ctrl+I 斜体 · Ctrl+K 链接\nCtrl+Shift+O 大纲 · Ctrl+Shift+T 打字机模式"); break;
    case "export-html": void exportHtml(); break;
    case "export-pdf": void printDocument(); break;
    case "table-add-row": editActiveTable("add-row"); break;
    case "table-add-column": editActiveTable("add-column"); break;
    case "table-delete-row": editActiveTable("delete-row"); break;
    case "table-delete-column": editActiveTable("delete-column"); break;
    case "table-align-left": editActiveTable("align-left"); break;
    case "table-align-center": editActiveTable("align-center"); break;
    case "table-align-right": editActiveTable("align-right"); break;
  }
}

async function exportHtml() {
  try {
    const markdown = markdownNow();
    const rendered = await invoke("render_markdown", { source: markdown, documentPath: activePath });
    const preview = document.createElement("div");
    preview.innerHTML = rendered.html;
    preview.querySelectorAll("img").forEach((image, index) => {
      if (rendered.images[index]) image.src = rendered.images[index].previewUrl;
    });
    await enhancePreview(preview, { eager: true });
    const katexCss = await getKatexCssWithEmbeddedFonts();
    const styles = katexCss + "\nbody{max-width:860px;margin:48px auto;padding:0 24px;color:#24292f;font:16px/1.75 Arial,'Microsoft YaHei UI',sans-serif}img,svg{max-width:100%}pre,code{font-family:Consolas,monospace}pre{padding:16px;background:#f6f8fa;border-radius:6px;overflow:auto}code{padding:.2em .4em;background:#eff1f3;border-radius:4px}table{border-collapse:collapse}th,td{padding:6px 12px;border:1px solid #d0d7de}blockquote{border-left:4px solid #d0d7de;padding-left:16px;color:#57606a}a{color:#0969da}";
    await invoke("export_html", { html: preview.innerHTML, styles });
  } catch (error) { window.alert(String(error)); }
}

async function printDocument() {
  const wasSourceMode = sourceMode;
  if (wasSourceMode) {
    await renderMarkdown(source.value);
    sourceMode = false;
    source.hidden = true;
    editor.hidden = false;
    document.body.classList.remove("source-mode");
  }
  window.addEventListener("afterprint", () => {
    if (wasSourceMode) {
      sourceMode = true;
      source.hidden = false;
      editor.hidden = true;
      document.body.classList.add("source-mode");
      source.focus();
    }
  }, { once: true });
  window.print();
}

async function getKatexCssWithEmbeddedFonts() {
  let css = await fetch("./vendor/katex/katex.min.css").then((response) => response.text());
  const urls = [...css.matchAll(/url\((?:"|')?([^)'\"]+)(?:"|')?\)/g)].map((match) => match[1]);
  for (const url of new Set(urls)) {
    if (!url.startsWith("fonts/")) continue;
    const response = await fetch("./vendor/katex/" + url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    const mime = url.endsWith(".woff2") ? "font/woff2" : url.endsWith(".woff") ? "font/woff" : "font/ttf";
    css = css.replaceAll(url, "data:" + mime + ";base64," + btoa(binary));
  }
  return css;
}

function closeMenus() {
  document.querySelectorAll(".menu-popup").forEach((menu) => { menu.hidden = true; });
  document.querySelectorAll(".menu-trigger").forEach((button) => button.classList.remove("open"));
}

function updateAfterEdit() {
  updateOutline();
  scheduleWordCount();
  setDirty(true);
  scheduleRecoveryDraft();
  const empty = editor.childNodes.length === 0 || (editor.childNodes.length === 1 && !editor.textContent.trim());
  editor.classList.toggle("is-empty", empty);
  if (typewriterMode) activeBlock()?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function scheduleRecoveryDraft() {
  clearTimeout(recoveryTimer);
  if (!dirty) return;
  recoveryTimer = setTimeout(() => {
    void invoke("save_recovery_draft", {
      content: markdownNow(),
      path: activePath,
      lineEnding: activeLineEnding
    }).catch((error) => console.error("Could not save recovery draft", error));
  }, 1500);
}

async function restoreRecoveryDraft() {
  try {
    const draft = await invoke("load_recovery_draft");
    if (!draft) return;
    if (!window.confirm("A recovered draft is available. Restore it now?")) {
      await invoke("clear_recovery_draft");
      return;
    }
    activePath = draft.path || null;
    activeLineEnding = draft.lineEnding || "lf";
    folderPath = activePath ? activePath.replace(/[\\/][^\\/]+$/, "") : null;
    sourceMode = false;
    source.hidden = true;
    editor.hidden = false;
    document.body.classList.remove("source-mode");
    const markdown = draft.content.replace(/\r\n?/g, "\n");
    source.value = markdown;
    await renderMarkdown(markdown);
    savedMarkdown = "\u0000recovered-draft";
    setDirty(true);
    if (folderPath) {
      activePanel = "files";
      showSidebar("files");
      await refreshFolder(folderPath);
    }
    editor.focus();
    placeCaretAtEnd(editor.lastElementChild || editor);
  } catch (error) {
    window.alert("Could not restore the recovered draft: " + String(error));
  }
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
    document.querySelector("#highlight-light").disabled = button.dataset.theme === "night";
    document.querySelector("#highlight-dark").disabled = button.dataset.theme !== "night";
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
document.querySelector("#replace-toggle").addEventListener("click", () => {
  replaceRow.hidden = !replaceRow.hidden;
  if (!replaceRow.hidden) replaceInput.focus();
});
document.querySelector("#replace-current").addEventListener("click", replaceCurrent);
document.querySelector("#replace-all").addEventListener("click", replaceAll);
findbar.addEventListener("mousedown", (event) => {
  if (event.target.closest("button")) event.preventDefault();
});
findInput.addEventListener("input", () => findNext(false));
findInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); findNext(event.shiftKey); }
  if (event.key === "Escape") findbar.hidden = true;
});

editor.addEventListener("input", updateAfterEdit);
source.addEventListener("input", updateAfterEdit);

editor.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key === "Enter" && activeTableCell) {
    event.preventDefault();
    editActiveTable("add-row");
    return;
  }
  if (event.key === "Tab" && activeTableCell) {
    const cells = [...activeTableCell.closest("table").querySelectorAll("td,th")];
    const index = cells.indexOf(activeTableCell);
    if (!event.shiftKey && index === cells.length - 1) {
      event.preventDefault();
      editActiveTable("add-row");
      const row = activeTableCell.closest("tr");
      focusTableCell(row.cells[0]);
      return;
    }
    const target = cells[index + (event.shiftKey ? -1 : 1)];
    if (target) {
      event.preventDefault();
      focusTableCell(target);
      return;
    }
  }
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
  const node = window.getSelection()?.anchorNode;
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (element && editor.contains(element)) {
    activeTableCell = element.closest("td,th");
    positionTableToolbar();
  }
});

function positionTableToolbar() {
  if (!activeTableCell || sourceMode || !editor.contains(activeTableCell)) {
    tableToolbar.hidden = true;
    return;
  }
  const bounds = activeTableCell.getBoundingClientRect();
  tableToolbar.hidden = false;
  tableToolbar.style.left = Math.max(8, Math.min(bounds.left, innerWidth - tableToolbar.offsetWidth - 8)) + "px";
  tableToolbar.style.top = Math.max(34, bounds.top - tableToolbar.offsetHeight - 6) + "px";
}

tableToolbar.addEventListener("mousedown", (event) => event.preventDefault());
tableToolbar.querySelectorAll("[data-table-action]").forEach((button) => {
  button.addEventListener("click", () => editActiveTable(button.dataset.tableAction));
});
document.querySelector("#main-area").addEventListener("scroll", positionTableToolbar, { passive: true });
window.addEventListener("resize", positionTableToolbar);

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
  else if (key === "h") { event.preventDefault(); showFindbar(true); }
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
  void restoreRecoveryDraft();
});
