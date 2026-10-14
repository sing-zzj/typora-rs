use std::{fs, io::Write, path::PathBuf, sync::Mutex};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd, html};
use serde::Serialize;
use tauri::State;

#[derive(Default)]
struct EditorState {
    current_path: Mutex<Option<PathBuf>>,
    current_folder: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    path: String,
    content: String,
    line_ending: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Heading {
    level: u8,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderedDocument {
    html: String,
    headings: Vec<Heading>,
    images: Vec<ImageSource>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageSource {
    markdown_url: String,
    preview_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedImage {
    markdown_url: String,
    data_url: String,
    alt: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderEntry {
    name: String,
    path: String,
    is_directory: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderListing {
    path: String,
    entries: Vec<FolderEntry>,
}

#[tauri::command]
fn open_document(state: State<'_, EditorState>) -> Result<Option<Document>, String> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("Markdown", &["md", "markdown", "mdown"])
        .add_filter("Text", &["txt"])
        .pick_file()
    else {
        return Ok(None);
    };

    load_document(path, &state).map(Some)
}

fn load_document(path: PathBuf, state: &EditorState) -> Result<Document, String> {
    let content = fs::read_to_string(&path).map_err(|error| format!("无法读取文件：{error}"))?;
    *state
        .current_path
        .lock()
        .map_err(|_| "文档状态不可用".to_owned())? = Some(path.clone());
    if let Some(parent) = path.parent() {
        *state
            .current_folder
            .lock()
            .map_err(|_| "文档状态不可用".to_owned())? = Some(parent.to_path_buf());
    }
    Ok(Document {
        path: path.to_string_lossy().into_owned(),
        line_ending: if content.contains("\r\n") {
            "crlf".to_owned()
        } else {
            "lf".to_owned()
        },
        content,
    })
}

#[tauri::command]
fn choose_folder(state: State<'_, EditorState>) -> Result<Option<FolderListing>, String> {
    let Some(path) = rfd::FileDialog::new().pick_folder() else {
        return Ok(None);
    };
    let root = path
        .canonicalize()
        .map_err(|error| format!("无法打开文件夹：{error}"))?;
    *state
        .current_folder
        .lock()
        .map_err(|_| "文档状态不可用".to_owned())? = Some(root.clone());
    read_folder_entries(root.clone(), root).map(Some)
}

#[tauri::command]
fn list_folder(path: String, state: State<'_, EditorState>) -> Result<FolderListing, String> {
    let root = state
        .current_folder
        .lock()
        .map_err(|_| "文档状态不可用".to_owned())?
        .clone()
        .ok_or_else(|| "请先选择文件夹".to_owned())?;
    let requested = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("无法打开文件夹：{error}"))?;
    if !requested.starts_with(&root) || !requested.is_dir() {
        return Err("只能浏览已选择文件夹中的内容".to_owned());
    }
    read_folder_entries(root, requested)
}

fn read_folder_entries(root: PathBuf, path: PathBuf) -> Result<FolderListing, String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path).map_err(|error| format!("无法读取文件夹：{error}"))? {
        let entry = entry.map_err(|error| format!("无法读取目录项：{error}"))?;
        let entry_path = entry.path();
        let Ok(canonical) = entry_path.canonicalize() else {
            continue;
        };
        if !canonical.starts_with(&root) {
            continue;
        }
        let is_directory = canonical.is_dir();
        let is_markdown = entry_path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "md" | "markdown" | "mdown"
                )
            });
        if is_directory || is_markdown {
            entries.push(FolderEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: canonical.to_string_lossy().into_owned(),
                is_directory,
            });
        }
    }
    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(FolderListing {
        path: path.to_string_lossy().into_owned(),
        entries,
    })
}

#[tauri::command]
fn open_document_by_path(path: String, state: State<'_, EditorState>) -> Result<Document, String> {
    let root = state
        .current_folder
        .lock()
        .map_err(|_| "文档状态不可用".to_owned())?
        .clone()
        .ok_or_else(|| "请先选择文件夹".to_owned())?;
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("无法打开文件：{error}"))?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err("只能打开已选择文件夹中的文件".to_owned());
    }
    load_document(path, &state)
}

#[tauri::command]
fn save_document(
    state: State<'_, EditorState>,
    content: String,
    save_as: bool,
    line_ending: String,
) -> Result<Option<String>, String> {
    let current_path = state
        .current_path
        .lock()
        .map_err(|_| "文档状态不可用".to_owned())?
        .clone();

    let path = if save_as || current_path.is_none() {
        rfd::FileDialog::new()
            .add_filter("Markdown", &["md"])
            .set_file_name("未命名.md")
            .save_file()
    } else {
        current_path
    };

    let Some(path) = path else {
        return Ok(None);
    };

    let content = normalize_line_endings(&content, &line_ending);
    atomic_write(&path, content.as_bytes()).map_err(|error| format!("无法保存文件：{error}"))?;
    *state
        .current_path
        .lock()
        .map_err(|_| "文档状态不可用".to_owned())? = Some(path.clone());
    if let Some(parent) = path.parent() {
        *state
            .current_folder
            .lock()
            .map_err(|_| "文档状态不可用".to_owned())? = Some(parent.to_path_buf());
    }

    Ok(Some(path.to_string_lossy().into_owned()))
}

fn normalize_line_endings(source: &str, line_ending: &str) -> String {
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    if line_ending == "crlf" {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    }
}

fn atomic_write(path: &PathBuf, contents: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(contents)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[tauri::command]
async fn render_markdown(
    source: String,
    document_path: Option<String>,
) -> Result<RenderedDocument, String> {
    tauri::async_runtime::spawn_blocking(move || render_markdown_blocking(source, document_path))
        .await
        .map_err(|error| format!("预览任务失败：{error}"))
}

#[tauri::command]
fn import_image(state: State<'_, EditorState>) -> Result<Option<ImportedImage>, String> {
    let Some(source) = rfd::FileDialog::new()
        .add_filter(
            "Images",
            &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"],
        )
        .pick_file()
    else {
        return Ok(None);
    };
    let document_path = state
        .current_path
        .lock()
        .map_err(|_| "文档状态不可用".to_owned())?
        .clone()
        .ok_or_else(|| "请先保存 Markdown 文档，再插入图片".to_owned())?;
    let parent = document_path
        .parent()
        .ok_or_else(|| "文档路径无效".to_owned())?;
    let stem = document_path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("document");
    let asset_dir = parent.join(format!("{stem}.assets"));
    fs::create_dir_all(&asset_dir).map_err(|error| format!("无法创建图片目录：{error}"))?;
    let original_name = source
        .file_name()
        .ok_or_else(|| "图片文件名无效".to_owned())?;
    let mut destination = asset_dir.join(original_name);
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png");
    let base_name = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let mut suffix = 1;
    while destination.exists() {
        destination = asset_dir.join(format!("{base_name}-{suffix}.{extension}"));
        suffix += 1;
    }
    fs::copy(&source, &destination).map_err(|error| format!("无法复制图片：{error}"))?;
    let bytes = fs::read(&destination).map_err(|error| format!("无法读取图片：{error}"))?;
    let mime = image_mime(extension);
    let data_url = format!("data:{mime};base64,{}", STANDARD.encode(bytes));
    let markdown_url = format!(
        "{}/{}",
        utf8_percent_encode(
            &asset_dir.file_name().unwrap_or_default().to_string_lossy(),
            NON_ALPHANUMERIC
        ),
        utf8_percent_encode(
            &destination
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
            NON_ALPHANUMERIC
        )
    );
    Ok(Some(ImportedImage {
        markdown_url,
        data_url,
        alt: base_name.to_owned(),
    }))
}

fn image_mime(extension: &str) -> &'static str {
    match extension.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "image/png",
    }
}

#[tauri::command]
fn export_html(html: String) -> Result<Option<String>, String> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("HTML", &["html", "htm"])
        .set_file_name("document.html")
        .save_file()
    else {
        return Ok(None);
    };
    let document = format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Markdown Export</title><style>body{{max-width:860px;margin:48px auto;padding:0 24px;color:#24292f;font:16px/1.75 Arial,'Microsoft YaHei UI',sans-serif}}img{{max-width:100%}}pre,code{{font-family:Consolas,monospace}}pre{{padding:16px;background:#f6f8fa;border-radius:6px;overflow:auto}}code{{padding:.2em .4em;background:#eff1f3;border-radius:4px}}table{{border-collapse:collapse}}th,td{{padding:6px 12px;border:1px solid #d0d7de}}blockquote{{border-left:4px solid #d0d7de;padding-left:16px;color:#57606a}}a{{color:#0969da}}</style></head><body>{html}</body></html>"
    );
    atomic_write(&path, document.as_bytes()).map_err(|error| format!("无法导出 HTML：{error}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn render_markdown_blocking(source: String, document_path: Option<String>) -> RenderedDocument {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_FOOTNOTES);

    let parser = Parser::new_ext(&source, options);
    let mut safe_events = Vec::new();
    let mut headings = Vec::new();
    let mut images = Vec::new();
    let mut image_replacements = Vec::new();
    let mut image_marker_prefix =
        format!("https://typora-rs.invalid/local-image-{}-", source.len());
    while source.contains(&image_marker_prefix) {
        image_marker_prefix.push('x');
    }
    let mut active_heading: Option<Heading> = None;

    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                active_heading = Some(Heading {
                    level: heading_level(level),
                    text: String::new(),
                });
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some(heading) = active_heading.take() {
                    headings.push(heading);
                }
            }
            Event::Text(text) => {
                if let Some(heading) = active_heading.as_mut() {
                    heading.text.push_str(&text);
                }
                safe_events.push(Event::Text(text));
            }
            Event::Code(text) => {
                if let Some(heading) = active_heading.as_mut() {
                    heading.text.push_str(&text);
                }
                safe_events.push(Event::Code(text));
            }
            // Raw HTML passes through an HTML sanitizer before reaching the WebView.
            Event::Html(text) => safe_events.push(Event::Html(text)),
            Event::InlineHtml(text) => safe_events.push(Event::InlineHtml(text)),
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                let dest_url = if safe_destination(&dest_url) {
                    dest_url
                } else {
                    "#".into()
                };
                safe_events.push(Event::Start(Tag::Link {
                    link_type,
                    dest_url,
                    title,
                    id,
                }));
            }
            Event::Start(Tag::Image {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                let markdown_url = dest_url.to_string();
                let preview_url = resolve_image_url(&markdown_url, document_path.as_deref());
                let rendered_url = if preview_url.starts_with("data:") {
                    let marker = format!("{image_marker_prefix}{}", images.len());
                    image_replacements.push((marker.clone(), preview_url.clone()));
                    marker
                } else {
                    preview_url.clone()
                };
                images.push(ImageSource {
                    markdown_url,
                    preview_url: preview_url.clone(),
                });
                safe_events.push(Event::Start(Tag::Image {
                    link_type,
                    dest_url: rendered_url.into(),
                    title,
                    id,
                }));
            }
            other => safe_events.push(other),
        }
    }

    let mut rendered = String::new();
    html::push_html(&mut rendered, safe_events.into_iter());
    let mut rendered = sanitize_html(&rendered);
    for (marker, data_url) in image_replacements {
        rendered = rendered.replace(&marker, &data_url);
    }
    RenderedDocument {
        html: rendered,
        headings,
        images,
    }
}

fn sanitize_html(source: &str) -> String {
    // Code-fence language classes come from Markdown metadata. Preserve their
    // values so themes and syntax-highlighting extensions can recognize them.
    let code_classes: Vec<String> = source
        .split("class=\"")
        .skip(1)
        .filter_map(|part| part.split_once('"').map(|(value, _)| value.to_owned()))
        .filter(|value| {
            !value.is_empty()
                && value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || "-_ ".contains(character))
        })
        .flat_map(|value| {
            value
                .split_whitespace()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect();
    let code_class_refs: Vec<&str> = code_classes.iter().map(String::as_str).collect();
    let mut sanitizer = ammonia::Builder::default();
    let mut allowed_tags = sanitizer.clone_tags();
    allowed_tags.insert("input");
    sanitizer.tags(allowed_tags);
    sanitizer.add_allowed_classes("code", &code_class_refs);
    sanitizer.add_allowed_classes("pre", &code_class_refs);
    sanitizer.url_relative(ammonia::UrlRelative::PassThrough);
    sanitizer.add_tag_attributes("input", &["type", "checked", "disabled"]);
    sanitizer.add_tag_attribute_values("input", "type", &["checkbox"]);
    sanitizer.add_tag_attributes("span", &["style"]);
    sanitizer.add_tag_attributes("div", &["style"]);
    sanitizer.add_tag_attributes("table", &["style"]);
    sanitizer.add_tag_attributes("th", &["style"]);
    sanitizer.add_tag_attributes("td", &["style"]);
    sanitizer.clean(source).to_string()
}

fn resolve_image_url(url: &str, document_path: Option<&str>) -> String {
    if let Some((scheme, _)) = url.split_once(':') {
        return if matches!(
            scheme.to_ascii_lowercase().as_str(),
            "http" | "https" | "data"
        ) {
            url.to_owned()
        } else {
            String::new()
        };
    }
    let Some(document_path) = document_path else {
        return String::new();
    };
    let Some(parent) = PathBuf::from(document_path).parent().map(PathBuf::from) else {
        return String::new();
    };
    let Ok(root) = parent.canonicalize() else {
        return String::new();
    };
    let Ok(decoded_url) = percent_decode_str(url).decode_utf8() else {
        return String::new();
    };
    let Ok(path) = parent.join(decoded_url.as_ref()).canonicalize() else {
        return String::new();
    };
    if !path.starts_with(&root) || !path.is_file() {
        return String::new();
    }
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return String::new();
    };
    let mime = image_mime(extension);
    let Ok(bytes) = fs::read(path) else {
        return String::new();
    };
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}

fn safe_destination(url: &str) -> bool {
    let trimmed = url.trim();
    let Some((scheme, _)) = trimmed.split_once(':') else {
        return true;
    };
    matches!(
        scheme.to_ascii_lowercase().as_str(),
        "http" | "https" | "mailto"
    )
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(EditorState::default())
        .invoke_handler(tauri::generate_handler![
            open_document,
            choose_folder,
            list_folder,
            open_document_by_path,
            save_document,
            render_markdown,
            export_html,
            import_image
        ])
        .run(tauri::generate_context!())
        .expect("启动 typora-rs 失败");
}
