# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间和试奏问题。

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

管理员登记整卷纸带与边角料；曲目按纸带宽度和所需长度申请用料。

- `POST /inventory/rolls`：登记整卷（`widthMm`、`lengthMm`，可选 `note`），状态为 `sealed`
- `POST /inventory/offcuts`：登记边角料（同上），状态为 `available`
- `GET /inventory/stocks?kind=&status=&widthMm=`：查询库存
- `GET /inventory/summary`：按宽度汇总各状态库存长度与废料长度
- `POST /allocations`：曲目申请用料（`tuneId`、`requiredLengthMm`，`widthMm` 默认取曲目规格）
- `GET /allocations?tuneId=&status=` / `GET /allocations/:id`
- `POST /allocations/:id/start`：开工下料
- `POST /allocations/:id/complete`：完工
- `POST /allocations/:id/cancel`：取消（body 可选 `reason`）
- `GET /scraps?tuneId=`：废料记录

分配规则：

1. 每首曲目只能占用**一整块完整料**（同宽度、长度足够），禁止拼接。
2. 先在合格余料中选**浪费最少**的一块（长度满足需求且最短，best-fit）；余料都不够才开新卷。
3. 申请后料被预订（`reserved`），尚未切割。
4. 开工时从整块料切出所需长度：剩余部分自动登记为新的边角料，恰好够用则整块耗尽。
5. **未开工取消：原样回填**，库存恢复申请前状态；**已开工后取消：只记废料**，不回收余料。
6. 每首曲目同时只能有一个进行中（`reserved` / `in_progress`）的申请。
7. 全部数据写入 `data/db.json`，服务重启后保留。

库存状态：整卷 `sealed → reserved → consumed`；边角料 `available → reserved`，开工后原块 `consumed` 并生成新 `available` 余料。
申请状态：`reserved → in_progress → completed`，任意未终结状态可转为 `cancelled`。

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔"}'

# 登记一卷 70mm 宽纸带和一块边角料
curl -X POST http://127.0.0.1:3019/inventory/rolls \
  -H 'Content-Type: application/json' -d '{"widthMm":70,"lengthMm":50000}'
curl -X POST http://127.0.0.1:3019/inventory/offcuts \
  -H 'Content-Type: application/json' -d '{"widthMm":70,"lengthMm":1200}'

# 曲目申请 1000mm（优先占用最短合格余料）
curl -X POST http://127.0.0.1:3019/allocations \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","requiredLengthMm":1000}'

# 开工（切下 1000mm，余 200mm 自动成为新边角料）、完工
curl -X POST http://127.0.0.1:3019/allocations/<id>/start
curl -X POST http://127.0.0.1:3019/allocations/<id>/complete
```
