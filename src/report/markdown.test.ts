import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ScenarioReport } from '../engine/run.ts';
import type { SuiteReport } from '../engine/suite.ts';
import { COMMENT_MARKER, formatMarkdown } from './markdown.ts';

function scenario(partial: Partial<ScenarioReport>): ScenarioReport {
  return {
    scenarioId: 'journey',
    title: 'A journey',
    platform: 'web',
    status: 'passed',
    steps: [],
    captures: {},
    heals: [],
    healCount: 0,
    startedAt: '2026-08-01T10:00:00Z',
    durationMs: 1200,
    ...partial,
  };
}

function suite(entries: SuiteReport['entries'], status: SuiteReport['status']): SuiteReport {
  return { status, entries, durationMs: 2000 };
}

describe('markdown report', () => {
  it('starts with the marker that lets the comment be updated', () => {
    const markdown = formatMarkdown(suite([], 'passed'));
    assert.ok(markdown.startsWith(COMMENT_MARKER), 'without the marker, CI would stack one comment per run');
  });

  it('does not expand the detail of green journeys', () => {
    const markdown = formatMarkdown(
      suite(
        [
          {
            scenarioId: 'checkout',
            resolutionPath: 'r.json',
            report: scenario({
              steps: [
                { stepId: 's1', intent: 'open', status: 'passed', failures: [], durationMs: 10 },
              ],
            }),
          },
        ],
        'passed',
      ),
    );

    assert.match(markdown, /✅ QAI/);
    assert.match(markdown, /\| `checkout` \| passed \|/);
    assert.doesNotMatch(markdown, /### `checkout`/, 'a green journey has no detail section');
  });

  it('surfaces a warning carried by a green journey', () => {
    // A watchdog set to "warn" reports without failing, so the step stays
    // green and the journey stays green. Skipping green detail therefore hid
    // every warning the level can produce, and the documented warn → fail
    // ramp could not be walked from the pull request comment at all.
    const markdown = formatMarkdown(
      suite(
        [
          {
            scenarioId: 'checkout',
            resolutionPath: 'r.json',
            report: scenario({
              steps: [
                {
                  stepId: 's4',
                  intent: 'open the cart',
                  status: 'passed',
                  failures: [],
                  warnings: ['2 failed request(s), including GET /api/reco → 500'],
                  durationMs: 12,
                },
              ],
            }),
          },
        ],
        'passed',
      ),
    );

    assert.match(markdown, /⚠️ QAI — green, with warnings/, 'the title is what most reviewers read');
    assert.match(markdown, /### `checkout`/);
    assert.match(markdown, /⚠️ 2 failed request\(s\), including GET \/api\/reco → 500/);
    assert.match(markdown, /1 warning\(s\) from watchdogs set to `warn`/);
    assert.match(markdown, /Raise them to `fail` once the list is empty/);
  });

  it('details a failure, with the assertion and the screenshot', () => {
    const markdown = formatMarkdown(
      suite(
        [
          {
            scenarioId: 'checkout',
            resolutionPath: 'r.json',
            report: scenario({
              status: 'failed',
              steps: [
                {
                  stepId: 's8',
                  intent: 'pay',
                  status: 'failed',
                  failures: [{ assertion: 'the order is confirmed', reason: 'no element' }],
                  screenshot: 'checkout-s8.png',
                  durationMs: 40,
                },
              ],
            }),
          },
        ],
        'failed',
      ),
      { runUrl: 'https://ci.example/run/7', artifactName: 'qai-captures' },
    );

    assert.match(markdown, /❌ QAI — regression detected/);
    assert.match(markdown, /### `checkout`/);
    assert.match(markdown, /`the order is confirmed` → no element/);
    assert.match(markdown, /\[screenshot at the moment of failure[^\]]*\]\(https:\/\/ci\.example\/run\/7\)/);
    assert.match(markdown, /an application regression, not a stale test/);
  });

  it('reports a repair and asks to review the diff', () => {
    const markdown = formatMarkdown(
      suite(
        [
          {
            scenarioId: 'checkout',
            resolutionPath: 'r.json',
            report: scenario({
              status: 'healed',
              healCount: 1,
              steps: [
                {
                  stepId: 's6',
                  intent: 'order',
                  status: 'healed',
                  failures: [],
                  healNotes: ['The button label changed.'],
                  durationMs: 30,
                },
              ],
            }),
          },
        ],
        'healed',
      ),
    );

    assert.match(markdown, /🟠 QAI — healed/);
    assert.match(markdown, /healed: The button label changed\./);
    assert.match(markdown, /review the diff before merging/);
  });

  it('reports an execution error without a journey report', () => {
    const markdown = formatMarkdown(
      suite(
        [{ scenarioId: 'checkout', resolutionPath: 'r.json', report: null, error: 'browser unreachable' }],
        'failed',
      ),
    );

    assert.match(markdown, /execution error/);
    assert.match(markdown, /browser unreachable/);
  });
});
