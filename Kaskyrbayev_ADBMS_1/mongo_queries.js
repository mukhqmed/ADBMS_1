// Lab tasks 
use('labdocdb');

// ─────────────────────────────────────────────────────────────────────────────
// 1) Faceted listing: Cameras by brand Contoso, price 300..1200, sort price asc,
//    project name + price only
// ─────────────────────────────────────────────────────────────────────────────
db.products.find(
  {
    category: 'Cameras',
    brand:    'Contoso',
    price:    { $gte: 300, $lte: 1200 }
  },
  { projection: { name: 1, price: 1, _id: 0 } }
).sort({ price: 1 });


// ─────────────────────────────────────────────────────────────────────────────
// 2) Seek (keyset) pagination for deviceEvents by tenantId = 't-educ', page size 50,
//    sorted by ts DESC, _id DESC (tie-breaker)
// ─────────────────────────────────────────────────────────────────────────────

// --- First page ---
const page1 = db.deviceEvents
  .find({ tenantId: 't-educ' })
  .sort({ ts: -1, _id: -1 })
  .limit(50)
  .toArray();

// --- Capture the cursor (last document of page 1) ---
const cursor = page1[page1.length - 1];

// --- Second page: seek past the cursor using $or to handle ties on ts ---
const page2 = db.deviceEvents
  .find({
    tenantId: 't-educ',
    $or: [
      { ts: { $lt: cursor.ts } },
      { ts: cursor.ts, _id: { $lt: cursor._id } }
    ]
  })
  .sort({ ts: -1, _id: -1 })
  .limit(50)
  .toArray();


// ─────────────────────────────────────────────────────────────────────────────
// 3) Aggregation: top 5 tags across all Camera products
//    Pipeline: $match → $unwind → $group → $sort → $limit
// ─────────────────────────────────────────────────────────────────────────────
db.products.aggregate([
  { $match: { category: 'Cameras' } },
  { $unwind: '$attributes.tags' },
  { $group: { _id: '$attributes.tags', n: { $sum: 1 } } },
  { $sort:  { n: -1 } },
  { $limit: 5 }
]);


// ─────────────────────────────────────────────────────────────────────────────
// 4) Aggregation: daily event counts for tenant 't-educ' over the last 7 days
//    Pipeline: $match → $project (dateTrunc to day) → $group → $sort
// ─────────────────────────────────────────────────────────────────────────────
const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

db.deviceEvents.aggregate([
  {
    $match: {
      tenantId: 't-educ',
      ts: { $gte: sevenDaysAgo.toISOString() }
    }
  },
  {
    $project: {
      day: {
        $dateTrunc: {
          date: { $dateFromString: { dateString: '$ts' } },
          unit: 'day'
        }
      }
    }
  },
  { $group: { _id: '$day', count: { $sum: 1 } } },
  { $sort:  { _id: 1 } }
]);


// ─────────────────────────────────────────────────────────────────────────────
// 5) Optimistic concurrency: atomically move a PENDING order → PAID
//    Filter matches _id + status + expected version; only updates if all three match.
// ─────────────────────────────────────────────────────────────────────────────
db.orders.findOneAndUpdate(
  {
    _id:     'ord_2026_1010',
    status:  'PENDING',
    version: 1
  },
  {
    $set: { status: 'PAID', paidAt: new Date() },
    $inc: { version: 1 }
  },
  { returnDocument: 'after' }
);


// ─────────────────────────────────────────────────────────────────────────────
// 6) Prefix search: products whose SKU starts with 'SKU-10'
//    Option A – anchored regex 
//    Option B – range trick 
// ─────────────────────────────────────────────────────────────────────────────

// Option A – regex
db.products.find({ sku: /^SKU-10/ });

// Option B – range (avoids regex scan; relies on lexicographic ordering)
db.products.find({ sku: { $gte: 'SKU-10', $lt: 'SKU-11' } });


// ─────────────────────────────────────────────────────────────────────────────
// 7) Partial unique index on email for non-deleted users (soft-delete pattern)
// ─────────────────────────────────────────────────────────────────────────────
db.users.createIndex(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: { $exists: false } }
  }
);


// ─────────────────────────────────────────────────────────────────────────────
// 8) Explain plan: compare query execution with vs. without a supporting index

// --- WITH index ---
const explainWithIndex = db.products
  .find({ category: 'Cameras', brand: 'Contoso' })
  .sort({ price: 1 })
  .explain('executionStats');


print('=== WITH index ===');
print(JSON.stringify({
  nReturned:         explainWithIndex.executionStats.nReturned,
  totalKeysExamined: explainWithIndex.executionStats.totalKeysExamined,
  totalDocsExamined: explainWithIndex.executionStats.totalDocsExamined,
  stage:             explainWithIndex.executionStats.executionStages.stage
}, null, 2));

// --- WITHOUT index: drop it temporarily, re-run, then recreate ---
db.products.dropIndex('tenantId_1_category_1_brand_1_price_1');

const explainNoIndex = db.products
  .find({ category: 'Cameras', brand: 'Contoso' })
  .sort({ price: 1 })
  .explain('executionStats');

print('=== WITHOUT index ===');
print(JSON.stringify({
  nReturned:         explainNoIndex.executionStats.nReturned,
  totalKeysExamined: explainNoIndex.executionStats.totalKeysExamined,
  totalDocsExamined: explainNoIndex.executionStats.totalDocsExamined,
  stage:             explainNoIndex.executionStats.executionStages.stage
}, null, 2));

// Recreate the index
db.products.createIndex({ tenantId: 1, category: 1, brand: 1, price: 1 });


// ─────────────────────────────────────────────────────────────────────────────
// 9) TTL sanity: insert a test document that expires in ~1 minute
//    Requires a TTL index on the expireAt field.
//    MongoDB's TTL monitor runs every 60 s, so actual deletion may take up to
//    ~120 s after expireAt.
// ─────────────────────────────────────────────────────────────────────────────

// Create the TTL index 
db.sessions.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });

// Insert a document set to expire 60 seconds from now
db.sessions.insertOne({
  _id:       'ttl-test-' + Date.now(),
  payload:   'test document for TTL verification',
  createdAt: new Date(),
  expireAt:  new Date(Date.now() + 60 * 1000)   // 1 minute in the future
});

print('TTL test doc inserted – it will be deleted automatically within ~2 minutes.');


// ─────────────────────────────────────────────────────────────────────────────
// 10) Design: shard key proposal for the deviceEvents collection (justifications in README)
//  Recommended shard key:  { tenantId: 1, deviceId: 1, ts: -1 }
