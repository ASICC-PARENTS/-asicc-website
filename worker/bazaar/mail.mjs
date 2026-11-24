import { randomUUID } from 'node:crypto';

const minute = 60_000;
const reminderTypes = new Set(['reminder3', 'reminderFinal']);
const paris = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
const quotaDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
const iso = time => new Date(time).toISOString();
const isTestAddress = address => typeof address === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
export const mailFields = () => ({ dueAt: iso(Date.now()), status: 'queued', providerKey: randomUUID() });

export function createMail(env, db, send = fetch) {
  const outbox = db.collection('bazaarOutbox');
  const provider = env.MAIL_PROVIDER;
  const isCapture = env.MAIL_MODE === 'capture' && env.BAZAAR_MODE !== 'production';
  const testRecipient = env.TEST_MAIL_TO;
  const key = env.BAZAAR_MAIL_API_KEY;
  const from = env.BAZAAR_MAIL_FROM;
  const canSend = () => isCapture || (env.MAIL_MODE === 'api' && ['resend', 'brevo'].includes(provider) && !!key && isTestAddress(from)
    && (env.BAZAAR_MODE === 'production' || isTestAddress(testRecipient)));

  function scheduleReminders(tx, order) {
    const created = Date.parse(order.createdAt);
    const cutoff = Date.parse(order.eventSnapshot?.orderCutoff);
    tx.create(outbox.doc(`${order.id}_reminder3`), {
      ...mailFields(), createdAt: order.createdAt, orderId: order.id, type: 'reminder3', dueAt: iso(created + 180 * minute)
    });
    tx.create(outbox.doc(`${order.id}_reminderFinal`), {
      ...mailFields(), createdAt: order.createdAt, orderId: order.id, type: 'reminderFinal',
      dueAt: iso(Math.max(created + 180 * minute, Number.isFinite(cutoff) ? cutoff : created))
    });
  }

  function nextReminder(job, order, event, time) {
    const cutoff = Date.parse(event?.transferCutoff);
    if (!event || event.eventId !== order.eventId || order.transferReportedAt || order.bankConfirmedAt
      || order.canceledAt || !Number.isFinite(cutoff) || time >= cutoff) return null;
    const earliest = job.type === 'reminderFinal'
      ? Math.max(Date.parse(event.orderCutoff), (Date.parse(order.reminder3At) || 0) + 180 * minute)
      : Date.parse(order.createdAt) + 180 * minute;
    if (!Number.isFinite(earliest)) return null;
    const eligible = at => {
      const parts = Object.fromEntries(paris.formatToParts(at).map(part => [part.type, part.value]));
      const hour = Number(parts.hour);
      return hour < 20 && (job.type === 'reminder3' ? hour >= 9 : parts.weekday === 'Fri' && hour >= 15);
    };
    if (time >= earliest && eligible(time)) return time;
    let next = Math.max(time + 15 * minute, earliest);
    for (let step = 0; step < 24 * 8 && next < cutoff; step++, next += 60 * minute) {
      if (eligible(next)) return next;
    }
    return null;
  }

  async function providerSend(job, payload) {
    if (isCapture) return { ok: true, id: 'captured' };
    const to = env.BAZAAR_MODE === 'production' ? payload.to : testRecipient;
    const common = { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000) };
    const response = provider === 'resend'
      ? await send('https://api.resend.com/emails', {
        ...common, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
          'Idempotency-Key': job.providerKey },
        body: JSON.stringify({ ...payload, to: [to], from: `ASICC <${from}>` })
      })
      : await send('https://api.brevo.com/v3/smtp/email', {
        ...common, headers: { 'api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: { name: 'ASICC', email: from },
          headers: { idempotencyKey: job.providerKey }, subject: payload.subject,
          htmlContent: payload.html, textContent: payload.text, messageVersions: [{ to: [{ email: to }] }] })
      });
    const result = await response.json().catch(() => ({}));
    if (response.ok) return { ok: true, id: result.id ?? result.messageId ?? result.messageIds?.[0] ?? 'accepted' };
    if (provider === 'brevo' && result.code === 'duplicate_parameter') return { ok: true, id: 'deduplicated' };
    if (response.status === 429 || response.status === 402) {
      const hint = response.headers.get('Retry-After');
      const wait = Number(hint) * 1000 || Date.parse(hint) - Date.now() || 0;
      return { retry: Math.max(15 * minute, Math.min(24 * 60 * minute, wait)), code: 'provider-limit' };
    }
    if (response.status >= 500 || response.status === 408 || response.status === 409) return { uncertain: true };
    return { code: 'provider-rejected' };
  }

  async function deliver(mailId, message) {
    if (!canSend()) return false;
    const ref = outbox.doc(mailId);
    const time = Date.now();
    const lease = randomUUID();
    const job = await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      const job = snapshot.data();
      if (!job || job.sentAt || job.status === 'failed' || job.status === 'skipped'
        || job.sendingUntil > iso(time) || job.dueAt > iso(time)) return null;
      const [orderSnap, active] = await Promise.all([tx.get(db.doc(`bazaarOrders/${job.orderId}`)),
        reminderTypes.has(job.type) ? tx.get(db.doc('bazaarMeta/event')) : null]);
      const order = orderSnap.data();
      if (!order?.email) {
        tx.update(ref, { status: 'skipped', dueAt: null });
        return null;
      }
      if (active && !job.payload) {
        const next = nextReminder(job, order, active.data(), time);
        if (next === null || (job.type === 'reminder3' ? order.reminder3At : order.reminderFinalAt)) {
          tx.update(ref, { status: 'skipped', dueAt: null });
          return null;
        }
        if (next > time) {
          tx.update(ref, { dueAt: iso(next) });
          return null;
        }
      }
      const dedupWindow = provider === 'brevo' ? 29 * minute : 23 * 60 * minute;
      const started = Date.parse(job.firstAttemptAt) || time;
      if (time - started >= dedupWindow) {
        tx.update(ref, { status: 'failed', lastError: 'verify-provider-before-resending', dueAt: null, sendingUntil: null });
        return null;
      }
      const payload = job.payload ?? { ...message(order, job.type, order.eventSnapshot), to: order.email };
      const providerKey = job.providerKey ?? randomUUID();
      const quotaDay = quotaDate.format(time);
      if (!isCapture && job.quotaDay !== quotaDay) {
        const quota = db.collection('bazaarMailUsage');
        const daily = quota.doc(`${provider}-day-${quotaDay}`);
        const monthly = provider === 'resend' ? quota.doc(`resend-month-${quotaDay.slice(0, 7)}`) : null;
        const [dayCount, monthCount] = await Promise.all([tx.get(daily), monthly && tx.get(monthly)]);
        const dailyTotal = dayCount.data()?.count ?? 0;
        const monthlyTotal = monthCount?.data()?.count ?? 0;
        if (dailyTotal >= (provider === 'resend' ? 100 : 300) || monthlyTotal >= 3000) {
          tx.update(ref, { status: 'delayed', dueAt: iso(time + 60 * minute), lastError: 'free-plan-limit' });
          return null;
        }
        tx.set(daily, { count: dailyTotal + 1 });
        if (monthly) tx.set(monthly, { count: monthlyTotal + 1 });
      }
      const until = iso(time + 2 * minute);
      const earlierUncertainty = job.deliveryUncertain === true || job.status === 'sending';
      tx.update(ref, { lease, sendingUntil: until, status: 'sending', dueAt: until,
        firstAttemptAt: iso(started), attempts: (job.attempts ?? 0) + 1, payload, providerKey, quotaDay,
        deliveryUncertain: earlierUncertainty });
      return { ...job, providerKey, payload, earlierUncertainty };
    });
    if (!job) return false;
    let result;
    try { result = await providerSend(job, job.payload); }
    catch { result = { uncertain: true }; }
    return db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (current?.lease !== lease) return false;
      if (result.ok) {
        const sentAt = iso(Date.now());
        const order = reminderTypes.has(job.type) ? await tx.get(db.doc(`bazaarOrders/${job.orderId}`)) : null;
        if (order?.exists) {
          tx.update(order.ref, { [job.type === 'reminder3' ? 'reminder3At' : 'reminderFinalAt']: sentAt });
        }
        tx.update(ref, { sentAt, providerId: result.id, status: 'sent', dueAt: null,
          sendingUntil: null, lastError: null, payload: null });
        return true;
      }
      const retry = result.retry ?? (result.uncertain ? 5 * minute : null);
      tx.update(ref, { status: retry ? 'delayed' : 'failed', dueAt: retry ? iso(Date.now() + retry) : null,
        sendingUntil: null, lastError: result.code ?? 'provider-result-uncertain',
        deliveryUncertain: job.earlierUncertainty || result.uncertain === true,
        ...(result.retry && !job.earlierUncertainty ? { firstAttemptAt: null } : {}) });
      return false;
    });
  }

  return {
    canSend,
    scheduleReminders,
    deliver,
    async run(message) {
      if (!canSend()) return;
      // One indexed field excludes terminal jobs. Small batches bound CPU and subrequests.
      const due = await outbox.where('dueAt', '>=', '0').where('dueAt', '<=', iso(Date.now())).orderBy('dueAt').limit(4).get();
      for (const job of due.docs) await deliver(job.id, message).catch(() => {});
    },
    async status(orderId) {
      const result = await outbox.where('orderId', '==', orderId).limit(25).get();
      return result.docs.map(doc => {
        const { type, status, sentAt, lastError, dueAt } = doc.data();
        return { type, status: status ?? (sentAt ? 'sent' : 'queued'), sentAt, lastError, dueAt };
      });
    }
  };
}
