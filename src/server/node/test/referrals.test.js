import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAppCta, isBot, visitorKey, REFERRAL_APPS } from '../referrals.js';

test('link-preview bots and scripts never count', () => {
  for (const ua of [
    'facebookexternalhit/1.1 Facebot Twitterbot/1.0', // iMessage previews
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'WhatsApp/2.23.20.0',
    'TelegramBot (like TwitterBot)',
    'Mozilla/5.0 (compatible; Discordbot/2.0)',
    'curl/8.4.0',
    '',
    undefined,
  ]) {
    assert.ok(isBot(ua), `${ua} should be a bot`);
  }
  assert.ok(!isBot('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'));
});

test('visitor keys are stable within a day and never the raw IP', () => {
  const a = visitorKey('salt', '203.0.113.9', 'UA', 'card', '2026-10-01');
  assert.equal(a, visitorKey('salt', '203.0.113.9', 'UA', 'card', '2026-10-01'));
  assert.notEqual(a, visitorKey('salt', '203.0.113.9', 'UA', 'card', '2026-10-02'));
  assert.ok(!a.includes('203'));
});

test('redirects only to the two App Store listings', () => {
  assert.deepEqual([...new Set(Object.values(REFERRAL_APPS).map((a) => a.storeUrl))], [
    'https://apps.apple.com/app/id6808065888',
    'https://apps.apple.com/app/id6808065892',
  ]);
});

test('"make your own" only on ordinary cards, and only when switched on', () => {
  assert.deepEqual(getAppCta('bizbuz-card', '/r/x', true), { label: 'Make your own card with BizBuz', href: '/r/x' });
  assert.equal(getAppCta('linkitylink-card', '/r/x', true).label, 'Make your own link page with Linkitylink');
  assert.equal(getAppCta('bizbuz-card', '/r/x', false), null, 'off unless SAVAGE_GET_APP_CTA=on');
  assert.equal(getAppCta('bizbuz-referral', '/r/x', true), null, 'an invite card is already the button');
  assert.equal(getAppCta('someone-elses-hash', '/r/x', true), null);
});
