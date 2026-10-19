import './helpers/env.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { startHarness, provisionPlatform } from './helpers/harness.js';
import { alphaIntegration, ALPHA } from './fixtures/mockPlatformApi.js';
import { userRepository } from '../src/repositories/userRepository.js';
import { accessRepository } from '../src/repositories/accessRepository.js';

const FROM = '2026-09-01';
const TO = '2026-09-14';
const ALPHA_MODULES = ['overview', 'settlement', 'revenue', 'subscribers', 'subscriber_records', 'renewals', 'churn'];

let h;
let rootToken;
let alpha;

before(async () => {
  h = await startHarness();
  rootToken = (await h.login()).body.data.token;
  alpha = await provisionPlatform(h, rootToken, {
    code: 'ALPHA_WINDOW_TEST',
    name: 'Alpha Window Test',
    integration: alphaIntegration(),
    secrets: { username: ALPHA.email, password: ALPHA.password },
    modules: ALPHA_MODULES,
    from: FROM,
    to: TO
  });
});

after(async () => {
  await h.close();
});

describe('User Access Window & Permanent Deletion', () => {
  test('Super Admin creates user with start and end dates', async () => {
    const startStr = '2026-10-01T00:00:00.000Z';
    const endStr = '2026-10-31T23:59:59.999Z';

    const res = await h.request('POST', '/users', {
      token: rootToken,
      body: {
        name: 'Window Operator',
        email: 'window.operator@example.test',
        username: 'window_op',
        password: 'Password@12345',
        access_start_date: startStr,
        access_end_date: endStr,
        platform_assignments: [{
          platform_id: alpha.id,
          role_id: 2, // Platform Admin / Analyst / Viewer
          start_date: startStr,
          end_date: endStr,
          status: 'ACTIVE'
        }]
      }
    });

    assert.equal(res.status, 201);
    assert.ok(res.body.data.access_start_date);
    assert.ok(res.body.data.access_end_date);
  });

  test('User cannot sign in BEFORE starting date', async () => {
    const futureStart = new Date(Date.now() + 5 * 86400000).toISOString();
    const futureEnd = new Date(Date.now() + 30 * 86400000).toISOString();

    await h.request('POST', '/users', {
      token: rootToken,
      body: {
        name: 'Future Operator',
        email: 'future.op@example.test',
        username: 'future_op',
        password: 'Password@12345',
        access_start_date: futureStart,
        access_end_date: futureEnd,
        platform_assignments: [{
          platform_id: alpha.id,
          role_id: 3,
          start_date: futureStart,
          end_date: futureEnd,
          status: 'ACTIVE'
        }]
      }
    });

    const loginRes = await h.login('future_op', 'Password@12345');
    assert.equal(loginRes.status, 403);
    assert.equal(loginRes.body.code, 'ACCOUNT_NOT_STARTED');
  });

  test('User cannot see data prior to their start date', async () => {
    // User whose access started on 2026-09-08
    const userStart = '2026-09-08T00:00:00.000Z';
    const userEnd = '2026-11-30T23:59:59.999Z';

    const created = await h.request('POST', '/users', {
      token: rootToken,
      body: {
        name: 'September Operator',
        email: 'sept.op@example.test',
        username: 'sept_op',
        password: 'Password@12345',
        access_start_date: userStart,
        access_end_date: userEnd,
        platform_assignments: [{
          platform_id: alpha.id,
          role_id: 3,
          start_date: userStart,
          end_date: userEnd,
          status: 'ACTIVE'
        }]
      }
    });
    assert.equal(created.status, 201);

    const loginRes = await h.login('sept_op', 'Password@12345');
    assert.equal(loginRes.status, 200);
    const token = loginRes.body.data.token;

    // Request date range entirely before user's start date (2026-09-01 to 2026-09-05)
    const earlyRes = await h.request('GET', '/reports/overview?range=custom&from=2026-09-01&to=2026-09-05', {
      token,
      headers: { 'x-platform-code': 'ALPHA_WINDOW_TEST' }
    });
    assert.equal(earlyRes.status, 200);
    // Trends series should be empty
    assert.equal(earlyRes.body.data.trends.series.length, 0);

    // Request spanning across the start date (2026-09-01 to 2026-09-12)
    const spanRes = await h.request('GET', '/reports/overview?range=custom&from=2026-09-01&to=2026-09-12', {
      token,
      headers: { 'x-platform-code': 'ALPHA_WINDOW_TEST' }
    });
    assert.equal(spanRes.status, 200);
    // Every returned date in trends must be >= userStart day (2026-09-08)
    for (const point of spanRes.body.data.trends.series) {
      assert.ok(point.date >= '2026-09-08', `Returned date ${point.date} must be on or after user start date 2026-09-08`);
    }
  });

  test('Expired user is permanently deleted on sign in and cannot log in again', async () => {
    // Create user whose access ended yesterday
    const pastStart = new Date(Date.now() - 10 * 86400000).toISOString();
    const pastEnd = new Date(Date.now() - 1 * 86400000).toISOString();

    const created = await h.request('POST', '/users', {
      token: rootToken,
      body: {
        name: 'Expired Operator',
        email: 'expired.op@example.test',
        username: 'expired_op',
        password: 'Password@12345',
        access_start_date: pastStart,
        access_end_date: pastEnd,
        platform_assignments: [{
          platform_id: alpha.id,
          role_id: 3,
          start_date: pastStart,
          end_date: pastEnd,
          status: 'ACTIVE'
        }]
      }
    });
    assert.equal(created.status, 201);
    const userId = created.body.data.id;

    // Login attempt triggers immediate deletion
    const loginRes = await h.login('expired_op', 'Password@12345');
    assert.equal(loginRes.status, 403);
    assert.equal(loginRes.body.code, 'ACCOUNT_EXPIRED');

    // Verify user record is completely gone from repository / DB
    const fetched = await userRepository.findById(userId);
    assert.equal(fetched, null, 'Expired user must be permanently purged from database');

    // Second login attempt fails with invalid credentials (user no longer exists)
    const secondLogin = await h.login('expired_op', 'Password@12345');
    assert.equal(secondLogin.status, 401);
  });

  test('cleanupExpiredUsers() purges expired non-super-admin accounts', async () => {
    const pastStart = new Date(Date.now() - 20 * 86400000).toISOString();
    const pastEnd = new Date(Date.now() - 2 * 86400000).toISOString();

    const created = await h.request('POST', '/users', {
      token: rootToken,
      body: {
        name: 'Auto Purge User',
        email: 'autopurge@example.test',
        username: 'autopurge',
        password: 'Password@12345',
        access_start_date: pastStart,
        access_end_date: pastEnd,
        platform_assignments: [{
          platform_id: alpha.id,
          role_id: 3,
          start_date: pastStart,
          end_date: pastEnd,
          status: 'ACTIVE'
        }]
      }
    });
    assert.equal(created.status, 201);
    const userId = created.body.data.id;

    // Run cleanupExpiredUsers
    const purged = await userRepository.cleanupExpiredUsers();
    assert.ok(purged.some(u => u.username === 'autopurge'), 'User should be purged by cleanup job');

    // Verify not in database
    const fetched = await userRepository.findById(userId);
    assert.equal(fetched, null);
  });
});
