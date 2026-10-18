// Comprehensive Firestore & Storage Security Rules Suite
// Executed against the Firebase Emulator Suite via @firebase/rules-unit-testing
// Governs: firestore.rules & storage.rules security boundaries

import { test, before, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

const PROJECT_ID = 'micro---volunteer';
let testEnv: RulesTestEnvironment;

// Helper timestamps
const nowTimestamp = new Date();

before(async () => {
  const rulesPath = path.resolve(process.cwd(), '../firestore.rules');
  const rules = fs.readFileSync(rulesPath, 'utf8');

  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

after(async () => {
  await testEnv.cleanup();
});

// ------------------------------------------------------------------
// 1. USERS COLLECTION SECURITY TESTS
// ------------------------------------------------------------------

test('Users Security: owner can create profile with valid keys and consent', async () => {
  const ownerDb = testEnv.authenticatedContext('user-1').firestore();

  await assertSucceeds(
    setDoc(doc(ownerDb, 'users/user-1'), {
      displayName: 'Alice Owner',
      photoURL: 'https://example.com/photo.jpg',
      bio: 'Community volunteer',
      phoneNumber: '+919876543210',
      email: 'alice@example.org',
      roles: ['volunteer'],
      skills: ['gardening'],
      consent: { tcVersion: '1.0', acceptedAt: nowTimestamp },
      createdAt: nowTimestamp,
    }),
  );
});

test('Users Security: client creation fails if server-locked fields are present', async () => {
  const clientDb = testEnv.authenticatedContext('user-hacker').firestore();

  // Attempting to set trustScore or idVerified on create
  await assertFails(
    setDoc(doc(clientDb, 'users/user-hacker'), {
      displayName: 'Hacker',
      phoneNumber: '+919876543210',
      consent: { tcVersion: '1.0', acceptedAt: nowTimestamp },
      createdAt: nowTimestamp,
      trustScore: 100, // SERVER LOCKED
    }),
  );

  await assertFails(
    setDoc(doc(clientDb, 'users/user-hacker'), {
      displayName: 'Hacker',
      phoneNumber: '+919876543210',
      consent: { tcVersion: '1.0', acceptedAt: nowTimestamp },
      createdAt: nowTimestamp,
      idVerified: true, // SERVER LOCKED
    }),
  );
});

test('Users Security: owner can update profile fields but cannot modify server-locked fields', async () => {
  // Seed profile via admin context
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    const adminDb = adminContext.firestore();
    await setDoc(doc(adminDb, 'users/user-2'), {
      displayName: 'Bob',
      trustScore: 50,
      points: 10,
      accountStatus: 'active',
      consent: { tcVersion: '1.0', acceptedAt: nowTimestamp },
      createdAt: nowTimestamp,
    });
  });

  const ownerDb = testEnv.authenticatedContext('user-2').firestore();

  // Legitimate update
  await assertSucceeds(
    updateDoc(doc(ownerDb, 'users/user-2'), {
      displayName: 'Bob Updated',
      availableNow: true,
    }),
  );

  // Attempting to update server-locked fields directly
  await assertFails(
    updateDoc(doc(ownerDb, 'users/user-2'), {
      trustScore: 99,
    }),
  );

  await assertFails(
    updateDoc(doc(ownerDb, 'users/user-2'), {
      points: 500,
    }),
  );

  await assertFails(
    updateDoc(doc(ownerDb, 'users/user-2'), {
      accountStatus: 'banned', // not in allowed update keys
    }),
  );
});

test('Users Security: non-owner and unauthenticated users cannot read/update other user profiles', async () => {
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    await setDoc(doc(adminContext.firestore(), 'users/user-secret'), {
      displayName: 'Secret User',
      phoneNumber: '+919999999999',
    });
  });

  const unauthedDb = testEnv.unauthenticatedContext().firestore();
  const strangerDb = testEnv.authenticatedContext('user-stranger').firestore();

  await assertFails(getDoc(doc(unauthedDb, 'users/user-secret')));
  await assertFails(getDoc(doc(strangerDb, 'users/user-secret')));
  await assertFails(
    updateDoc(doc(strangerDb, 'users/user-secret'), { displayName: 'Hacked' }),
  );
});

test('Users Security: admin user can read any user profile', async () => {
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    await setDoc(doc(adminContext.firestore(), 'users/admin-1'), {
      displayName: 'Admin User',
      isAdmin: true,
    });
    await setDoc(doc(adminContext.firestore(), 'users/target-user'), {
      displayName: 'Target User',
    });
  });

  const adminDb = testEnv.authenticatedContext('admin-1').firestore();
  await assertSucceeds(getDoc(doc(adminDb, 'users/target-user')));
});

// ------------------------------------------------------------------
// 2. TASKS COLLECTION SECURITY TESTS
// ------------------------------------------------------------------

test('Tasks Security: customer can create task with valid schema', async () => {
  const customerDb = testEnv.authenticatedContext('customer-1').firestore();

  await assertSucceeds(
    setDoc(doc(customerDb, 'tasks/task-101'), {
      customerId: 'customer-1',
      customerName: 'Customer One',
      title: 'Water plants in park',
      category: 'gardening',
      requiredSkills: ['buy-groceries'],
      description: {
        meetingPoint: 'Park Main Gate',
        whatToBring: 'Watering can',
      },
      location: { lat: 13.0202, lng: 77.6815, h3Cell: '89618926487ffff' },
      riskLevel: 'low',
      estimatedMinutes: 30,
      status: 'searching',
      searchRadiusM: 2000,
      createdAt: nowTimestamp,
      expiresAt: new Date(Date.now() + 86400 * 1000),
    }),
  );
});

test('Tasks Security: client direct update and delete of tasks are strictly DENIED', async () => {
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    await setDoc(doc(adminContext.firestore(), 'tasks/task-102'), {
      customerId: 'customer-1',
      status: 'searching',
    });
  });

  const customerDb = testEnv.authenticatedContext('customer-1').firestore();
  const volunteerDb = testEnv.authenticatedContext('volunteer-1').firestore();

  // Attempting to change status or assigned volunteer directly
  await assertFails(
    updateDoc(doc(customerDb, 'tasks/task-102'), { status: 'completed' }),
  );
  await assertFails(
    updateDoc(doc(volunteerDb, 'tasks/task-102'), {
      acceptedVolunteerId: 'volunteer-1',
    }),
  );
  await assertFails(deleteDoc(doc(customerDb, 'tasks/task-102')));
});

test('Tasks Security: read access allowed only to customer, assigned volunteer, or admin on active tasks', async () => {
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    const db = adminContext.firestore();
    await setDoc(doc(db, 'users/admin-1'), { isAdmin: true });
    await setDoc(doc(db, 'tasks/task-assigned'), {
      customerId: 'customer-owner',
      acceptedVolunteerId: 'assigned-vol',
      status: 'accepted',
    });
  });

  const ownerDb = testEnv.authenticatedContext('customer-owner').firestore();
  const assignedVolDb = testEnv
    .authenticatedContext('assigned-vol')
    .firestore();
  const strangerDb = testEnv.authenticatedContext('unrelated-vol').firestore();
  const adminDb = testEnv.authenticatedContext('admin-1').firestore();

  await assertSucceeds(getDoc(doc(ownerDb, 'tasks/task-assigned')));
  await assertSucceeds(getDoc(doc(assignedVolDb, 'tasks/task-assigned')));
  await assertSucceeds(getDoc(doc(adminDb, 'tasks/task-assigned')));
  await assertFails(getDoc(doc(strangerDb, 'tasks/task-assigned')));
});

test('Tasks Security: authenticated active volunteer can read open searching tasks, but customer-only or stranger on active task is denied', async () => {
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    const db = adminContext.firestore();
    await setDoc(doc(db, 'users/vol-reader'), {
      accountStatus: 'active',
      roles: ['volunteer'],
    });
    await setDoc(doc(db, 'users/customer-only'), {
      accountStatus: 'active',
      roles: ['customer'],
    });
    await setDoc(doc(db, 'users/vol-suspended'), {
      accountStatus: 'suspended',
      suspendedUntil: new Date(Date.now() + 86400 * 1000),
      roles: ['volunteer'],
    });
    await setDoc(doc(db, 'tasks/task-open-searching'), {
      customerId: 'other-customer',
      title: 'Open grocery run',
      status: 'searching',
    });
  });

  const volDb = testEnv.authenticatedContext('vol-reader').firestore();
  const custDb = testEnv.authenticatedContext('customer-only').firestore();
  const suspendedVolDb = testEnv.authenticatedContext('vol-suspended').firestore();
  const unauthedDb = testEnv.unauthenticatedContext().firestore();

  // Active volunteer can read open searching task
  await assertSucceeds(getDoc(doc(volDb, 'tasks/task-open-searching')));

  // Customer-only user without volunteer role is denied
  await assertFails(getDoc(doc(custDb, 'tasks/task-open-searching')));

  // Suspended volunteer is denied
  await assertFails(getDoc(doc(suspendedVolDb, 'tasks/task-open-searching')));

  // Unauthenticated caller is denied
  await assertFails(getDoc(doc(unauthedDb, 'tasks/task-open-searching')));
});

test('Tasks Security: suspended or banned user cannot create or read active tasks', async () => {
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    const db = adminContext.firestore();
    await setDoc(doc(db, 'users/banned-user'), { accountStatus: 'banned' });
    await setDoc(doc(db, 'tasks/task-103'), {
      customerId: 'banned-user',
      status: 'searching',
    });
  });

  const bannedDb = testEnv.authenticatedContext('banned-user').firestore();

  await assertFails(
    setDoc(doc(bannedDb, 'tasks/task-new'), {
      customerId: 'banned-user',
      customerName: 'Banned User',
      title: 'Task by banned user',
      category: 'errands',
      requiredSkills: ['buy-groceries'],
      description: { meetingPoint: 'Gate' },
      location: { lat: 13.0202, lng: 77.6815, h3Cell: '89618926487ffff' },
      riskLevel: 'low',
      estimatedMinutes: 30,
      status: 'searching',
      searchRadiusM: 2000,
      createdAt: nowTimestamp,
      expiresAt: new Date(Date.now() + 86400 * 1000),
    }),
  );

  await assertFails(getDoc(doc(bannedDb, 'tasks/task-103')));
});

// ------------------------------------------------------------------
// 3. OFFERS SUBCOLLECTION SECURITY TESTS
// ------------------------------------------------------------------

test('Offers Security: client direct creation or update of offers is DENIED', async () => {
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    await setDoc(doc(adminContext.firestore(), 'tasks/task-200'), {
      customerId: 'customer-1',
      status: 'searching',
    });
  });

  const volDb = testEnv.authenticatedContext('volunteer-1').firestore();

  await assertFails(
    setDoc(doc(volDb, 'tasks/task-200/offers/volunteer-1'), {
      volunteerId: 'volunteer-1',
      state: 'offered',
      score: 0.95,
      offeredAt: nowTimestamp,
    }),
  );
});

test('Offers Security: customer can read offers under their own task', async () => {
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    const db = adminContext.firestore();
    await setDoc(doc(db, 'tasks/task-201'), { customerId: 'customer-1' });
    await setDoc(doc(db, 'tasks/task-201/offers/vol-1'), {
      volunteerId: 'vol-1',
      state: 'offered',
    });
  });

  const ownerDb = testEnv.authenticatedContext('customer-1').firestore();
  const strangerDb = testEnv.authenticatedContext('customer-2').firestore();

  await assertSucceeds(getDoc(doc(ownerDb, 'tasks/task-201/offers/vol-1')));
  await assertFails(getDoc(doc(strangerDb, 'tasks/task-201/offers/vol-1')));
});

// ------------------------------------------------------------------
// 4. AUDIT EVENTS SECURITY TESTS
// ------------------------------------------------------------------

test('Events Security: client writes to task events are DENIED', async () => {
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    await setDoc(doc(adminContext.firestore(), 'tasks/task-300'), {
      customerId: 'customer-1',
    });
  });

  const volDb = testEnv.authenticatedContext('volunteer-1').firestore();

  await assertFails(
    setDoc(doc(volDb, 'tasks/task-300/events/event-1'), {
      type: 'accepted',
      actorUid: 'volunteer-1',
      at: nowTimestamp,
    }),
  );
});

test('Events Security: customer and assigned volunteer can read task events; stranger denied', async () => {
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    const db = adminContext.firestore();
    await setDoc(doc(db, 'tasks/task-301'), {
      customerId: 'customer-1',
      acceptedVolunteerId: 'assigned-vol',
    });
    await setDoc(doc(db, 'tasks/task-301/events/evt-1'), {
      type: 'created',
      actorUid: 'customer-1',
    });
  });

  const ownerDb = testEnv.authenticatedContext('customer-1').firestore();
  const volDb = testEnv.authenticatedContext('assigned-vol').firestore();
  const strangerDb = testEnv.authenticatedContext('stranger').firestore();

  await assertSucceeds(getDoc(doc(ownerDb, 'tasks/task-301/events/evt-1')));
  await assertSucceeds(getDoc(doc(volDb, 'tasks/task-301/events/evt-1')));
  await assertFails(getDoc(doc(strangerDb, 'tasks/task-301/events/evt-1')));
});

// ------------------------------------------------------------------
// 5. CHAT & MESSAGES SECURITY TESTS
// ------------------------------------------------------------------

test('Chats Security: client create fails if caller is not a task participant or task status is invalid', async () => {
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    const db = adminContext.firestore();
    await setDoc(doc(db, 'tasks/task-accepted'), {
      customerId: 'customer-1',
      acceptedVolunteerId: 'vol-1',
      status: 'accepted',
    });
    await setDoc(doc(db, 'tasks/task-searching'), {
      customerId: 'customer-1',
      status: 'searching',
    });
  });

  const customerDb = testEnv.authenticatedContext('customer-1').firestore();
  const strangerDb = testEnv.authenticatedContext('stranger-vol').firestore();

  // Valid chat create on accepted task
  await assertSucceeds(
    setDoc(doc(customerDb, 'chats/task-accepted'), {
      taskId: 'task-accepted',
      participants: ['customer-1', 'vol-1'],
      createdAt: nowTimestamp,
      lastMessageAt: nowTimestamp,
      lastMessagePreview: 'Connected',
    }),
  );

  // Stranger attempt DENIED
  await assertFails(
    setDoc(doc(strangerDb, 'chats/task-accepted'), {
      taskId: 'task-accepted',
      participants: ['customer-1', 'stranger-vol'],
      createdAt: nowTimestamp,
      lastMessageAt: nowTimestamp,
      lastMessagePreview: 'Connected',
    }),
  );

  // Chat create on 'searching' task DENIED
  await assertFails(
    setDoc(doc(customerDb, 'chats/task-searching'), {
      taskId: 'task-searching',
      participants: ['customer-1', 'vol-1'],
      createdAt: nowTimestamp,
      lastMessageAt: nowTimestamp,
      lastMessagePreview: 'Connected',
    }),
  );
});

test('Chat Messages Security: participant can send non-system message; messages immutable for clients', async () => {
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    const db = adminContext.firestore();
    await setDoc(doc(db, 'chats/chat-100'), {
      taskId: 'task-100',
      participants: ['customer-1', 'vol-1'],
    });
  });

  const volDb = testEnv.authenticatedContext('vol-1').firestore();

  // Valid message create
  await assertSucceeds(
    setDoc(doc(volDb, 'chats/chat-100/messages/msg-1'), {
      senderUid: 'vol-1',
      text: 'Hello customer!',
      sentAt: nowTimestamp,
      system: false,
    }),
  );

  // Forging system message DENIED
  await assertFails(
    setDoc(doc(volDb, 'chats/chat-100/messages/msg-system-forge'), {
      senderUid: 'vol-1',
      text: 'System message',
      sentAt: nowTimestamp,
      system: true, // CLIENT CANNOT SET system: true
    }),
  );

  // Message update or delete DENIED
  await assertFails(
    updateDoc(doc(volDb, 'chats/chat-100/messages/msg-1'), { text: 'Edited' }),
  );
  await assertFails(deleteDoc(doc(volDb, 'chats/chat-100/messages/msg-1')));
});

test('Chat Messages Security: message creation DENIED if mutual block document exists', async () => {
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    const db = adminContext.firestore();
    await setDoc(doc(db, 'chats/chat-blocked'), {
      taskId: 'chat-blocked',
      participants: ['customer-1', 'vol-blocked'],
    });
    // Mutual block doc created at blocks/customer-1_vol-blocked or vice versa
    await setDoc(doc(db, 'blocks/customer-1_vol-blocked'), {
      userA: 'customer-1',
      userB: 'vol-blocked',
      blockedBy: 'customer-1',
    });
  });

  const volDb = testEnv.authenticatedContext('vol-blocked').firestore();
  const customerDb = testEnv.authenticatedContext('customer-1').firestore();

  await assertFails(
    setDoc(doc(volDb, 'chats/chat-blocked/messages/msg-fail'), {
      senderUid: 'vol-blocked',
      text: 'Blocked message',
      sentAt: nowTimestamp,
      system: false,
    }),
  );

  await assertFails(
    setDoc(doc(customerDb, 'chats/chat-blocked/messages/msg-fail-2'), {
      senderUid: 'customer-1',
      text: 'Blocked message 2',
      sentAt: nowTimestamp,
      system: false,
    }),
  );
});

// ------------------------------------------------------------------
// 6. REPORTS / ADMIN ACTIONS / ACTIVITY LOG SECURITY TESTS
// ------------------------------------------------------------------

test('Reports & Moderation Security: direct client create of reports or adminActions DENIED', async () => {
  const clientDb = testEnv.authenticatedContext('user-1').firestore();

  await assertFails(
    setDoc(doc(clientDb, 'reports/report-1'), {
      reporterUid: 'user-1',
      reportedUid: 'user-2',
      reason: 'safety',
      details: 'Abusive behavior',
    }),
  );

  await assertFails(
    setDoc(doc(clientDb, 'adminActions/act-1'), {
      adminUid: 'user-1',
      targetUid: 'user-2',
      action: 'ban',
    }),
  );
});

test('Activity Log Security: non-admin read DENIED; all client writes DENIED', async () => {
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    const db = adminContext.firestore();
    await setDoc(doc(db, 'users/admin-1'), { isAdmin: true });
    await setDoc(doc(db, 'activityLog/entry-1'), {
      eventType: 'task_created',
      description: 'Task created by User A',
      userId: 'user-1',
      createdAt: nowTimestamp,
    });
  });

  const userDb = testEnv.authenticatedContext('user-1').firestore();
  const adminDb = testEnv.authenticatedContext('admin-1').firestore();

  // Non-admin read DENIED
  await assertFails(getDoc(doc(userDb, 'activityLog/entry-1')));

  // Admin read ALLOWED
  await assertSucceeds(getDoc(doc(adminDb, 'activityLog/entry-1')));

  // Client write DENIED for everyone (including admin)
  await assertFails(
    setDoc(doc(adminDb, 'activityLog/entry-hacked'), {
      eventType: 'hack',
      description: 'Hacked entry',
    }),
  );
});
