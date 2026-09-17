# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间、试奏问题和纸带库存。

## 启动

```bash
PORT=3019 node server.js
```

## 主要接口

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`

## 库存分配模块

管理员登记整卷（`roll`）与边角料（`remnant`），曲目按宽度和所需长度申请用料。
每首曲目独占一块完整料、禁止拼接；分配时优先选用浪费最少的合格余料（长度富余最小），
余料不够才开新卷。未开工的申请取消后材料原样回填；已开工后取消不回填，只记废料。
库存数据写入 `data/db.json`，服务重启后保留。

- `GET /inventory/pieces?kind=&status=&widthMm=` — 查询库存料
- `POST /inventory/pieces` — 登记整卷或边角料 `{kind, widthMm, lengthMm, note?}`
- `GET /inventory/summary` — 库存/申请/废料汇总
- `GET /inventory/waste?tuneId=` — 废料台账
- `GET /allocations?tuneId=&status=` — 查询用料申请
- `POST /allocations` — 申请用料 `{tuneId, widthMm, lengthMm}`，自动选料
- `POST /allocations/:id/start` — 开工
- `POST /allocations/:id/cancel` — 取消（未开工原样回填，已开工只记废料）
- `POST /allocations/:id/complete` — 完工（余料富余部分记为废料）

申请状态流转：`allocated`（已分配未开工）→ `in_progress`（已开工）→ `completed` / `cancelled`。

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔"}'

# 登记一卷新料，为曲目申请 400mm，开工后取消只记废料
curl -X POST http://127.0.0.1:3019/inventory/pieces \
  -H 'Content-Type: application/json' \
  -d '{"kind":"roll","widthMm":70,"lengthMm":5000,"note":"备用整卷"}'
curl -X POST http://127.0.0.1:3019/allocations \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","widthMm":70,"lengthMm":400}'
curl -X POST http://127.0.0.1:3019/allocations/<申请ID>/start
curl -X POST http://127.0.0.1:3019/allocations/<申请ID>/cancel
curl http://127.0.0.1:3019/inventory/waste
```
