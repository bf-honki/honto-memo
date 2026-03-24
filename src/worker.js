import { connect } from "@tidbcloud/serverless";

const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store",
};

let schemaState = {
  url: null,
  promise: null,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env, url);
    }

    return serveStaticAsset(request, env);
  },
};

async function handleApiRequest(request, env, url) {
  try {
    const databaseUrl = buildDatabaseUrl(env);
    const db = connect({ url: databaseUrl });

    await ensureDatabaseReady(db, databaseUrl);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return jsonResponse({
        ok: true,
        databaseAvailable: true,
        database: String(env.TIDB_DATABASE ?? "test"),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/notes") {
      return jsonResponse(await listNotes(db));
    }

    const noteMatch = /^\/api\/notes\/([^/]+)$/.exec(url.pathname);
    if (noteMatch) {
      const noteId = normalizeId(decodeURIComponent(noteMatch[1]));

      if (request.method === "PUT") {
        const payload = await readJson(request);
        return jsonResponse(await upsertNote(db, noteId, payload));
      }

      if (request.method === "DELETE") {
        await db.execute("DELETE FROM notes WHERE id = ?", [noteId]);
        return new Response(null, {
          status: 204,
          headers: {
            "cache-control": "no-store",
          },
        });
      }
    }

    return jsonResponse(
      {
        error: "not_found",
        message: "요청한 API를 찾을 수 없습니다.",
      },
      404,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

async function listNotes(db) {
  const result = await db.execute(
    `
      SELECT
        id,
        title,
        content,
        images_json AS imagesJson,
        created_at_ms AS createdAt,
        updated_at_ms AS updatedAt
      FROM notes
      ORDER BY updated_at_ms DESC
    `,
  );

  return rowsFrom(result).map(noteFromRow);
}

async function upsertNote(db, noteId, payload) {
  const title = normalizeTitle(payload?.title);
  const content = typeof payload?.content === "string" ? payload.content : "";
  const images = normalizeImages(payload?.images);
  const now = Date.now();

  await db.execute(
    `
      INSERT INTO notes (id, title, content, images_json, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        title = VALUES(title),
        content = VALUES(content),
        images_json = VALUES(images_json),
        updated_at_ms = VALUES(updated_at_ms)
    `,
    [noteId, title, content, JSON.stringify(images), now, now],
  );

  const saved = await fetchNoteById(db, noteId);
  if (!saved) {
    throw new HttpError(500, "메모 저장 후 다시 읽지 못했습니다.");
  }

  return saved;
}

async function fetchNoteById(db, noteId) {
  const result = await db.execute(
    `
      SELECT
        id,
        title,
        content,
        images_json AS imagesJson,
        created_at_ms AS createdAt,
        updated_at_ms AS updatedAt
      FROM notes
      WHERE id = ?
      LIMIT 1
    `,
    [noteId],
  );

  const row = rowsFrom(result)[0];
  return row ? noteFromRow(row) : null;
}

async function ensureDatabaseReady(db, databaseUrl) {
  if (schemaState.url !== databaseUrl) {
    schemaState = {
      url: databaseUrl,
      promise: null,
    };
  }

  if (!schemaState.promise) {
    schemaState.promise = initializeDatabase(db).catch((error) => {
      schemaState.promise = null;
      throw error;
    });
  }

  await schemaState.promise;
}

async function initializeDatabase(db) {
  await db.execute(
    `
      CREATE TABLE IF NOT EXISTS notes (
        id VARCHAR(64) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content LONGTEXT NOT NULL,
        images_json LONGTEXT NOT NULL,
        created_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL
      )
    `,
  );

  const countResult = await db.execute("SELECT COUNT(*) AS noteCount FROM notes");
  const noteCount = numberOr(rowsFrom(countResult)[0]?.noteCount, 0);

  if (noteCount > 0) {
    return;
  }

  const now = Date.now();
  await db.execute(
    `
      INSERT INTO notes (id, title, content, images_json, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE title = title
    `,
    [
      "system-ready",
      "SYSTEM_READY.log",
      "Cloudflare Worker와 TiDB 연결이 준비되었습니다. 다른 기기에서도 같은 메모를 확인할 수 있습니다.",
      "[]",
      now,
      now,
    ],
  );
}

function buildDatabaseUrl(env) {
  if (typeof env.DATABASE_URL === "string" && env.DATABASE_URL.trim()) {
    return env.DATABASE_URL.trim();
  }

  const missingKeys = ["TIDB_HOST", "TIDB_PORT", "TIDB_USER", "TIDB_PASSWORD", "TIDB_DATABASE"].filter(
    (key) => typeof env[key] !== "string" || !String(env[key]).trim(),
  );

  if (missingKeys.length > 0) {
    throw new HttpError(
      500,
      `Cloudflare Secret 누락: ${missingKeys.join(", ")}. Settings > Variables and Secrets에서 값을 넣어주세요.`,
    );
  }

  const user = encodeURIComponent(String(env.TIDB_USER).trim());
  const password = encodeURIComponent(String(env.TIDB_PASSWORD).trim());
  const host = String(env.TIDB_HOST).trim();
  const port = String(env.TIDB_PORT).trim();
  const database = encodeURIComponent(String(env.TIDB_DATABASE).trim());

  return `mysql://${user}:${password}@${host}:${port}/${database}?sslaccept=strict`;
}

function noteFromRow(row) {
  return {
    id: String(row.id ?? ""),
    title: String(row.title ?? ""),
    content: String(row.content ?? ""),
    images: parseImages(row.imagesJson),
    createdAt: numberOr(row.createdAt, Date.now()),
    updatedAt: numberOr(row.updatedAt, Date.now()),
  };
}

function parseImages(imagesJson) {
  if (typeof imagesJson !== "string" || !imagesJson.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(imagesJson);
    return normalizeImages(parsed);
  } catch {
    return [];
  }
}

function normalizeImages(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((rawImage) => {
    const ratio = numberOr(rawImage?.ratio, 1) || 1;
    const width = Math.max(60, numberOr(rawImage?.w, 220));

    return {
      id: String(rawImage?.id ?? generateId()),
      src: String(rawImage?.src ?? ""),
      x: numberOr(rawImage?.x, 50),
      y: numberOr(rawImage?.y, 120),
      w: width,
      h: Math.max(60, numberOr(rawImage?.h, width / ratio)),
      ratio,
    };
  });
}

function normalizeTitle(value) {
  const text = typeof value === "string" ? value.trim() : "";

  if (!text) {
    return "UNTITLED.txt";
  }

  return text.slice(0, 255);
}

function normalizeId(value) {
  const text = String(value ?? "").trim();

  if (!text) {
    throw new HttpError(400, "메모 ID가 비어 있습니다.");
  }

  if (text.length > 64) {
    throw new HttpError(400, "메모 ID가 너무 깁니다.");
  }

  return text;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "JSON 본문을 읽지 못했습니다.");
  }
}

function rowsFrom(result) {
  if (Array.isArray(result)) {
    return result;
  }

  if (result && Array.isArray(result.rows)) {
    return result.rows;
  }

  return [];
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function generateId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function serveStaticAsset(request, env) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    return new Response("ASSETS binding is missing.", { status: 500 });
  }

  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404) {
    return response;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return response;
  }

  const indexUrl = new URL(request.url);
  indexUrl.pathname = "/index.html";
  return env.ASSETS.fetch(new Request(indexUrl, request));
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: JSON_HEADERS,
  });
}

function errorResponse(error) {
  if (error instanceof HttpError) {
    return jsonResponse(
      {
        error: error.status >= 500 ? "server_error" : "bad_request",
        message: error.message,
      },
      error.status,
    );
  }

  const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
  return jsonResponse(
    {
      error: "server_error",
      message,
    },
    503,
  );
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
