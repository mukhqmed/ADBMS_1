# MongoDB Lab — README

## Collections & Data Model

| Collection | Key Design Decisions |
|---|---|
| `products` | Embedded `attributes.tags` (array) + `ratingSummary` to avoid runtime aggregation on catalogue reads |
| `orders` | Embedded `items` array (immutable after placement); `version` integer for optimistic concurrency; JSON Schema validator enforces `status` enum |
| `deviceEvents` | Append-only; `ts` stored as ISO-8601 string; `geo.countryCode` flat field (no GeoJSON needed) |
| `sessions` | TTL via `lastSeenAt` (sliding 30-day window) or `expireAt` with `expireAfterSeconds: 0` for point-in-time expiry |
| `users` | Soft-delete pattern (`deletedAt`); partial unique index on `email` covers only active users |

---

## Index List & Rationale

| Collection | Index | Rationale |
|---|---|---|
| `products` | `{ tenantId:1, category:1, brand:1, price:1 }` | Covers faceted query #1 and explain comparison #8; sort on price satisfied by index order |
| `products` | `{ 'attributes.tags':1 }` | Multikey index for `$unwind`/`$group` aggregation in task #3 |
| `products` | `text` on `name, description` | Full-text search on catalogue |
| `reviews` | `{ productId:1, createdAt:-1 }` | Sorted review feeds per product |
| `orders` | `{ tenantId:1, customerId:1, createdAt:-1 }` | Customer order history |
| `orders` | `{ tenantId:1, status:1, createdAt:-1 }` | Status-filtered order queues |
| `deviceEvents` | `{ tenantId:1, deviceId:1, ts:-1 }` | Covers seek pagination #2 and daily aggregation #4 |
| `deviceEvents` | `{ 'geo.countryCode':1, ts:-1 }` | Geo-filtered event queries |
| `sessions` | `{ lastSeenAt:1 }` TTL 30 days | Auto-expire inactive sessions |
| `users` *(task #7)* | `{ email:1 }` partial: `deletedAt $exists false` | Unique email only among active users; re-registration after deletion is allowed |

---

## Explain Output — Task #8

Query: `db.products.find({ category:"Cameras", brand:"Contoso" }).sort({ price:1 })`

| Scenario | Stage | nReturned | keysExamined | docsExamined |
|---|---|---|---|---|
| **With** compound index (`hint`) | SORT | 2 | 40 | 40 |
| **Without** index (`$natural hint`) | SORT | 2 | 0 | 40 |

**Method:** `hint()` used instead of drop/recreate. `hint({ $natural:1 })` forces COLLSCAN; `hint({ tenantId:1, category:1, brand:1, price:1 })` forces the compound index.

**Observation:** Both plans examine all 40 documents and use an in-memory SORT. The difference: with the index `keysExamined=40` (index was traversed), without it `keysExamined=0` (pure collection scan). The index doesn't reduce `docsExamined` here because the query skips `tenantId` — the leading key of the compound index — so MongoDB can't do a tight prefix scan and falls back to a full index scan followed by a fetch.

**Fix:** A narrower index `{ category:1, brand:1, price:1 }` would match this query exactly and would reduce both `keysExamined` and `docsExamined` to 2.
![alt text](image.png)
![alt text](image-1.png)

---

## Bonus — Shard Key Proposal for `deviceEvents`

**Proposed key:** `{ tenantId: 1, deviceId: 1, ts: -1 }`

- **Cardinality** — `tenantId` alone has only 2 values (no spread). Adding `deviceId` yields hundreds of distinct prefixes for fine-grained chunk splitting.
- **Write distribution** — the `tenantId+deviceId` prefix diversifies inserts so new events don't pile onto a single tail chunk (monotonic `ts` alone would create a hotspot).
- **Query targeting** — all queries filter by `tenantId` (often `deviceId` too), so mongos routes to a single shard — no scatter-gather.
- **Seek pagination** — the seek cursor `(ts < last.ts) OR (ts == last.ts AND _id < last._id)` stays within one shard after the prefix narrows it. No cross-shard merge sort needed.
- **Why not hashed `_id`?** Perfect write spread but every tenant aggregation becomes scatter-gather — unacceptable for an operational workload.

---

## Consistency Note

For reads that must see just-committed writes (e.g. reading an order immediately after the task #5 `findOneAndUpdate`):

- Use `writeConcern: { w: "majority" }` on the write and `readConcern: "majority"` on the subsequent read.
- This guarantees the PAID status is visible even if the read briefly routes to a secondary.
- `readConcern: "linearizable"` offers the strongest guarantee (linearizable reads from primary) at the cost of higher latency — appropriate only when strict ordering across sessions is required.
