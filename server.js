const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3019);
const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  tunes: [
    {
      id: "tune_demo",
      title: "雨后圆舞曲",
      composer: "匿名",
      stripSpec: {
        widthMm: 70,
        scale: "20音",
        tempoBpm: 82,
        paperType: "半透明纸带"
      },
      createdAt: new Date().toISOString()
    }
  ],
  sections: [
    {
      id: "section_demo_1",
      tuneId: "tune_demo",
      startBeat: 1,
      endBeat: 32,
      laneRange: "1-10",
      checked: true,
      note: "开头主题已试奏"
    },
    {
      id: "section_demo_2",
      tuneId: "tune_demo",
      startBeat: 33,
      endBeat: 64,
      laneRange: "4-18",
      checked: false,
      note: "副歌段等待校对"
    }
  ],
  issues: [
    {
      id: "issue_demo",
      tuneId: "tune_demo",
      sectionId: "section_demo_2",
      type: "漏孔",
      beat: 41,
      lane: 12,
      description: "第41拍高音孔漏打",
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    }
  ],
  stockPieces: [
    {
      id: "piece_demo_roll",
      kind: "roll",
      widthMm: 70,
      lengthMm: 3000,
      status: "available",
      note: "新到半透明纸带整卷",
      createdAt: new Date().toISOString()
    },
    {
      id: "piece_demo_remnant",
      kind: "remnant",
      widthMm: 70,
      lengthMm: 450,
      status: "available",
      note: "上次裁剩的边角料",
      createdAt: new Date().toISOString()
    }
  ],
  allocations: [],
  waste: []
};

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "PATCH /sections/:id/check",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /inventory/pieces",
  "POST /inventory/pieces",
  "GET /inventory/summary",
  "GET /inventory/waste",
  "GET /allocations",
  "POST /allocations",
  "POST /allocations/:id/start",
  "POST /allocations/:id/cancel",
  "POST /allocations/:id/complete"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

function normalizeDb(data) {
  for (const key of ["tunes", "sections", "issues", "stockPieces", "allocations", "waste"]) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  return data;
}

async function readDb() {
  await ensureDb();
  return normalizeDb(JSON.parse(await readFile(DB_FILE, "utf8")));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) {
    const error = new Error("曲目不存在");
    error.status = 404;
    throw error;
  }
  return tune;
}

function positiveNumber(value, field) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    const error = new Error(`${field}必须是正数`);
    error.status = 400;
    throw error;
  }
  return num;
}

function findPiece(db, pieceId) {
  const piece = db.stockPieces.find((item) => item.id === pieceId);
  if (!piece) {
    const error = new Error("库存料不存在");
    error.status = 404;
    throw error;
  }
  return piece;
}

function findAllocation(db, allocationId) {
  const allocation = db.allocations.find((item) => item.id === allocationId);
  if (!allocation) {
    const error = new Error("申请不存在");
    error.status = 404;
    throw error;
  }
  return allocation;
}

// 选料：优先浪费最少的合格余料（长度富余最小），余料不够才开新卷（同样取最贴合的卷）
function pickPiece(db, widthMm, lengthMm) {
  const fits = (piece) => piece.status === "available" && piece.widthMm === widthMm && piece.lengthMm >= lengthMm;
  const byLeastWaste = (a, b) => a.lengthMm - b.lengthMm || a.createdAt.localeCompare(b.createdAt);
  const remnant = db.stockPieces.filter((p) => p.kind === "remnant" && fits(p)).sort(byLeastWaste)[0];
  if (remnant) return remnant;
  return db.stockPieces.filter((p) => p.kind === "roll" && fits(p)).sort(byLeastWaste)[0] || null;
}

function buildInventorySummary(db) {
  const countBy = (items, key) =>
    items.reduce((acc, item) => {
      acc[item[key]] = (acc[item[key]] || 0) + 1;
      return acc;
    }, {});
  const availableLength = (kind) =>
    db.stockPieces
      .filter((p) => p.kind === kind && p.status === "available")
      .reduce((sum, p) => sum + p.lengthMm, 0);
  return {
    pieces: {
      total: db.stockPieces.length,
      byKind: countBy(db.stockPieces, "kind"),
      byStatus: countBy(db.stockPieces, "status"),
      availableLengthMm: { roll: availableLength("roll"), remnant: availableLength("remnant") }
    },
    allocations: { total: db.allocations.length, byStatus: countBy(db.allocations, "status") },
    waste: {
      total: db.waste.length,
      totalLengthMm: db.waste.reduce((sum, item) => sum + item.lengthMm, 0)
    }
  };
}

function buildProgress(db, tuneId) {
  findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0
  };
}

async function handle(req, res) {
  const { pathname, searchParams } = parseUrl(req);
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
  }

  if (req.method === "GET" && pathname === "/tunes") {
    const tunes = db.tunes.map((tune) => ({ ...tune, progress: buildProgress(db, tune.id) }));
    return send(res, 200, { data: tunes });
  }

  if (req.method === "POST" && pathname === "/tunes") {
    const body = await parseBody(req);
    required(body, ["title", "stripSpec"]);
    const tune = {
      id: makeId("tune"),
      title: body.title,
      composer: body.composer || "",
      stripSpec: body.stripSpec,
      createdAt: new Date().toISOString()
    };
    db.tunes.push(tune);
    await writeDb(db);
    return send(res, 201, { data: tune });
  }

  const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
  if (tuneSectionsMatch && req.method === "GET") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId) });
  }

  if (tuneSectionsMatch && req.method === "POST") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    const body = await parseBody(req);
    required(body, ["startBeat", "endBeat", "laneRange"]);
    const section = {
      id: makeId("section"),
      tuneId,
      startBeat: Number(body.startBeat),
      endBeat: Number(body.endBeat),
      laneRange: body.laneRange,
      checked: Boolean(body.checked),
      note: body.note || ""
    };
    db.sections.push(section);
    await writeDb(db);
    return send(res, 201, { data: section });
  }

  const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
  if (uncheckedMatch && req.method === "GET") {
    const tuneId = uncheckedMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId && !item.checked) });
  }

  const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
  if (progressMatch && req.method === "GET") {
    return send(res, 200, { data: buildProgress(db, progressMatch[1]) });
  }

  const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (checkMatch && req.method === "PATCH") {
    const section = db.sections.find((item) => item.id === checkMatch[1]);
    if (!section) return send(res, 404, { error: "区间不存在" });
    const body = await parseBody(req);
    section.checked = body.checked !== undefined ? Boolean(body.checked) : true;
    section.note = body.note ?? section.note;
    await writeDb(db);
    return send(res, 200, { data: section });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const issues = db.issues.filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status));
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description"]);
    findTune(db, body.tuneId);
    const section = db.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
    if (!section) return send(res, 400, { error: "区间不存在或不属于该曲目" });
    const issue = {
      id: makeId("issue"),
      tuneId: body.tuneId,
      sectionId: body.sectionId,
      type: body.type,
      beat: body.beat === undefined ? null : Number(body.beat),
      lane: body.lane === undefined ? null : Number(body.lane),
      description: body.description,
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };
    db.issues.push(issue);
    await writeDb(db);
    return send(res, 201, { data: issue });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const issue = db.issues.find((item) => item.id === issueStatusMatch[1]);
    if (!issue) return send(res, 404, { error: "问题不存在" });
    const body = await parseBody(req);
    required(body, ["status"]);
    issue.status = body.status;
    issue.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
    issue.note = body.note ?? issue.note;
    await writeDb(db);
    return send(res, 200, { data: issue });
  }

  // ---------- 库存分配模块 ----------

  if (req.method === "GET" && pathname === "/inventory/pieces") {
    const kind = searchParams.get("kind");
    const status = searchParams.get("status");
    const widthMm = searchParams.get("widthMm");
    const pieces = db.stockPieces.filter(
      (item) =>
        (!kind || item.kind === kind) &&
        (!status || item.status === status) &&
        (!widthMm || item.widthMm === Number(widthMm))
    );
    return send(res, 200, { data: pieces });
  }

  if (req.method === "POST" && pathname === "/inventory/pieces") {
    const body = await parseBody(req);
    required(body, ["kind", "widthMm", "lengthMm"]);
    if (!["roll", "remnant"].includes(body.kind)) {
      return send(res, 400, { error: "kind 必须是 roll（整卷）或 remnant（边角料）" });
    }
    const piece = {
      id: makeId("piece"),
      kind: body.kind,
      widthMm: positiveNumber(body.widthMm, "宽度"),
      lengthMm: positiveNumber(body.lengthMm, "长度"),
      status: "available",
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.stockPieces.push(piece);
    await writeDb(db);
    return send(res, 201, { data: piece });
  }

  if (req.method === "GET" && pathname === "/inventory/summary") {
    return send(res, 200, { data: buildInventorySummary(db) });
  }

  if (req.method === "GET" && pathname === "/inventory/waste") {
    const tuneId = searchParams.get("tuneId");
    const waste = db.waste.filter((item) => !tuneId || item.tuneId === tuneId);
    return send(res, 200, { data: waste });
  }

  if (req.method === "GET" && pathname === "/allocations") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const allocations = db.allocations.filter(
      (item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status)
    );
    return send(res, 200, { data: allocations });
  }

  if (req.method === "POST" && pathname === "/allocations") {
    const body = await parseBody(req);
    required(body, ["tuneId", "widthMm", "lengthMm"]);
    findTune(db, body.tuneId);
    const widthMm = positiveNumber(body.widthMm, "宽度");
    const lengthMm = positiveNumber(body.lengthMm, "长度");
    const piece = pickPiece(db, widthMm, lengthMm);
    if (!piece) {
      return send(res, 409, { error: "没有宽度匹配且长度足够的余料或整卷" });
    }
    // 每首曲目独占一块完整料：余料整段保留给该曲目；整卷则裁下所需长度
    if (piece.kind === "remnant") {
      piece.status = "allocated";
    } else {
      piece.lengthMm -= lengthMm;
      if (piece.lengthMm === 0) piece.status = "depleted";
    }
    const allocation = {
      id: makeId("alloc"),
      tuneId: body.tuneId,
      widthMm,
      lengthMm,
      pieceId: piece.id,
      sourceKind: piece.kind,
      status: "allocated",
      wasteMm: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      cancelledAt: null,
      completedAt: null
    };
    db.allocations.push(allocation);
    await writeDb(db);
    return send(res, 201, { data: allocation });
  }

  const allocActionMatch = pathname.match(/^\/allocations\/([^/]+)\/(start|cancel|complete)$/);
  if (allocActionMatch && req.method === "POST") {
    const allocation = findAllocation(db, allocActionMatch[1]);
    const action = allocActionMatch[2];
    const piece = findPiece(db, allocation.pieceId);
    const now = new Date().toISOString();

    if (action === "start") {
      if (allocation.status !== "allocated") {
        return send(res, 409, { error: "只有未开工的申请才能开工" });
      }
      allocation.status = "in_progress";
      allocation.startedAt = now;
    }

    if (action === "cancel") {
      if (allocation.status === "allocated") {
        // 未开工取消：原样回填，余料恢复可用，整卷退回裁下的长度
        if (allocation.sourceKind === "remnant") {
          piece.status = "available";
        } else {
          piece.lengthMm += allocation.lengthMm;
          piece.status = "available";
        }
        allocation.status = "cancelled";
        allocation.cancelledAt = now;
      } else if (allocation.status === "in_progress") {
        // 已开工取消：不回填库存，只记废料
        const wasteMm = allocation.sourceKind === "remnant" ? piece.lengthMm : allocation.lengthMm;
        if (allocation.sourceKind === "remnant") piece.status = "scrapped";
        db.waste.push({
          id: makeId("waste"),
          allocationId: allocation.id,
          tuneId: allocation.tuneId,
          pieceId: piece.id,
          widthMm: allocation.widthMm,
          lengthMm: wasteMm,
          reason: "开工后取消",
          createdAt: now
        });
        allocation.status = "cancelled";
        allocation.wasteMm = wasteMm;
        allocation.cancelledAt = now;
      } else {
        return send(res, 409, { error: "已完成或已取消的申请不能取消" });
      }
    }

    if (action === "complete") {
      if (allocation.status !== "in_progress") {
        return send(res, 409, { error: "只有已开工的申请才能完工" });
      }
      // 余料被整段占用，富余部分在完工时记为废料
      if (allocation.sourceKind === "remnant") {
        piece.status = "consumed";
        const surplus = piece.lengthMm - allocation.lengthMm;
        if (surplus > 0) {
          db.waste.push({
            id: makeId("waste"),
            allocationId: allocation.id,
            tuneId: allocation.tuneId,
            pieceId: piece.id,
            widthMm: allocation.widthMm,
            lengthMm: surplus,
            reason: "余料富余",
            createdAt: now
          });
          allocation.wasteMm = surplus;
        }
      }
      allocation.status = "completed";
      allocation.completedAt = now;
    }

    await writeDb(db);
    return send(res, 200, { data: allocation });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
