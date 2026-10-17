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
const tableMoreButton = document.querySelector("#table-more-button");
const codeLangTooltip = document.createElement("div");
codeLangTooltip.id = "code-lang-tooltip";
codeLangTooltip.className = "code-lang-tooltip";
codeLangTooltip.innerHTML = '<span class="code-lang-value"></span>';
codeLangTooltip.hidden = true;
document.body.append(codeLangTooltip);
codeLangTooltip.addEventListener("mousedown", (event) => event.preventDefault());
codeLangTooltip.addEventListener("click", (event) => {
  if (event.target.closest(".code-lang-list")) return;
  beginLangEdit();
});
const BACKTICK = String.fromCharCode(96);
const preferenceDefaults = {
  autoRecover: true,
  restoreDraft: true,
  autoSave: false,
  autoSaveInterval: 1,
  saveOnSwitch: false,
  defaultLineEnding: "lf",
  spellCheck: false,
  fontFamily: "sans",
  fontSize: 17,
  lineHeight: 1.6,
  tabSize: 2,
  autoPair: true,
  autoFormatMarkdown: true,
  wrapCode: true,
  codeLineNumbers: false,
  imageLocation: "document-assets",
  relativeImageDot: true,
  smartPunctuation: false,
  enableMath: true,
  enableSubscript: true,
  enableSuperscript: true,
  emojiShortcodes: true,
  hardLineBreaks: false,
  exportTheme: true,
  exportOutline: false,
  pageBreakHeadings: false,
  theme: "github",
  contentWidth: 1100,
  zoom: 100,
  startupSidebar: "files",
  statusBar: true,
  typewriterCenter: true,
};
const preferenceKey = "typora-rs-preferences-v1";
let preferences = loadPreferences();

function loadPreferences() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(preferenceKey) || "{}") || {}; } catch (_) {}
  if (!localStorage.getItem("typora-rs-pref-layout-v2")) {
    localStorage.setItem("typora-rs-pref-layout-v2", "1");
    // One-time migration: these were the defaults before the layout was widened.
    if (stored.fontSize === 16) stored.fontSize = preferenceDefaults.fontSize;
    if (stored.contentWidth === 920) stored.contentWidth = preferenceDefaults.contentWidth;
  }
  if (!localStorage.getItem("typora-rs-pref-layout-v3")) {
    localStorage.setItem("typora-rs-pref-layout-v3", "1");
    // One-time migration: widen content further and default to wrapping code lines.
    if (stored.contentWidth === 1000) stored.contentWidth = preferenceDefaults.contentWidth;
    if (stored.wrapCode === false) stored.wrapCode = preferenceDefaults.wrapCode;
  }
  return { ...preferenceDefaults, ...stored };
}

function savePreferences() {
  localStorage.setItem(preferenceKey, JSON.stringify(preferences));
}

function applyPreferences() {
  const fonts = {
    sans: '"Helvetica Neue", Helvetica, Arial, "Microsoft YaHei UI", sans-serif',
    serif: 'Georgia, "Songti SC", serif',
    mono: 'Consolas, "Courier New", monospace',
  };
  document.documentElement.style.setProperty("--document-font-family", fonts[preferences.fontFamily] || fonts.sans);
  document.documentElement.style.setProperty("--document-font-size", `${preferences.fontSize}px`);
  document.documentElement.style.setProperty("--document-line-height", preferences.lineHeight);
  document.documentElement.style.setProperty("--document-width", `${preferences.contentWidth}px`);
  document.documentElement.style.setProperty("--source-tab-size", preferences.tabSize);
  document.body.style.zoom = preferences.zoom === 100 ? "" : String(preferences.zoom / 100);
  document.body.classList.toggle("wrap-code-lines", preferences.wrapCode);
  document.body.classList.toggle("print-page-breaks", preferences.pageBreakHeadings);
  editor.spellcheck = preferences.spellCheck;
  source.spellcheck = preferences.spellCheck;
  document.body.classList.toggle("hide-statusbar", !preferences.statusBar);
  if (preferences.theme === "github") delete document.body.dataset.theme;
  else document.body.dataset.theme = preferences.theme;
  document.querySelector("#highlight-light").disabled = preferences.theme === "night";
  document.querySelector("#highlight-dark").disabled = preferences.theme !== "night";
}

applyPreferences();

let activePath = null;
let activeLineEnding = preferences.defaultLineEnding;
let savedMarkdown = "";
let dirty = false;
let sourceMode = false;
let focusMode = false;
let typewriterMode = false;
let activePanel = "outline";
let folderRoot = null;
let treeRootNode = null;
const treeNodes = new Map();
const treeElements = new Map();
let selectedTreeNode = null;
let renamingPath = null;
let pendingFsEvents = [];
let zoomLevel = preferences.zoom / 100;
let recoveryTimer = null;
let wordCountTimer = null;
let autoSaveTimer = null;
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
  if (signature !== outlineSignature) {
    outlineSignature = signature;
    outline.replaceChildren();
    if (!headings.length) {
      const empty = document.createElement("div");
      empty.className = "sidebar-empty";
      empty.textContent = "Headings will appear here";
      outline.append(empty);
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
  syncActiveOutlineItem();
}

function syncActiveOutlineItem() {
  if (activePanel !== "outline") return;
  const items = [...outline.querySelectorAll(".outline-item")];
  if (!items.length) return;
  const headings = [...editor.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  let index = -1;
  headings.forEach((heading, index2) => {
    if (heading.getBoundingClientRect().top <= 120) index = index2;
  });
  items.forEach((item, index2) => item.classList.toggle("active", index2 === index));
}

function buildFrontMatterBlock(raw) {
  if (!raw) return null;
  const lines = raw.replace(/\r\n?/g, "\n")
    .replace(/^---[ \t]*\n/, "")
    .replace(/\n---[ \t]*(?:\n|$)$/, "")
    .split("\n");
  const block = document.createElement("div");
  block.className = "front-matter";
  block.contentEditable = "false";
  let row = null;
  for (const line of lines) {
    const match = line.match(/^([^\s:][^:]*):(?:\s+(.*))?$/);
    if (match) {
      row = document.createElement("div");
      row.className = "front-matter-row";
      const key = document.createElement("span");
      key.className = "front-matter-key";
      key.textContent = match[1].trim();
      const value = document.createElement("span");
      value.className = "front-matter-value";
      value.textContent = match[2] || "";
      row.append(key, value);
      block.append(row);
    } else if (row && line.trim()) {
      row.querySelector(".front-matter-value").textContent += "\n" + line;
    }
  }
  return block.childElementCount ? block : null;
}

function renderMarkdown(markdown) {
  const sequence = ++renderSequence;
  previewObservers.forEach((observer) => observer.disconnect());
  previewObservers.clear();
  editor.setAttribute("aria-busy", "true");
  statusCenter.textContent = "正在解析 Markdown…";
  return invoke("render_markdown", {
    source: markdown, documentPath: activePath,
    smartPunctuation: preferences.smartPunctuation,
    enableMath: preferences.enableMath,
    enableSubscript: preferences.enableSubscript,
    enableSuperscript: preferences.enableSuperscript,
    emojiShortcodes: preferences.emojiShortcodes,
    hardLineBreaks: preferences.hardLineBreaks,
  }).then(async (result) => {
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
    const frontBlock = buildFrontMatterBlock(editor.dataset.frontMatter);
    if (frontBlock) editor.insertBefore(frontBlock, editor.firstChild);
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

function textDisplayWidth(text) {
  let width = 0;
  for (const ch of text) width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return width;
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
  // "格式化表格源码"标记过的表格按显示宽度补齐空格，让管道符上下对齐（中文按 2 列计）。
  const widths = table.classList.contains("table-formatted")
    ? Array.from({ length: columns }, (_, index) => Math.max(3, ...[header, divider, ...rows.slice(1)].map((row) => textDisplayWidth(row[index] || ""))))
    : null;
  const format = (row) => "| " + Array.from({ length: columns }, (_, index) => {
    const text = row[index] || "";
    return widths ? text + " ".repeat(Math.max(0, widths[index] - textDisplayWidth(text))) : text;
  }).join(" | ") + " |";
  return [format(header), format(divider), ...rows.slice(1).map(format)].join("\n");
}

function blockMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.nodeValue || "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  if (node.classList.contains("front-matter")) return "";
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
    return BACKTICK.repeat(3) + language + "\n" + (code ? codeLogicalText(code) : node.innerText.replace(/\n$/, "")) + "\n" + BACKTICK.repeat(3);
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
  if (!(await canSwitchDocument())) return;
  try {
    const file = await invoke("open_document");
    if (!file) return;
    await invoke("clear_recovery_draft");
    await showDocument(file);
  } catch (error) {
    window.alert(String(error));
  }
}

async function canSwitchDocument() {
  if (!dirty) return true;
  if (preferences.saveOnSwitch && activePath) {
    await saveDocument(false);
    return !dirty;
  }
  return window.confirm("This document has unsaved changes. Continue and discard them?");
}

async function showDocument(file) {
  activePath = normalizeTreePath(file.path);
  activeLineEnding = file.lineEnding;
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
  await revealFileInTree(file.path);
}

function normalizeTreePath(path) {
  return String(path).replace(/^\\\\\?\\/, "");
}

function isWithinRoot(path) {
  if (!folderRoot) return false;
  const normalized = normalizeTreePath(path).toLocaleLowerCase();
  const root = normalizeTreePath(folderRoot).toLocaleLowerCase().replace(/[\\/]+$/, "");
  return normalized === root || normalized.startsWith(root + "\\") || normalized.startsWith(root + "/");
}

function makeTreeNode(entry, parent) {
  const node = {
    path: normalizeTreePath(entry.path),
    name: entry.name,
    isDirectory: Boolean(entry.isDirectory),
    parent,
    expanded: false,
    loaded: false,
    children: [],
  };
  treeNodes.set(node.path.toLocaleLowerCase(), node);
  return node;
}

function forgetTreeSubtree(node) {
  treeNodes.delete(node.path.toLocaleLowerCase());
  node.children.forEach(forgetTreeSubtree);
}

async function loadChildren(node) {
  const listing = await invoke("list_folder", { path: node.path });
  const previous = new Map(node.children.map((child) => [child.path.toLocaleLowerCase(), child]));
  forgetTreeSubtree(node);
  node.children = listing.entries.map((entry) => {
    const child = makeTreeNode(entry, node);
    const before = previous.get(child.path.toLocaleLowerCase());
    if (before?.expanded) child.expanded = true;
    return child;
  });
  node.loaded = true;
  treeNodes.set(node.path.toLocaleLowerCase(), node);
  for (const child of node.children) {
    if (child.expanded && !child.loaded) {
      try { await loadChildren(child); }
      catch (_) {}
    }
  }
}

function nodeDepth(node) {
  let depth = 0;
  for (let parent = node.parent; parent; parent = parent.parent) depth += 1;
  return depth;
}

function renderTreeNode(node) {
  const depth = nodeDepth(node);
  const row = document.createElement("div");
  row.className = "file-library-node file-tree-node" + (node.isDirectory ? " directory" : " file")
    + (node.expanded ? " expanded" : "")
    + (node.path === activePath ? " active" : "")
    + (node.path === selectedTreeNode?.path ? " selected" : "");
  row.dataset.path = node.path;
  row.dataset.isDirectory = String(node.isDirectory);
  row.tabIndex = -1;

  const content = document.createElement("div");
  content.className = "file-node-content";
  content.style.paddingLeft = (6 + depth * 13) + "px";

  const openState = document.createElement("span");
  openState.className = "file-node-open-state";
  openState.textContent = node.isDirectory ? (node.expanded ? "▾" : "▸") : "";
  const title = document.createElement("span");
  title.className = "file-node-title";
  title.textContent = node.name;
  const renameInput = document.createElement("input");
  renameInput.className = "file-tree-rename-input";
  renameInput.type = "text";
  renameInput.setAttribute("aria-label", "重命名");
  content.append(openState, title, renameInput);

  const children = document.createElement("div");
  children.className = "file-node-children";

  row.append(content, children);
  treeElements.set(node.path.toLocaleLowerCase(), row);
  if (node.expanded && node.loaded) {
    node.children.forEach((child) => children.append(renderTreeNode(child)));
  }
  return row;
}

function renderNodeChildren(node) {
  const row = treeElements.get(node.path.toLocaleLowerCase());
  if (!row) return;
  const container = row.querySelector(":scope > .file-node-children");
  container.replaceChildren();
  node.children.forEach((child) => container.append(renderTreeNode(child)));
}

function renderTree() {
  const tree = document.querySelector("#file-library-tree");
  tree.replaceChildren();
  treeElements.clear();
  if (!folderRoot || !treeRootNode) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "打开文件夹以浏览 Markdown 文档";
    tree.append(empty);
    return;
  }
  tree.append(renderTreeNode(treeRootNode));
}

async function mountFolder(path) {
  folderRoot = normalizeTreePath(path);
  treeNodes.clear();
  treeElements.clear();
  treeRootNode = makeTreeNode({ path, name: normalizeTreePath(path).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path, isDirectory: true }, null);
  treeRootNode.expanded = true;
  selectedTreeNode = null;
  renderTree();
  try {
    await invoke("watch_folder", { path });
    await loadChildren(treeRootNode);
    renderTree();
  } catch (error) {
    window.alert(String(error));
  }
}

async function expandNode(node) {
  if (!node.isDirectory) return;
  if (!node.loaded) {
    try { await loadChildren(node); }
    catch (error) { window.alert(String(error)); return; }
  }
  node.expanded = true;
  const row = treeElements.get(node.path.toLocaleLowerCase());
  if (row) {
    row.classList.add("expanded");
    row.querySelector(".file-node-open-state").textContent = "▾";
  }
  renderNodeChildren(node);
}

function collapseNode(node) {
  node.expanded = false;
  const row = treeElements.get(node.path.toLocaleLowerCase());
  if (row) {
    row.classList.remove("expanded");
    row.querySelector(".file-node-open-state").textContent = "▸";
    row.querySelector(":scope > .file-node-children").replaceChildren();
  }
}

async function reloadDirectory(dirPath, options = {}) {
  if (!dirPath) return;
  const node = treeNodes.get(dirPath.toLocaleLowerCase());
  if (!node || !node.isDirectory) return;
  if (!node.expanded) {
    if (options.forceExpand) await expandNode(node);
    else node.loaded = false;
    return;
  }
  try { await loadChildren(node); }
  catch (_) { return; }
  renderNodeChildren(node);
  markActivePath();
}

function markActivePath() {
  treeElements.forEach((row) => row.classList.toggle("active", row.dataset.path === activePath));
}

async function revealFileInTree(path) {
  if (!path) return;
  if (!folderRoot || !isWithinRoot(path)) {
    await mountFolder(parentDirectory(normalizeTreePath(path)));
  }
  if (!treeRootNode) return;
  const rootPath = normalizeTreePath(folderRoot).replace(/[\\/]+$/, "");
  const parts = normalizeTreePath(path).slice(rootPath.length).split(/[\\/]+/).filter(Boolean);
  let node = treeRootNode;
  for (let index = 0; index < parts.length; index += 1) {
    if (!node.loaded) {
      try { await loadChildren(node); }
      catch (_) { return; }
    }
    if (node.expanded) renderNodeChildren(node);
    const child = node.children.find((candidate) => candidate.name === parts[index]);
    if (!child) return;
    if (index < parts.length - 1) child.expanded = true;
    node = child;
  }
  selectedTreeNode = node;
  const tree = document.querySelector("#file-library-tree");
  const row = treeElements.get(node.path.toLocaleLowerCase());
  if (row) {
    tree.querySelectorAll(".file-library-node.selected").forEach((other) => other.classList.remove("selected"));
    row.classList.add("selected", "active");
    row.scrollIntoView({ block: "nearest" });
  }
}

function parentDirectory(path) {
  const normalized = path.replace(/[\\/]+$/, "");
  const separator = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  if (separator < 0) return path;
  if (separator === 2 && /^[A-Za-z]:/.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, separator) || normalized.slice(0, 1);
}

function selectTreeNode(node) {
  selectedTreeNode = node;
  const tree = document.querySelector("#file-library-tree");
  tree.querySelectorAll(".file-library-node.selected").forEach((other) => other.classList.remove("selected"));
  if (!node) return;
  const row = treeElements.get(node.path.toLocaleLowerCase());
  if (row) {
    row.classList.add("selected");
    row.scrollIntoView({ block: "nearest" });
  }
}

function closeContextMenu() {
  const menu = document.querySelector("#file-context-menu");
  menu.hidden = true;
  menu.replaceChildren();
}

function renderContextMenuEntries(container, items) {
  items.forEach((item) => {
    if (item === "-" || item.divider) {
      const divider = document.createElement("div");
      divider.className = "file-context-menu-divider";
      container.append(divider);
      return;
    }
    if (item.row) {
      const row = document.createElement("div");
      row.className = "file-context-menu-row";
      item.row.forEach((entry) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "file-context-menu-row-button" + (entry.checked ? " checked" : "");
        button.title = entry.title || entry.label;
        button.textContent = entry.label;
        if (entry.action && !entry.disabled) {
          button.addEventListener("click", () => { closeContextMenu(); entry.action(); });
        } else {
          button.disabled = true;
        }
        row.append(button);
      });
      container.append(row);
      return;
    }
    const entry = document.createElement("div");
    entry.className = "file-context-menu-item"
      + (item.destructive ? " destructive" : "")
      + (item.disabled ? " disabled" : "")
      + (item.checked ? " checked" : "")
      + (item.children ? " has-extra-menu" : "");
    entry.setAttribute("role", "menuitem");
    const label = document.createElement("span");
    label.className = "file-context-menu-label";
    label.textContent = item.label;
    entry.append(label);
    if (item.shortcut) {
      const shortcut = document.createElement("span");
      shortcut.className = "file-context-menu-shortcut";
      shortcut.textContent = item.shortcut;
      entry.append(shortcut);
    }
    if (item.children) {
      const caret = document.createElement("span");
      caret.className = "file-context-menu-caret";
      caret.textContent = "›";
      entry.append(caret);
      const submenu = document.createElement("div");
      submenu.className = "file-context-menu-submenu";
      renderContextMenuEntries(submenu, item.children);
      entry.append(submenu);
      entry.addEventListener("mouseenter", () => positionContextMenuSubmenu(entry, submenu));
    } else if (item.action && !item.disabled) {
      entry.addEventListener("click", () => { closeContextMenu(); item.action(); });
    }
    container.append(entry);
  });
}

function positionContextMenuSubmenu(entry, submenu) {
  submenu.classList.remove("flip-left");
  submenu.style.top = "0px";
  const rect = entry.getBoundingClientRect();
  const box = submenu.getBoundingClientRect();
  let offset = -5;
  if (rect.top + offset + box.height > window.innerHeight - 8) {
    offset = window.innerHeight - 8 - box.height - rect.top;
  }
  submenu.style.top = Math.max(offset, 4 - rect.top) + "px";
  if (rect.right + box.width > window.innerWidth - 8) submenu.classList.add("flip-left");
}

function openContextMenu(x, y, items) {
  const menu = document.querySelector("#file-context-menu");
  menu.replaceChildren();
  renderContextMenuEntries(menu, items);
  menu.onmousedown = (event) => event.preventDefault();
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 8)) + "px";
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 8)) + "px";
}

function contextMenuItems(node) {
  if (!node) {
    const items = folderRoot
      ? [
          { label: "新建文件", action: () => void createTreeEntry("file") },
          { label: "新建文件夹", action: () => void createTreeEntry("folder") },
          { label: "刷新", action: () => { if (folderRoot) void reloadDirectory(folderRoot); } },
          { label: "在资源管理器中显示", action: () => void revealTreeEntry(null) },
        ]
      : [];
    items.push({ label: "打开文件夹…", action: () => void chooseFolder() });
    return items;
  }
  if (node.isDirectory) {
    const items = [
      { label: "新建文件", action: () => { selectTreeNode(node); void createTreeEntry("file"); } },
      { label: "新建文件夹", action: () => { selectTreeNode(node); void createTreeEntry("folder"); } },
    ];
    if (node.parent) {
      items.push(
        { label: "重命名", action: () => startInlineRename(node) },
        { label: "复制文件夹路径", action: () => void copyTreePath(node) },
        { label: "在资源管理器中显示", action: () => void revealTreeEntry(node) },
        { label: "删除", destructive: true, action: () => void deleteTreeEntry(node) },
      );
    } else {
      items.push(
        { label: "复制文件夹路径", action: () => void copyTreePath(node) },
        { label: "在资源管理器中显示", action: () => void revealTreeEntry(node) },
      );
    }
    return items;
  }
  return [
    { label: "打开", action: () => void openTreeFile(node) },
    { label: "重命名", action: () => startInlineRename(node) },
    { label: "复制文件", action: () => void duplicateTreeEntry(node) },
    { label: "复制文件路径", action: () => void copyTreePath(node) },
    { label: "在资源管理器中显示", action: () => void revealTreeEntry(node) },
    { label: "删除", destructive: true, action: () => void deleteTreeEntry(node) },
  ];
}

async function openTreeFile(node) {
  if (!node || node.isDirectory) return;
  if (!(await canSwitchDocument())) return;
  try {
    const file = await invoke("open_document_by_path", { path: node.path });
    await invoke("clear_recovery_draft");
    await showDocument(file);
  } catch (error) { window.alert(String(error)); }
}

async function createTreeEntry(kind) {
  if (!folderRoot) return;
  const targetDir = selectedTreeNode
    ? (selectedTreeNode.isDirectory ? selectedTreeNode.path : parentDirectory(selectedTreeNode.path))
    : folderRoot;
  try {
    const created = await invoke("create_entry", { folder: targetDir, kind });
    if (!created) return;
    await reloadDirectory(targetDir, { forceExpand: true });
    const node = treeNodes.get(normalizeTreePath(created.path).toLocaleLowerCase());
    if (node) {
      selectTreeNode(node);
      if (!node.isDirectory) startInlineRename(node);
    }
  } catch (error) { window.alert(String(error)); }
}

function startInlineRename(node) {
  if (!node || renamingPath) return;
  const row = treeElements.get(node.path.toLocaleLowerCase());
  const input = row?.querySelector(".file-tree-rename-input");
  if (!row || !input) return;
  renamingPath = node.path;
  row.classList.add("file-node-on-edit");
  selectTreeNode(node);
  input.value = node.name;
  const dot = node.name.lastIndexOf(".");
  if (!node.isDirectory && dot > 0) input.setSelectionRange(0, dot);
  else input.select();
  input.focus();
}

function finishInlineRename(node) {
  const row = treeElements.get(node.path.toLocaleLowerCase());
  const input = row?.querySelector(".file-tree-rename-input");
  const value = input ? input.value : "";
  if (row) row.classList.remove("file-node-on-edit");
  renamingPath = null;
  return value;
}

async function commitInlineRename() {
  if (!renamingPath) return;
  const node = treeNodes.get(renamingPath.toLocaleLowerCase());
  if (!node) { renamingPath = null; return; }
  const newName = finishInlineRename(node).trim();
  const oldPath = node.path;
  const parentDir = parentDirectory(oldPath);
  if (!newName || newName === node.name) { flushPendingFsEvents(); return; }
  if (node.path === activePath && dirty) await saveDocument(false);
  try {
    const newPath = normalizeTreePath(await invoke("rename_entry", { path: oldPath, newName }));
    treeNodes.delete(oldPath.toLocaleLowerCase());
    node.path = newPath;
    node.name = newName;
    treeNodes.set(newPath.toLocaleLowerCase(), node);
    const row = treeElements.get(oldPath.toLocaleLowerCase());
    treeElements.delete(oldPath.toLocaleLowerCase());
    if (row) {
      treeElements.set(newPath.toLocaleLowerCase(), row);
      row.dataset.path = newPath;
      row.querySelector(".file-node-title").textContent = newName;
    }
    if (node.isDirectory && activePath) {
      const oldLower = oldPath.toLocaleLowerCase();
      const activeLower = activePath.toLocaleLowerCase();
      if (activeLower === oldLower || activeLower.startsWith(oldLower + "\\") || activeLower.startsWith(oldLower + "/")) {
        activePath = newPath + activePath.slice(oldPath.length);
        try { await invoke("adopt_document_path", { path: activePath }); } catch (_) {}
        setDirty(dirty);
      }
    } else if (node.path === activePath) {
      activePath = newPath;
      try { await invoke("adopt_document_path", { path: activePath }); } catch (_) {}
      setDirty(dirty);
    }
    if (node.isDirectory) await reloadDirectory(parentDir, { forceExpand: true });
    else markActivePath();
  } catch (error) {
    window.alert(String(error));
    await reloadDirectory(parentDir);
  }
  flushPendingFsEvents();
}

function cancelInlineRename() {
  if (!renamingPath) return;
  const node = treeNodes.get(renamingPath.toLocaleLowerCase());
  if (node) finishInlineRename(node);
  flushPendingFsEvents();
}

async function duplicateTreeEntry(node) {
  if (!node || node.isDirectory) return;
  try {
    const created = await invoke("duplicate_entry", { path: node.path });
    if (created) await reloadDirectory(parentDirectory(node.path));
  } catch (error) { window.alert(String(error)); }
}

async function deleteTreeEntry(node) {
  if (!node || !node.parent) return;
  if (!window.confirm(`确定将“${node.name}”移入回收站吗？`)) return;
  try {
    await invoke("trash_entry", { path: node.path });
    await reloadDirectory(parentDirectory(node.path));
  } catch (error) { window.alert(String(error)); }
}

async function revealTreeEntry(node) {
  const target = node ? node.path : folderRoot;
  if (!target) return;
  try { await invoke("reveal_entry", { path: target }); }
  catch (error) { window.alert(String(error)); }
}

async function copyTreePath(node) {
  const target = node ? node.path : folderRoot;
  if (!target) return;
  try { await navigator.clipboard.writeText(normalizeTreePath(target)); }
  catch (_) { window.alert("复制失败"); }
}

function handleFsChanges(changes) {
  if (!folderRoot) return;
  const directories = new Set();
  changes.forEach((change) => {
    const normalized = normalizeTreePath(change.path);
    if (!isWithinRoot(normalized)) return;
    const parent = parentDirectory(normalized);
    directories.add(isWithinRoot(parent) ? parent.toLocaleLowerCase() : folderRoot.toLocaleLowerCase());
  });
  directories.forEach((key) => {
    const node = treeNodes.get(key);
    if (node) void reloadDirectory(node.path);
  });
}

function queueFsChanges(changes) {
  if (renamingPath) {
    pendingFsEvents.push(...changes);
    return;
  }
  handleFsChanges(changes);
}

function flushPendingFsEvents() {
  const events = pendingFsEvents;
  pendingFsEvents = [];
  if (events.length && !renamingPath) handleFsChanges(events);
}

function bindTreeEvents() {
  const tree = document.querySelector("#file-library-tree");

  tree.addEventListener("click", (event) => {
    if (event.target.closest(".file-tree-rename-input")) return;
    const row = event.target.closest(".file-library-node");
    if (!row) {
      selectTreeNode(null);
      return;
    }
    const node = treeNodes.get(row.dataset.path.toLocaleLowerCase());
    if (!node) return;
    selectTreeNode(node);
    if (node.isDirectory) {
      if (node.expanded) collapseNode(node);
      else void expandNode(node);
    } else {
      void openTreeFile(node);
    }
  });

  tree.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const row = event.target.closest(".file-library-node");
    const node = row?.dataset.path ? treeNodes.get(row.dataset.path.toLocaleLowerCase()) : null;
    if (node) selectTreeNode(node);
    openContextMenu(event.clientX, event.clientY, contextMenuItems(node));
  });

  tree.addEventListener("keydown", (event) => {
    const input = event.target.closest?.(".file-tree-rename-input");
    if (input) {
      if (event.key === "Enter") {
        event.preventDefault();
        void commitInlineRename();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelInlineRename();
      }
      return;
    }
    if (event.key === "Escape") {
      closeContextMenu();
      return;
    }
    if (renamingPath || !selectedTreeNode) return;
    if (event.key === "F2") {
      event.preventDefault();
      startInlineRename(selectedTreeNode);
    } else if (event.key === "Delete") {
      event.preventDefault();
      void deleteTreeEntry(selectedTreeNode);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (selectedTreeNode.isDirectory) {
        if (selectedTreeNode.expanded) collapseNode(selectedTreeNode);
        else void expandNode(selectedTreeNode);
      } else {
        void openTreeFile(selectedTreeNode);
      }
    }
  });

  tree.addEventListener("focusout", (event) => {
    if (renamingPath && event.target.closest?.(".file-tree-rename-input")) void commitInlineRename();
  });
}


async function chooseFolder() {
  try {
    const listing = await invoke("choose_folder");
    if (!listing) return;
    activePanel = "files";
    showSidebar("files");
    await mountFolder(listing.path);
  } catch (error) { window.alert(String(error)); }
}

async function saveDocument(saveAs) {
  if (!dirty && !saveAs && activePath) return;
  const markdown = markdownNow();
  try {
    const lineEnding = activePath ? activeLineEnding : preferences.defaultLineEnding;
    const path = await invoke("save_document", { content: markdown, saveAs: Boolean(saveAs), lineEnding });
    if (!path) return;
    activePath = normalizeTreePath(path);
    activeLineEnding = lineEnding;
    savedMarkdown = markdown;
    source.value = markdown;
    clearTimeout(recoveryTimer);
    await invoke("clear_recovery_draft");
    setDirty(false);
  } catch (error) {
    window.alert(String(error));
  }
}

function resetAutoSaveTimer() {
  clearInterval(autoSaveTimer);
  autoSaveTimer = null;
  if (!preferences.autoSave) return;
  autoSaveTimer = setInterval(async () => {
    if (!dirty || !activePath) return;
    const markdown = markdownNow();
    try {
      const path = await invoke("save_document", { content: markdown, saveAs: false, lineEnding: activeLineEnding });
      if (!path) return;
      savedMarkdown = markdown;
      if (markdownNow() === markdown) {
        clearTimeout(recoveryTimer);
        await invoke("clear_recovery_draft");
        setDirty(false);
      }
    } catch (error) { console.error("Auto save failed", error); }
  }, Number(preferences.autoSaveInterval) * 60_000);
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
  } else if (action === "add-row-above") {
    const rowIndex = row.parentElement.tagName === "THEAD" ? 0 : Math.max(0, [...body.rows].indexOf(row));
    const newRow = body.insertRow(rowIndex);
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
  } else if (action === "add-column-left") {
    [...table.rows].forEach((tableRow) => {
      const newCell = document.createElement(tableRow.parentElement.tagName === "THEAD" ? "th" : "td");
      newCell.append(document.createElement("br"));
      tableRow.insertBefore(newCell, tableRow.cells[column] || null);
      if (tableRow === row) nextCell = newCell;
    });
  } else if (action === "delete-column") {
    const columns = Math.max(...[...table.rows].map((tableRow) => tableRow.cells.length));
    if (columns <= 1) return;
    [...table.rows].forEach((tableRow) => tableRow.cells[column]?.remove());
    nextCell = row.cells[Math.min(column, row.cells.length - 1)] || row.cells[row.cells.length - 1] || null;
  } else if (action === "move-row-up" || action === "move-row-down") {
    if (row.parentElement.tagName === "THEAD") return;
    const rows = [...body.rows];
    const index = rows.indexOf(row);
    if (action === "move-row-up" && index > 0) row.parentNode.insertBefore(row, rows[index - 1]);
    if (action === "move-row-down" && index < rows.length - 1) row.parentNode.insertBefore(rows[index + 1], row);
  } else if (action === "move-col-left" || action === "move-col-right") {
    const delta = action === "move-col-left" ? -1 : 1;
    [...table.rows].forEach((tableRow) => {
      const current = tableRow.cells[column];
      const neighbor = tableRow.cells[column + delta];
      if (!current || !neighbor) return;
      tableRow.insertBefore(delta < 0 ? current : neighbor, delta < 0 ? neighbor : current);
    });
  } else if (action === "delete-table") {
    table.remove();
    if (!editor.firstElementChild) {
      const paragraph = document.createElement("p");
      paragraph.append(document.createElement("br"));
      editor.append(paragraph);
    }
    placeCaretAtEnd(editor.lastElementChild || editor);
    updateAfterEdit();
    return;
  } else if (action.startsWith("align-")) {
    const align = action.slice(6);
    [...table.rows].forEach((tableRow) => { if (tableRow.cells[column]) tableRow.cells[column].style.textAlign = align; });
  }
  updateAfterEdit();
  if (nextCell) focusTableCell(nextCell);
}

function formatTableSource() {
  const table = activeTableCell?.closest("table");
  if (!table || !editor.contains(table)) return;
  table.classList.add("table-formatted");
  updateAfterEdit();
  statusCenter.textContent = "表格源码已格式化";
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

function highlightCode(code) {
  window.hljs.highlightElement(code);
  if (!preferences.codeLineNumbers) return;
  const pre = code.closest("pre");
  if (!pre || pre.querySelector(".code-gutter")) return;
  const lineCount = Math.max(1, (code.textContent || "").replace(/\n$/, "").split("\n").length);
  const gutter = document.createElement("span");
  gutter.className = "code-gutter";
  gutter.setAttribute("aria-hidden", "true");
  gutter.textContent = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n");
  pre.classList.add("numbered-code");
  pre.insertBefore(gutter, code);
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
  if (window.hljs) runWhenVisible(container, [...container.querySelectorAll("pre code:not(.language-mermaid)")], highlightCode, eager);
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
    const image = await invoke("import_image", { imageLocation: preferences.imageLocation, relativeDot: preferences.relativeImageDot });
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

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {}
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch (_) { return false; }
}

function selectionRange() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  return selection.getRangeAt(0);
}

const codeLanguages = ["js","javascript","java","json","typescript","ts","clojure","coffeescript","css","less","scss","gfm","markdown","xaml","xml","haskell","html","lua","lisp","commonlisp","pascal","perl","perl6","php","php+html","python","cython","ruby","shell","sh","sql","sqlite","mssql","mysql","cql","mariadb","cassandra","plsql","tiddlywiki","wiki","vb","basic","visual basic","vbscript","velocity","verilog","xquery","yaml","go","groovy","nginx","octave","c","clike","c++","cpp","objc","objective-c","csharp","c#","squirrel","ceylon","kotlin","tex","latex","swift","scala","r","d","diff","erlang","http","jade","rst","rust","jinja2","restructuredtext","asp","jsp","erb","ejs","embeddedjs","powershell","dockerfile","jsx","tsx","react","vue","nsis","mathematica","tiki wiki","properties","ini","livescript","assembly","gas","toml","matlab","ocaml","f#","fsharp","elm","pgp","asciiarmor","spreadsheet","elixir","cmake","cypher","dart","django","dtd","xml-dtd","dylan","handlebars","idl","web-idl","yacas","mbox","vhdl","julia","haxe","hxml","fortran","protobuf","makefile","tcl","scheme","twig","bash","sas","pseudocode","stylus","cobol","oz","sparql","crystal","asn.1","gherkin","smalltalk","turtle","glsl","apl","abap","q","v","forth","nim","solidity","htaccess","postgresql","hive","stata","systemverilog","smarty","yara","pug","svelte","pegjs","cmd","bat","modelica","structured text","url","mermaid"];
let lastCodeLang = "";
try { lastCodeLang = localStorage.getItem("typora-rs-last-code-lang") || ""; } catch (_) {}
let activeLangPre = null;
let langEditing = false;
let langEditCaret = null;

function rememberCodeLang(lang) {
  lastCodeLang = lang;
  try { localStorage.setItem("typora-rs-last-code-lang", lang); } catch (_) {}
}

function currentCodeBlock() {
  if (sourceMode) return null;
  const block = activeBlock();
  if (!block || block.tagName !== "PRE" || !editor.contains(block)) return null;
  const code = block.querySelector("code");
  if (!code || code.classList.contains("language-mermaid")) return null;
  return block;
}

function codeLanguageOf(code) {
  return [...code.classList].find((name) => name.startsWith("language-"))?.slice(9) || "";
}

function codeNormalizedText(code) {
  let text = "";
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) { text += node.textContent; return; }
    if (node.nodeName === "BR") { text += "\n"; return; }
    [...node.childNodes].forEach(walk);
  };
  walk(code);
  return text;
}

function codeLogicalText(code) {
  // The empty-block placeholder is a lone <br>, which normalizes to "\n" but
  // renders as a single line; map it back to the empty string.
  const text = codeNormalizedText(code);
  return text === "\n" && !code.textContent ? "" : text;
}

function lineColOfText(text, offset) {
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length - 1, ch: lines[lines.length - 1].length };
}

function codeAbsoluteOffset(code, container, offset) {
  let total = 0;
  const stopped = { value: false };
  const walk = (node) => {
    if (stopped.value) return;
    if (node === container) {
      if (node.nodeType === Node.TEXT_NODE) total += offset;
      else [...node.childNodes].slice(0, offset).forEach(walk);
      stopped.value = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) { total += node.textContent.length; return; }
    if (node.nodeName === "BR") { total += 1; return; }
    [...node.childNodes].forEach(walk);
  };
  walk(code);
  return stopped.value ? total : null;
}

function codeOffsetToPosition(code, absoluteOffset) {
  let remaining = absoluteOffset;
  const find = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (remaining <= node.textContent.length) return { node, offset: remaining };
      remaining -= node.textContent.length;
      return null;
    }
    if (node.nodeName === "BR") {
      if (remaining === 0) return { before: node };
      remaining -= 1;
      return null;
    }
    for (const child of [...node.childNodes]) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  return find(code);
}

function placeCaretInCode(code, absoluteOffset, endOffset) {
  editor.focus();
  const range = document.createRange();
  const start = codeOffsetToPosition(code, absoluteOffset);
  if (start?.before) range.setStartBefore(start.before);
  else if (start) range.setStart(start.node, start.offset);
  else { range.selectNodeContents(code); range.collapse(false); }
  if (endOffset != null && endOffset !== absoluteOffset) {
    const end = codeOffsetToPosition(code, endOffset);
    if (end?.before) range.setEndBefore(end.before);
    else if (end) range.setEnd(end.node, end.offset);
    else if (code.lastChild) range.setEndAfter(code.lastChild);
  } else range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function setCodeText(code, text) {
  if (text) code.textContent = text;
  else code.innerHTML = "<br>";
}

function rehighlightCode(code) {
  code.removeAttribute("data-highlighted");
  if (window.hljs && !code.classList.contains("language-mermaid")) {
    try { window.hljs.highlightElement(code); } catch (_) {}
  }
}

function updateCodeGutter(pre) {
  if (!pre || !preferences.codeLineNumbers) return;
  const code = pre.querySelector("code");
  if (!code || code.classList.contains("language-mermaid")) return;
  let gutter = pre.querySelector(".code-gutter");
  if (!gutter) {
    gutter = document.createElement("span");
    gutter.className = "code-gutter";
    gutter.setAttribute("aria-hidden", "true");
    pre.classList.add("numbered-code");
    pre.insertBefore(gutter, code);
  }
  const lineCount = Math.max(1, codeLogicalText(code).split("\n").length);
  const text = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n");
  if (gutter.textContent !== text) gutter.textContent = text;
}

function applyCodeLanguage(pre, rawLang) {
  const code = pre.querySelector("code");
  if (!code) return false;
  const lang = (rawLang || "").trim().split(/\s+/)[0] || "";
  if (lang === codeLanguageOf(code)) return false;
  code.className = lang ? "language-" + lang : "";
  setCodeText(code, codeLogicalText(code));
  rehighlightCode(code);
  updateCodeGutter(pre);
  if (lang) rememberCodeLang(lang);
  updateAfterEdit();
  return true;
}

let codeComposing = false;
let rehighlightTimer = null;

function scheduleCodeRehighlight(code) {
  if (!code || code.classList.contains("language-mermaid") || !window.hljs) return;
  clearTimeout(rehighlightTimer);
  rehighlightTimer = setTimeout(() => {
    if (codeComposing || !editor.contains(code) || !codeLogicalText(code).trim()) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const startOffset = range && code.contains(range.startContainer)
      ? codeAbsoluteOffset(code, range.startContainer, range.startOffset) : null;
    const endOffset = range && !range.collapsed && code.contains(range.endContainer)
      ? codeAbsoluteOffset(code, range.endContainer, range.endOffset) : null;
    rehighlightCode(code);
    if (startOffset != null) placeCaretInCode(code, startOffset, endOffset ?? undefined);
  }, 160);
}

function showCodeLangTooltip(pre) {
  updateCodeGutter(pre);
  if (langEditing) {
    if (activeLangPre !== pre) finishLangEdit(true, false);
    else { positionCodeLangTooltip(pre); return; }
  }
  activeLangPre = pre;
  const value = codeLanguageOf(pre.querySelector("code"));
  const label = codeLangTooltip.querySelector(".code-lang-value");
  label.textContent = value || "代码语言";
  codeLangTooltip.classList.toggle("empty", !value);
  codeLangTooltip.hidden = false;
  positionCodeLangTooltip(pre);
}

function hideCodeLangTooltip() {
  codeLangTooltip.hidden = true;
}

function positionCodeLangTooltip(pre) {
  if (!pre || codeLangTooltip.hidden) return;
  const bounds = pre.getBoundingClientRect();
  codeLangTooltip.style.left = Math.max(8, bounds.right - codeLangTooltip.offsetWidth - 10) + "px";
  codeLangTooltip.style.top = Math.max(4, Math.min(bounds.bottom + 6, innerHeight - codeLangTooltip.offsetHeight - 8)) + "px";
}

function renderLangSuggestions(query) {
  const list = codeLangTooltip.querySelector(".code-lang-list");
  if (!list) return;
  const needle = query.trim().toLowerCase();
  const matches = needle ? codeLanguages.filter((name) => name.toLowerCase().startsWith(needle)) : codeLanguages;
  list.replaceChildren(...matches.slice(0, 9).map((name) => {
    const item = document.createElement("li");
    item.textContent = name;
    item.addEventListener("mousedown", (event) => event.preventDefault());
    item.addEventListener("click", () => {
      const input = codeLangTooltip.querySelector(".code-lang-input");
      if (input) input.value = name;
      finishLangEdit(true, true);
    });
    return item;
  }));
}

function setActiveLangSuggestion(items, index) {
  items.forEach((item, position) => item.classList.toggle("active", position === index));
  items[index]?.scrollIntoView({ block: "nearest" });
}

function beginLangEdit() {
  const pre = activeLangPre;
  if (!pre || langEditing) return;
  const code = pre.querySelector("code");
  langEditing = true;
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  langEditCaret = range && code.contains(range.startContainer)
    ? codeAbsoluteOffset(code, range.startContainer, range.startOffset)
    : null;
  const input = document.createElement("input");
  input.className = "code-lang-input";
  input.value = codeLanguageOf(code);
  input.placeholder = "代码语言";
  input.setAttribute("spellcheck", "false");
  const list = document.createElement("ul");
  list.className = "code-lang-list";
  codeLangTooltip.replaceChildren(input, list);
  codeLangTooltip.classList.add("editing");
  positionCodeLangTooltip(pre);
  input.addEventListener("input", () => renderLangSuggestions(input.value));
  input.addEventListener("keydown", (event) => {
    const items = [...codeLangTooltip.querySelectorAll(".code-lang-list li")];
    const index = items.findIndex((item) => item.classList.contains("active"));
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveLangSuggestion(items, index < 0 ? 0 : Math.min(index + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index > 0) setActiveLangSuggestion(items, index - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (index >= 0) input.value = items[index].textContent;
      finishLangEdit(true, true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finishLangEdit(false, true);
    }
  });
  input.addEventListener("blur", () => { if (langEditing) finishLangEdit(true, false); });
  input.focus();
  input.select();
  renderLangSuggestions(input.value);
}

function finishLangEdit(apply, restoreCaret) {
  const pre = activeLangPre;
  const input = codeLangTooltip.querySelector(".code-lang-input");
  langEditing = false;
  const label = document.createElement("span");
  label.className = "code-lang-value";
  codeLangTooltip.replaceChildren(label);
  codeLangTooltip.classList.remove("editing");
  if (pre && editor.contains(pre)) {
    const code = pre.querySelector("code");
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    let clickOffset = null;
    if (anchor && code?.contains(anchor) && selection.rangeCount) {
      const range = selection.getRangeAt(0);
      clickOffset = codeAbsoluteOffset(code, range.startContainer, range.startOffset);
    }
    const changed = apply && input ? applyCodeLanguage(pre, input.value) : false;
    if (code) {
      if (changed && clickOffset != null) placeCaretInCode(code, Math.min(clickOffset, codeNormalizedText(code).length));
      else if (restoreCaret) {
        const textLength = codeNormalizedText(code).length;
        placeCaretInCode(code, Math.min(langEditCaret ?? textLength, textLength));
      }
    }
  }
  if (pre && editor.contains(pre) && currentCodeBlock() === pre) showCodeLangTooltip(pre);
  else { activeLangPre = null; hideCodeLangTooltip(); }
}

function nearestSiblingBlock(node, direction) {
  let element = node;
  while (element && element !== editor) {
    const sibling = direction === "up" ? element.previousElementSibling : element.nextElementSibling;
    if (sibling) {
      let target = sibling;
      for (;;) {
        if (/^(UL|OL)$/.test(target.tagName)) target = direction === "up" ? target.lastElementChild : target.firstElementChild;
        else if (target.tagName === "BLOCKQUOTE") target = direction === "up" ? target.lastElementChild : target.firstElementChild;
        else if (target.tagName === "TABLE") {
          target = direction === "up"
            ? target.querySelector("tbody tr:last-of-type td:last-of-type, tbody tr:last-of-type th:last-of-type")
            : target.querySelector("thead th, tbody td, tbody th") || target.querySelector("tr td, tr th");
        } else break;
        if (!target) return null;
      }
      return target;
    }
    element = element.parentElement;
  }
  return null;
}

function exitCodeBlock(code, direction) {
  const pre = code.closest("pre");
  if (!pre) return;
  const target = nearestSiblingBlock(pre, direction);
  if (target) {
    if (direction === "up") placeCaretAtEnd(target);
    else placeCaretAtStart(target);
  } else {
    const paragraph = document.createElement("p");
    paragraph.append(document.createElement("br"));
    if (direction === "up") pre.before(paragraph);
    else pre.after(paragraph);
    placeCaretAtEnd(paragraph);
  }
  updateAfterEdit();
}

function moveCodeLine(code, delta) {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || !code.contains(range.startContainer)) return;
  const startOffset = codeAbsoluteOffset(code, range.startContainer, range.startOffset);
  const endOffset = range.collapsed ? startOffset : codeAbsoluteOffset(code, range.endContainer, range.endOffset);
  if (startOffset == null || endOffset == null) return;
  const text = codeLogicalText(code);
  const lines = text.split("\n");
  const startPos = lineColOfText(text, startOffset);
  const endPos = lineColOfText(text, endOffset);
  const firstLine = Math.min(startPos.line, endPos.line);
  const lastLine = Math.max(startPos.line, endPos.line);
  if (delta < 0 ? firstLine === 0 : lastLine === lines.length - 1) return;
  const moving = lines.splice(firstLine, lastLine - firstLine + 1);
  lines.splice(delta < 0 ? firstLine - 1 : firstLine + 1, 0, ...moving);
  setCodeText(code, lines.join("\n"));
  rehighlightCode(code);
  updateCodeGutter(code.closest("pre"));
  const lineOffset = (line) => (line > 0 ? lines.slice(0, line).join("\n").length + 1 : 0);
  const newStartOffset = lineOffset(startPos.line + delta) + startPos.ch;
  const newEndOffset = endOffset === startOffset ? null : lineOffset(endPos.line + delta) + endPos.ch;
  placeCaretInCode(code, newStartOffset, newEndOffset);
  updateAfterEdit();
}

function createCodeBlockFromParagraph(paragraph) {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  if (lastCodeLang) code.className = "language-" + lastCodeLang;
  code.innerHTML = "<br>";
  pre.append(code);
  paragraph.replaceWith(pre);
  if (lastCodeLang) rehighlightCode(code);
  updateCodeGutter(pre);
  placeCaretAtStart(code);
  updateAfterEdit();
}

function escapeHtmlCode(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function copyRichTextToClipboard(plain, html) {
  try {
    if (navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" })
      })]);
      return true;
    }
  } catch (_) {}
  return copyTextToClipboard(plain);
}

function selectionFragmentContainer() {
  const range = selectionRange();
  if (!range) return null;
  const container = document.createElement("div");
  container.append(range.cloneContents());
  return container;
}

function selectionMarkdown() {
  const range = selectionRange();
  if (!range) return "";
  const container = selectionFragmentContainer();
  const hasBlock = [...container.children].some((child) => /^(P|H[1-6]|LI|UL|OL|PRE|TABLE|BLOCKQUOTE|DIV)$/.test(child.tagName));
  if (hasBlock) return serializeContainer(container);
  const root = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const blockRoot = root ? root.closest("p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,table") : null;
  if (blockRoot && editor.contains(blockRoot)) {
    const selected = range.toString().replace(/\s+/g, " ").trim();
    const whole = (blockRoot.innerText || blockRoot.textContent || "").replace(/\s+/g, " ").trim();
    if (selected && selected === whole) {
      return blockMarkdown(blockRoot.tagName === "LI" ? blockRoot.parentElement : blockRoot);
    }
  }
  return inlineMarkdown(container);
}

function selectionHtml() {
  const container = selectionFragmentContainer();
  return container ? container.innerHTML : "";
}

function sanitizePastedHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script,style,iframe,object,embed,link,meta,form").forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attribute.value)) element.removeAttribute(attribute.name);
    });
  });
  return template.innerHTML;
}

async function readClipboardText() {
  try { return await navigator.clipboard.readText(); } catch (_) { return null; }
}

async function readClipboardHtml() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes("text/html")) return await (await item.getType("text/html")).text();
    }
  } catch (_) {}
  return null;
}

async function pasteIntoEditor(plainText) {
  editor.focus();
  if (!window.getSelection()?.rangeCount) return;
  if (plainText) {
    const text = await readClipboardText();
    if (text === null) { window.alert("无法读取剪贴板内容"); return; }
    document.execCommand("insertText", false, text);
    updateAfterEdit();
    return;
  }
  const html = await readClipboardHtml();
  if (html !== null) {
    document.execCommand("insertHTML", false, sanitizePastedHtml(html));
    updateAfterEdit();
    return;
  }
  const text = await readClipboardText();
  if (text === null) { window.alert("无法读取剪贴板内容"); return; }
  document.execCommand("insertText", false, text);
  updateAfterEdit();
}

function toggleInlineCode() {
  editor.focus();
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  document.execCommand("insertHTML", false, "<code>" + escapeAttribute(selection.toString()) + "</code>");
  updateAfterEdit();
}

function toggleBlockquote() {
  editor.focus();
  const quote = activeBlock()?.closest("blockquote");
  if (quote) {
    const fragment = document.createDocumentFragment();
    while (quote.firstChild) fragment.append(quote.firstChild);
    quote.replaceWith(fragment);
  } else {
    document.execCommand("formatBlock", false, "BLOCKQUOTE");
  }
  updateAfterEdit();
}

function toggleTaskList() {
  editor.focus();
  const item = activeBlock()?.closest("li");
  const attachCheckbox = (listItem) => {
    const created = document.createElement("input");
    created.type = "checkbox";
    created.addEventListener("change", updateAfterEdit);
    listItem.insertBefore(created, listItem.firstChild);
  };
  if (item) {
    const checkbox = item.querySelector(":scope > input[type=checkbox]");
    if (checkbox) checkbox.remove();
    else attachCheckbox(item);
    updateAfterEdit();
    return;
  }
  document.execCommand("insertUnorderedList");
  const newItem = activeBlock()?.closest("li");
  if (newItem && !newItem.querySelector(":scope > input[type=checkbox]")) attachCheckbox(newItem);
  updateAfterEdit();
}

function indentList(outdent) {
  editor.focus();
  document.execCommand(outdent ? "outdent" : "indent");
  updateAfterEdit();
}

function insertHorizontalRule() {
  editor.focus();
  document.execCommand("insertHorizontalRule");
  let node = window.getSelection()?.anchorNode;
  if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
  const rule = node?.closest?.("hr");
  if (rule) {
    const paragraph = document.createElement("p");
    paragraph.append(document.createElement("br"));
    rule.after(paragraph);
    placeCaretAtStart(paragraph);
  }
  updateAfterEdit();
}

function insertCodeBlock() {
  editor.focus();
  const language = lastCodeLang ? ' class="language-' + lastCodeLang + '"' : "";
  document.execCommand("insertHTML", false, "<pre><code" + language + "><br></code></pre><p><br></p>");
  const node = window.getSelection()?.anchorNode;
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const code = element?.closest?.("pre code");
  if (code) {
    if (lastCodeLang) rehighlightCode(code);
    updateCodeGutter(code.closest("pre"));
  }
  updateAfterEdit();
}

function insertMathBlock() {
  const tex = window.prompt("LaTeX 公式", "E = mc^2");
  if (tex === null) return;
  editor.focus();
  const math = document.createElement("div");
  math.className = "math-display";
  math.contentEditable = "false";
  math.dataset.markdownMath = tex;
  let node = window.getSelection()?.anchorNode;
  if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
  let topLevel = null;
  if (node && editor.contains(node)) {
    topLevel = node;
    while (topLevel.parentElement && topLevel.parentElement !== editor) topLevel = topLevel.parentElement;
  }
  const paragraph = document.createElement("p");
  paragraph.append(document.createElement("br"));
  if (topLevel && topLevel.tagName === "P" && !topLevel.textContent.trim()) topLevel.replaceWith(math);
  else if (topLevel) topLevel.after(math);
  else editor.append(math);
  math.after(paragraph);
  if (window.katex) {
    window.katex.render(tex, math, { displayMode: true, throwOnError: false, strict: "ignore" });
  } else {
    math.textContent = tex;
  }
  placeCaretAtStart(paragraph);
  updateAfterEdit();
}

function deleteActiveBlock() {
  editor.focus();
  let node = window.getSelection()?.anchorNode;
  if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!node || !editor.contains(node)) return;
  const item = node.closest("li");
  if (item) {
    const list = item.parentElement;
    item.remove();
    if (list && !list.querySelector("li")) list.remove();
  } else if (node.closest("table")) {
    node.closest("table").remove();
  } else {
    let target = node.closest("p,h1,h2,h3,h4,h5,h6,pre,blockquote,.math-display,.mermaid-block,hr,img");
    if (!target || target === editor) return;
    const quote = target.closest("blockquote");
    if (quote) target = quote;
    target.remove();
  }
  if (!editor.firstElementChild) {
    const paragraph = document.createElement("p");
    paragraph.append(document.createElement("br"));
    editor.append(paragraph);
  }
  placeCaretAtEnd(editor.lastElementChild || editor);
  updateAfterEdit();
}

function contextAnchorElement() {
  let node = window.getSelection()?.anchorNode;
  if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
  return node && editor.contains(node) ? node : null;
}

function contextClosest(selector) {
  return contextAnchorElement()?.closest?.(selector) || null;
}

async function copyAsPlainText() {
  await copyTextToClipboard(window.getSelection()?.toString() ?? "");
}

async function copyAsMarkdown() {
  await copyTextToClipboard(selectionMarkdown());
}

async function copyAsHtmlCode() {
  await copyTextToClipboard(selectionHtml());
}

async function copyCodeContent() {
  const code = contextClosest("pre")?.querySelector("code");
  if (!code) return;
  const plain = codeLogicalText(code);
  const html = "<pre lang='" + codeLanguageOf(code) + "'>" + escapeHtmlCode(plain) + "</pre>";
  await copyRichTextToClipboard(plain, html);
}

async function copyTableMarkdown() {
  const table = contextClosest("table");
  if (!table) return;
  await copyTextToClipboard(tableMarkdown(table));
}

async function openLinkUrl(url) {
  try { await invoke("open_url", { url }); }
  catch (error) { window.alert(String(error)); }
}

function openContextLink() {
  const href = contextClosest("a")?.getAttribute("href") || "";
  if (href) void openLinkUrl(href);
}

async function copyContextLinkAddress() {
  const href = contextClosest("a")?.getAttribute("href") || "";
  if (href) await copyTextToClipboard(href);
}

async function searchSelectedWithGoogle() {
  const text = window.getSelection()?.toString().trim() ?? "";
  if (!text) return;
  await openLinkUrl("https://www.google.com/search?q=" + encodeURIComponent(text));
}

async function copyImageContent() {
  const image = contextClosest("img");
  const src = image?.getAttribute("src");
  if (!src) return;
  try {
    const blob = await (await fetch(src)).blob();
    if (!navigator.clipboard?.write || !window.ClipboardItem) {
      window.alert("当前环境不支持复制图片");
      return;
    }
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
  } catch (error) {
    window.alert("复制图片失败：" + String(error));
  }
}

async function copyImageAsMarkdown() {
  const image = contextClosest("img");
  if (!image) return;
  const alt = image.getAttribute("alt") || "";
  const url = image.dataset.markdownSrc || image.getAttribute("src") || "";
  await copyTextToClipboard("![" + alt + "](" + url + ")");
}

async function copyMathSource() {
  const math = contextClosest(".math-display,.math-inline");
  if (!math) return;
  await copyTextToClipboard(math.dataset.markdownMath || math.textContent || "");
}

async function copyDiagramSource() {
  const diagram = contextClosest(".mermaid-block");
  if (!diagram) return;
  await copyTextToClipboard(diagram.dataset.markdownSource || diagram.textContent || "");
}

function collapseCaretToClick(event) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  for (const rect of range.getClientRects()) {
    if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) return;
  }
  const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
  if (!caret || !editor.contains(caret.startContainer)) return;
  const collapsed = document.createRange();
  collapsed.setStart(caret.startContainer, caret.startOffset);
  collapsed.collapse(true);
  selection.removeAllRanges();
  selection.addRange(collapsed);
}

function blockDeleteLabel(block) {
  if (!block) return "";
  const tag = block.tagName;
  if (/^H[1-6]$/.test(tag)) return "标题 " + tag[1];
  if (tag === "PRE") return "代码块";
  if (tag === "TABLE") return "表格";
  if (tag === "LI") return "列表项";
  if (tag === "BLOCKQUOTE" || (block.closest && block.closest("blockquote"))) return "引用";
  if (tag === "P") return "段落";
  return "";
}

function buildTableMenuItems() {
  return [
    { label: "上方插入行", action: () => editActiveTable("add-row-above") },
    { label: "下方插入行", shortcut: "Ctrl+Enter", action: () => editActiveTable("add-row") },
    { label: "左侧插入列", action: () => editActiveTable("add-column-left") },
    { label: "右侧插入列", action: () => editActiveTable("add-column") },
    "-",
    { label: "上移该行", shortcut: "Alt+↑", action: () => editActiveTable("move-row-up") },
    { label: "下移该行", shortcut: "Alt+↓", action: () => editActiveTable("move-row-down") },
    { label: "左移该列", shortcut: "Alt+←", action: () => editActiveTable("move-col-left") },
    { label: "右移该列", shortcut: "Alt+→", action: () => editActiveTable("move-col-right") },
    "-",
    { label: "删除行", shortcut: "Ctrl+Shift+⌫", action: () => editActiveTable("delete-row") },
    { label: "删除列", action: () => editActiveTable("delete-column") },
    "-",
    { label: "复制表格", action: () => void copyTableMarkdown() },
    { label: "格式化表格源码", action: () => formatTableSource() },
    { label: "删除表格", destructive: true, action: () => editActiveTable("delete-table") },
  ];
}

function buildEditorContextMenu(target) {
  const selection = window.getSelection();
  const hasSelection = Boolean(selection && !selection.isCollapsed && selection.toString().trim());
  let probe = target?.nodeType === Node.TEXT_NODE ? target.parentElement : target;
  if (!probe || !editor.contains(probe)) probe = contextAnchorElement();
  const anchor = contextAnchorElement();
  const closest = (selector) => probe?.closest?.(selector) || anchor?.closest?.(selector) || null;
  const block = closest("p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,table");
  const cell = closest("td,th");
  const pre = closest("pre");
  const link = closest("a");
  const image = closest("img");
  const math = closest(".math-display,.math-inline");
  const diagram = closest(".mermaid-block");
  const listItem = closest("li");
  const inTable = Boolean(cell);
  const items = [];

  items.push({ row: [
    { label: "剪切", title: "剪切 (Ctrl+X)", action: () => document.execCommand("cut"), disabled: !hasSelection },
    { label: "复制", title: "复制 (Ctrl+C)", action: () => document.execCommand("copy"), disabled: !hasSelection },
    { label: "粘贴", title: "粘贴 (Ctrl+V)", action: () => void pasteIntoEditor(false) },
    { label: "删除", title: "删除所选", action: () => document.execCommand("delete"), disabled: !hasSelection },
  ] });
  if (hasSelection) {
    items.push(
      "-",
      { label: "复制为", children: [
        { label: "复制为 Markdown", action: () => void copyAsMarkdown() },
        { label: "复制为 HTML 代码", action: () => void copyAsHtmlCode() },
        { label: "复制为纯文本", action: () => void copyAsPlainText() },
        "-",
        { label: "粘贴为纯文本", shortcut: "Ctrl+Shift+V", action: () => void pasteIntoEditor(true) },
      ] },
      { label: "用 Google 搜索", action: () => void searchSelectedWithGoogle() },
    );
  }
  items.push("-", { label: "全选", shortcut: "Ctrl+A", action: () => { editor.focus(); document.execCommand("selectAll"); } });
  if (hasSelection && !inTable) {
    items.push("-", { row: [
      { label: "B", title: "加粗 (Ctrl+B)", action: () => document.execCommand("bold") },
      { label: "I", title: "斜体 (Ctrl+I)", action: () => document.execCommand("italic") },
      { label: "S", title: "删除线", action: () => document.execCommand("strikeThrough") },
      { label: "<>", title: "行内代码", action: () => toggleInlineCode() },
      { label: "链接", title: "链接 (Ctrl+K)", action: () => insertLink() },
    ] });
  }
  const headingItems = [];
  for (let level = 1; level <= 6; level += 1) {
    headingItems.push({ label: "标题 " + level, shortcut: "Ctrl+" + level, checked: block?.tagName === "H" + level, action: () => applyHeading(level) });
  }
  headingItems.push("-", { label: "正文", shortcut: "Ctrl+0", checked: block?.tagName === "P", action: () => applyHeading(0) });
  items.push(
    "-",
    { label: "段落", children: headingItems },
    { label: "引用", shortcut: "Ctrl+Shift+Q", checked: Boolean(closest("blockquote")), action: () => toggleBlockquote() },
    { label: "有序列表", shortcut: "Ctrl+Shift+[", checked: Boolean(closest("ol")), action: () => { editor.focus(); document.execCommand("insertOrderedList"); updateAfterEdit(); } },
    { label: "无序列表", shortcut: "Ctrl+Shift+]", checked: Boolean(closest("ul:not(.task-list)")) && !closest("li > input[type=checkbox]") && !closest("ul"), action: () => { editor.focus(); document.execCommand("insertUnorderedList"); updateAfterEdit(); } },
    { label: "任务列表", checked: Boolean(closest("li")?.querySelector(":scope > input[type=checkbox]")), action: () => toggleTaskList() },
  );
  if (listItem) {
    items.push(
      { label: "减少缩进", shortcut: "Shift+Tab", action: () => indentList(true) },
      { label: "增加缩进", shortcut: "Tab", action: () => indentList(false) },
    );
  }
  items.push("-", { label: "插入", children: [
    { label: "图片", shortcut: "Ctrl+Shift+I", action: () => void insertImage() },
    { label: "表格", shortcut: "Ctrl+T", action: () => insertTable() },
    { label: "代码块", shortcut: "Ctrl+Shift+K", action: () => insertCodeBlock() },
    { label: "数学块", action: () => insertMathBlock() },
    { label: "水平分割线", action: () => insertHorizontalRule() },
  ] });
  if (inTable) {
    items.push("-", { label: "表格", children: buildTableMenuItems() });
  }
  if (pre && !inTable) items.push("-", { label: "复制代码内容", action: () => void copyCodeContent() });
  if (link) {
    items.push(
      "-",
      { label: "打开链接", action: () => openContextLink() },
      { label: "复制链接地址", action: () => void copyContextLinkAddress() },
    );
  }
  if (image) {
    items.push(
      "-",
      { label: "复制图片", action: () => void copyImageContent() },
      { label: "复制图片为 Markdown", action: () => void copyImageAsMarkdown() },
    );
  }
  if (math) items.push("-", { label: "复制公式源码", action: () => void copyMathSource() });
  if (diagram) items.push("-", { label: "复制图表源码", action: () => void copyDiagramSource() });
  const deleteLabel = blockDeleteLabel(block);
  if (deleteLabel && !inTable) items.push("-", { label: "删除" + deleteLabel, destructive: true, action: () => deleteActiveBlock() });
  return items;
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
    case "status-bar": preferences.statusBar = !preferences.statusBar; savePreferences(); applyPreferences(); break;
    case "fullscreen":
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
      break;
    case "zoom-in": zoomLevel = Math.min(1.5, zoomLevel + 0.1); preferences.zoom = Math.round(zoomLevel * 100); savePreferences(); applyPreferences(); break;
    case "zoom-out": zoomLevel = Math.max(0.7, zoomLevel - 0.1); preferences.zoom = Math.round(zoomLevel * 100); savePreferences(); applyPreferences(); break;
    case "zoom-reset": zoomLevel = 1; preferences.zoom = 100; savePreferences(); applyPreferences(); break;
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
    case "code-block": insertCodeBlock(); break;
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
    case "preferences": openPreferences(); break;
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
    const rendered = await invoke("render_markdown", {
      source: markdown, documentPath: activePath,
      smartPunctuation: preferences.smartPunctuation,
      enableMath: preferences.enableMath,
      enableSubscript: preferences.enableSubscript,
      enableSuperscript: preferences.enableSuperscript,
      emojiShortcodes: preferences.emojiShortcodes,
      hardLineBreaks: preferences.hardLineBreaks,
    });
    const preview = document.createElement("div");
    preview.innerHTML = rendered.html;
    preview.querySelectorAll("img").forEach((image, index) => {
      if (rendered.images[index]) image.src = rendered.images[index].previewUrl;
    });
    if (preferences.exportOutline) {
      const headings = [...preview.querySelectorAll("h1,h2,h3,h4,h5,h6")];
      const used = new Map();
      const nav = document.createElement("nav");
      nav.className = "export-outline";
      const title = document.createElement("strong");
      title.textContent = "Contents";
      const list = document.createElement("ul");
      headings.forEach((heading) => {
        const label = heading.textContent.trim();
        const base = heading.id || slugify(label);
        const count = used.get(base) || 0;
        used.set(base, count + 1);
        heading.id = base + (count ? "-" + count : "");
        const item = document.createElement("li");
        item.className = "level-" + heading.tagName.slice(1);
        const link = document.createElement("a");
        link.href = "#" + heading.id;
        link.textContent = label;
        item.append(link);
        list.append(item);
      });
      nav.append(title, list);
      preview.prepend(nav);
    }
    await enhancePreview(preview, { eager: true });
    const katexCss = await getKatexCssWithEmbeddedFonts();
    const exportColors = preferences.exportTheme && preferences.theme === "night"
      ? "background:#282c34;color:#d7dae0"
      : preferences.exportTheme && preferences.theme === "newsprint"
        ? "background:#f5f1e8;color:#433e35"
        : "background:#fff;color:#24292f";
    const exportFont = !preferences.exportTheme ? 'Arial,"Microsoft YaHei UI",sans-serif' : preferences.fontFamily === "serif" ? 'Georgia,"Songti SC",serif' : preferences.fontFamily === "mono" ? 'Consolas,"Courier New",monospace' : 'Arial,"Microsoft YaHei UI",sans-serif';
    const exportWidth = preferences.exportTheme ? preferences.contentWidth : 860;
    const exportSize = preferences.exportTheme ? preferences.fontSize : 16;
    const exportHeight = preferences.exportTheme ? preferences.lineHeight : 1.75;
    const exportBackground = preferences.exportTheme ? exportColors : "background:#fff;color:#24292f";
    const styles = katexCss + `\nbody{max-width:${exportWidth}px;margin:48px auto;padding:0 24px;${exportBackground};font:${exportSize}px/${exportHeight} ${exportFont}}img,svg{max-width:100%}pre,code{font-family:Consolas,monospace}pre{padding:16px;background:#f6f8fa;border-radius:6px;overflow:auto}code{padding:.2em .4em;background:#eff1f3;border-radius:4px}table{border-collapse:collapse}th,td{padding:6px 12px;border:1px solid #d0d7de}blockquote{border-left:4px solid #d0d7de;padding-left:16px;color:#57606a}a{color:#0969da}.export-outline{padding:14px 18px;margin:0 0 28px;background:#f6f8fa;border-radius:5px}.export-outline ul{padding-left:22px}.export-outline .level-2{margin-left:14px}.export-outline .level-3,.export-outline .level-4,.export-outline .level-5,.export-outline .level-6{margin-left:28px}.numbered-code{display:flex;gap:12px}.code-gutter{border-right:1px solid #d0d7de;padding-right:10px;color:#8c959f;text-align:right;white-space:pre;user-select:none}`;
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

const preferencesDialog = document.querySelector("#preferences-dialog");

function selectPreferenceTab(tabName) {
  document.querySelectorAll("[data-preference-tab]").forEach((tab) => tab.classList.toggle("selected", tab.dataset.preferenceTab === tabName));
  document.querySelectorAll("[data-preference-panel]").forEach((panel) => { panel.hidden = panel.dataset.preferencePanel !== tabName; });
}

function refreshPreferenceControls() {
  document.querySelectorAll("[data-pref]").forEach((control) => {
    const key = control.dataset.pref;
    control.type === "checkbox" ? control.checked = Boolean(preferences[key]) : control.value = String(preferences[key]);
  });
  document.querySelectorAll("[data-pref-output]").forEach((output) => {
    const value = preferences[output.dataset.prefOutput];
    const suffix = output.dataset.prefOutput === "zoom" ? "%" : output.dataset.prefOutput === "lineHeight" ? "" : " px";
    output.textContent = `${output.dataset.prefOutput === "lineHeight" ? Number(value).toFixed(1) : value}${suffix}`;
  });
}

function openPreferences() {
  closeMenus();
  refreshPreferenceControls();
  selectPreferenceTab("files");
  preferencesDialog.hidden = false;
  document.querySelector("#preferences-close").focus();
}

function closePreferences() {
  preferencesDialog.hidden = true;
  (sourceMode ? source : editor).focus();
}

function applyPreferenceChange(control) {
  const key = control.dataset.pref;
  preferences[key] = control.type === "checkbox" ? control.checked : ["fontSize", "lineHeight", "tabSize", "contentWidth", "zoom", "autoSaveInterval"].includes(key) ? Number(control.value) : control.value;
  if (key === "zoom") zoomLevel = preferences.zoom / 100;
  savePreferences();
  applyPreferences();
  refreshPreferenceControls();
  if (key === "autoRecover" && !preferences.autoRecover) {
    clearTimeout(recoveryTimer);
    void invoke("clear_recovery_draft");
  }
  if (key === "autoSave" || key === "autoSaveInterval") resetAutoSaveTimer();
  if (["smartPunctuation", "enableMath", "enableSubscript", "enableSuperscript", "emojiShortcodes", "hardLineBreaks", "codeLineNumbers"].includes(key)) void renderMarkdown(markdownNow());
  if (key === "defaultLineEnding" && !activePath) activeLineEnding = preferences.defaultLineEnding;
}

document.querySelectorAll("[data-preference-tab]").forEach((tab) => tab.addEventListener("click", () => selectPreferenceTab(tab.dataset.preferenceTab)));
document.querySelectorAll("[data-pref]").forEach((control) => {
  control.addEventListener(control.type === "range" ? "input" : "change", () => applyPreferenceChange(control));
});
document.querySelector("#preferences-close").addEventListener("click", closePreferences);
document.querySelector("#preferences-done").addEventListener("click", closePreferences);
preferencesDialog.addEventListener("click", (event) => { if (event.target === preferencesDialog) closePreferences(); });
document.querySelector("#preferences-reset").addEventListener("click", () => {
  preferences = { ...preferenceDefaults };
  zoomLevel = preferences.zoom / 100;
  savePreferences();
  applyPreferences();
  refreshPreferenceControls();
  activeLineEnding = activePath ? activeLineEnding : preferences.defaultLineEnding;
  resetAutoSaveTimer();
  void renderMarkdown(markdownNow());
});

function updateAfterEdit() {
  updateOutline();
  scheduleWordCount();
  setDirty(true);
  scheduleRecoveryDraft();
  const empty = editor.childNodes.length === 0 || (editor.childNodes.length === 1 && !editor.textContent.trim());
  editor.classList.toggle("is-empty", empty);
  const editedBlock = activeBlock();
  if (editedBlock?.tagName === "PRE") {
    updateCodeGutter(editedBlock);
    scheduleCodeRehighlight(editedBlock.querySelector("code"));
  }
  if (typewriterMode && preferences.typewriterCenter) editedBlock?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function scheduleRecoveryDraft() {
  clearTimeout(recoveryTimer);
  if (!dirty || !preferences.autoRecover) return;
  recoveryTimer = setTimeout(() => {
    void invoke("save_recovery_draft", {
      content: markdownNow(),
      path: activePath,
      lineEnding: activeLineEnding
    }).catch((error) => console.error("Could not save recovery draft", error));
  }, 1500);
}

async function restoreRecoveryDraft() {
  if (!preferences.restoreDraft) return;
  try {
    const draft = await invoke("load_recovery_draft");
    if (!draft) return;
    if (!window.confirm("A recovered draft is available. Restore it now?")) {
      await invoke("clear_recovery_draft");
      return;
    }
    activePath = draft.path ? normalizeTreePath(draft.path) : null;
    activeLineEnding = draft.lineEnding || "lf";
    sourceMode = false;
    source.hidden = true;
    editor.hidden = false;
    document.body.classList.remove("source-mode");
    const markdown = draft.content.replace(/\r\n?/g, "\n");
    source.value = markdown;
    await renderMarkdown(markdown);
    savedMarkdown = "\u0000recovered-draft";
    setDirty(true);
    if (activePath) {
      activePanel = "files";
      showSidebar("files");
      await revealFileInTree(activePath);
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

const typingPairs = { "(": ")", "[": "]", "{": "}", "\"": "\"", "'": "'", "`": "`" };

function handleSourcePairKeydown(event) {
  if (!preferences.autoPair || event.ctrlKey || event.metaKey || event.altKey) return false;
  const start = source.selectionStart;
  const end = source.selectionEnd;
  const next = source.value[end];
  if (Object.values(typingPairs).includes(event.key) && next === event.key && start === end) {
    event.preventDefault();
    source.setSelectionRange(end + 1, end + 1);
    return true;
  }
  if (event.key === "Backspace" && start === end && start > 0 && typingPairs[source.value[start - 1]] === next) {
    event.preventDefault();
    source.setRangeText("", start - 1, end + 1, "end");
    updateAfterEdit();
    return true;
  }
  const closing = typingPairs[event.key];
  if (!closing) return false;
  event.preventDefault();
  const selected = source.value.slice(start, end);
  source.setRangeText(event.key + selected + closing, start, end, "end");
  source.setSelectionRange(start + 1 + selected.length, start + 1 + selected.length);
  updateAfterEdit();
  return true;
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
    preferences.theme = button.dataset.theme;
    savePreferences();
    applyPreferences();
    closeMenus();
  });
});

document.addEventListener("click", (event) => {
  if (!event.target.closest?.(".app-menu")) closeMenus();
  if (!event.target.closest?.("#file-context-menu")) closeContextMenu();
});
document.addEventListener("contextmenu", () => closeContextMenu(), true);

document.querySelectorAll(".sidebar-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    activePanel = tab.dataset.panel;
    document.querySelectorAll(".sidebar-tab").forEach((other) => other.classList.toggle("selected", other === tab));
    document.querySelector("#outline-panel").hidden = activePanel !== "outline";
    document.querySelector("#files-panel").hidden = activePanel !== "files";
    if (activePanel === "files" && folderRoot) void reloadDirectory(folderRoot);
    if (activePanel === "outline") syncActiveOutlineItem();
  });
});

document.querySelector("#close-sidebar").addEventListener("click", () => { sidebar.hidden = true; });
document.querySelector("#toggle-sidebar").addEventListener("click", () => toggleSidebar());
document.querySelector("#toggle-source").addEventListener("click", () => { void toggleSourceMode(); });
document.querySelector("#word-count").addEventListener("click", () => performAction("word-count"));
bindTreeEvents();
window.__TAURI__?.event?.listen("fs-change", (event) => queueFsChanges(Array.isArray(event?.payload) ? event.payload : []));
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
editor.addEventListener("compositionstart", () => { codeComposing = true; });
editor.addEventListener("compositionend", () => {
  codeComposing = false;
  const block = activeBlock();
  if (block?.tagName === "PRE") scheduleCodeRehighlight(block.querySelector("code"));
});
editor.addEventListener("mousedown", (event) => {
  if (event.button === 2) {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) event.preventDefault();
  }
});
editor.addEventListener("click", (event) => {
  const link = event.target.closest?.("a[href]");
  if (!link || !editor.contains(link)) return;
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) openLinkUrl(link.getAttribute("href"));
});
editor.addEventListener("contextmenu", (event) => {
  if (sourceMode) return;
  event.preventDefault();
  if (editor.getAttribute("aria-busy") === "true") return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) collapseCaretToClick(event);
  const clickedCell = event.target.closest?.("td,th");
  activeTableCell = clickedCell && editor.contains(clickedCell) ? clickedCell : null;
  const items = buildEditorContextMenu(event.target);
  if (items.length) openContextMenu(event.clientX, event.clientY, items);
});
source.addEventListener("input", updateAfterEdit);

editor.addEventListener("keydown", (event) => {
  const codeBlock = (() => {
    if (sourceMode || activeTableCell) return null;
    const anchor = window.getSelection()?.anchorNode;
    const element = anchor?.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
    const code = element?.closest?.("pre code");
    return code && editor.contains(code) ? code : null;
  })();
  if (event.key === "`" && !event.ctrlKey && !event.metaKey && !event.altKey && !codeBlock) {
    const block = activeBlock();
    if (block?.tagName === "P" && (block.innerText || "").trim() === "``") {
      event.preventDefault();
      createCodeBlockFromParagraph(block);
      return;
    }
  }
  if (!sourceMode && preferences.autoPair && !event.ctrlKey && !event.metaKey && !event.altKey && !(codeBlock && event.key === "`")) {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range && Object.values(typingPairs).includes(event.key) && !range.collapsed && range.toString() === "") return;
    const nextNode = range?.startContainer;
    if (Object.values(typingPairs).includes(event.key) && event.key === nextNode?.textContent?.[range.startOffset] && range.collapsed) {
      event.preventDefault();
      selection.modify("move", "forward", "character");
      return;
    }
    if (event.key === "Backspace" && range?.collapsed && range.startContainer.nodeType === Node.TEXT_NODE) {
      const node = range.startContainer;
      const offset = range.startOffset;
      if (offset > 0 && typingPairs[node.textContent[offset - 1]] === node.textContent[offset]) {
        range.setStart(node, offset - 1);
        range.setEnd(node, offset + 1);
        range.deleteContents();
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        event.preventDefault();
        updateAfterEdit();
        return;
      }
    }
    const closing = typingPairs[event.key];
    if (closing) {
      document.execCommand("insertText", false, event.key + (range?.toString() || "") + closing);
      window.getSelection()?.modify("move", "backward", "character");
      event.preventDefault();
      updateAfterEdit();
      return;
    }
  }
  if (event.ctrlKey && event.key === "Enter" && activeTableCell) {
    event.preventDefault();
    editActiveTable("add-row");
    return;
  }
  if (activeTableCell && !sourceMode) {
    if (event.altKey && event.key.startsWith("Arrow")) {
      event.preventDefault();
      editActiveTable({ ArrowUp: "move-row-up", ArrowDown: "move-row-down", ArrowLeft: "move-col-left", ArrowRight: "move-col-right" }[event.key]);
      return;
    }
    if (event.ctrlKey && event.shiftKey && event.key === "Backspace") {
      event.preventDefault();
      editActiveTable("delete-row");
      return;
    }
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
  if (codeBlock) {
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
      // Chromium routes Enter to paragraph splitting, which ejects the caret
      // from the code block; splice the newline into the text directly.
      event.preventDefault();
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (!range) return;
      if (!range.collapsed) range.deleteContents();
      const offset = codeAbsoluteOffset(codeBlock, range.startContainer, range.startOffset);
      if (offset == null) return;
      const text = codeLogicalText(codeBlock);
      setCodeText(codeBlock, text.slice(0, offset) + "\n" + text.slice(offset));
      rehighlightCode(codeBlock);
      placeCaretInCode(codeBlock, offset + 1);
      updateAfterEdit();
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      moveCodeLine(codeBlock, event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (range?.collapsed) {
        const offset = codeAbsoluteOffset(codeBlock, range.startContainer, range.startOffset);
        if (offset != null) {
          const text = codeLogicalText(codeBlock);
          const position = lineColOfText(text, offset);
          if (event.key === "ArrowUp" && position.line === 0) {
            event.preventDefault();
            exitCodeBlock(codeBlock, "up");
            return;
          }
          if (event.key === "ArrowDown" && position.line >= text.split("\n").length - 1) {
            event.preventDefault();
            exitCodeBlock(codeBlock, "down");
            return;
          }
        }
      }
    }
  }
  const block = activeBlock();
  if (preferences.autoFormatMarkdown && event.key === " ") {
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
  if (event.key === "Enter" && typewriterMode && preferences.typewriterCenter) setTimeout(() => activeBlock()?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
});

document.addEventListener("selectionchange", () => {
  const block = activeBlock();
  document.querySelectorAll(".active-block").forEach((element) => element.classList.remove("active-block"));
  if (block) block.classList.add("active-block");
  const node = window.getSelection()?.anchorNode;
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  activeTableCell = element && editor.contains(element) ? element.closest("td,th") : null;
  positionTableMoreButton();
  const langPre = currentCodeBlock();
  if (langPre) showCodeLangTooltip(langPre);
  else if (!langEditing) { activeLangPre = null; hideCodeLangTooltip(); }
});

function positionTableMoreButton() {
  const table = activeTableCell?.closest("table");
  if (!table || sourceMode || !editor.contains(table)) {
    tableMoreButton.hidden = true;
    return;
  }
  const bounds = table.getBoundingClientRect();
  tableMoreButton.hidden = false;
  tableMoreButton.style.left = Math.max(8, bounds.right - tableMoreButton.offsetWidth) + "px";
  tableMoreButton.style.top = Math.max(34, bounds.top - tableMoreButton.offsetHeight - 8) + "px";
}

tableMoreButton.addEventListener("mousedown", (event) => event.preventDefault());
tableMoreButton.addEventListener("click", (event) => {
  event.stopPropagation();
  const rect = tableMoreButton.getBoundingClientRect();
  openContextMenu(rect.right + 4, rect.top - 2, buildTableMenuItems());
});

document.querySelector("#main-area").addEventListener("scroll", positionTableMoreButton, { passive: true });
document.querySelector("#main-area").addEventListener("scroll", syncActiveOutlineItem, { passive: true });
document.querySelector("#main-area").addEventListener("scroll", () => positionCodeLangTooltip(activeLangPre), { passive: true });
document.querySelector("#main-area").addEventListener("scroll", closeContextMenu, { passive: true });
document.querySelector("#file-library-tree").addEventListener("scroll", closeContextMenu, { passive: true });
window.addEventListener("resize", positionTableMoreButton);
window.addEventListener("resize", () => positionCodeLangTooltip(activeLangPre));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !preferencesDialog.hidden) { closePreferences(); return; }
  if (event.key === "F11") { event.preventDefault(); performAction("fullscreen"); return; }
  if ((event.ctrlKey || event.metaKey) && event.key === "0" && !event.shiftKey) { event.preventDefault(); performAction("zoom-reset"); return; }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "=" || event.key === "+")) { event.preventDefault(); performAction("zoom-in"); return; }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "-" || event.key === "_")) { event.preventDefault(); performAction("zoom-out"); return; }
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key === ",") { event.preventDefault(); openPreferences(); return; }
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
  if (handleSourcePairKeydown(event)) return;
  if (event.key === "Tab") {
    event.preventDefault();
    const start = source.selectionStart;
    const end = source.selectionEnd;
    source.setRangeText(" ".repeat(preferences.tabSize), start, end, "end");
    updateAfterEdit();
  }
});

window.addEventListener("beforeunload", (event) => {
  if (dirty) { event.preventDefault(); event.returnValue = ""; }
});

resetAutoSaveTimer();
renderMarkdown("").then(() => {
  editor.innerHTML = "<p><br></p>";
  updateOutline();
  updateWordCount();
  setDirty(false);
  if (preferences.startupSidebar !== "none") showSidebar(preferences.startupSidebar);
  placeCaretAtStart(editor.firstElementChild || editor);
  void restoreRecoveryDraft();
});
