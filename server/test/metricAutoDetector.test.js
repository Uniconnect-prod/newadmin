import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFieldMappings, evaluateMetricMappings, DASHBOARD_METRICS, executeHealthCheck } from '../src/integrations/metricAutoDetector.js';

test('Metric Auto-Detector', async (t) => {
  await t.test('detects standard camelCase and snake_case metrics at root level', () => {
    const json = {
      totalSubscribers: 15420,
      dailySubscribers: 230,
      durationSubscribers: 14800,
      churnSubscribers: 45,
      renewals: 120,
      monthlyIncome: 75000.50
    };

    const result = detectFieldMappings(json);
    assert.equal(result.detectedMappings.totalSubscribers, 'totalSubscribers');
    assert.equal(result.detectedMappings.dailySubscribers, 'dailySubscribers');
    assert.equal(result.detectedMappings.durationSubscribers, 'durationSubscribers');
    assert.equal(result.detectedMappings.churnSubscribers, 'churnSubscribers');
    assert.equal(result.detectedMappings.renewals, 'renewals');
    assert.equal(result.detectedMappings.monthlyIncome, 'monthlyIncome');
    assert.equal(result.detectedCount, 6);
    assert.equal(result.warnings.length, 0);
  });

  await t.test('detects nested metrics inside data / result envelopes', () => {
    const json = {
      status: 'success',
      data: {
        summary: {
          total_subscribers: 50000,
          new_subscribers: 1200,
          active_duration_subscribers: 48000,
          deactivations: 150,
          renewal_count: 3400,
          total_revenue: 125000
        }
      }
    };

    const result = detectFieldMappings(json);
    assert.equal(result.detectedMappings.totalSubscribers, 'data.summary.total_subscribers');
    assert.equal(result.detectedMappings.dailySubscribers, 'data.summary.new_subscribers');
    assert.equal(result.detectedMappings.durationSubscribers, 'data.summary.active_duration_subscribers');
    assert.equal(result.detectedMappings.churnSubscribers, 'data.summary.deactivations');
    assert.equal(result.detectedMappings.renewals, 'data.summary.renewal_count');
    assert.equal(result.detectedMappings.monthlyIncome, 'data.summary.total_revenue');
  });

  await t.test('evaluates dot-notation mappings against JSON and parses numbers', () => {
    const json = {
      data: {
        subscribers: {
          total: '25,400',
          today: '350'
        },
        financials: {
          income: 18500.75
        }
      }
    };

    const mappings = {
      totalSubscribers: 'data.subscribers.total',
      dailySubscribers: 'data.subscribers.today',
      monthlyIncome: 'data.financials.income'
    };

    const evaluated = evaluateMetricMappings(json, mappings);
    assert.equal(evaluated.totalSubscribers.valid, true);
    assert.equal(evaluated.totalSubscribers.value, 25400);
    assert.equal(evaluated.dailySubscribers.valid, true);
    assert.equal(evaluated.dailySubscribers.value, 350);
    assert.equal(evaluated.monthlyIncome.valid, true);
    assert.equal(evaluated.monthlyIncome.value, 18500.75);
    assert.equal(evaluated.churnSubscribers.configured, false);
  });

  await t.test('flags unmapped or missing paths with descriptive errors', () => {
    const json = {
      data: {
        total: 100
      }
    };

    const mappings = {
      totalSubscribers: 'data.nonexistent_field'
    };

    const evaluated = evaluateMetricMappings(json, mappings);
    assert.equal(evaluated.totalSubscribers.valid, false);
    assert.match(evaluated.totalSubscribers.error, /not found in response/i);
  });

  await t.test('flags non-numeric paths with type error', () => {
    const json = {
      data: {
        user_name: 'John Doe'
      }
    };

    const mappings = {
      totalSubscribers: 'data.user_name'
    };

    const evaluated = evaluateMetricMappings(json, mappings);
    assert.equal(evaluated.totalSubscribers.valid, false);
    assert.match(evaluated.totalSubscribers.error, /Expected numeric value/);
  });

  await t.test('warns when field detection encounters ambiguity', () => {
    const json = {
      summary: {
        subscribers: 100
      },
      stats: {
        subscribers: 200
      }
    };

    const result = detectFieldMappings(json);
    // Multiple paths match subscribers with different values
    assert.ok(result.warnings.length > 0);
    assert.match(result.warnings[0].message, /Multiple distinct candidate fields/);
  });
});
