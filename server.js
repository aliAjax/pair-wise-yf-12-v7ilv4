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
  stocks: [
    {
      id: "roll_demo",
      kind: "roll",
      widthMm: 70,
      lengthMm: 50000,
      status: "sealed",
      sourceStockId: null,
      note: "示范整卷",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "offcut_demo_1",
      kind: "offcut",
      widthMm: 70,
      lengthMm: 1200,
      status: "available",
      sourceStockId: null,
      note: "示范边角料",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ],
  allocations: [],
  scraps: []
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
  "POST /inventory/rolls",
  "POST /inventory/offcuts",
  "GET /inventory/stocks",
  "GET /inventory/summary",
  "POST /allocations",
  "GET /allocations",
  "GET /allocations/:id",
  "POST /allocations/:id/start",
  "POST /allocations/:id/complete",
  "POST /allocations/:id/cancel",
  "GET /scraps"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  // 旧版本数据平滑升级，缺失的库存集合补齐为空数组
  let migrated = false;
  for (const key of ["stocks", "allocations", "scraps"]) {
    if (!Array.isArray(db[key])) {
      db[key] = key === "stocks" ? initialData.stocks : [];
      migrated = true;
    }
  }
  if (migrated) await writeDb(db);
  return db;
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

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function positiveMm(value, label) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw httpError(400, `${label}必须是正数（毫米）`);
  }
  return num;
}

function nowIso() {
  return new Date().toISOString();
}

function registerStock(db, kind, body) {
  required(body, ["widthMm", "lengthMm"]);
  const widthMm = positiveMm(body.widthMm, "宽度");
  const lengthMm = positiveMm(body.lengthMm, "长度");
  const stock = {
    id: makeId(kind === "roll" ? "roll" : "offcut"),
    kind,
    widthMm,
    lengthMm,
    // 整卷登记后密封，边角料登记后可直接使用
    status: kind === "roll" ? "sealed" : "available",
    sourceStockId: body.sourceStockId || null,
    note: body.note || "",
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  db.stocks.push(stock);
  return stock;
}

// 选料：只接受同宽度、长度足够的一整块料；优先合格余料中浪费最少（best-fit），余料不够才开新卷
function pickStock(db, widthMm, lengthMm) {
  const usableOffcuts = db.stocks
    .filter((stock) => stock.kind === "offcut" && stock.status === "available" && stock.widthMm === widthMm && stock.lengthMm >= lengthMm)
    .sort((a, b) => a.lengthMm - b.lengthMm || a.createdAt.localeCompare(b.createdAt));
  if (usableOffcuts.length) {
    return { stock: usableOffcuts[0], selectedFrom: "offcut" };
  }
  const usableRolls = db.stocks
    .filter((stock) => stock.kind === "roll" && stock.status === "sealed" && stock.widthMm === widthMm && stock.lengthMm >= lengthMm)
    .sort((a, b) => a.lengthMm - b.lengthMm || a.createdAt.localeCompare(b.createdAt));
  if (usableRolls.length) {
    return { stock: usableRolls[0], selectedFrom: "roll" };
  }
  return null;
}

function findAllocation(db, allocationId) {
  const allocation = db.allocations.find((item) => item.id === allocationId);
  if (!allocation) throw httpError(404, "分配申请不存在");
  return allocation;
}

function requireAllocationStatus(allocation, allowed, message) {
  if (!allowed.includes(allocation.status)) {
    throw httpError(409, message || `当前状态为${allocation.status}，不能执行该操作`);
  }
}

function allocationDetail(db, allocation) {
  const stock = db.stocks.find((item) => item.id === allocation.stockId) || null;
  const remainderStock = allocation.remainderStockId ? db.stocks.find((item) => item.id === allocation.remainderStockId) || null : null;
  return { ...allocation, stock, remainderStock };
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

  if (req.method === "POST" && pathname === "/inventory/rolls") {
    const body = await parseBody(req);
    const stock = registerStock(db, "roll", body);
    await writeDb(db);
    return send(res, 201, { data: stock });
  }

  if (req.method === "POST" && pathname === "/inventory/offcuts") {
    const body = await parseBody(req);
    const stock = registerStock(db, "offcut", body);
    await writeDb(db);
    return send(res, 201, { data: stock });
  }

  if (req.method === "GET" && pathname === "/inventory/stocks") {
    const kind = searchParams.get("kind");
    const status = searchParams.get("status");
    const widthMm = searchParams.get("widthMm");
    const stocks = db.stocks.filter(
      (item) =>
        (!kind || item.kind === kind) &&
        (!status || item.status === status) &&
        (widthMm === null || item.widthMm === Number(widthMm))
    );
    return send(res, 200, { data: stocks });
  }

  if (req.method === "GET" && pathname === "/inventory/summary") {
    const group = (list, widthMm) => list
      .filter((item) => item.widthMm === widthMm)
      .reduce((sum, item) => sum + item.lengthMm, 0);
    const widths = [...new Set(db.stocks.map((item) => item.widthMm))].sort((a, b) => a - b);
    const summary = widths.map((widthMm) => ({
      widthMm,
      sealedRollCount: db.stocks.filter((item) => item.widthMm === widthMm && item.kind === "roll" && item.status === "sealed").length,
      availableOffcutCount: db.stocks.filter((item) => item.widthMm === widthMm && item.kind === "offcut" && item.status === "available").length,
      availableOffcutLengthMm: group(db.stocks.filter((item) => item.kind === "offcut" && item.status === "available"), widthMm),
      reservedLengthMm: group(db.stocks.filter((item) => item.status === "reserved"), widthMm),
      inProgressLengthMm: group(db.stocks.filter((item) => item.status === "in_progress"), widthMm),
      consumedLengthMm: group(db.stocks.filter((item) => item.status === "consumed"), widthMm),
      scrapLengthMm: group(db.scraps || [], widthMm)
    }));
    return send(res, 200, { data: summary });
  }

  if (req.method === "POST" && pathname === "/allocations") {
    const body = await parseBody(req);
    required(body, ["tuneId", "requiredLengthMm"]);
    const tune = findTune(db, body.tuneId);
    const widthMm = body.widthMm === undefined ? Number(tune.stripSpec.widthMm) : positiveMm(body.widthMm, "宽度");
    if (tune.stripSpec && Number(tune.stripSpec.widthMm) !== widthMm) {
      throw httpError(400, `申请宽度${widthMm}mm与曲目纸带规格${tune.stripSpec.widthMm}mm不符`);
    }
    const requiredLengthMm = positiveMm(body.requiredLengthMm, "所需长度");

    // 每首曲目同时只能有一个未终结的申请
    const active = db.allocations.find((item) => item.tuneId === body.tuneId && ["reserved", "in_progress"].includes(item.status));
    if (active) throw httpError(409, "该曲目已有进行中的分配申请，禁止重复占用");

    const picked = pickStock(db, widthMm, requiredLengthMm);
    if (!picked) throw httpError(409, `没有宽度${widthMm}mm且长度不小于${requiredLengthMm}mm的完整料，禁止拼接`);

    const stock = picked.stock;
    // 开工前只是预订：整块料锁定，尚未切割
    stock.status = "reserved";
    stock.updatedAt = nowIso();

    const allocation = {
      id: makeId("alloc"),
      tuneId: body.tuneId,
      widthMm,
      requiredLengthMm,
      stockId: stock.id,
      stockKind: stock.kind,
      stockOriginalLengthMm: stock.lengthMm,
      stockOriginalStatus: stock.kind === "roll" ? "sealed" : "available",
      selectedFrom: picked.selectedFrom,
      status: "reserved",
      remainderStockId: null,
      wasteMm: stock.lengthMm - requiredLengthMm,
      note: body.note || "",
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      cancelReason: null
    };
    db.allocations.push(allocation);
    await writeDb(db);
    return send(res, 201, { data: allocationDetail(db, allocation) });
  }

  if (req.method === "GET" && pathname === "/allocations") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const allocations = db.allocations
      .filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status))
      .map((item) => allocationDetail(db, item));
    return send(res, 200, { data: allocations });
  }

  const allocationMatch = pathname.match(/^\/allocations\/([^/]+)$/);
  if (allocationMatch && req.method === "GET") {
    const allocation = findAllocation(db, allocationMatch[1]);
    return send(res, 200, { data: allocationDetail(db, allocation) });
  }

  const allocationStartMatch = pathname.match(/^\/allocations\/([^/]+)\/start$/);
  if (allocationStartMatch && req.method === "POST") {
    const allocation = findAllocation(db, allocationStartMatch[1]);
    requireAllocationStatus(allocation, ["reserved"], "仅未开工的申请可以开工");
    const stock = db.stocks.find((item) => item.id === allocation.stockId);

    // 开工即下料：从整块料中切出所需长度；有剩余才生成新的边角料，恰好够则整块耗尽
    stock.status = "consumed";
    stock.updatedAt = nowIso();
    let remainder = null;
    const leftover = stock.lengthMm - allocation.requiredLengthMm;
    if (leftover > 0) {
      remainder = {
        id: makeId("offcut"),
        kind: "offcut",
        widthMm: allocation.widthMm,
        lengthMm: leftover,
        status: "available",
        sourceStockId: stock.id,
        note: `开卷/切余，来源申请${allocation.id}`,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      db.stocks.push(remainder);
      allocation.remainderStockId = remainder.id;
    }
    allocation.status = "in_progress";
    allocation.startedAt = nowIso();
    await writeDb(db);
    return send(res, 200, { data: allocationDetail(db, allocation) });
  }

  const allocationCompleteMatch = pathname.match(/^\/allocations\/([^/]+)\/complete$/);
  if (allocationCompleteMatch && req.method === "POST") {
    const allocation = findAllocation(db, allocationCompleteMatch[1]);
    requireAllocationStatus(allocation, ["in_progress"], "仅已开工的申请可以完工");
    allocation.status = "completed";
    allocation.completedAt = nowIso();
    const body = await parseBody(req).catch(() => ({}));
    if (body.note !== undefined) allocation.note = body.note;
    await writeDb(db);
    return send(res, 200, { data: allocationDetail(db, allocation) });
  }

  const allocationCancelMatch = pathname.match(/^\/allocations\/([^/]+)\/cancel$/);
  if (allocationCancelMatch && req.method === "POST") {
    const allocation = findAllocation(db, allocationCancelMatch[1]);
    requireAllocationStatus(allocation, ["reserved", "in_progress"], "已终结的申请不能取消");
    const body = await parseBody(req).catch(() => ({}));
    const stock = db.stocks.find((item) => item.id === allocation.stockId);

    const wasReserved = allocation.status === "reserved";
    if (wasReserved) {
      // 未开工取消：原样回填，料根本没有动过
      stock.status = allocation.stockOriginalStatus;
      stock.updatedAt = nowIso();
    } else {
      // 已开工取消：切下的料只记废料，余料不回收
      db.scraps.push({
        id: makeId("scrap"),
        allocationId: allocation.id,
        tuneId: allocation.tuneId,
        stockId: allocation.stockId,
        widthMm: allocation.widthMm,
        lengthMm: allocation.requiredLengthMm,
        reason: body.reason || "开工后取消",
        createdAt: nowIso()
      });
    }
    allocation.status = "cancelled";
    allocation.cancelledAt = nowIso();
    allocation.cancelReason = body.reason || (wasReserved ? "取消申请" : "开工后取消");
    await writeDb(db);
    return send(res, 200, { data: allocationDetail(db, allocation) });
  }

  if (req.method === "GET" && pathname === "/scraps") {
    const tuneId = searchParams.get("tuneId");
    const scraps = db.scraps.filter((item) => !tuneId || item.tuneId === tuneId);
    return send(res, 200, { data: scraps });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
