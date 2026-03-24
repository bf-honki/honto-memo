use std::{
    collections::HashMap,
    env,
    net::SocketAddr,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, anyhow};
use axum::{
    Json, Router,
    extract::{Path as AxumPath, State},
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{get, put},
};
use dotenvy::dotenv;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{
    MySqlPool, Row,
    mysql::{MySqlPoolOptions, MySqlRow},
};
use tokio::fs;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
struct AppState {
    db: Option<MySqlPool>,
    fallback_dir: PathBuf,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NoteImage {
    id: String,
    src: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    ratio: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Note {
    id: String,
    title: String,
    content: String,
    images: Vec<NoteImage>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupEnvelope {
    note: Note,
    saved_at: i64,
    reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertNoteRequest {
    title: String,
    content: String,
    images: Vec<NoteImage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    database_available: bool,
    fallback_dir: String,
}

type AppResult<T> = Result<T, AppError>;

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    error: anyhow::Error,
}

impl AppError {
    fn new(status: StatusCode, error: anyhow::Error) -> Self {
        Self { status, error }
    }

    fn service_unavailable(error: anyhow::Error) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, error)
    }
}

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(error: E) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, error.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        tracing::error!("{:#}", self.error);
        (
            self.status,
            Json(json!({
                "error": "server_error",
                "message": self.error.to_string(),
            })),
        )
            .into_response()
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenv().ok();
    init_tracing();

    let fallback_dir = env::current_dir()
        .context("failed to resolve current working directory")?
        .join("failed_notes");
    fs::create_dir_all(&fallback_dir)
        .await
        .context("failed to create fallback backup directory")?;

    let port = env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3000);

    let db = connect_database().await;
    let app_state = AppState { db, fallback_dir };

    let api_router = Router::new()
        .route("/health", get(health_check))
        .route("/notes", get(list_notes))
        .route(
            "/notes/{id}",
            put(upsert_note)
                .delete(delete_note)
                .route_layer(middleware::from_fn(no_store)),
        );

    let app = Router::new()
        .nest("/api", api_router)
        .fallback_service(
            ServeDir::new("public").not_found_service(ServeFile::new("public/index.html")),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(app_state);

    let address = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .context("failed to bind TCP listener")?;

    tracing::info!("HonKi Memo listening on http://{}", address);
    axum::serve(listener, app).await?;

    Ok(())
}

async fn no_store(request: axum::extract::Request, next: Next) -> axum::response::Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn health_check(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        database_available: state.db.is_some(),
        fallback_dir: state.fallback_dir.display().to_string(),
    })
}

async fn list_notes(State(state): State<AppState>) -> AppResult<Json<Vec<Note>>> {
    let mut merged = HashMap::<String, Note>::new();

    if let Some(db) = state.db.as_ref() {
        match fetch_notes_from_db(db).await {
            Ok(notes) => {
                for note in notes {
                    merged.insert(note.id.clone(), note);
                }
            }
            Err(error) => {
                tracing::warn!("MySQL read failed, falling back to txt backups: {error:#}");
            }
        }
    }

    for note in load_fallback_notes(&state.fallback_dir).await? {
        match merged.get(&note.id) {
            Some(existing) if existing.updated_at >= note.updated_at => {}
            _ => {
                merged.insert(note.id.clone(), note);
            }
        }
    }

    let mut notes = merged.into_values().collect::<Vec<_>>();
    notes.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));

    Ok(Json(notes))
}

async fn upsert_note(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(payload): Json<UpsertNoteRequest>,
) -> AppResult<(StatusCode, Json<Note>)> {
    let now = current_time_ms();
    let mut note = Note {
        id,
        title: normalize_title(&payload.title),
        content: payload.content,
        images: payload.images,
        created_at: now,
        updated_at: now,
    };

    let Some(db) = state.db.as_ref() else {
        let path = write_note_backup(
            &state.fallback_dir,
            &note,
            "MySQL is not connected. Saved backup to txt instead.",
        )
        .await?;

        return Err(AppError::service_unavailable(anyhow!(
            "MySQL unavailable. Backup written to {}",
            path.display()
        )));
    };

    match sqlx::query_scalar::<_, i64>("SELECT created_at_ms FROM notes WHERE id = ?")
        .bind(&note.id)
        .fetch_optional(db)
        .await
    {
        Ok(Some(created_at)) => {
            note.created_at = created_at;
        }
        Ok(None) => {}
        Err(error) => {
            let path = write_note_backup(
                &state.fallback_dir,
                &note,
                &format!("MySQL lookup failed before save: {error}"),
            )
            .await?;

            return Err(AppError::service_unavailable(anyhow!(
                "MySQL lookup failed. Backup written to {}",
                path.display()
            )));
        }
    }

    let images_json = serde_json::to_string(&note.images)?;

    match sqlx::query(
        r#"
        INSERT INTO notes (id, title, content, images_json, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            title = VALUES(title),
            content = VALUES(content),
            images_json = VALUES(images_json),
            updated_at_ms = VALUES(updated_at_ms)
        "#,
    )
    .bind(&note.id)
    .bind(&note.title)
    .bind(&note.content)
    .bind(images_json)
    .bind(note.created_at)
    .bind(note.updated_at)
    .execute(db)
    .await
    {
        Ok(_) => {
            delete_fallback_note_files(&state.fallback_dir, &note.id).await?;
            Ok((StatusCode::OK, Json(note)))
        }
        Err(error) => {
            let path = write_note_backup(
                &state.fallback_dir,
                &note,
                &format!("MySQL save failed: {error}"),
            )
            .await?;

            Err(AppError::service_unavailable(anyhow!(
                "MySQL save failed. Backup written to {}",
                path.display()
            )))
        }
    }
}

async fn delete_note(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<StatusCode> {
    delete_fallback_note_files(&state.fallback_dir, &id).await?;

    if let Some(db) = state.db.as_ref() {
        sqlx::query("DELETE FROM notes WHERE id = ?")
            .bind(&id)
            .execute(db)
            .await
            .map_err(|error| {
                AppError::service_unavailable(anyhow!("MySQL delete failed: {error}"))
            })?;
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn connect_database() -> Option<MySqlPool> {
    let Some(database_url) = env::var("DATABASE_URL").ok() else {
        tracing::warn!("DATABASE_URL is not set. Running in txt-backup fallback mode.");
        return None;
    };

    let db = match MySqlPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
    {
        Ok(pool) => pool,
        Err(error) => {
            tracing::warn!("failed to connect to MySQL, fallback txt mode enabled: {error:#}");
            return None;
        }
    };

    if let Err(error) = initialize_schema(&db).await {
        tracing::warn!("failed to initialize MySQL schema, fallback txt mode enabled: {error:#}");
        return None;
    }

    if let Err(error) = seed_starter_note(&db).await {
        tracing::warn!("failed to seed MySQL starter note, fallback txt mode enabled: {error:#}");
        return None;
    }

    Some(db)
}

async fn fetch_notes_from_db(db: &MySqlPool) -> anyhow::Result<Vec<Note>> {
    let rows = sqlx::query(
        r#"
        SELECT id, title, content, images_json, created_at_ms, updated_at_ms
        FROM notes
        ORDER BY updated_at_ms DESC
        "#,
    )
    .fetch_all(db)
    .await?;

    rows.iter()
        .map(note_from_row)
        .collect::<Result<Vec<_>, _>>()
}

async fn initialize_schema(db: &MySqlPool) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS notes (
            id VARCHAR(64) PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            content LONGTEXT NOT NULL,
            images_json LONGTEXT NOT NULL,
            created_at_ms BIGINT NOT NULL,
            updated_at_ms BIGINT NOT NULL
        )
        "#,
    )
    .execute(db)
    .await
    .context("failed to initialize notes table")?;

    Ok(())
}

async fn seed_starter_note(db: &MySqlPool) -> anyhow::Result<()> {
    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM notes")
        .fetch_one(db)
        .await
        .context("failed to count notes")?;

    if count > 0 {
        return Ok(());
    }

    let now = current_time_ms();
    let starter_images = serde_json::to_string(&Vec::<NoteImage>::new())?;

    sqlx::query(
        r#"
        INSERT INTO notes (id, title, content, images_json, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind("system-ready")
    .bind("SYSTEM_READY.log")
    .bind("서버 저장 시스템이 준비되었습니다.\n다른 기기에서 접속해도 같은 메모를 볼 수 있습니다.")
    .bind(starter_images)
    .bind(now)
    .bind(now)
    .execute(db)
    .await
    .context("failed to seed starter note")?;

    Ok(())
}

async fn load_fallback_notes(fallback_dir: &Path) -> anyhow::Result<Vec<Note>> {
    let mut notes_by_id = HashMap::<String, Note>::new();

    let mut entries = match fs::read_dir(fallback_dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("txt") {
            continue;
        }

        let Ok(contents) = fs::read_to_string(&path).await else {
            continue;
        };
        let Ok(backup) = serde_json::from_str::<BackupEnvelope>(&contents) else {
            continue;
        };

        match notes_by_id.get(&backup.note.id) {
            Some(existing) if existing.updated_at >= backup.note.updated_at => {}
            _ => {
                notes_by_id.insert(backup.note.id.clone(), backup.note);
            }
        }
    }

    let mut notes = notes_by_id.into_values().collect::<Vec<_>>();
    notes.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(notes)
}

async fn write_note_backup(
    fallback_dir: &Path,
    note: &Note,
    reason: &str,
) -> anyhow::Result<PathBuf> {
    fs::create_dir_all(fallback_dir).await?;

    let path = fallback_dir.join(format!(
        "{}_{}.txt",
        note.updated_at,
        sanitize_filename(&note.id)
    ));

    let payload = BackupEnvelope {
        note: note.clone(),
        saved_at: current_time_ms(),
        reason: reason.to_string(),
    };

    fs::write(&path, serde_json::to_string_pretty(&payload)?).await?;
    Ok(path)
}

async fn delete_fallback_note_files(fallback_dir: &Path, note_id: &str) -> anyhow::Result<()> {
    let mut entries = match fs::read_dir(fallback_dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("txt") {
            continue;
        }

        let Ok(contents) = fs::read_to_string(&path).await else {
            continue;
        };
        let Ok(backup) = serde_json::from_str::<BackupEnvelope>(&contents) else {
            continue;
        };

        if backup.note.id == note_id {
            let _ = fs::remove_file(path).await;
        }
    }

    Ok(())
}

fn note_from_row(row: &MySqlRow) -> anyhow::Result<Note> {
    let images_json: String = row.try_get("images_json")?;
    let images = serde_json::from_str::<Vec<NoteImage>>(&images_json)
        .map_err(|error| anyhow!("invalid images_json in database: {error}"))?;

    Ok(Note {
        id: row.try_get("id")?,
        title: row.try_get("title")?,
        content: row.try_get("content")?,
        images,
        created_at: row.try_get("created_at_ms")?,
        updated_at: row.try_get("updated_at_ms")?,
    })
}

fn normalize_title(title: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        "UNTITLED.txt".to_string()
    } else if trimmed.chars().count() > 255 {
        trimmed.chars().take(255).collect()
    } else {
        trimmed.to_string()
    }
}

fn sanitize_filename(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => character,
            _ => '_',
        })
        .collect()
}

fn current_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock drifted before UNIX_EPOCH")
        .as_millis() as i64
}

fn init_tracing() {
    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("honki_memo=info,tower_http=info")),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
}
