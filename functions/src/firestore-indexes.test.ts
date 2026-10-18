import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface IndexField {
  fieldPath: string;
  order?: 'ASCENDING' | 'DESCENDING';
  arrayConfig?: 'CONTAINS';
}

interface IndexDefinition {
  collectionGroup: string;
  queryScope: 'COLLECTION' | 'COLLECTION_GROUP';
  fields: IndexField[];
}

interface FirestoreIndexesConfig {
  indexes: IndexDefinition[];
  fieldOverrides?: unknown[];
}

function loadIndexes(): FirestoreIndexesConfig {
  const filePath = join(__dirname, '../../firestore.indexes.json');
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as FirestoreIndexesConfig;
}

function findIndex(
  config: FirestoreIndexesConfig,
  collectionGroup: string,
  queryScope: 'COLLECTION' | 'COLLECTION_GROUP',
  fields: Array<{ fieldPath: string; order?: 'ASCENDING' | 'DESCENDING' }>,
): IndexDefinition | undefined {
  return config.indexes.find((idx) => {
    if (idx.collectionGroup !== collectionGroup || idx.queryScope !== queryScope) {
      return false;
    }
    if (idx.fields.length !== fields.length) {
      return false;
    }
    return idx.fields.every(
      (f, i) =>
        f.fieldPath === fields[i]?.fieldPath &&
        (f.order ?? 'ASCENDING') === (fields[i]?.order ?? 'ASCENDING'),
    );
  });
}

test('firestore.indexes.json: contains valid schema and no duplicate definitions', () => {
  const config = loadIndexes();
  assert.ok(Array.isArray(config.indexes), 'Indexes must be an array');
  assert.ok(config.indexes.length >= 12, 'Expected at least 12 composite indexes');

  const seen = new Set<string>();
  for (const idx of config.indexes) {
    const key = `${idx.queryScope}:${idx.collectionGroup}:${idx.fields
      .map((f) => `${f.fieldPath}:${f.order ?? 'ASC'}`)
      .join(',')}`;
    assert.ok(!seen.has(key), `Duplicate index definition detected: ${key}`);
    seen.add(key);

    assert.ok(
      ['COLLECTION', 'COLLECTION_GROUP'].includes(idx.queryScope),
      `Invalid queryScope: ${idx.queryScope}`,
    );
    assert.ok(idx.fields.length >= 2, 'Composite index must have at least 2 fields');
    for (const field of idx.fields) {
      assert.ok(field.fieldPath, 'Field must have a fieldPath');
      if (field.order) {
        assert.ok(
          ['ASCENDING', 'DESCENDING'].includes(field.order),
          `Invalid order: ${field.order}`,
        );
      }
    }
  }
});

// 1. Scheduled Task Activation
test('Index Verification: activateScheduledTasks sweep query', () => {
  const config = loadIndexes();
  // Query: db.collection('tasks').where('status', '==', 'scheduled').where('scheduledFor', '<=', nowTimestamp)
  const idx = findIndex(config, 'tasks', 'COLLECTION', [
    { fieldPath: 'status', order: 'ASCENDING' },
    { fieldPath: 'scheduledFor', order: 'ASCENDING' },
  ]);
  assert.ok(idx, 'Missing composite index for activateScheduledTasks (status ASC, scheduledFor ASC)');
});

// 2. Periodic Redispatch Offers
test('Index Verification: periodicRedispatchOffers check query', () => {
  const config = loadIndexes();
  // Query: db.collection('tasks').where('status', '==', 'searching').where('nextCheckAt', '<=', nowTimestamp)
  const idx = findIndex(config, 'tasks', 'COLLECTION', [
    { fieldPath: 'status', order: 'ASCENDING' },
    { fieldPath: 'nextCheckAt', order: 'ASCENDING' },
  ]);
  assert.ok(idx, 'Missing composite index for periodicRedispatchOffers (status ASC, nextCheckAt ASC)');
});

// 3. Customer Dashboard & MyTasksList Task Loading
test('Index Verification: CustomerDashboard & MyTasksList query', () => {
  const config = loadIndexes();
  // Query: collection('tasks').where('customerId', '==', uid).orderBy('createdAt', 'desc')
  const idx = findIndex(config, 'tasks', 'COLLECTION', [
    { fieldPath: 'customerId', order: 'ASCENDING' },
    { fieldPath: 'createdAt', order: 'DESCENDING' },
  ]);
  assert.ok(idx, 'Missing composite index for CustomerDashboard (customerId ASC, createdAt DESC)');
});

// 4. Volunteer Accepted Tasks Loading
test('Index Verification: VolunteerDashboard & AcceptedTasksList query', () => {
  const config = loadIndexes();
  // Query: collection('tasks').where('acceptedVolunteerId', '==', uid).orderBy('acceptedAt', 'desc')
  const idx = findIndex(config, 'tasks', 'COLLECTION', [
    { fieldPath: 'acceptedVolunteerId', order: 'ASCENDING' },
    { fieldPath: 'acceptedAt', order: 'DESCENDING' },
  ]);
  assert.ok(idx, 'Missing composite index for AcceptedTasksList (acceptedVolunteerId ASC, acceptedAt DESC)');
});

// 5. Volunteer Nearby Open Tasks Loading
test('Index Verification: VolunteerDashboard nearby open tasks query', () => {
  const config = loadIndexes();
  // Query: collection('tasks').where('status', '==', 'searching').orderBy('createdAt', 'desc')
  const idx = findIndex(config, 'tasks', 'COLLECTION', [
    { fieldPath: 'status', order: 'ASCENDING' },
    { fieldPath: 'createdAt', order: 'DESCENDING' },
  ]);
  assert.ok(idx, 'Missing composite index for open tasks (status ASC, createdAt DESC)');
});

// 6. Cross-Role Awareness & Moderation Action (Volunteer Active Tasks)
test('Index Verification: CrossRoleBanner & applyModerationAction (Volunteer Active Tasks)', () => {
  const config = loadIndexes();
  // Query: collection('tasks').where('acceptedVolunteerId', '==', uid).where('status', 'in', ['accepted', 'in_progress'])
  const idx = findIndex(config, 'tasks', 'COLLECTION', [
    { fieldPath: 'acceptedVolunteerId', order: 'ASCENDING' },
    { fieldPath: 'status', order: 'ASCENDING' },
  ]);
  assert.ok(
    idx,
    'Missing composite index for active volunteer tasks (acceptedVolunteerId ASC, status ASC)',
  );
});

// 7. Cross-Role Awareness & Moderation Action (Customer Active Tasks)
test('Index Verification: CrossRoleBanner & applyModerationAction (Customer Active Tasks)', () => {
  const config = loadIndexes();
  // Query: collection('tasks').where('customerId', '==', uid).where('status', 'in', ['searching', 'accepted', 'in_progress'])
  const idx = findIndex(config, 'tasks', 'COLLECTION', [
    { fieldPath: 'customerId', order: 'ASCENDING' },
    { fieldPath: 'status', order: 'ASCENDING' },
  ]);
  assert.ok(
    idx,
    'Missing composite index for active customer tasks (customerId ASC, status ASC)',
  );
});

// 8. Offer Inbox & Volunteer Dashboard Offers (Collection Group)
test('Index Verification: OfferInbox collectionGroup query', () => {
  const config = loadIndexes();
  // Query: collectionGroup('offers').where('volunteerId', '==', uid).where('state', '==', 'offered').orderBy('offeredAt', 'desc')
  const idx = findIndex(config, 'offers', 'COLLECTION_GROUP', [
    { fieldPath: 'volunteerId', order: 'ASCENDING' },
    { fieldPath: 'state', order: 'ASCENDING' },
    { fieldPath: 'offeredAt', order: 'DESCENDING' },
  ]);
  assert.ok(
    idx,
    'Missing COLLECTION_GROUP index for offers (volunteerId ASC, state ASC, offeredAt DESC)',
  );
});

// 9. Admin Dashboard Reports Feed
test('Index Verification: AdminDashboard pending reports query', () => {
  const config = loadIndexes();
  // Query: collection('reports').where('status', '==', 'pending').orderBy('createdAt', 'desc')
  const idx = findIndex(config, 'reports', 'COLLECTION', [
    { fieldPath: 'status', order: 'ASCENDING' },
    { fieldPath: 'createdAt', order: 'DESCENDING' },
  ]);
  assert.ok(idx, 'Missing composite index for reports (status ASC, createdAt DESC)');
});

// 10. Duplicate & Sibling Reports Prevention
test('Index Verification: reportUser duplicate and sibling prevention queries', () => {
  const config = loadIndexes();
  // Query 1: reports.where('reporterUid', '==', id).where('reportedUid', '==', id).where('taskId', '==', id)
  const idx1 = findIndex(config, 'reports', 'COLLECTION', [
    { fieldPath: 'reportedUid', order: 'ASCENDING' },
    { fieldPath: 'taskId', order: 'ASCENDING' },
    { fieldPath: 'reporterUid', order: 'ASCENDING' },
  ]);
  assert.ok(idx1, 'Missing composite index for reports duplicate lookup');

  // Query 2: reports.where('reportedUid', '==', id).where('taskId', '==', id)
  const idx2 = findIndex(config, 'reports', 'COLLECTION', [
    { fieldPath: 'reportedUid', order: 'ASCENDING' },
    { fieldPath: 'taskId', order: 'ASCENDING' },
  ]);
  assert.ok(idx2, 'Missing composite index for reports sibling lookup');
});

// 11. Admin Dashboard Activity Log Filtering
test('Index Verification: AdminDashboard filtered activityLog query', () => {
  const config = loadIndexes();
  // Query: collection('activityLog').where('eventType', '==', filter).orderBy('createdAt', 'desc')
  const idx = findIndex(config, 'activityLog', 'COLLECTION', [
    { fieldPath: 'eventType', order: 'ASCENDING' },
    { fieldPath: 'createdAt', order: 'DESCENDING' },
  ]);
  assert.ok(idx, 'Missing composite index for activityLog (eventType ASC, createdAt DESC)');
});
