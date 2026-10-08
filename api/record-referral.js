// api/record-referral.js
//
// Resolves a referral code to the referring account and records the credit
// -- a thin service-role bridge the website calls once, right after a new
// signup. The browser's own Supabase session can only ever read its OWN
// profile row under RLS, never look up someone else's by their
// referral_code, so this one narrow lookup has to happen server-side, the
// same "write on behalf of a verified relationship" pattern
// api/telegram-webhook.js already uses for linking codes and storage.
//
// Purely a social/vanity counter for now -- no reward or credit is granted
// -- so the validation here is intentionally light: a self-referral or a
// code that doesn't resolve to anyone just comes back as "not credited"
// rather than erroring the signup the caller is already mid-way through.
// Idempotent by construction (referrals.referred_user_id is unique), so a
// retried or duplicate call never double-credits.

const db = require('../lib/supabase-rest');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { code, referredUserId } = req.body || {};
  if (!code || !referredUserId) {
    res.status(400).json({ error: 'Missing required fields: code, referredUserId.' });
    return;
  }

  try {
    const codeNorm = String(code).trim().toUpperCase();
    if (!codeNorm) {
      res.status(200).json({ ok: true, credited: false, reason: 'no_such_code' });
      return;
    }

    const referrerRows = await db.select('profiles', {
      columns: 'user_id,referral_code',
      filters: ['referral_code=eq.' + encodeURIComponent(codeNorm)],
      limit: 1,
    });
    const referrer = referrerRows && referrerRows[0];
    if (!referrer) {
      res.status(200).json({ ok: true, credited: false, reason: 'no_such_code' });
      return;
    }
    if (referrer.user_id === referredUserId) {
      res.status(200).json({ ok: true, credited: false, reason: 'self_referral' });
      return;
    }

    const existing = await db.select('referrals', {
      columns: 'id',
      filters: ['referred_user_id=eq.' + encodeURIComponent(referredUserId)],
      limit: 1,
    });
    if (existing && existing[0]) {
      res.status(200).json({ ok: true, credited: false, reason: 'already_credited' });
      return;
    }

    await db.insert('referrals', [{
      referrer_user_id: referrer.user_id,
      referred_user_id: referredUserId,
      source: 'website',
    }], { returning: false });

    res.status(200).json({ ok: true, credited: true });
  } catch (e) {
    // A referral not being recorded should never surface as a visible
    // error to someone who just finished signing up -- log it server-side
    // and report success-but-not-credited instead of a 500 the caller has
    // no good way to react to anyway (it already discarded the one-time
    // pending code before this request even went out).
    console.error('record-referral error:', e.message);
    res.status(200).json({ ok: true, credited: false, reason: 'error' });
  }
};
