const LOCAL_STATE_KEY = "honki-memo-state-v1";
const REQUEST_TIMEOUT_MS = 8000;

let notes = [];
let activeNoteId = null;
let isSidebarOpen = true;
let resizing = null;
let dragging = null;
let saveTimer = null;
let flushInFlight = false;
let pendingDeletes = new Set();

const sidebar = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebarToggle");
const toggleIcon = document.getElementById("toggleIcon");
const noteList = document.getElementById("noteList");
const addNoteBtn = document.getElementById("addNoteBtn");
const editorHeader = document.getElementById("editorHeader");
const editorContent = document.getElementById("editorContent");
const emptyState = document.getElementById("emptyState");
const noteTitle = document.getElementById("noteTitle");
const noteBody = document.getElementById("noteBody");
const imageInput = document.getElementById("imageInput");
const imageLayer = document.getElementById("imageLayer");
const syncStatus = document.getElementById("syncStatus");
const retrySyncBtn = document.getElementById("retrySyncBtn");
const saveHint = document.getElementById("saveHint");

function generateId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
        return globalThis.crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function currentTimeMs() {
    return Date.now();
}

function createStarterNote() {
    const now = currentTimeMs();
    return {
        id: generateId(),
        title: "SYSTEM_READY.log",
        content: "연결이 잠깐 끊겨도 로컬에 붙잡아 두었다가 서버로 다시 보냅니다.\n이제 노트북을 꺼도 사이트 자체가 같이 꺼지지 않게 배포할 수 있습니다.",
        images: [],
        createdAt: now,
        updatedAt: now,
        dirty: true,
    };
}

function normalizeImage(raw) {
    return {
        id: String(raw?.id ?? generateId()),
        src: String(raw?.src ?? ""),
        x: Number(raw?.x ?? 50),
        y: Number(raw?.y ?? 120),
        w: Number(raw?.w ?? 220),
        h: Number(raw?.h ?? 160),
        ratio: Number(raw?.ratio ?? 1) || 1,
    };
}

function normalizeNote(raw) {
    const updatedAt = Number(raw?.updatedAt ?? currentTimeMs());

    return {
        id: String(raw?.id ?? generateId()),
        title: String(raw?.title ?? ""),
        content: String(raw?.content ?? ""),
        images: Array.isArray(raw?.images) ? raw.images.map(normalizeImage) : [],
        createdAt: Number(raw?.createdAt ?? updatedAt),
        updatedAt,
        dirty: Boolean(raw?.dirty),
    };
}

function sortNotes(list) {
    return [...list].sort((left, right) => right.updatedAt - left.updatedAt);
}

function getActiveNote() {
    return notes.find((note) => note.id === activeNoteId) ?? null;
}

function setSyncStatus(message, state) {
    syncStatus.textContent = message;
    syncStatus.dataset.state = state;
    retrySyncBtn.hidden = state !== "offline" && state !== "error";
}

function setSaveHint(message) {
    saveHint.textContent = message;
}

function formatTimestamp(timestamp) {
    return new Intl.DateTimeFormat("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).format(timestamp);
}

function persistLocalState() {
    const payload = {
        activeNoteId,
        notes: notes.map((note) => ({
            ...note,
            dirty: Boolean(note.dirty),
        })),
        pendingDeletes: [...pendingDeletes],
    };

    localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(payload));
}

function loadLocalState() {
    try {
        const raw = localStorage.getItem(LOCAL_STATE_KEY);
        if (!raw) {
            return;
        }

        const parsed = JSON.parse(raw);
        notes = sortNotes(Array.isArray(parsed.notes) ? parsed.notes.map(normalizeNote) : []);
        pendingDeletes = new Set(
            Array.isArray(parsed.pendingDeletes)
                ? parsed.pendingDeletes.map((id) => String(id))
                : [],
        );
        activeNoteId = typeof parsed.activeNoteId === "string" ? parsed.activeNoteId : notes[0]?.id ?? null;
    } catch (error) {
        console.warn("failed to restore local memo state", error);
    }
}

function renderNoteList() {
    noteList.innerHTML = "";

    sortNotes(notes).forEach((note) => {
        const item = document.createElement("div");
        item.className = `note-item${activeNoteId === note.id ? " active" : ""}`;
        item.addEventListener("click", () => setActiveNote(note.id));

        const top = document.createElement("div");
        top.className = "note-top";

        const arrow = document.createElement("span");
        arrow.className = "note-arrow";
        arrow.textContent = activeNoteId === note.id ? ">" : "";

        const title = document.createElement("span");
        title.className = "note-title";
        title.textContent = note.title || "UNTITLED";

        const dirtyPill = document.createElement("span");
        dirtyPill.className = `dirty-pill${note.dirty ? " is-visible" : ""}`;
        dirtyPill.textContent = "LOCAL";

        top.append(arrow, title, dirtyPill);

        const preview = document.createElement("div");
        preview.className = "note-preview";
        preview.textContent = note.content.trim() || "빈 메모";

        const footer = document.createElement("div");
        footer.className = "note-footer";

        const updatedAt = document.createElement("span");
        updatedAt.textContent = `업데이트 ${formatTimestamp(note.updatedAt)}`;

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "note-delete-btn";
        deleteBtn.type = "button";
        deleteBtn.textContent = "DEL";
        deleteBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            deleteNote(note.id);
        });

        footer.append(updatedAt, deleteBtn);
        item.append(top, preview, footer);
        noteList.appendChild(item);
    });
}

function renderImages(images) {
    imageLayer.innerHTML = "";

    images.forEach((img) => {
        const container = document.createElement("div");
        container.className = "image-container";
        container.style.left = `${img.x}px`;
        container.style.top = `${img.y}px`;
        container.style.width = `${img.w}px`;
        container.style.height = `${img.h}px`;

        const frame = document.createElement("div");
        frame.className = "image-frame";

        const image = document.createElement("img");
        image.src = img.src;
        image.alt = "첨부 이미지";
        frame.appendChild(image);

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "image-delete-btn";
        deleteBtn.type = "button";
        deleteBtn.textContent = "X";
        deleteBtn.addEventListener("click", () => removeImage(img.id));

        const resizeHandle = document.createElement("div");
        resizeHandle.className = "resize-handle";

        frame.addEventListener("mousedown", (event) => startDrag(event, img.id));
        resizeHandle.addEventListener("mousedown", (event) => startResize(event, img.id));

        container.append(frame, deleteBtn, resizeHandle);
        imageLayer.appendChild(container);
    });
}

function setActiveNote(id) {
    activeNoteId = id;
    const note = getActiveNote();

    if (!note) {
        editorHeader.classList.add("hidden");
        editorContent.classList.add("hidden");
        emptyState.classList.remove("hidden");
        renderNoteList();
        persistLocalState();
        return;
    }

    editorHeader.classList.remove("hidden");
    editorContent.classList.remove("hidden");
    emptyState.classList.add("hidden");
    noteTitle.value = note.title;
    noteBody.value = note.content;
    renderImages(note.images);
    setSaveHint(note.dirty ? "로컬 변경 있음" : "자동 저장 켜짐");
    renderNoteList();
    persistLocalState();
}

function markActiveNoteDirty() {
    const note = getActiveNote();
    if (!note) {
        return;
    }

    note.updatedAt = currentTimeMs();
    note.dirty = true;
    notes = sortNotes(notes);
    persistLocalState();
    renderNoteList();
    setSaveHint("저장 예약됨");
    scheduleFlush();
}

function updateActiveNoteData(updates, options = { schedule: true }) {
    const note = getActiveNote();
    if (!note) {
        return;
    }

    Object.assign(note, updates);
    note.updatedAt = currentTimeMs();
    note.dirty = true;
    notes = sortNotes(notes);
    persistLocalState();

    if (Object.prototype.hasOwnProperty.call(updates, "title")) {
        renderNoteList();
    }

    setSaveHint("저장 예약됨");

    if (options.schedule !== false) {
        scheduleFlush();
    }
}

function deleteNote(id) {
    notes = notes.filter((note) => note.id !== id);
    pendingDeletes.add(id);

    if (activeNoteId === id) {
        activeNoteId = notes[0]?.id ?? null;
    }

    persistLocalState();
    renderNoteList();
    setActiveNote(activeNoteId);
    setSaveHint("삭제 전송 예약됨");
    scheduleFlush(120);
}

function createNote() {
    const now = currentTimeMs();
    const newNote = {
        id: generateId(),
        title: "NEW_LOG.txt",
        content: "",
        images: [],
        createdAt: now,
        updatedAt: now,
        dirty: true,
    };

    notes = sortNotes([newNote, ...notes]);
    activeNoteId = newNote.id;
    persistLocalState();
    renderNoteList();
    setActiveNote(newNote.id);

    if (!isSidebarOpen) {
        toggleSidebar();
    }

    noteTitle.focus();
    scheduleFlush(120);
}

function replaceActiveImages(images, markDirty) {
    const note = getActiveNote();
    if (!note) {
        return;
    }

    note.images = images.map(normalizeImage);

    if (markDirty) {
        note.updatedAt = currentTimeMs();
        note.dirty = true;
        notes = sortNotes(notes);
        renderNoteList();
        setSaveHint("이미지 위치 저장 예약됨");
        scheduleFlush();
    }

    persistLocalState();
    renderImages(note.images);
}

function removeImage(id) {
    const note = getActiveNote();
    if (!note) {
        return;
    }

    replaceActiveImages(
        note.images.filter((image) => image.id !== id),
        true,
    );
}

function startDrag(event, imageId) {
    const note = getActiveNote();
    const image = note?.images.find((candidate) => candidate.id === imageId);

    if (!image) {
        return;
    }

    event.preventDefault();

    dragging = {
        id: imageId,
        startX: event.clientX,
        startY: event.clientY,
        startXPos: image.x,
        startYPos: image.y,
    };
}

function startResize(event, imageId) {
    const note = getActiveNote();
    const image = note?.images.find((candidate) => candidate.id === imageId);

    if (!image) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    resizing = {
        id: imageId,
        startX: event.clientX,
        startW: image.w,
        ratio: image.ratio || 1,
    };
}

function toggleSidebar() {
    isSidebarOpen = !isSidebarOpen;
    sidebar.classList.toggle("sidebar-open", isSidebarOpen);
    sidebar.classList.toggle("sidebar-closed", !isSidebarOpen);
    toggleIcon.textContent = isSidebarOpen ? "<" : ">";
}

function scheduleFlush(delay = 650) {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
        flushPendingChanges().catch((error) => {
            console.warn("flush failed", error);
        });
    }, delay);
}

async function request(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const requestOptions = {
        ...options,
        signal: controller.signal,
        headers: {
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers ?? {}),
        },
    };

    try {
        const response = await fetch(url, requestOptions);

        if (response.status === 204) {
            return null;
        }

        const contentType = response.headers.get("content-type") ?? "";
        const body = contentType.includes("application/json")
            ? await response.json()
            : await response.text();

        if (!response.ok) {
            const message =
                typeof body === "object" && body !== null
                    ? body.message || body.error || `HTTP ${response.status}`
                    : String(body || `HTTP ${response.status}`);
            throw new Error(message);
        }

        return body;
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error("요청 시간이 초과되었습니다.");
        }

        throw error;
    } finally {
        window.clearTimeout(timeoutId);
    }
}

async function fetchServerNotes() {
    const serverNotes = await request("/api/notes");
    return Array.isArray(serverNotes)
        ? serverNotes.map((note) => normalizeNote({ ...note, dirty: false }))
        : [];
}

async function upsertServerNote(noteSnapshot) {
    const saved = await request(`/api/notes/${encodeURIComponent(noteSnapshot.id)}`, {
        method: "PUT",
        body: JSON.stringify({
            title: noteSnapshot.title,
            content: noteSnapshot.content,
            images: noteSnapshot.images,
        }),
    });

    return normalizeNote({ ...saved, dirty: false });
}

async function deleteServerNote(id) {
    await request(`/api/notes/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });
}

function mergeServerAndLocal(serverNotes) {
    const merged = new Map(
        serverNotes.map((note) => [
            note.id,
            {
                ...note,
                dirty: false,
            },
        ]),
    );

    notes.filter((note) => note.dirty).forEach((note) => {
        merged.set(note.id, normalizeNote(note));
    });

    pendingDeletes.forEach((id) => {
        merged.delete(id);
    });

    return sortNotes([...merged.values()]);
}

async function flushPendingChanges() {
    if (flushInFlight) {
        return;
    }

    const dirtyNotes = sortNotes(notes.filter((note) => note.dirty));
    if (!dirtyNotes.length && pendingDeletes.size === 0) {
        setSaveHint("자동 저장 켜짐");
        if (navigator.onLine) {
            setSyncStatus(`동기화 완료 ${formatTimestamp(currentTimeMs())}`, "ok");
        }
        return;
    }

    flushInFlight = true;
    setSyncStatus("서버에 저장하는 중...", "saving");
    setSaveHint("변경 사항 전송 중");

    try {
        for (const id of [...pendingDeletes]) {
            await deleteServerNote(id);
            pendingDeletes.delete(id);
            persistLocalState();
        }

        for (const snapshot of dirtyNotes) {
            const saved = await upsertServerNote(snapshot);
            const current = notes.find((note) => note.id === saved.id);

            if (!current) {
                continue;
            }

            if (current.updatedAt !== snapshot.updatedAt) {
                continue;
            }

            Object.assign(current, saved, { dirty: false });
        }

        notes = sortNotes(notes);
        persistLocalState();
        setActiveNote(notes.find((note) => note.id === activeNoteId)?.id ?? notes[0]?.id ?? null);
        setSyncStatus(`동기화 완료 ${formatTimestamp(currentTimeMs())}`, "ok");
        setSaveHint("자동 저장 완료");
    } catch (error) {
        setSyncStatus("연결 불안정, 로컬 임시 저장 유지", "offline");
        setSaveHint(error.message || "온라인 되면 다시 전송합니다.");
        persistLocalState();
    } finally {
        flushInFlight = false;
    }
}

async function bootstrap() {
    loadLocalState();
    renderNoteList();
    setActiveNote(activeNoteId);
    setSyncStatus("서버 연결 중...", "loading");

    try {
        const serverNotes = await fetchServerNotes();
        notes = mergeServerAndLocal(serverNotes);

        if (!notes.length) {
            notes = [createStarterNote()];
        }

        if (!notes.find((note) => note.id === activeNoteId)) {
            activeNoteId = notes[0]?.id ?? null;
        }

        persistLocalState();
        renderNoteList();
        setActiveNote(activeNoteId);
        setSyncStatus("서버 연결 완료", "ok");
        await flushPendingChanges();
    } catch (error) {
        if (!notes.length) {
            notes = [createStarterNote()];
            activeNoteId = notes[0].id;
            persistLocalState();
            renderNoteList();
            setActiveNote(activeNoteId);
        }

        setSyncStatus("연결 불안정, 로컬 임시 저장 중", "offline");
        setSaveHint(error.message || "학교망이 끊겨도 로컬에 저장됩니다.");
    }
}

addNoteBtn.addEventListener("click", createNote);
sidebarToggle.addEventListener("click", toggleSidebar);
retrySyncBtn.addEventListener("click", () => {
    flushPendingChanges().catch((error) => {
        console.warn("retry failed", error);
    });
});

noteTitle.addEventListener("input", (event) => {
    updateActiveNoteData({ title: event.target.value });
});

noteBody.addEventListener("input", (event) => {
    updateActiveNoteData({ content: event.target.value });
});

imageInput.addEventListener("change", (event) => {
    const file = event.target.files?.[0];

    if (!file) {
        return;
    }

    const reader = new FileReader();
    reader.onload = (loadEvent) => {
        const image = new Image();
        image.onload = () => {
            const ratio = image.width / image.height || 1;
            const initialWidth = Math.min(image.width, 320);
            const newImage = {
                id: generateId(),
                src: String(loadEvent.target?.result ?? ""),
                x: 40,
                y: 120,
                w: initialWidth,
                h: initialWidth / ratio,
                ratio,
            };

            const note = getActiveNote();
            if (!note) {
                return;
            }

            replaceActiveImages([...note.images, newImage], true);
        };

        image.src = String(loadEvent.target?.result ?? "");
    };

    reader.readAsDataURL(file);
    event.target.value = "";
});

window.addEventListener("mousemove", (event) => {
    const note = getActiveNote();
    if (!note) {
        return;
    }

    if (dragging) {
        const updatedImages = note.images.map((image) =>
            image.id === dragging.id
                ? {
                    ...image,
                    x: dragging.startXPos + (event.clientX - dragging.startX),
                    y: dragging.startYPos + (event.clientY - dragging.startY),
                }
                : image,
        );

        replaceActiveImages(updatedImages, false);
    } else if (resizing) {
        const newWidth = Math.max(60, resizing.startW + (event.clientX - resizing.startX));
        const updatedImages = note.images.map((image) =>
            image.id === resizing.id
                ? {
                    ...image,
                    w: newWidth,
                    h: newWidth / resizing.ratio,
                }
                : image,
        );

        replaceActiveImages(updatedImages, false);
    }
});

window.addEventListener("mouseup", () => {
    if (dragging || resizing) {
        markActiveNoteDirty();
    }

    dragging = null;
    resizing = null;
});

window.addEventListener("online", () => {
    setSyncStatus("네트워크 복구, 다시 전송 중...", "saving");
    flushPendingChanges().catch((error) => {
        console.warn("online retry failed", error);
    });
});

window.addEventListener("offline", () => {
    setSyncStatus("오프라인 상태, 로컬에만 저장 중", "offline");
});

bootstrap().catch((error) => {
    console.error("bootstrap failed", error);
    setSyncStatus("앱 시작 실패", "error");
    setSaveHint(error.message || "페이지를 새로고침해 주세요.");
});
